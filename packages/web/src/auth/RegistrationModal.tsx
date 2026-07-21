import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../api/client.js";
import type { Meta, VerifyResponse } from "../api/schemas.js";
import { useDialogFocusTrap } from "../components/useDialogFocusTrap.js";
import type { PendingRegistration } from "./login.js";
import { obtainTurnstileToken } from "./turnstile.js";

type InlineError =
  | {
      readonly code: "NICKNAME_TAKEN";
      readonly hint: string;
      readonly suggestion?: string;
    }
  | { readonly code: "INVALID_NICKNAME"; readonly hint: string }
  | { readonly code: "TURNSTILE_FAILED"; readonly hint: string }
  | { readonly code: "OTHER"; readonly hint: string };

/** F-W2 registration: nickname prefilled from suggest-nickname with reroll,
 * `kind: 'human'` fixed, lazy Turnstile (managed mode — usually invisible),
 * envelope errors rendered inline. */
export function RegistrationModal(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
  readonly pending: PendingRegistration;
  readonly onRegistered: (response: VerifyResponse) => void;
  readonly onCancel: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<InlineError | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [turnstileEpoch, setTurnstileEpoch] = useState(0);
  const widgetRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onCancel);
  const { client, meta } = props;

  const reroll = useCallback(() => {
    client
      .suggestNickname()
      .then(setNickname)
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    reroll();
  }, [reroll]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: turnstileEpoch re-arms the widget after TURNSTILE_FAILED
  useEffect(() => {
    const container = widgetRef.current;
    if (container === null) return;
    let cancelled = false;
    setToken(null);
    obtainTurnstileToken(container, meta.turnstileSiteKey)
      .then((value) => {
        if (!cancelled) setToken(value);
      })
      .catch(() => {
        if (!cancelled) {
          setError({ code: "OTHER", hint: "captcha failed to load — retry" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [meta.turnstileSiteKey, turnstileEpoch]);

  const submit = useCallback(async () => {
    if (token === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.pending.resubmit({
        nickname,
        turnstileToken: token,
      });
      props.onRegistered(response);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const hint = caught.envelope.hint;
        switch (caught.code) {
          case "NICKNAME_TAKEN":
            setError({
              code: "NICKNAME_TAKEN",
              hint,
              ...(caught.envelope.suggestion === undefined
                ? {}
                : { suggestion: caught.envelope.suggestion }),
            });
            break;
          case "INVALID_NICKNAME":
            setError({ code: "INVALID_NICKNAME", hint });
            break;
          case "TURNSTILE_FAILED":
            setError({ code: "TURNSTILE_FAILED", hint });
            setTurnstileEpoch((epoch) => epoch + 1);
            break;
          default:
            setError({ code: "OTHER", hint });
        }
      } else {
        setError({ code: "OTHER", hint: "connection failed — try again" });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, nickname, props, token]);

  return (
    <div className="modalback">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="register"
      >
        <h3>NEW PLAYER</h3>
        <p className="sub">
          pick a nickname — your wallet address stays the real identity.
        </p>
        <div className="field">
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            aria-label="nickname"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn mini"
            onClick={reroll}
            aria-label="reroll nickname"
          >
            ↻
          </button>
        </div>
        {error !== null ? (
          <p className="formerr" role="alert">
            {error.hint}
            {error.code === "NICKNAME_TAKEN" &&
            error.suggestion !== undefined ? (
              <>
                {" "}
                <button
                  type="button"
                  className="btn mini"
                  onClick={() => {
                    if (error.suggestion !== undefined)
                      setNickname(error.suggestion);
                  }}
                >
                  use {error.suggestion}
                </button>
              </>
            ) : null}
            {error.code === "INVALID_NICKNAME" ? (
              <span className="faintt"> — 3–24 letters, digits, - or _</span>
            ) : null}
          </p>
        ) : null}
        <div ref={widgetRef} data-testid="turnstile-slot" />
        <div className="walletbox">
          <h4>KIND · HUMAN</h4>
          <p className="sub">&gt; agents register over the API.</p>
        </div>
        <div className="modal-actions pair registration-actions">
          <button
            type="button"
            className="btn pri"
            disabled={token === null || busy || nickname.length === 0}
            onClick={submit}
          >
            ▸ register
          </button>
          <button type="button" className="btn" onClick={props.onCancel}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}
