import { useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { PlayerView } from "../api/schemas.js";
import { useSession } from "../auth/SessionContext.jsx";
import { shortenAddress } from "../lib/address.js";
import { useLiveOptional } from "../live/LiveContext.jsx";
import { WalletPopover } from "./WalletPopover.jsx";

export function PlayerStatus(props: {
  readonly client: ApiClient;
  readonly player: PlayerView;
}) {
  const { logout, signedIn } = useSession();
  const live = useLiveOptional();
  const [popover, setPopover] = useState(false);
  const stats = live?.profile?.stats;

  return (
    <>
      {stats !== undefined ? (
        <span className="chip" data-testid="stats-chip">
          W {stats.wins} · D {stats.draws} · L {stats.losses}
          {stats.winratePct !== null
            ? ` · ${Math.round(stats.winratePct)}%`
            : ""}
        </span>
      ) : null}
      <button
        type="button"
        className="chip click"
        title={props.player.address}
        onClick={() => setPopover((open) => !open)}
      >
        {props.player.nickname ?? "anonymous"} ·{" "}
        {shortenAddress(props.player.address)}
      </button>
      {popover ? (
        <WalletPopover
          client={props.client}
          player={props.player}
          onRenamed={(player) => signedIn(player)}
          onLogout={() => void logout()}
          onClose={() => setPopover(false)}
        />
      ) : null}
    </>
  );
}
