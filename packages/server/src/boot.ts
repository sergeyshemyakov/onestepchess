import { eq } from "drizzle-orm";
import type { ServerConfig, ServerEnv } from "./config.js";
import type { Db } from "./db/open.js";
import { schema } from "./db/open.js";
import type { Logger } from "./logger.js";

function hasPersistedMoneyState(db: Db): boolean {
  return [
    schema.claims,
    schema.paymentIntents,
    schema.stakeEntries,
    schema.ledger,
    schema.payoutJobs,
    schema.payoutBatches,
    schema.bonuses,
    schema.fundingJobs,
  ].some((table) => db.select().from(table).limit(1).get() !== undefined);
}

export type InitializeSystemStateOptions = {
  readonly db: Db;
  readonly railKind: ServerEnv["RAIL"];
  readonly config: ServerConfig;
  readonly treasuryAddress: string;
  readonly banner: string | undefined;
  readonly now: number;
  readonly logger: Logger;
};

/** Pins the database to one rail/network/treasury identity. A mismatch is
 * reported and refused before recovery can touch persisted money state. */
export function initializeSystemState(
  options: InitializeSystemStateOptions,
): boolean {
  const identity = options.db.select().from(schema.systemState).get();
  if (identity === undefined) {
    options.db
      .insert(schema.systemState)
      .values({
        id: 1,
        railKind: options.railKind,
        caip2: options.config.CAIP2,
        usdcAsset: options.config.USDC_ASA,
        treasuryAddress: options.treasuryAddress,
        pauseCausesJson: "[]",
        banner: options.banner ?? null,
        updatedAt: options.now,
      })
      .run();
    return true;
  }

  if (
    identity.railKind !== options.railKind ||
    identity.caip2 !== options.config.CAIP2 ||
    identity.usdcAsset !== options.config.USDC_ASA ||
    identity.treasuryAddress !== options.treasuryAddress
  ) {
    if (!hasPersistedMoneyState(options.db)) {
      options.db
        .update(schema.systemState)
        .set({
          railKind: options.railKind,
          caip2: options.config.CAIP2,
          usdcAsset: options.config.USDC_ASA,
          treasuryAddress: options.treasuryAddress,
          banner: options.banner ?? identity.banner,
          updatedAt: options.now,
        })
        .where(eq(schema.systemState.id, 1))
        .run();
      return true;
    }
    options.logger.fatal(
      {
        stored: {
          railKind: identity.railKind,
          caip2: identity.caip2,
          usdcAsset: identity.usdcAsset,
        },
        configured: {
          railKind: options.railKind,
          caip2: options.config.CAIP2,
          usdcAsset: options.config.USDC_ASA,
        },
      },
      "rail identity mismatch — refusing to start (migration required)",
    );
    return false;
  }

  if (options.banner !== undefined && identity.banner !== options.banner) {
    options.db
      .update(schema.systemState)
      .set({ banner: options.banner, updatedAt: options.now })
      .where(eq(schema.systemState.id, 1))
      .run();
  }
  return true;
}

export function currentMode(db: Db): "running" | "paused" {
  const row = db
    .select({ pauseCausesJson: schema.systemState.pauseCausesJson })
    .from(schema.systemState)
    .get();
  const causes =
    row === undefined ? [] : (JSON.parse(row.pauseCausesJson) as string[]);
  return causes.length > 0 ? "paused" : "running";
}
