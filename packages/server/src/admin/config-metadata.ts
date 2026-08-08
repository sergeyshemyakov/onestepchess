import { type ServerConfig, serverConfigSchema } from "../config.js";

export type ConfigEffect = "immediate" | "new_claims" | "new_games" | "restart";

const CONFIG_DESCRIPTIONS = {
  HUMAN_STAKE: "Amount charged per human move, in micro-USDC.",
  AGENT_STAKE: "Amount charged per agent move, in micro-USDC.",
  ENDSPIEL_STAKE: "Amount charged per endspiel move, in micro-USDC.",
  DRAW_FEE: "Amount withheld from each draw payout, in micro-USDC.",
  PROTOCOL_FEE_BPS: "Protocol fee deducted from payouts, in basis points.",
  HUMAN_TARGET_MULT: "Target human share of normal-phase moves.",
  ENDSPIEL_PIECES: "Piece count that can trigger the agent-only endspiel.",
  REPETITION_WIN_MARGIN:
    "Material-point lead required to win on threefold repetition.",
  MAX_PLIES: "Maximum plies before the game resolves automatically.",
  MIN_PLY_INTERVAL_SECONDS: "Minimum delay between normal-phase moves.",
  COOLDOWN_PLIES: "Plies before a player can rejoin the same game.",
  CLAIM_TTL_HUMAN: "Seconds a human has to submit a claimed move.",
  CLAIM_TTL_AGENT: "Seconds an agent has to submit a claimed move.",
  CLAIM_TTL_ENDSPIEL: "Seconds an agent has to submit an endspiel move.",
  QUOTA_HUMAN: "Staked human claims allowed per rolling hour.",
  QUOTA_AGENT: "Agent claims allowed per rolling hour.",
  QUOTA_DEMO: "Demo claims allowed per rolling hour.",
  GUEST_CLAIM_ALLOWANCE: "Lifetime demo claims allowed before login.",
  GAME_POOL_TARGET: "Number of live games the pool keeps available.",
  STALL_ABORT_HOURS: "Hours without a move before a game is aborted.",
  TIMER_REVEAL_SECONDS: "Seconds remaining when the numeric timer appears.",
  NEXT_GAME_NUDGE_SECONDS: "Delay before suggesting another game.",
  PAGE_SIZE_ACTIVE: "Active-game rows returned per page.",
  PAGE_SIZE_FINISHED: "Finished-game rows returned per page.",
  NONCE_TTL_SECONDS: "Seconds an authentication challenge remains valid.",
  JWT_TTL_HOURS: "Hours a signed-in session remains valid.",
  NICKNAME_CHANGES_PER_DAY: "Nickname changes allowed per UTC day.",
  ABANDON_THRESHOLD: "Expired claims before temporary deprioritization.",
  DEPRIORITIZE_HOURS: "Hours an abandoning player remains deprioritized.",
  PAYMENT_RECOVERY_TIMEOUT_SECONDS:
    "Seconds before an uncertain payment is recovered.",
  RATE_LIMIT_AUTH_PER_IP_MIN: "Authentication requests allowed per IP minute.",
  RATE_LIMIT_CLAIMS_PER_IP_MIN: "Claim requests allowed per IP minute.",
  HUMAN_BOARD_RESERVE_PERCENT:
    "Minimum percentage of live boards kept free for human claims.",
  SSE_HEARTBEAT_SECONDS: "Seconds between live-stream heartbeats.",
  SSE_MAX_CONNECTIONS_PER_PLAYER: "Maximum concurrent live streams per player.",
  EVENTS_RETENTION_DAYS: "Days live events remain available for replay.",
  ADMIN_CACHE_TTL_SECONDS: "Seconds admin overview responses remain cached.",
  PAYOUT_BATCH_MAX: "Maximum payout transfers in one batch.",
  PAYOUT_MAX_ATTEMPTS: "Maximum attempts before a payout remains failed.",
  RECONCILE_INTERVAL_MINUTES: "Minutes between treasury reconciliations.",
  BACKUP_HOUR_UTC: "UTC hour when the daily database backup runs.",
  BACKUP_RETENTION_DAYS: "Days completed database backups are retained.",
  TREASURY_CAP_MICROUSDC: "Maximum treasury exposure, in micro-USDC.",
  TREASURY_MIN_ALGO_MICRO: "Minimum treasury gas reserve, in micro-ALGO.",
  ALERT_DEDUPE_SECONDS: "Seconds duplicate operational alerts are suppressed.",
  TURNSTILE_SITE_KEY: "Public Cloudflare Turnstile site key.",
  GUEST_TOKEN_TTL_DAYS: "Days a guest identity token remains valid.",
  BONUS_ENABLED: "Whether new starter-stake claims are available.",
  BONUS_ALGO_MICRO: "Starter-stake ALGO amount, in micro-ALGO.",
  BONUS_USDC_MICRO: "Starter-stake USDC amount, in micro-USDC.",
  BONUS_DAILY_CAP: "Starter-stake claims allowed per UTC day.",
  BONUS_MAX_ATTEMPTS: "Maximum attempts for each starter-stake transfer.",
  BONUS_WATCH_INTERVAL_SECONDS: "Seconds between starter-stake funding checks.",
  POINTS_MOVE: "Points awarded for a settled staked move.",
  POINTS_WIN: "Extra points awarded for a win.",
  REFERRAL_QUALIFY_MOVES: "Staked moves needed to qualify a referral.",
  REFERRAL_POINTS: "Points awarded for a qualified referral.",
  PUBLIC_STATS_ENABLED: "Whether aggregate public stats appear on the site.",
  TOWER_BANNER_ENABLED:
    "Whether the Tower integration banner appears on the site.",
  CHAMP_BANNER_ENABLED:
    "Whether the championship promo banner appears on the site.",
  CARD_CACHE_MAX: "Maximum rendered share cards held in memory.",
  CAIP2: "CAIP-2 identifier for the active Algorand network.",
  USDC_ASA: "ASA identifier for the accepted native USDC asset.",
  ALGOD_URL: "Algod endpoint used for chain reads and submissions.",
  WALLETCONNECT_RELAY_URL: "WalletConnect relay allowed by the site policy.",
  INDEXER_URL: "Indexer endpoint used for confirmed-chain lookups.",
  FACILITATOR_URL: "x402 facilitator endpoint used for settlement.",
  EXPLORER_BASE_URL: "Explorer base URL used to build transaction links.",
} satisfies Record<keyof ServerConfig, string>;

const GAME_RULE_KEYS = new Set<keyof ServerConfig>([
  "HUMAN_STAKE",
  "AGENT_STAKE",
  "ENDSPIEL_STAKE",
  "DRAW_FEE",
  "PROTOCOL_FEE_BPS",
  "HUMAN_TARGET_MULT",
  "ENDSPIEL_PIECES",
  "REPETITION_WIN_MARGIN",
  "MAX_PLIES",
  "MIN_PLY_INTERVAL_SECONDS",
  "COOLDOWN_PLIES",
  "CLAIM_TTL_HUMAN",
  "CLAIM_TTL_AGENT",
  "CLAIM_TTL_ENDSPIEL",
  "STALL_ABORT_HOURS",
]);

const NEW_CLAIM_KEYS = new Set<keyof ServerConfig>([
  "QUOTA_HUMAN",
  "QUOTA_AGENT",
  "QUOTA_DEMO",
  "GUEST_CLAIM_ALLOWANCE",
  "HUMAN_BOARD_RESERVE_PERCENT",
]);

const RESTART_KEYS = new Set<keyof ServerConfig>([
  "CAIP2",
  "USDC_ASA",
  "ALGOD_URL",
  "INDEXER_URL",
  "FACILITATOR_URL",
  "EXPLORER_BASE_URL",
  "WALLETCONNECT_RELAY_URL",
  "TURNSTILE_SITE_KEY",
]);

const NON_EDITABLE_KEYS = new Set<keyof ServerConfig>([
  "CAIP2",
  "USDC_ASA",
  "TURNSTILE_SITE_KEY",
]);

export function configEffect(key: keyof ServerConfig): ConfigEffect {
  if (GAME_RULE_KEYS.has(key)) return "new_games";
  if (NEW_CLAIM_KEYS.has(key)) return "new_claims";
  if (RESTART_KEYS.has(key)) return "restart";
  return "immediate";
}

export function configDescription(key: keyof ServerConfig): string {
  return CONFIG_DESCRIPTIONS[key];
}

export function configEditable(key: keyof ServerConfig): boolean {
  return !NON_EDITABLE_KEYS.has(key);
}

export function isConfigKey(key: string): key is keyof ServerConfig {
  return Object.hasOwn(serverConfigSchema.parse({}), key);
}

export function validateConfigValue(
  current: ServerConfig,
  key: keyof ServerConfig,
  value: unknown,
): ServerConfig {
  return serverConfigSchema.parse({ ...current, [key]: value });
}
