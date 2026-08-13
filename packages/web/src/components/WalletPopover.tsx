import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { type ApiClient, ApiError } from "../api/client.js";
import type { PlayerView, ProfileView } from "../api/schemas.js";
import { copyText } from "../lib/clipboard.js";
import { formatMicroAlgo, formatMicroUsdc } from "../lib/format.js";
import { ReturnBonusSheet } from "./ReturnBonusSheet.jsx";
import { useDialogFocusTrap } from "./useDialogFocusTrap.js";

/** F-W9 wallet popover. Balances are fetched only while it is open — the
 * only surface that ever requests them (`?include=balances`); a slow fetch
 * shows a stale marker instead of blocking. No separate route. */
export function WalletPopover(props: {
  readonly client: ApiClient;
  readonly player: PlayerView;
  readonly onRenamed: (player: PlayerView) => void;
  readonly onLogout: () => void;
  readonly onClose: () => void;
}) {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [copiedWhat, setCopiedWhat] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [returning, setReturning] = useState(false);
  const [nickname, setNickname] = useState(props.player.nickname ?? "");
  const [renameError, setRenameError] = useState<{
    readonly hint: string;
    readonly suggestion?: string;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, props.onClose);
  const { client } = props;

  const fetchProfile = useCallback(() => {
    let cancelled = false;
    client
      .getProfile({ balances: true })
      .then((fetched) => {
        if (!cancelled) setProfile(fetched);
      })
      .catch(() => {
        // stale marker stays — the popover never blocks on the chain
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => fetchProfile(), [fetchProfile]);

  const saveNickname = (value: string) => {
    setRenameError(null);
    client
      .renameProfile(value)
      .then((player) => {
        setEditing(false);
        setNickname(player.nickname ?? "");
        props.onRenamed(player);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          setRenameError({
            hint: error.envelope.hint,
            ...(error.envelope.suggestion === undefined
              ? {}
              : { suggestion: error.envelope.suggestion }),
          });
        } else {
          setRenameError({ hint: "rename failed — try again" });
        }
      });
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="popover"
      role="dialog"
      aria-label="wallet"
      data-testid="wallet-popover"
    >
      <div className="poprow addr">
        <span className="console popaddr">{props.player.address}</span>
        <button
          type="button"
          className="btn mini"
          onClick={() => {
            void copyText(props.player.address);
            setCopiedWhat("address");
          }}
        >
          {copiedWhat === "address" ? "✓" : "📋"}
        </button>
      </div>

      <div className="poprow" data-testid="popover-balances">
        {profile?.balances === undefined ? (
          <span className="dim">balances: fetching… (may be stale)</span>
        ) : (
          <span>
            {formatMicroUsdc(profile.balances.usdcMicroUsdc)} USDC ·{" "}
            {formatMicroAlgo(profile.balances.algoMicroAlgo)}
          </span>
        )}
        {profile?.bonus !== undefined ? (
          <button
            type="button"
            className="btn mini"
            title="return remaining welcome bonus"
            data-testid="return-bonus-button"
            onClick={() => setReturning(true)}
          >
            return bonus
          </button>
        ) : null}
      </div>
      {returning ? (
        <ReturnBonusSheet
          client={client}
          address={props.player.address}
          onClose={() => setReturning(false)}
          onReturned={() => fetchProfile()}
        />
      ) : null}

      <div className="poprow">
        <Link to="/start">need USDC? setup guide ▸</Link>
      </div>

      <div className="poprow">
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveNickname(nickname);
            }}
          >
            <input
              className="input mini"
              aria-label="nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
            />
            <button type="submit" className="btn mini">
              save
            </button>
            <button
              type="button"
              className="btn mini"
              onClick={() => {
                setEditing(false);
                setNickname(props.player.nickname ?? "");
                setRenameError(null);
              }}
            >
              cancel
            </button>
            {renameError !== null ? (
              <p className="formerr" role="alert">
                {renameError.hint}
                {renameError.suggestion !== undefined ? (
                  <button
                    type="button"
                    className="btn mini"
                    onClick={() => {
                      const suggestion = renameError.suggestion as string;
                      setNickname(suggestion);
                      saveNickname(suggestion);
                    }}
                  >
                    use {renameError.suggestion}
                  </button>
                ) : null}
              </p>
            ) : null}
            <p className="faintt">
              the address is your real identity — the nickname is just a label.
            </p>
          </form>
        ) : (
          <>
            <span>Displayed nick: {nickname}</span>
            <button
              type="button"
              className="btn mini"
              onClick={() => setEditing(true)}
            >
              edit
            </button>
          </>
        )}
      </div>

      {profile?.refCode !== undefined && profile.refCode !== null ? (
        <div className="poprow" data-testid="popover-invite">
          <span className="dim">invite:</span>{" "}
          <span className="console">
            {window.location.origin}/?ref={profile.refCode}
          </span>
          <button
            type="button"
            className="btn mini"
            onClick={() => {
              void copyText(
                `${window.location.origin}/?ref=${profile.refCode}`,
              );
              setCopiedWhat("invite");
            }}
          >
            {copiedWhat === "invite" ? "✓" : "📋"}
          </button>
          {profile.referrals !== undefined ? (
            <span className="dim">
              {" "}
              {profile.referrals.joined} joined · {profile.referrals.qualified}{" "}
              qualified
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="poprow" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn mini" onClick={props.onLogout}>
          log out
        </button>
        <button type="button" className="btn mini" onClick={props.onClose}>
          close
        </button>
      </div>
    </div>
  );
}
