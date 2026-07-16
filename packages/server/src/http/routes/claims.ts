import { renderAscii } from "@onestepchess/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type {
  ClaimDeps,
  ClaimRecord,
  MoveReceipt,
} from "../../coordinator/claims.js";
import { legalMove } from "../../coordinator/claims.js";
import { schema } from "../../db/open.js";
import { type AppEnv, AppError } from "../app.js";
import { clientIp } from "../middleware/client-ip.js";
import { createTokenBucket } from "../middleware/ratelimit.js";
import { type AuthRouteDeps, sessionAuth } from "./auth.js";

const claimBody = z.object({ demo: z.boolean().optional().default(false) });
const moveBody = z.object({ move: z.string().min(1).max(32) });

export type ClaimRouteDeps = ClaimDeps &
  Pick<AuthRouteDeps, "jwtSecret" | "trustProxyHops"> & {
    readonly publicBaseUrl: string;
    readonly mode: () => "running" | "paused";
  };

function parseBody<T>(
  schema_: z.ZodType<T>,
  request: { json(): Promise<unknown> },
): Promise<T> {
  return request
    .json()
    .catch(() => {
      throw new AppError("INVALID_REQUEST", { hint: "body must be JSON" });
    })
    .then((body) => {
      const parsed = schema_.safeParse(body);
      if (!parsed.success)
        throw new AppError("INVALID_REQUEST", { hint: "invalid request body" });
      return parsed.data;
    });
}

function claimView(deps: ClaimRouteDeps, claim: ClaimRecord, ascii: boolean) {
  const game = deps.db
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, claim.gameId))
    .get();
  if (game === undefined) throw new Error("claim game missing");
  const adapter = deps.registry.get(JSON.parse(game.rulesJson));
  const state = adapter.fromHistory(JSON.parse(game.historyJson));
  return {
    claimId: claim.id,
    yourSide: claim.side,
    phase: game.status === "endspiel" ? "endspiel" : "normal",
    demo: claim.demo,
    fen: game.fen,
    legalMoves: adapter.legalMoves(state),
    stakeMicroUsdc: claim.stakeMicrousdc,
    deadline: new Date(claim.deadline).toISOString(),
    ...(ascii ? { board: renderAscii(game.fen) } : {}),
  };
}

function claimed(
  deps: ClaimRouteDeps,
  id: string,
  player: string,
): ClaimRecord {
  const claim = deps.db
    .select()
    .from(schema.claims)
    .where(eq(schema.claims.id, id))
    .get();
  if (claim === undefined)
    throw new AppError("CLAIM_NOT_FOUND", { hint: "claim not found" });
  if (claim.player !== player)
    throw new AppError("NOT_YOUR_CLAIM", {
      hint: "claim belongs to another player",
    });
  return claim;
}

function pauseCheck(deps: ClaimRouteDeps): void {
  if (deps.mode() === "paused")
    throw new AppError("PAUSED", {
      hint: "new play is paused",
      retryAfterSeconds: 5,
    });
}

function challenge(deps: ClaimRouteDeps, claim: ClaimRecord) {
  return deps.rail.buildPaymentChallenge({
    amountMicroUsdc: claim.stakeMicrousdc,
    resource: `${deps.publicBaseUrl}/api/v1/claims/${claim.id}/move`,
  });
}

function paymentError(
  code:
    | "PAYMENT_INVALID"
    | "INSUFFICIENT_FUNDS"
    | "NOT_OPTED_IN"
    | "PAYMENT_UNAVAILABLE",
  header: string,
): AppError {
  return new AppError(code, {
    hint: code.toLowerCase().replaceAll("_", " "),
    ...(code === "PAYMENT_UNAVAILABLE" ? { retryAfterSeconds: 5 } : {}),
    headers: { "PAYMENT-REQUIRED": header },
  });
}

export function registerClaimRoutes(
  app: Hono<AppEnv>,
  deps: ClaimRouteDeps,
): void {
  const auth = sessionAuth(deps as unknown as AuthRouteDeps);
  const bucket = createTokenBucket({
    limitPerMinute: () => deps.config().RATE_LIMIT_CLAIMS_PER_IP_MIN,
    now: deps.now,
  });
  app.use("/api/v1/claims/*", auth);
  app.post("/api/v1/claims", auth, async (c) => {
    pauseCheck(deps);
    const decision = bucket.take(clientIp(c, deps.trustProxyHops));
    if (!decision.ok)
      throw new AppError("RATE_LIMITED", {
        hint: "too many claim requests",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    const body = await parseBody(claimBody, c.req);
    const session = c.get("session");
    if (body.demo && session.kind === "agent")
      throw new AppError("DEMO_HUMANS_ONLY", {
        hint: "demo claims are for humans",
      });
    const result = await deps.coordinator.dispatch<
      { player: string; kind: "human" | "agent" | "guest"; demo: boolean },
      {
        claim: ClaimRecord | null;
        created: boolean;
        quota?: boolean;
        retryAfterSeconds?: number;
      }
    >({
      type: "ClaimRequested",
      payload: { player: session.address, kind: session.kind, demo: body.demo },
      claimClass: session.kind === "agent" ? "agent" : "human",
    });
    if (result.kind === "deprioritized")
      return c.body(null, 204, { "Retry-After": "1" });
    const data = result.result;
    if (data.claim === null) {
      if (data.quota)
        throw new AppError("QUOTA_OUT", {
          hint: "claim quota exhausted",
          retryAfterSeconds: data.retryAfterSeconds,
        });
      return c.body(null, 204, {
        "Retry-After": String(data.retryAfterSeconds ?? 1),
      });
    }
    return c.json(
      {
        claim: claimView(deps, data.claim, c.req.query("include") === "ascii"),
      },
      data.created ? 201 : 200,
    );
  });
  app.get("/api/v1/claims/current", (c) => {
    const claim = deps.db
      .select()
      .from(schema.claims)
      .where(
        and(
          eq(schema.claims.player, c.get("session").address),
          eq(schema.claims.status, "open"),
        ),
      )
      .get();
    if (claim === undefined)
      throw new AppError("NO_OPEN_CLAIM", { hint: "no open claim" });
    return c.json({
      claim: claimView(deps, claim, c.req.query("include") === "ascii"),
    });
  });
  app.get("/api/v1/claims/:id/status", (c) => {
    const claim = claimed(deps, c.req.param("id"), c.get("session").address);
    if (claim.status === "expired") return c.json({ status: "expired" });
    if (claim.status === "moved")
      return c.json({ status: "moved", receipt: receipt(deps, claim) });
    const intent = deps.db
      .select()
      .from(schema.paymentIntents)
      .where(
        and(
          eq(schema.paymentIntents.claimId, claim.id),
          inArray(schema.paymentIntents.status, ["verified", "settling"]),
        ),
      )
      .get();
    return c.json({
      status: "open",
      claim: claimView(deps, claim, false),
      paymentState:
        intent?.status === "verified" ? "verifying" : (intent?.status ?? null),
    });
  });
  app.post("/api/v1/claims/:id/move", async (c) => {
    pauseCheck(deps);
    const session = c.get("session");
    const claim = claimed(deps, c.req.param("id"), session.address);
    if (
      claim.status === "expired" ||
      (claim.status === "open" && claim.deadline <= deps.now())
    )
      throw new AppError("CLAIM_EXPIRED", { hint: "claim expired" });
    if (claim.status === "moved") return c.json(receipt(deps, claim));
    const body = await parseBody(moveBody, c.req);
    const normalized = legalMove(deps, claim, body.move);
    if (!normalized.ok)
      throw new AppError(
        normalized.reason === "ambiguous" ? "AMBIGUOUS_MOVE" : "ILLEGAL_MOVE",
        {
          hint: "move is not uniquely legal",
          legalMoves: normalized.legalMoves,
        },
      );
    if (claim.demo) {
      const result = await deps.coordinator.dispatch({
        type: "DemoMoveSubmitted",
        payload: {
          claimId: claim.id,
          player: session.address,
          move: normalized.move,
        },
      });
      if (result.kind === "deprioritized")
        throw new Error("internal command deprioritized");
      return c.json(result.result as MoveReceipt);
    }
    const signature = c.req.header("PAYMENT-SIGNATURE");
    const required = challenge(deps, claim);
    if (signature === undefined)
      throw new AppError("PAYMENT_REQUIRED", {
        hint: "payment signature required",
        headers: { "PAYMENT-REQUIRED": required.header },
      });
    const decoded = deps.rail.decodePayment(signature);
    if (
      !decoded.ok ||
      decoded.payment.sender !== session.address ||
      decoded.payment.amountMicroUsdc !== claim.stakeMicrousdc ||
      decoded.payment.payTo !== deps.rail.treasuryAddress
    )
      throw paymentError("PAYMENT_INVALID", required.header);
    const existing = deps.db
      .select()
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.clientTxid, decoded.payment.clientTxId))
      .get();
    if (existing?.status === "settled") {
      const moved = deps.db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, existing.claimId))
        .get();
      if (moved !== undefined)
        return c.json(receipt(deps, moved), 200, {
          "PAYMENT-RESPONSE": existing.paymentResponseHeader ?? "",
        });
    }
    if (existing?.status === "verified" || existing?.status === "settling")
      return c.json(
        { status: "payment_pending", claimId: claim.id, retryAfterSeconds: 5 },
        202,
        { "Retry-After": "5" },
      );
    const inflight = deps.db
      .select()
      .from(schema.paymentIntents)
      .where(
        and(
          eq(schema.paymentIntents.claimId, claim.id),
          inArray(schema.paymentIntents.status, ["verified", "settling"]),
        ),
      )
      .get();
    if (inflight !== undefined)
      throw new AppError("PAYMENT_IN_FLIGHT", {
        hint: "another payment is in flight",
      });
    const verification = await deps.rail.verify(signature, required.required);
    if (!verification.ok) {
      const code =
        verification.reason === "insufficient_funds"
          ? "INSUFFICIENT_FUNDS"
          : verification.reason === "not_opted_in"
            ? "NOT_OPTED_IN"
            : verification.reason === "unavailable"
              ? "PAYMENT_UNAVAILABLE"
              : "PAYMENT_INVALID";
      throw paymentError(code, required.header);
    }
    const opened = await deps.coordinator.dispatch<
      {
        claimId: string;
        player: string;
        move: MoveReceipt["move"];
        clientTxid: string;
        amount: number;
        lastValidRound: number | null;
      },
      "verified" | "in_flight" | "settling" | "settled" | "failed"
    >({
      type: "PaymentIntentOpened",
      payload: {
        claimId: claim.id,
        player: session.address,
        move: normalized.move,
        clientTxid: decoded.payment.clientTxId,
        amount: claim.stakeMicrousdc,
        lastValidRound: decoded.payment.lastValidRound,
      },
    });
    if (opened.kind === "deprioritized" || opened.result === "in_flight")
      throw new AppError("PAYMENT_IN_FLIGHT", {
        hint: "another payment is in flight",
      });
    if (opened.result !== "verified")
      return c.json(
        { status: "payment_pending", claimId: claim.id, retryAfterSeconds: 5 },
        202,
        { "Retry-After": "5" },
      );
    await deps.coordinator.dispatch({
      type: "IntentMarkedSettling",
      payload: { clientTxid: decoded.payment.clientTxId },
    });
    const settled = await deps.rail.settle(signature, required.required);
    if (!settled.ok) {
      if (settled.reason === "unavailable")
        return c.json(
          {
            status: "payment_pending",
            claimId: claim.id,
            retryAfterSeconds: 5,
          },
          202,
          { "Retry-After": "5" },
        );
      await deps.coordinator.dispatch({
        type: "IntentFailed",
        payload: {
          clientTxid: decoded.payment.clientTxId,
          failureCode: settled.reason,
        },
      });
      throw paymentError("PAYMENT_INVALID", required.header);
    }
    const committed = await deps.coordinator.dispatch({
      type: "MoveSettled",
      payload: {
        claimId: claim.id,
        player: session.address,
        move: normalized.move,
        clientTxid: decoded.payment.clientTxId,
        txid: settled.txid,
        response: settled.paymentResponseHeader,
      },
    });
    if (committed.kind === "deprioritized")
      throw new Error("internal command deprioritized");
    return c.json(committed.result as MoveReceipt, 200, {
      "PAYMENT-RESPONSE": settled.paymentResponseHeader,
    });
  });
}

function receipt(deps: ClaimRouteDeps, claim: ClaimRecord): MoveReceipt {
  if (
    claim.moveUci === null ||
    claim.moveSan === null ||
    claim.fenAfter === null
  )
    throw new Error("incomplete receipt");
  const intent = claim.demo
    ? undefined
    : deps.db
        .select()
        .from(schema.paymentIntents)
        .where(eq(schema.paymentIntents.claimId, claim.id))
        .get();
  const txid = intent?.settleTxid ?? null;
  return {
    status: "moved",
    move: { uci: claim.moveUci, san: claim.moveSan },
    debitMicroUsdc: claim.demo ? 0 : claim.stakeMicrousdc,
    txid,
    explorerUrl:
      txid === null ? null : `${deps.config().EXPLORER_BASE_URL}/tx/${txid}`,
    fenAfterYourMove: claim.fenAfter,
  };
}
