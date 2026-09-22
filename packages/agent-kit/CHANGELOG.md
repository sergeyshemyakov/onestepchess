# @onestepchess/agent-kit

## 0.4.0

Additive (pre-1.0 minor bump):

- `move(claimId, move, { stakeTxid })` pays a staked move with a direct
  on-chain USDC transfer the caller already confirmed, instead of the x402
  challenge flow. No `PAYMENT-SIGNATURE` is built, the signer, payment cache
  and budget are never touched. `200` requires `receipt.txid === stakeTxid`
  (`OscClientError("NETWORK_MISMATCH")` otherwise); `202` throws
  `OscApiError PAYMENT_PENDING` with `retryAfterSeconds`; `409 STAKE_RETAINED`
  throws an `OscApiError` exposing `stakeTxid`, `retainedMicroUsdc` and
  `claimStatus`.
- `directStakeNote(claimId)` returns the UTF-8 note bytes
  (`osc:stake:<claimId>`) the transfer must carry.
- `OSC_SERVER_ERROR_CODES` gains `STAKE_RETAINED`; `errorEnvelopeSchema` and
  `OscApiError` gain the three optional `STAKE_RETAINED` fields.

x402 behavior is unchanged.

## 0.3.0

Breaking (pre-1.0 minor bump):

- `move()` now posts to the stable resource `POST /api/v1/moves` with the
  claim id in the JSON body (`{ claimId, move }`). The per-claim route
  `POST /api/v1/claims/:id/move` is retired server-side and answers
  `410 ENDPOINT_RETIRED`; upgrade to keep playing. See
  `docs/spec/2026-08-20-stable-x402-move-resource.md` in the repository.
- `OSC_SERVER_ERROR_CODES` gains `ENDPOINT_RETIRED`.

All recovery behavior (resend-once, rebuild-once, 202 handling, status
polling) is unchanged.
