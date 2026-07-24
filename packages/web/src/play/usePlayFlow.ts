import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../api/client.js";
import type { ClaimStatus, ErrorEnvelope, Meta, Move } from "../api/schemas.js";
import { readClaimDraft } from "../lib/storage.js";
import { syncDraft } from "./draft.js";
import {
  initialPlayState,
  type PlayEvent,
  type PlayState,
  playReducer,
} from "./machine.js";
import { rehydrate } from "./rehydrate.js";

const SETTLE_POLL_MS = 2_000;
const ANONYMOUS_CLAIM_OPTIONS = { anonymous: true } as const;
const CONNECTION_FAILED: ErrorEnvelope = {
  error: "INTERNAL",
  hint: "connection failed — try again",
  docs: "",
};
const PAYMENT_DID_NOT_LAND: ErrorEnvelope = {
  error: "PAYMENT_INVALID",
  hint: "payment didn't land — nothing was charged; try again",
  docs: "",
};

type OpenClaimStatus = Extract<ClaimStatus, { readonly status: "open" }>;

/** Effects hook for the §5.5 reducer: API/wallet calls run here and come
 * back as dispatched events; the reducer itself stays pure. */
export function usePlayFlow(args: {
  readonly client: ApiClient;
  readonly meta: Meta | null;
  readonly address: string | null;
  readonly enabled: boolean;
  readonly guest?: boolean;
}) {
  const [state, dispatch] = useReducer(playReducer, initialPlayState);
  const { client, address, enabled } = args;
  const previousState = useRef<PlayState>(initialPlayState);
  const claimInFlight = useRef(false);
  const submitInFlight = useRef(false);
  const rehydrated = useRef(false);
  const guest = args.guest === true;
  const claimOptions = guest ? ANONYMOUS_CLAIM_OPTIONS : undefined;

  const applyClaimStatus = useCallback(
    (
      status: ClaimStatus | null,
      onOpen: (open: OpenClaimStatus) => void,
      nullIsExpired = true,
    ) => {
      if (status === null) {
        if (nullIsExpired) dispatch({ type: "CLAIM_EXPIRED" });
      } else if (status.status === "moved") {
        dispatch({ type: "RECEIPT", receipt: status.receipt });
      } else if (status.status === "expired") {
        dispatch({ type: "CLAIM_EXPIRED" });
      } else {
        onOpen(status);
      }
    },
    [],
  );

  // Draft persistence exactly at the specced points (§5.5).
  useEffect(() => {
    syncDraft(previousState.current, state);
    previousState.current = state;
  }, [state]);

  // Rehydration: refresh path and app-switch return path in one place.
  useEffect(() => {
    if (!enabled || rehydrated.current) return;
    rehydrated.current = true;
    const draft = readClaimDraft();
    // A cold logged-out landing is limited to `/meta` + the session probe.
    // Guest claim recovery is per-tab, so only a tab with a persisted draft
    // needs the anonymous current-claim request.
    if (guest && draft === null) return;
    const recoveryClient = guest
      ? {
          getCurrentClaim: () => client.getCurrentClaim(claimOptions),
          getClaimStatus: (id: string) =>
            client.getClaimStatus(id, claimOptions),
        }
      : client;
    rehydrate(recoveryClient, draft)
      .then((restored) => {
        if (restored.phase !== "IDLE") {
          dispatch({
            type: "RESTORE",
            state: guest ? { ...restored, guest: true } : restored,
          });
        }
      })
      .catch(() => undefined);
  }, [enabled, client, guest, claimOptions]);

  // CLAIMING → POST /claims (get-or-create).
  useEffect(() => {
    if (state.phase !== "CLAIMING" || claimInFlight.current) return;
    claimInFlight.current = true;
    client
      .createClaim(
        state.demo
          ? {
              demo: true,
              ...(state.turnstileToken === undefined
                ? {}
                : { turnstileToken: state.turnstileToken }),
              ...(state.ref === undefined ? {} : { ref: state.ref }),
            }
          : {},
      )
      .then((result) => {
        switch (result.kind) {
          case "claim":
            dispatch({ type: "CLAIM_READY", claim: result.claim });
            break;
          case "none":
            dispatch({
              type: "NO_BOARDS",
              retryAfterSeconds: result.retryAfterSeconds,
            });
            break;
          case "quota":
            dispatch({
              type: "QUOTA_OUT",
              retryAfterSeconds: result.retryAfterSeconds,
            });
            break;
          case "paused":
            dispatch({ type: "PAUSED" });
            break;
          case "guest_used":
            dispatch({ type: "GUEST_DEMO_USED" });
            break;
          case "turnstile_failed":
            dispatch({
              type: "GUEST_GATE_FAILED",
              envelope: result.envelope,
            });
            break;
        }
      })
      .catch(() => dispatch({ type: "NO_BOARDS", retryAfterSeconds: 5 }))
      .finally(() => {
        claimInFlight.current = false;
      });
  }, [state.phase, state.demo, state.turnstileToken, state.ref, client]);

  // Demo settle: plain POST, no header, no wallet, ever (F-W4).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on the phase transition only — re-running on claim/move context would double-submit
  useEffect(() => {
    if (
      state.phase !== "SETTLING" ||
      !state.demo ||
      state.settlePoll === true ||
      submitInFlight.current ||
      state.claim === undefined ||
      state.chosenMove === undefined
    ) {
      return;
    }
    submitInFlight.current = true;
    const { claim, chosenMove } = state;
    client
      .postMove(claim.claimId, chosenMove.uci)
      .then((result) => {
        switch (result.kind) {
          case "receipt":
            dispatch({ type: "RECEIPT", receipt: result.receipt });
            break;
          case "expired":
            dispatch({ type: "CLAIM_EXPIRED" });
            break;
          case "paused":
            dispatch({
              type: "PAYMENT_FAILED",
              envelope: {
                error: "PAUSED",
                hint: "settlement offline — your board is held",
                docs: "",
              },
            });
            break;
          case "illegal":
            refreshClaim();
            break;
          default:
            dispatch({
              type: "PAYMENT_FAILED",
              envelope: {
                error: "INTERNAL",
                hint: "move failed — try again",
                docs: "",
              },
            });
        }
      })
      .catch(() =>
        dispatch({ type: "PAYMENT_FAILED", envelope: CONNECTION_FAILED }),
      )
      .finally(() => {
        submitInFlight.current = false;
      });
  }, [state.phase, state.demo, state.settlePoll]);

  // Staked path: SIGNING runs the x402 module (§5.6).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on entering SIGNING only — context deps would re-run payMove mid-flight
  useEffect(() => {
    if (
      state.phase !== "SIGNING" ||
      submitInFlight.current ||
      state.claim === undefined ||
      state.chosenMove === undefined ||
      args.meta === null ||
      address === null
    ) {
      return;
    }
    submitInFlight.current = true;
    const { claim, chosenMove } = state;
    const meta = args.meta;
    import("../wallet/x402.js")
      .then(({ payMove }) =>
        payMove({
          claimId: claim.claimId,
          moveUci: chosenMove.uci,
          address,
          stakeMicroUsdc: claim.stakeMicroUsdc,
          meta,
          client,
          onPhase: (phase) => {
            if (phase === "settling")
              dispatch({ type: "HEADER_READY", header: "" });
          },
        }),
      )
      .then((outcome) => {
        dispatch({ type: "HEADER_READY", header: "" });
        switch (outcome.kind) {
          case "receipt":
            dispatch({ type: "RECEIPT", receipt: outcome.receipt });
            break;
          case "pending":
            dispatch({
              type: "PAYMENT_PENDING",
              retryAfterSeconds: outcome.retryAfterSeconds,
            });
            break;
          case "in_flight":
            dispatch({ type: "PAYMENT_IN_FLIGHT" });
            break;
          case "failed":
            dispatch({ type: "PAYMENT_FAILED", envelope: outcome.envelope });
            break;
          case "unavailable":
            dispatch({
              type: "PAYMENT_UNAVAILABLE",
              retryAfterSeconds: outcome.retryAfterSeconds,
            });
            break;
          case "expired":
            dispatch({ type: "CLAIM_EXPIRED" });
            break;
          case "unsupported":
            dispatch({
              type: "PAYMENT_FAILED",
              envelope: {
                error: "UNSUPPORTED",
                hint: outcome.reason,
                docs: "",
              },
            });
            break;
          case "illegal":
            refreshClaim();
            break;
          case "paused":
            dispatch({
              type: "PAYMENT_FAILED",
              envelope: {
                error: "PAUSED",
                hint: "settlement offline — your board is held",
                docs: "",
              },
            });
            break;
        }
      })
      .catch(() =>
        dispatch({ type: "PAYMENT_FAILED", envelope: CONNECTION_FAILED }),
      )
      .finally(() => {
        submitInFlight.current = false;
      });
  }, [state.phase]);

  // Ambiguous settle: poll claim status — never re-sign (§5.5).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the poll keys on phase + claim id; client is stable for the app lifetime
  useEffect(() => {
    if (state.phase !== "SETTLING" || state.settlePoll !== true) return;
    const claimId = state.claim?.claimId;
    if (claimId === undefined) return;
    const poll = setInterval(() => {
      client
        .getClaimStatus(claimId)
        .then((status) => {
          applyClaimStatus(
            status,
            (open) => {
              if (open.paymentState === null) {
                dispatch({
                  type: "PAYMENT_FAILED",
                  envelope: PAYMENT_DID_NOT_LAND,
                });
              }
            },
            false,
          );
        })
        .catch(() => undefined);
    }, SETTLE_POLL_MS);
    return () => clearInterval(poll);
  }, [state.phase, state.settlePoll, state.claim?.claimId, applyClaimStatus]);

  const refreshClaim = useCallback(() => {
    client
      .getCurrentClaim(claimOptions)
      .then((claim) => {
        if (claim !== null) dispatch({ type: "CLAIM_REFRESHED", claim });
        else dispatch({ type: "CLAIM_EXPIRED" });
      })
      .catch(() => undefined);
  }, [client, claimOptions]);

  const refreshStatus = useCallback(() => {
    const claimId = state.claim?.claimId;
    if (claimId === undefined) return;
    client
      .getClaimStatus(claimId, claimOptions)
      .then((status) => {
        applyClaimStatus(status, (open) =>
          dispatch({ type: "CLAIM_REFRESHED", claim: open.claim }),
        );
      })
      .catch(() => undefined);
  }, [client, claimOptions, state.claim?.claimId, applyClaimStatus]);

  // Timer expiry is cosmetic — confirm against the server before EXPIRED.
  const checkExpiry = useCallback(() => {
    const claimId = state.claim?.claimId;
    if (claimId === undefined) return;
    client
      .getClaimStatus(claimId, claimOptions)
      .then((status) => {
        // open → the settle-grace rule is playing out; keep the surface.
        applyClaimStatus(status, () => undefined);
      })
      .catch(() => undefined);
  }, [client, claimOptions, state.claim?.claimId, applyClaimStatus]);

  const send = useCallback((event: PlayEvent) => dispatch(event), []);

  return { state, send, checkExpiry, refreshClaim, refreshStatus } as const;
}

export type PlayFlow = ReturnType<typeof usePlayFlow>;
export type { Move };
