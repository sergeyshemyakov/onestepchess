import type { GameRules, Side } from "@onestepchess/core";
import { eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { parseGameRules } from "./timers.js";

const QUOTA_WINDOW_MS = 3_600_000;

export type PoolGameView = {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "endspiel";
  fen: string;
  ply: number;
  minNextClaimAt: number;
  lastPlyAt: number;
  readonly rules: GameRules;
};

export type OpenClaimView = {
  readonly id: string;
  readonly gameId: string;
  readonly player: string;
  readonly side: Side;
  readonly demo: boolean;
  readonly stakeMicrousdc: number;
  readonly createdAt: number;
  readonly deadline: number;
};

/** Derived, never authoritative (server spec §7): updated inside command
 * execution, read lock-free by the HTTP layer, rebuilt from SQLite at boot.
 * Anything not rebuildable from the DB must not live here. */
export class CoordinatorViews {
  readonly games = new Map<string, PoolGameView>();
  readonly openClaims = new Map<string, OpenClaimView>();
  readonly openClaimByGame = new Map<string, string>();
  readonly openClaimByPlayer = new Map<string, string>();
  readonly quota = new Map<string, { staked: number[]; demo: number[] }>();
  readonly banned = new Set<string>();
  readonly revokedJti = new Set<string>();

  rebuild(db: Db, now: number): void {
    this.games.clear();
    this.openClaims.clear();
    this.openClaimByGame.clear();
    this.openClaimByPlayer.clear();
    this.quota.clear();
    this.banned.clear();
    this.revokedJti.clear();

    const liveGames = db
      .select()
      .from(schema.games)
      .where(inArray(schema.games.status, ["active", "endspiel"]))
      .all();
    for (const game of liveGames) {
      this.games.set(game.id, {
        id: game.id,
        name: game.name,
        status: game.status as "active" | "endspiel",
        fen: game.fen,
        ply: game.ply,
        minNextClaimAt: game.minNextClaimAt,
        lastPlyAt: game.lastPlyAt,
        rules: parseGameRules(game.rulesJson),
      });
    }

    const openClaims = db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.status, "open"))
      .all();
    for (const claim of openClaims) {
      this.setOpenClaim({
        id: claim.id,
        gameId: claim.gameId,
        player: claim.player,
        side: claim.side,
        demo: claim.demo,
        stakeMicrousdc: claim.stakeMicrousdc,
        createdAt: claim.createdAt,
        deadline: claim.deadline,
      });
    }

    const windowClaims = db
      .select({
        player: schema.claims.player,
        demo: schema.claims.demo,
        createdAt: schema.claims.createdAt,
      })
      .from(schema.claims)
      .where(gt(schema.claims.createdAt, now - QUOTA_WINDOW_MS))
      .all();
    for (const claim of windowClaims) {
      this.countClaim(claim.player, claim.demo, claim.createdAt);
    }

    const bannedPlayers = db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(eq(schema.players.banned, true))
      .all();
    for (const player of bannedPlayers) {
      this.banned.add(player.address);
    }

    const liveJtis = db
      .select({ jti: schema.revokedJti.jti })
      .from(schema.revokedJti)
      .where(gt(schema.revokedJti.expiresAt, now))
      .all();
    for (const revoked of liveJtis) {
      this.revokedJti.add(revoked.jti);
    }
  }

  setOpenClaim(claim: OpenClaimView): void {
    this.openClaims.set(claim.id, claim);
    this.openClaimByGame.set(claim.gameId, claim.id);
    this.openClaimByPlayer.set(claim.player, claim.id);
  }

  removeOpenClaim(claimId: string): void {
    const claim = this.openClaims.get(claimId);
    if (claim === undefined) {
      return;
    }
    this.openClaims.delete(claimId);
    if (this.openClaimByGame.get(claim.gameId) === claimId) {
      this.openClaimByGame.delete(claim.gameId);
    }
    if (this.openClaimByPlayer.get(claim.player) === claimId) {
      this.openClaimByPlayer.delete(claim.player);
    }
  }

  countClaim(player: string, demo: boolean, createdAt: number): void {
    let counters = this.quota.get(player);
    if (counters === undefined) {
      counters = { staked: [], demo: [] };
      this.quota.set(player, counters);
    }
    (demo ? counters.demo : counters.staked).push(createdAt);
  }

  /** Rolling-window claim count; prunes aged-out entries as it reads. */
  claimsInWindow(player: string, demo: boolean, now: number): number {
    const counters = this.quota.get(player);
    if (counters === undefined) {
      return 0;
    }
    const list = demo ? counters.demo : counters.staked;
    const cutoff = now - QUOTA_WINDOW_MS;
    while (list.length > 0 && (list[0] as number) <= cutoff) {
      list.shift();
    }
    return list.length;
  }
}
