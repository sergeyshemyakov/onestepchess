import { renderAscii } from "@onestepchess/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { TurnstileVerifier } from "../../auth/turnstile.js";
import type {
  ClaimDeps,
  ClaimRecord,
  MoveReceipt,
} from "../../coordinator/claims.js";
import { legalMove, receiptFor } from "../../coordinator/claims.js";
import type { DispatchResult } from "../../coordinator/queue.js";
import { parseGameRules } from "../../coordinator/timers.js";
import { schema } from "../../db/open.js";
import { newId } from "../../ids.js";
import { resolveReferrer } from "../../incentives/referrals.js";
import { type AppEnv, AppError } from "../app.js";
import { claimBodySchema, moveBodySchema } from "../contracts.js";
import { clientIp } from "../middleware/client-ip.js";
import { createTokenBucket } from "../middleware/ratelimit.js";
import { requireTurnstile } from "../turnstile.js";
import { parseJsonBody } from "../validation.js";
import {
  guestOrSessionAuth,
  optionalGuestOrSessionAuth,
  type SessionAuthDeps,
  setGuestCookie,
} from "./auth.js";

export type ClaimRouteDeps = ClaimDeps &
  SessionAuthDeps & {
    readonly trustProxyHops: number;
    readonly turnstile: TurnstileVerifier;
    readonly mode: () => "running" | "paused";
    readonly metrics?: {
      recordClaimCreated(): void;
      recordMoveSettled(latencyMs: number): void;
      recordFacilitatorError(): void;
    };
    // The recovery loop only re-arms itself while intents are in flight; any
    // path that leaves an intent unresolved must kick it or the intent (and
    // its claim) can stay stuck until the next boot.
    readonly scheduleRecovery?: (dueAt: number) => void;
  };

function claimView(deps: ClaimRouteDeps, claim: ClaimRecord, ascii: boolean) {
  const game = deps.db
    .select()
    .from(schema.games)
    .where(eq(schema.games.id, claim.gameId))
    .get();
  if (game === undefined) throw new Error("claim game missing");
  const adapter = deps.registry.get(parseGameRules(game.rulesJson));
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

function failurePaymentCode(
  failureCode: string | null,
):
  | "PAYMENT_INVALID"
  | "INSUFFICIENT_FUNDS"
  | "NOT_OPTED_IN"
  | "PAYMENT_UNAVAILABLE" {
  if (failureCode === "insufficient_funds") return "INSUFFICIENT_FUNDS";
  if (failureCode === "not_opted_in") return "NOT_OPTED_IN";
  if (failureCode === "unavailable") return "PAYMENT_UNAVAILABLE";
  return "PAYMENT_INVALID";
}

function assertClaimNotExpired(deps: ClaimRouteDeps, claim: ClaimRecord): void {
  if (
    claim.status === "expired" ||
    (claim.status === "open" && claim.deadline <= deps.now())
  )
    throw new AppError("CLAIM_EXPIRED", { hint: "claim expired" });
}

async function normalizeRequestedMove(
  deps: ClaimRouteDeps,
  claim: ClaimRecord,
  request: { json(): Promise<unknown> },
): Promise<MoveReceipt["move"]> {
  const body = await parseJsonBody(
    moveBodySchema,
    request,
    "invalid request body",
  );
  const normalized = legalMove(deps, claim, body.move);
  if (!normalized.ok)
    throw new AppError(
      normalized.reason === "ambiguous" ? "AMBIGUOUS_MOVE" : "ILLEGAL_MOVE",
      {
        hint: "move is not uniquely legal",
        legalMoves: normalized.legalMoves,
      },
    );
  return normalized.move;
}

type JsonRequest = {
  json(): Promise<unknown>;
};

type PaidMoveResult =
  | {
      readonly kind: "moved";
      readonly receipt: MoveReceipt;
      readonly paymentResponse: string | null;
    }
  | { readonly kind: "pending"; readonly claimId: string };

function unwrapInternal<R>(result: DispatchResult<R>): R {
  if (result.kind === "deprioritized") {
    throw new Error("internal command deprioritized");
  }
  return result.result;
}

async function submitDemoMove(
  deps: ClaimRouteDeps,
  claim: ClaimRecord,
  player: string,
  request: JsonRequest,
): Promise<MoveReceipt> {
  assertClaimNotExpired(deps, claim);
  if (claim.status === "moved") return receipt(deps, claim);
  const move = await normalizeRequestedMove(deps, claim, request);
  const result = await deps.coordinator.dispatch<unknown, MoveReceipt>({
    type: "DemoMoveSubmitted",
    payload: { claimId: claim.id, player, move },
  });
  return unwrapInternal(result);
}

async function submitPaidMove(
  deps: ClaimRouteDeps,
  claim: ClaimRecord,
  player: string,
  signature: string | undefined,
  request: JsonRequest,
): Promise<PaidMoveResult> {
  const required = challenge(deps, claim);
  if (signature === undefined) {
    assertClaimNotExpired(deps, claim);
    if (claim.status === "moved") {
      return {
        kind: "moved",
        receipt: receipt(deps, claim),
        paymentResponse: null,
      };
    }
    await normalizeRequestedMove(deps, claim, request);
    throw new AppError("PAYMENT_REQUIRED", {
      hint: "payment signature required",
      headers: { "PAYMENT-REQUIRED": required.header },
    });
  }

  const decoded = deps.rail.decodePayment(signature);
  const accepted = required.required.accepts[0];
  if (
    !decoded.ok ||
    decoded.payment.sender !== player ||
    decoded.payment.amountMicroUsdc !== claim.stakeMicrousdc ||
    decoded.payment.asset !== accepted.asset ||
    decoded.payment.payTo !== deps.rail.treasuryAddress
  ) {
    throw paymentError("PAYMENT_INVALID", required.header);
  }

  const clientTxid = decoded.payment.clientTxId;
  const existing = deps.db
    .select()
    .from(schema.paymentIntents)
    .where(eq(schema.paymentIntents.clientTxid, clientTxid))
    .get();
  if (
    existing !== undefined &&
    (existing.player !== player || existing.claimId !== claim.id)
  ) {
    throw paymentError("PAYMENT_INVALID", required.header);
  }
  if (existing?.status === "settled") {
    if (claim.status !== "moved" || existing.paymentResponseHeader === null) {
      throw new Error("settled intent lacks a durable receipt");
    }
    return {
      kind: "moved",
      receipt: receipt(deps, claim),
      paymentResponse: existing.paymentResponseHeader,
    };
  }
  if (existing?.status === "verified" || existing?.status === "settling") {
    deps.scheduleRecovery?.(deps.now());
    return { kind: "pending", claimId: claim.id };
  }
  if (existing?.status === "failed") {
    throw paymentError(
      failurePaymentCode(existing.failureCode),
      required.header,
    );
  }

  assertClaimNotExpired(deps, claim);
  if (claim.status !== "open") {
    throw paymentError("PAYMENT_INVALID", required.header);
  }
  const move = await normalizeRequestedMove(deps, claim, request);
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
  if (inflight !== undefined) {
    throw new AppError("PAYMENT_IN_FLIGHT", {
      hint: "another payment is in flight",
    });
  }

  const opened = unwrapInternal(
    await deps.coordinator.dispatch<
      {
        claimId: string;
        player: string;
        move: MoveReceipt["move"];
        clientTxid: string;
        amount: number;
        lastValidRound: number | null;
      },
      {
        status:
          | "verified"
          | "in_flight"
          | "settling"
          | "settled"
          | "failed"
          | "foreign"
          | "expired";
        created: boolean;
      }
    >({
      type: "PaymentIntentOpened",
      payload: {
        claimId: claim.id,
        player,
        move,
        clientTxid,
        amount: claim.stakeMicrousdc,
        lastValidRound: decoded.payment.lastValidRound,
      },
    }),
  );
  if (opened.status === "foreign") {
    throw paymentError("PAYMENT_INVALID", required.header);
  }
  if (opened.status === "expired") {
    await deps.coordinator.dispatch({
      type: "ExpireClaim",
      payload: { claimId: claim.id },
    });
    throw new AppError("CLAIM_EXPIRED", { hint: "claim expired" });
  }
  if (opened.status === "in_flight") {
    throw new AppError("PAYMENT_IN_FLIGHT", {
      hint: "another payment is in flight",
    });
  }
  if (!opened.created && opened.status === "failed") {
    const failed = deps.db
      .select({ failureCode: schema.paymentIntents.failureCode })
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.clientTxid, clientTxid))
      .get();
    throw paymentError(
      failurePaymentCode(failed?.failureCode ?? null),
      required.header,
    );
  }
  if (!opened.created && opened.status === "settled") {
    const settledIntent = deps.db
      .select()
      .from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.clientTxid, clientTxid))
      .get();
    const moved = deps.db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, claim.id))
      .get();
    if (
      settledIntent?.paymentResponseHeader === null ||
      settledIntent?.paymentResponseHeader === undefined ||
      moved?.status !== "moved"
    ) {
      throw new Error("settled intent lacks a durable receipt");
    }
    return {
      kind: "moved",
      receipt: receipt(deps, moved),
      paymentResponse: settledIntent.paymentResponseHeader,
    };
  }
  if (!opened.created) {
    deps.scheduleRecovery?.(deps.now());
    return { kind: "pending", claimId: claim.id };
  }

  const settlementStartedAt = deps.now();
  let verification: Awaited<ReturnType<typeof deps.rail.verify>>;
  try {
    verification = await deps.rail.verify(signature, required.required);
  } catch (error) {
    deps.metrics?.recordFacilitatorError();
    deps.scheduleRecovery?.(deps.now());
    throw error;
  }
  if (!verification.ok) {
    deps.metrics?.recordFacilitatorError();
    await deps.coordinator.dispatch({
      type: "IntentFailed",
      payload: { clientTxid, failureCode: verification.reason },
    });
    throw paymentError(
      failurePaymentCode(verification.reason),
      required.header,
    );
  }

  await deps.coordinator.dispatch({
    type: "IntentMarkedSettling",
    payload: { clientTxid },
  });
  let settled: Awaited<ReturnType<typeof deps.rail.settle>>;
  try {
    settled = await deps.rail.settle(signature, required.required);
  } catch (error) {
    deps.metrics?.recordFacilitatorError();
    deps.scheduleRecovery?.(deps.now());
    throw error;
  }
  if (!settled.ok) {
    deps.metrics?.recordFacilitatorError();
    if (settled.reason === "unavailable") {
      deps.scheduleRecovery?.(deps.now());
      return { kind: "pending", claimId: claim.id };
    }
    await deps.coordinator.dispatch({
      type: "IntentFailed",
      payload: { clientTxid, failureCode: settled.reason },
    });
    throw paymentError("PAYMENT_INVALID", required.header);
  }

  const committed = unwrapInternal(
    await deps.coordinator.dispatch<unknown, MoveReceipt>({
      type: "MoveSettled",
      payload: {
        claimId: claim.id,
        player,
        move,
        clientTxid,
        txid: settled.txid,
        response: settled.paymentResponseHeader,
      },
    }),
  );
  deps.metrics?.recordMoveSettled(deps.now() - settlementStartedAt);
  return {
    kind: "moved",
    receipt: committed,
    paymentResponse: settled.paymentResponseHeader,
  };
}

export function registerClaimRoutes(
  app: Hono<AppEnv>,
  deps: ClaimRouteDeps,
): void {
  const auth = guestOrSessionAuth(deps);
  const optionalAuth = optionalGuestOrSessionAuth(deps);
  const bucket = createTokenBucket({
    limitPerMinute: () => deps.config().RATE_LIMIT_CLAIMS_PER_IP_MIN,
    now: deps.now,
  });
  app.post("/api/v1/claims", optionalAuth, async (c) => {
    pauseCheck(deps);
    const decision = bucket.take(clientIp(c, deps.trustProxyHops));
    if (!decision.ok)
      throw new AppError("RATE_LIMITED", {
        hint: "too many claim requests",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    const body = await parseJsonBody(
      claimBodySchema,
      c.req,
      "invalid request body",
    );
    let session = c.get("session");
    let createGuest:
      | { turnstileVerifiedAt: number; referredBy: string | null }
      | undefined;
    if (session === undefined) {
      if (!body.demo)
        throw new AppError("UNAUTHENTICATED", { hint: "missing session" });
      if (body.turnstileToken === undefined)
        throw new AppError("TURNSTILE_REQUIRED", {
          hint: "anonymous demo play requires Turnstile",
        });
      await requireTurnstile(
        deps.turnstile,
        body.turnstileToken,
        clientIp(c, deps.trustProxyHops),
      );
      const address = newId("guest_");
      session = {
        address,
        kind: "guest",
        jti: "guest",
        exp: 0,
      };
      // F15 step 3: a ref on the anonymous claim is stored on the guest row so
      // link-on-login can carry it into a fresh registration. Unknown codes are
      // ignored silently (resolveReferrer returns null).
      createGuest = {
        turnstileVerifiedAt: deps.now(),
        referredBy: resolveReferrer(deps.db, body.ref, address),
      };
    }
    if (session.kind === "guest" && !body.demo)
      throw new AppError("INVALID_REQUEST", {
        hint: "guest sessions may request demo claims only",
      });
    if (body.demo && session.kind === "agent")
      throw new AppError("DEMO_HUMANS_ONLY", {
        hint: "demo claims are for humans",
      });
    const player = deps.db
      .select({ deprioritizedUntil: schema.players.deprioritizedUntil })
      .from(schema.players)
      .where(eq(schema.players.address, session.address))
      .get();
    const hasOpenClaim = deps.views.openClaimByPlayer.has(session.address);
    const claimClass =
      session.kind === "agent"
        ? "agent"
        : !hasOpenClaim &&
            player?.deprioritizedUntil !== null &&
            player?.deprioritizedUntil !== undefined &&
            player.deprioritizedUntil > deps.now()
          ? "deprioritized"
          : "human";
    const result = await deps.coordinator.dispatch<
      {
        player: string;
        kind: "human" | "agent" | "guest";
        demo: boolean;
        createGuest?: {
          turnstileVerifiedAt: number;
          referredBy: string | null;
        };
      },
      {
        claim: ClaimRecord | null;
        created: boolean;
        quota?: boolean;
        guestUsed?: boolean;
        retryAfterSeconds?: number;
      }
    >({
      type: "ClaimRequested",
      payload: {
        player: session.address,
        kind: session.kind,
        demo: body.demo,
        ...(createGuest === undefined ? {} : { createGuest }),
      },
      claimClass,
    });
    if (result.kind === "deprioritized")
      return c.body(null, 204, { "Retry-After": "1" });
    const data = result.result;
    if (data.claim === null) {
      if (data.guestUsed)
        throw new AppError("GUEST_DEMO_USED", {
          hint: "demo used — log in to keep playing",
        });
      if (data.quota)
        throw new AppError("QUOTA_OUT", {
          hint: "claim quota exhausted",
          retryAfterSeconds: data.retryAfterSeconds,
        });
      return c.body(null, 204, {
        "Retry-After": String(data.retryAfterSeconds ?? 1),
      });
    }
    if (createGuest !== undefined) setGuestCookie(c, deps, session.address);
    if (data.created) deps.metrics?.recordClaimCreated();
    return c.json(
      {
        claim: claimView(deps, data.claim, c.req.query("include") === "ascii"),
      },
      data.created ? 201 : 200,
    );
  });
  app.get("/api/v1/claims/current", auth, (c) => {
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
  app.get("/api/v1/claims/:id/status", auth, (c) => {
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
  app.post("/api/v1/claims/:id/move", auth, async (c) => {
    pauseCheck(deps);
    const session = c.get("session");
    const claim = claimed(deps, c.req.param("id"), session.address);
    if (claim.demo) {
      return c.json(await submitDemoMove(deps, claim, session.address, c.req));
    }
    const result = await submitPaidMove(
      deps,
      claim,
      session.address,
      c.req.header("PAYMENT-SIGNATURE"),
      c.req,
    );
    if (result.kind === "pending") {
      return c.json(
        {
          status: "payment_pending",
          claimId: result.claimId,
          retryAfterSeconds: 5,
        },
        202,
        { "Retry-After": "5" },
      );
    }
    return result.paymentResponse === null
      ? c.json(result.receipt)
      : c.json(result.receipt, 200, {
          "PAYMENT-RESPONSE": result.paymentResponse,
        });
  });
}

function receipt(deps: ClaimRouteDeps, claim: ClaimRecord): MoveReceipt {
  const intent = claim.demo
    ? undefined
    : deps.db
        .select()
        .from(schema.paymentIntents)
        .where(
          and(
            eq(schema.paymentIntents.claimId, claim.id),
            eq(schema.paymentIntents.status, "settled"),
          ),
        )
        .get();
  return receiptFor(
    claim,
    intent?.settleTxid ?? null,
    deps.config().EXPLORER_BASE_URL,
  );
}
