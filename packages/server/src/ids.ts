import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Prefixed nanoid-style ids (`gm_`, `clm_`, `pi_`, `pj_`, `se_` — §4). */
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let suffix = "";
  for (const byte of bytes) {
    suffix += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}${suffix}`;
}
