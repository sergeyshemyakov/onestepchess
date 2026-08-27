import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Conventions (server spec §4): epoch-ms integers, integer µUSDC, lowercase
// enums, prefixed nanoids; events/ledger use autoincrement integers because
// SSE resume and audit need a total order.

export const players = sqliteTable(
  "players",
  {
    address: text("address").primaryKey(),
    kind: text("kind", { enum: ["human", "agent", "guest"] }).notNull(),
    nickname: text("nickname"),
    createdAt: integer("created_at").notNull(),
    turnstileVerifiedAt: integer("turnstile_verified_at"),
    abandonCount: integer("abandon_count").notNull().default(0),
    deprioritizedUntil: integer("deprioritized_until"),
    wins: integer("wins").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    quotaOverride: integer("quota_override"),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    // Incentives (F15): ref_code is the human's invite slug; referred_by is the
    // referrer's address, first-touch immutable, and carried on guest rows too;
    // referral_awarded_at marks when THIS player's qualifying move credited the
    // referrer; ref_joined/ref_qualified are referrer-side O(1) counters; points
    // is a humans-only cache of SUM(point_awards.amount), never money (I11).
    refCode: text("ref_code"),
    referredBy: text("referred_by"),
    referralAwardedAt: integer("referral_awarded_at"),
    refJoined: integer("ref_joined").notNull().default(0),
    refQualified: integer("ref_qualified").notNull().default(0),
    points: integer("points").notNull().default(0),
    linkedAddress: text("linked_address"),
    linkedAt: integer("linked_at"),
  },
  (table) => [
    uniqueIndex("players_nickname_nocase").on(
      sql`${table.nickname} COLLATE NOCASE`,
    ),
    uniqueIndex("players_ref_code").on(table.refCode),
  ],
);

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    status: text("status", {
      enum: ["active", "endspiel", "finished", "aborted"],
    })
      .notNull()
      .default("active"),
    fen: text("fen").notNull(),
    ply: integer("ply").notNull().default(0),
    historyJson: text("history_json").notNull().default("[]"),
    rulesJson: text("rules_json").notNull(),
    result: text("result", { enum: ["white", "black", "draw", "aborted"] }),
    termination: text("termination", {
      enum: [
        "checkmate",
        "stalemate",
        "insufficient",
        "threefold",
        "fifty_move",
        "max_plies",
        "aborted",
      ],
    }),
    endspielPly: integer("endspiel_ply"),
    // Materialized at resolution (F7); carried as a NULL column from the
    // initial migration so the resolution slice needs no schema change.
    replayJson: text("replay_json"),
    minNextClaimAt: integer("min_next_claim_at").notNull().default(0),
    lastPlyAt: integer("last_ply_at").notNull(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [index("games_resolved_at").on(table.resolvedAt)],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id),
    player: text("player")
      .notNull()
      .references(() => players.address),
    side: text("side", { enum: ["white", "black"] }).notNull(),
    demo: integer("demo", { mode: "boolean" }).notNull().default(false),
    stakeMicrousdc: integer("stake_microusdc").notNull(),
    status: text("status", { enum: ["open", "moved", "expired"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at").notNull(),
    deadline: integer("deadline").notNull(),
    movedAt: integer("moved_at"),
    movedPly: integer("moved_ply"),
    moveUci: text("move_uci"),
    moveSan: text("move_san"),
    fenBefore: text("fen_before"),
    fenAfter: text("fen_after"),
    nudgeDueAt: integer("nudge_due_at"),
    nudgeSentAt: integer("nudge_sent_at"),
    expiringNotifiedAt: integer("expiring_notified_at"),
  },
  (table) => [
    uniqueIndex("claims_open_game")
      .on(table.gameId)
      .where(sql`status = 'open'`),
    uniqueIndex("claims_open_player")
      .on(table.player)
      .where(sql`status = 'open'`),
    index("claims_player_created").on(table.player, table.createdAt),
    index("claims_created_at").on(table.createdAt),
    index("claims_status_moved_at").on(table.status, table.movedAt),
  ],
);

export const stakeEntries = sqliteTable(
  "stake_entries",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id),
    claimId: text("claim_id")
      .notNull()
      .unique()
      .references(() => claims.id),
    player: text("player")
      .notNull()
      .references(() => players.address),
    side: text("side", { enum: ["white", "black"] }).notNull(),
    kind: text("kind", { enum: ["human", "agent"] }).notNull(),
    amount: integer("amount").notNull(),
    payTxid: text("pay_txid").notNull(),
    ply: integer("ply").notNull(),
    payoutAmount: integer("payout_amount"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("stake_entries_game").on(table.gameId),
    index("stake_entries_player").on(table.player),
    index("stake_entries_created_at").on(table.createdAt),
  ],
);

export const paymentIntents = sqliteTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id),
    player: text("player").notNull(),
    moveUci: text("move_uci").notNull(),
    amount: integer("amount").notNull(),
    clientTxid: text("client_txid").notNull().unique(),
    status: text("status", {
      enum: ["verified", "settling", "settled", "failed"],
    }).notNull(),
    lastValidRound: integer("last_valid_round"),
    settleTxid: text("settle_txid"),
    paymentResponseHeader: text("payment_response_header"),
    failureCode: text("failure_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("payment_intents_in_flight")
      .on(table.claimId)
      .where(sql`status IN ('verified', 'settling')`),
  ],
);

export const payoutBatches = sqliteTable("payout_batches", {
  id: text("id").primaryKey(),
  status: text("status", {
    enum: ["prepared", "submitted", "confirmed", "failed"],
  }).notNull(),
  payloadB64: text("payload_b64").notNull(),
  groupId: text("group_id").notNull(),
  lastValidRound: integer("last_valid_round").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const payoutJobs = sqliteTable(
  "payout_jobs",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id),
    recipient: text("recipient").notNull(),
    amount: integer("amount").notNull(),
    reason: text("reason", { enum: ["resolution", "refund"] }).notNull(),
    status: text("status", {
      enum: ["pending", "prepared", "submitted", "confirmed", "failed"],
    })
      .notNull()
      .default("pending"),
    batchId: text("batch_id").references(() => payoutBatches.id),
    txid: text("txid"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("payout_jobs_game_recipient").on(table.gameId, table.recipient),
    index("payout_jobs_status_created_at").on(table.status, table.createdAt),
  ],
);

export const bonuses = sqliteTable(
  "bonuses",
  {
    player: text("player")
      .primaryKey()
      .references(() => players.address),
    status: text("status", {
      enum: ["claimed", "opted_in", "funded", "expired"],
    })
      .notNull()
      .default("claimed"),
    algoAmount: integer("algo_amount").notNull(),
    usdcAmount: integer("usdc_amount").notNull(),
    claimIp: text("claim_ip").notNull(),
    algoTxid: text("algo_txid"),
    usdcTxid: text("usdc_txid"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    claimedAt: integer("claimed_at").notNull(),
    optInDeadlineAt: integer("opt_in_deadline_at").notNull(),
    algoSkippedAt: integer("algo_skipped_at"),
    optedInAt: integer("opted_in_at"),
    fundedAt: integer("funded_at"),
  },
  (table) => [index("bonuses_claimed_at").on(table.claimedAt)],
);

export const fundingJobs = sqliteTable(
  "funding_jobs",
  {
    id: text("id").primaryKey(),
    player: text("player")
      .notNull()
      .references(() => players.address),
    leg: text("leg", { enum: ["algo", "usdc"] }).notNull(),
    amount: integer("amount").notNull(),
    status: text("status", {
      enum: ["pending", "prepared", "submitted", "confirmed", "failed"],
    })
      .notNull()
      .default("pending"),
    payloadB64: text("payload_b64"),
    txid: text("txid"),
    lastValidRound: integer("last_valid_round"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("funding_jobs_player_leg").on(table.player, table.leg),
  ],
);

export const ledger = sqliteTable(
  "ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    account: text("account").notNull(),
    deltaMicrousdc: integer("delta_microusdc").notNull(),
    refType: text("ref_type", {
      enum: [
        "opening",
        "adjustment",
        "stake",
        "payout",
        "fee",
        "dust",
        "surplus",
        "bonus",
      ],
    }).notNull(),
    refId: text("ref_id").notNull(),
    txid: text("txid"),
  },
  (table) => [index("ledger_ts").on(table.ts)],
);

export const ledgerBalances = sqliteTable("ledger_balances", {
  account: text("account").primaryKey(),
  balanceMicrousdc: integer("balance_microusdc").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(),
    player: text("player"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [index("events_ts").on(table.ts)],
);

export const authNonces = sqliteTable("auth_nonces", {
  address: text("address").primaryKey(),
  nonce: text("nonce").notNull(),
  arc60DataB64: text("arc60_data_b64").notNull(),
  fallbackUnsignedB64: text("fallback_unsigned_b64").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const revokedJti = sqliteTable("revoked_jti", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});

export const nicknameChanges = sqliteTable("nickname_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  player: text("player")
    .notNull()
    .references(() => players.address),
  changedAt: integer("changed_at").notNull(),
});

export const pointAwards = sqliteTable(
  "point_awards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    player: text("player")
      .notNull()
      .references(() => players.address),
    amount: integer("amount").notNull(),
    reason: text("reason", { enum: ["move", "win", "referral"] }).notNull(),
    // Claim id for move/win (distinct per claim); referred player's address for
    // referral (F15). The UNIQUE key makes every award idempotent, so replayed
    // resolutions and backfills never double-count (players.points is a cache).
    refId: text("ref_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("point_awards_player_reason_ref").on(
      table.player,
      table.reason,
      table.refId,
    ),
  ],
);

export const configOverrides = sqliteTable("config_overrides", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  payloadJson: text("payload_json").notNull(),
});

export const errorLog = sqliteTable("error_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  level: text("level").notNull(),
  code: text("code").notNull(),
  requestId: text("request_id"),
  contextJson: text("context_json").notNull(),
});

export const systemState = sqliteTable(
  "system_state",
  {
    id: integer("id").primaryKey(),
    railKind: text("rail_kind", { enum: ["mock", "avm"] }).notNull(),
    caip2: text("caip2").notNull(),
    usdcAsset: text("usdc_asset").notNull(),
    treasuryAddress: text("treasury_address").notNull(),
    pauseCausesJson: text("pause_causes_json").notNull().default("[]"),
    banner: text("banner"),
    configRevision: integer("config_revision").notNull().default(0),
    lastReconcileAt: integer("last_reconcile_at"),
    lastReconcileJson: text("last_reconcile_json"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("system_state_singleton", sql`${table.id} = 1`)],
);
