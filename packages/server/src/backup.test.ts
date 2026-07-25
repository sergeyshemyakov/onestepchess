import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { createLogger } from "./logger.js";

const trash: string[] = [];
afterEach(() => {
  for (const dir of trash.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

const logger = createLogger({ level: "silent" });

describe("SQLite backup (server spec §4)", () => {
  it("backup_schedule_retains_snapshots_and_alerts_without_pause", async () => {
    const dbDir = tempDir("osc-db-");
    const sqlite = new Database(join(dbDir, "osc.sqlite"));
    sqlite.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);");
    const backupDir = tempDir("osc-backups-");

    // Snapshots older than the retention window should be pruned.
    for (const date of [
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
      "2026-07-13",
      "2026-07-14",
    ]) {
      writeFileSync(join(backupDir, `osc-${date}.sqlite`), "old");
    }

    const now = Date.parse("2026-07-15T03:00:00Z");
    const result = await runBackup({
      sqlite,
      backupDir,
      retentionDays: 3,
      now: () => now,
      logger,
    });

    expect(result.ok).toBe(true);
    const finalPath = join(backupDir, "osc-2026-07-15.sqlite");
    expect(existsSync(finalPath)).toBe(true);

    // The snapshot is a complete, readable copy of the source database.
    const restored = new Database(finalPath, { readonly: true });
    expect(restored.prepare("SELECT count(*) AS c FROM t").get()).toEqual({
      c: 3,
    });
    restored.close();

    // Atomic publish leaves no temporary artifacts behind.
    expect(readdirSync(backupDir).some((f) => f.includes(".tmp"))).toBe(false);

    // Retention keeps only the newest N snapshots (today + the two most recent).
    const remaining = readdirSync(backupDir)
      .filter((f) => /^osc-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .sort();
    expect(remaining).toEqual([
      "osc-2026-07-13.sqlite",
      "osc-2026-07-14.sqlite",
      "osc-2026-07-15.sqlite",
    ]);

    sqlite.close();
  });

  it("reports a failed backup without pausing gameplay", async () => {
    const backupDir = tempDir("osc-backups-fail-");
    // A backup that rejects mid-copy must be reported, not thrown: the caller's
    // game loop keeps running (server spec §4).
    const failing = {
      backup: () => Promise.reject(new Error("disk full")),
    } as unknown as Database.Database;

    const result = await runBackup({
      sqlite: failing,
      backupDir,
      retentionDays: 3,
      now: () => Date.parse("2026-07-15T03:00:00Z"),
      logger,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.message).toContain("disk full");
    }
    // No partial snapshot or temp file is left on disk.
    expect(readdirSync(backupDir).some((f) => f.includes(".tmp"))).toBe(false);
    expect(existsSync(join(backupDir, "osc-2026-07-15.sqlite"))).toBe(false);
  });
});
