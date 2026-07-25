import { type ServerConfig, serverConfigSchema } from "../config.js";

export type ConfigEffect = "immediate" | "new_claims" | "new_games" | "restart";

const GAME_RULE_KEYS = new Set<keyof ServerConfig>([
  "HUMAN_STAKE",
  "AGENT_STAKE",
  "ENDSPIEL_STAKE",
  "DRAW_FEE",
  "PROTOCOL_FEE_BPS",
  "HUMAN_TARGET_MULT",
  "ENDSPIEL_PLY",
  "ENDSPIEL_PIECES",
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
