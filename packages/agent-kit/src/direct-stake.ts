/** The note a bot must put on its direct USDC stake transfer so the server
 * can bind the payment to the claim (spec 2026-09-21 §3.2, T7). The server
 * compares it byte-exact; this is the one definition both sides share. */
export function directStakeNote(claimId: string): Uint8Array {
  return new TextEncoder().encode(`osc:stake:${claimId}`);
}
