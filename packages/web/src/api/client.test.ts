import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, retryAfterSecondsFrom } from "./client.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const envelope = (error: string, extra: Record<string, unknown> = {}) => ({
  error,
  hint: "hint text",
  docs: "http://localhost/llms.txt#err",
  ...extra,
});

function clientWith(response: Response, onUnauthorized?: () => void) {
  const fetchFn = vi.fn(async () => response);
  return {
    client: createApiClient({
      fetchFn: fetchFn as unknown as typeof fetch,
      onUnauthorized,
    }),
    fetchFn,
  };
}

describe("envelope decode + Retry-After extraction", () => {
  it("decodes the base envelope with typed additions", async () => {
    const { client } = clientWith(
      jsonResponse(
        409,
        envelope("NICKNAME_TAKEN", { suggestion: "brave-rook-7" }),
      ),
    );
    const error = await client
      .authVerify({ address: "A" })
      .then(() => null)
      .catch((error_: ApiError) => error_);
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.code).toBe("NICKNAME_TAKEN");
    expect(error?.envelope.hint).toBe("hint text");
    expect(error?.envelope.suggestion).toBe("brave-rook-7");
  });

  it("decodes legalMoves and requestId additions", async () => {
    const { client } = clientWith(
      jsonResponse(
        400,
        envelope("ILLEGAL_MOVE", { legalMoves: [{ uci: "e2e4", san: "e4" }] }),
      ),
    );
    const result = await client.postMove("clm_1", "a1a2");
    expect(result).toMatchObject({
      kind: "illegal",
      envelope: { legalMoves: [{ uci: "e2e4", san: "e4" }] },
    });

    const { client: client2 } = clientWith(
      jsonResponse(500, envelope("INTERNAL", { requestId: "req-1" })),
    );
    const internal = await client2
      .getMeta()
      .then(() => null)
      .catch((error_: ApiError) => error_);
    expect(internal?.envelope.requestId).toBe("req-1");
  });

  it("extracts Retry-After on 204 no-boards", async () => {
    const { client } = clientWith(
      jsonResponse(204, null, { "Retry-After": "19" }),
    );
    const result = await client.createClaim({});
    expect(result).toEqual({ kind: "none", retryAfterSeconds: 19 });
  });

  it("extracts Retry-After on 429 quota-out", async () => {
    const { client } = clientWith(
      jsonResponse(429, envelope("QUOTA_OUT"), { "Retry-After": "1800" }),
    );
    const result = await client.createClaim({});
    expect(result).toEqual({ kind: "quota", retryAfterSeconds: 1800 });
  });

  it("extracts Retry-After on 503 payment-unavailable", async () => {
    const { client } = clientWith(
      jsonResponse(503, envelope("PAYMENT_UNAVAILABLE"), {
        "Retry-After": "7",
      }),
    );
    const result = await client.postMove("clm_1", "e2e4", "hdr");
    expect(result).toEqual({ kind: "unavailable", retryAfterSeconds: 7 });
  });

  it("survives a malformed error body with a displayable envelope", async () => {
    const { client } = clientWith(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const error = await client
      .getMeta()
      .then(() => null)
      .catch((error_: ApiError) => error_);
    expect(error?.envelope.error).toBe("INTERNAL");
    expect(error?.envelope.hint).toContain("502");
  });

  it("parses Retry-After header values defensively", () => {
    expect(retryAfterSecondsFrom(new Headers({ "Retry-After": "12" }))).toBe(
      12,
    );
    expect(
      retryAfterSecondsFrom(new Headers({ "Retry-After": "soon" })),
    ).toBeNull();
    expect(retryAfterSecondsFrom(new Headers())).toBeNull();
  });
});

describe("session-out hook", () => {
  it("fires on 401 outside login and the boot probe", async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(
      jsonResponse(401, envelope("UNAUTHENTICATED")),
      onUnauthorized,
    );
    await client.authLogout().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for the boot probe 401 (probe result is just out)", async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(
      jsonResponse(401, envelope("UNAUTHENTICATED")),
      onUnauthorized,
    );
    expect(await client.probeProfile()).toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("postMove result mapping", () => {
  it("posts_claim_id_and_move_to_the_stable_moves_route", async () => {
    const { client, fetchFn } = clientWith(
      jsonResponse(200, {
        status: "moved",
        move: { uci: "e2e4", san: "e4" },
        debitMicroUsdc: 0,
        txid: null,
        explorerUrl: null,
        fenAfterYourMove: "fen",
      }),
    );
    await client.postMove("clm_1", "e2e4");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("/api/v1/moves");
    expect(JSON.parse(init.body)).toEqual({ claimId: "clm_1", move: "e2e4" });
  });

  it("maps a 402 challenge to payment_required with the header", async () => {
    const { client } = clientWith(
      jsonResponse(402, envelope("PAYMENT_REQUIRED"), {
        "PAYMENT-REQUIRED": "b64==",
      }),
    );
    const result = await client.postMove("clm_1", "e2e4");
    expect(result).toMatchObject({
      kind: "payment_required",
      challengeHeader: "b64==",
    });
  });

  it("maps 202 to pending with Retry-After", async () => {
    const { client } = clientWith(
      jsonResponse(
        202,
        { status: "payment_pending", claimId: "clm_1", retryAfterSeconds: 5 },
        { "Retry-After": "5" },
      ),
    );
    expect(await client.postMove("clm_1", "e2e4", "hdr")).toEqual({
      kind: "pending",
      retryAfterSeconds: 5,
    });
  });

  it("maps 409 / 410 / paused", async () => {
    const cases: readonly [Response, string][] = [
      [jsonResponse(409, envelope("PAYMENT_IN_FLIGHT")), "in_flight"],
      [jsonResponse(410, envelope("CLAIM_EXPIRED")), "expired"],
      [jsonResponse(503, envelope("PAUSED")), "paused"],
    ];
    for (const [response, kind] of cases) {
      const { client } = clientWith(response);
      expect((await client.postMove("clm_1", "e2e4", "hdr")).kind).toBe(kind);
    }
  });
});
