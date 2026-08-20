export const X402_GLOBAL_CHALLENGE_TAG = "x402-global-challenge";

export const MOVE_RESOURCE_DESCRIPTION =
  "Submit one legal move to an active shared One Step Chess game and receive the committed move and Algorand settlement receipt.";

export const MOVE_RESOURCE_MIME_TYPE = "application/json";

export function moveBazaarExtensions(): Readonly<Record<string, unknown>> {
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "POST",
          bodyType: "json",
          body: { claimId: "clm_example", move: "e2e4" },
        },
        output: {
          type: "json",
          example: {
            status: "moved",
            move: { uci: "e2e4", san: "e4" },
            debitMicroUsdc: 1_000,
            txid: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            explorerUrl:
              "https://allo.info/tx/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            fenAfterYourMove:
              "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          },
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["POST"] },
              bodyType: { type: "string", enum: ["json"] },
              body: {
                type: "object",
                properties: {
                  claimId: { type: "string" },
                  move: { type: "string" },
                },
                required: ["claimId", "move"],
                additionalProperties: false,
              },
            },
            required: ["type", "method", "bodyType", "body"],
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: {
              type: { type: "string" },
              example: {
                type: "object",
                properties: {
                  status: { type: "string", const: "moved" },
                  move: {
                    type: "object",
                    properties: {
                      uci: { type: "string" },
                      san: { type: "string" },
                    },
                    required: ["uci", "san"],
                    additionalProperties: false,
                  },
                  debitMicroUsdc: {
                    type: "integer",
                    minimum: 0,
                  },
                  txid: { type: ["string", "null"] },
                  explorerUrl: {
                    type: ["string", "null"],
                    format: "uri",
                  },
                  fenAfterYourMove: { type: "string" },
                },
                required: [
                  "status",
                  "move",
                  "debitMicroUsdc",
                  "txid",
                  "explorerUrl",
                  "fenAfterYourMove",
                ],
                additionalProperties: false,
              },
            },
            required: ["type", "example"],
            additionalProperties: false,
          },
        },
        required: ["input", "output"],
        additionalProperties: false,
      },
    },
  };
}
