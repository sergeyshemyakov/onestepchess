export type GenesisProfile = {
  readonly id: string;
  readonly hashB64: string;
};

const MAINNET: GenesisProfile = {
  id: "mainnet-v1.0",
  hashB64: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
};

const TESTNET: GenesisProfile = {
  id: "testnet-v1.0",
  hashB64: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
};

/** The auth fallback txn's genesis derives from the configured CAIP-2
 * (CA-R9). `mock:local` uses the mainnet profile so real wallets render the
 * never-submitted signing artifact consistently (§6.3). */
export function genesisForCaip2(caip2: string): GenesisProfile {
  if (caip2 === "mock:local") {
    return MAINNET;
  }
  if (caip2.startsWith("algorand:")) {
    const reference = caip2.slice("algorand:".length);
    if (reference.length > 0 && TESTNET.hashB64.startsWith(reference)) {
      return TESTNET;
    }
    if (reference.length > 0 && MAINNET.hashB64.startsWith(reference)) {
      return MAINNET;
    }
  }
  throw new Error(`unsupported CAIP-2 network: ${caip2}`);
}
