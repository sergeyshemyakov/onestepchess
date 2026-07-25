import type { Rng } from "@onestepchess/core";
import { and, ne, sql } from "drizzle-orm";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";
import { generateUniqueName } from "../names.js";

export const NICKNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;

export function nicknameTaken(
  db: Db,
  nickname: string,
  exceptAddress?: string,
): boolean {
  const sameNickname = sql`${schema.players.nickname} = ${nickname} COLLATE NOCASE`;
  const condition =
    exceptAddress === undefined
      ? sameNickname
      : and(sameNickname, ne(schema.players.address, exceptAddress));
  return (
    db
      .select({ address: schema.players.address })
      .from(schema.players)
      .where(condition)
      .get() !== undefined
  );
}

export function freeNickname(db: Db, rng: Rng): string {
  return generateUniqueName(
    rng,
    (nickname) => nicknameTaken(db, nickname),
    "a nickname",
  );
}
