# @onestepchess/agent-kit

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
