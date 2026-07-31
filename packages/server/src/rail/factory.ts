import type { PaymentRail } from "@onestepchess/core";
import { createAvmRail } from "@onestepchess/rail-avm";
import { createMockRail, type MockRailState } from "@onestepchess/rail-mock";
import type { ServerConfig, ServerEnv } from "../config.js";

export type PaymentRailFactoryOptions = {
  readonly env: ServerEnv;
  readonly config: ServerConfig;
  readonly storedBookMicroUsdc?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly mockState?: MockRailState;
};

/** Selects exactly one final rail from the already-validated profile. Secret
 * material is passed straight into rail-avm's signing closure and is never
 * copied onto the returned object. */
export function createPaymentRail(
  options: PaymentRailFactoryOptions,
): PaymentRail {
  if (options.env.RAIL === "mock") {
    const storedBook = options.storedBookMicroUsdc ?? 0;
    return createMockRail({
      ...(storedBook === 0
        ? {}
        : { initialTreasury: { usdcMicroUsdc: storedBook } }),
      ...(options.mockState === undefined ? {} : { state: options.mockState }),
    });
  }
  const mnemonic = options.env.TREASURY_MNEMONIC;
  if (mnemonic === undefined) {
    throw new Error("validated AVM profile is missing TREASURY_MNEMONIC");
  }
  return createAvmRail(
    {
      caip2: options.config.CAIP2,
      usdcAsaId: Number(options.config.USDC_ASA),
      algodUrl: options.config.ALGOD_URL,
      indexerUrl: options.config.INDEXER_URL,
      facilitatorUrl: options.config.FACILITATOR_URL,
      treasuryMnemonic: mnemonic,
    },
    options.fetch === undefined ? {} : { fetch: options.fetch },
  );
}
