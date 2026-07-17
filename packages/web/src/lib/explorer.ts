/** §4.4 — one helper for every txid link. When a payload already carries an
 * `explorerUrl`, use that verbatim instead of building one. */
export function explorerTxUrl(explorerBaseUrl: string, txid: string): string {
  return `${explorerBaseUrl.replace(/\/$/, "")}/tx/${txid}`;
}
