#!/usr/bin/env bash
set -euo pipefail

image="onestepchess:release1-smoke"
suffix="$$"
container="osc-release3-migration-${suffix}"
volume="osc-release3-migration-${suffix}"
runtime_secret="release3-docker-runtime-secret-0123456789"
banner="mock staging — no real USDC"

cleanup() {
  docker rm --force "${container}" >/dev/null 2>&1 || true
  docker volume rm "${volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Reuse the canonical image/fresh-DB/restart/secret gate first. It retains the
# exact image that this Release 2 migration drill then boots.
./scripts/docker-smoke.sh

docker volume create "${volume}" >/dev/null
docker run --rm \
  --mount "source=${volume},target=/data" \
  --entrypoint node \
  "${image}" \
  --input-type=module --eval '
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    import Database from "/app/packages/server/node_modules/better-sqlite3/lib/index.js";

    const migrationDir = "/app/packages/server/drizzle";
    const journal = JSON.parse(readFileSync(`${migrationDir}/meta/_journal.json`, "utf8"));
    const database = new Database("/data/osc.sqlite");
    database.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 2)) {
      const sql = readFileSync(`${migrationDir}/${entry.tag}.sql`, "utf8");
      database.transaction(() => {
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) database.exec(statement);
        }
        database.prepare(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
        ).run(createHash("sha256").update(sql).digest("hex"), entry.when);
      })();
    }
    database.prepare(`
      INSERT INTO config_overrides (key, value_json, updated_at, updated_by)
      VALUES ("GAME_POOL_TARGET", "64", 1, "release2-operator")
    `).run();
    database.close();
  '

docker run --detach \
  --name "${container}" \
  --mount "source=${volume},target=/data" \
  --env "JWT_SECRET=${runtime_secret}" \
  --env "PUBLIC_BASE_URL=http://localhost:3000" \
  --env "SYSTEM_BANNER=${banner}" \
  "${image}" >/dev/null

for _ in $(seq 1 45); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" != "healthy" ]; then
  docker logs "${container}"
  exit 1
fi

docker exec "${container}" node --input-type=module --eval '
  import Database from "/app/packages/server/node_modules/better-sqlite3/lib/index.js";
  const database = new Database("/data/osc.sqlite", { readonly: true });
  const claimColumns = database.prepare("PRAGMA table_info(claims)").all().map((row) => row.name);
  if (!claimColumns.includes("fen_before")) throw new Error("Release 3 migration 0003 missing");
  const marker = database.prepare(
    "SELECT value_json, updated_by FROM config_overrides WHERE key = ?"
  ).get("GAME_POOL_TARGET");
  if (marker?.value_json !== "64" || marker.updated_by !== "release2-operator") {
    throw new Error("Release 2 operational state did not survive migration");
  }
  database.close();
'

docker stop "${container}" >/dev/null
docker start "${container}" >/dev/null
for _ in $(seq 1 45); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" != "healthy" ]; then
  docker logs "${container}"
  exit 1
fi

echo "release3_migrates_release2_db_and_recovers_persistent_restart: PASS"

docker exec "${container}" node --input-type=module --eval '
  import { readdirSync } from "node:fs";
  import Database from "/app/packages/server/node_modules/better-sqlite3/lib/index.js";
  import { runBackup } from "/app/packages/server/dist/backup.js";
  import { createLogger } from "/app/packages/server/dist/logger.js";

  const database = new Database("/data/osc.sqlite");
  const result = await runBackup({
    sqlite: database,
    backupDir: "/data/backups",
    retentionDays: 7,
    now: () => Date.UTC(2026, 6, 26, 3),
    logger: createLogger({ level: "silent" }),
  });
  database.close();
  if (!result.ok) throw result.error;
  const snapshot = readdirSync("/data/backups").find((file) => file.endsWith(".sqlite"));
  if (snapshot === undefined) throw new Error("backup snapshot missing");
  const restored = new Database(`/data/backups/${snapshot}`, { readonly: true });
  const marker = restored.prepare(
    "SELECT value_json, updated_by FROM config_overrides WHERE key = ?"
  ).get("GAME_POOL_TARGET");
  if (marker?.value_json !== "64" || marker.updated_by !== "release2-operator") {
    throw new Error("backup restore lost operational state");
  }
  const migrationCount = restored.prepare(
    "SELECT count(*) AS count FROM __drizzle_migrations"
  ).get().count;
  if (migrationCount < 4) throw new Error("backup restore lost migration history");
  restored.close();
'

echo "release3_backup_restore_preserves_history_and_ops_state: PASS"
echo "Release 3 Docker smoke passed: Release 2 migration, persistent restart, backup/restore, mock-only banner, and base image audits."
