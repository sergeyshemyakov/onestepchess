import { sideToMove } from "../chess/adapter.js";
import type { GameRules } from "../config.js";
import {
  CoreError,
  type EpochMs,
  type MicroUsdc,
  type PlayerKind,
  type Side,
} from "../types.js";

export function claimTerms(args: {
  game: { readonly fen: string; readonly status: "active" | "endspiel" };
  requesterKind: PlayerKind;
  demo: boolean;
  now: EpochMs;
  cfg: GameRules;
}): { side: Side; stakeMicroUsdc: MicroUsdc; deadline: EpochMs } {
  const { game, requesterKind, demo, now, cfg } = args;
  if (game.status === "endspiel" && requesterKind !== "agent") {
    throw new CoreError("CONTRACT", "endspiel claims are agent-only");
  }
  if (demo && requesterKind === "agent") {
    throw new CoreError("CONTRACT", "agents cannot make demo claims");
  }
  if (requesterKind === "guest" && !demo) {
    throw new CoreError("CONTRACT", "guest claims must be demo");
  }

  const stakeMicroUsdc = demo
    ? 0
    : game.status === "endspiel"
      ? cfg.ENDSPIEL_STAKE
      : requesterKind === "human"
        ? cfg.HUMAN_STAKE
        : cfg.AGENT_STAKE;
  const ttlSeconds =
    game.status === "endspiel"
      ? cfg.CLAIM_TTL_ENDSPIEL
      : requesterKind === "agent"
        ? cfg.CLAIM_TTL_AGENT
        : cfg.CLAIM_TTL_HUMAN;

  return {
    side: sideToMove(game.fen),
    stakeMicroUsdc,
    deadline: now + ttlSeconds * 1_000,
  };
}
