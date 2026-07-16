import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export type OpenedDatabase = {
  readonly sqlite: Database.Database;
  readonly db: Db;
};

// Works from both src/db (tsx) and dist/db (compiled) — the migrations
// folder is a package-level sibling of src and dist.
const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export function openDatabase(options: {
  readonly path: string;
}): OpenedDatabase {
  const sqlite = new Database(options.path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return { sqlite, db };
}

export { schema };
