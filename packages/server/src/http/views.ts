import type { schema } from "../db/open.js";

type Player = typeof schema.players.$inferSelect;

export function playerView(
  player: Pick<Player, "address" | "kind" | "nickname" | "createdAt">,
) {
  return {
    address: player.address,
    kind: player.kind,
    nickname: player.nickname,
    createdAt: new Date(player.createdAt).toISOString(),
  };
}
