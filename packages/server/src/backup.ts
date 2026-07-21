import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import type { Logger } from "./logger.js";

const BACKUP_RE = /^osc-\d{4}-\d{2}-\d{2}\.sqlite$/;
const DEFAULT_PAGES_PER_STEP = 200;

export type BackupResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: Error };

export type BackupDeps = {
  readonly sqlite: Pick<BetterSqlite3.Database, "backup">;
  readonly backupDir: string;
  readonly retentionDays: number;
  readonly now: () => number;
  readonly logger: Logger;
  /** Pages copied per pacing cycle; keeps the copy off the write path. */
  readonly pagesPerStep?: number;
};

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Milliseconds until the next `hourUtc:00:00` UTC boundary from `now`. */
export function nextBackupDelayMs(now: number, hourUtc: number): number {
  const at = new Date(now);
  const next = new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

/** One incremental, paced online snapshot of the live database (server spec
 * §4): copied to a temp name, atomically renamed to the UTC-date filename, then
 * pruned to `retentionDays`. A failure is reported, never thrown — a broken
 * backup alerts but must not pause gameplay. */
export async function runBackup(deps: BackupDeps): Promise<BackupResult> {
  const finalName = `osc-${utcDate(deps.now())}.sqlite`;
  const finalPath = join(deps.backupDir, finalName);
  const tmpPath = join(deps.backupDir, `.${finalName}.${process.pid}.tmp`);
  try {
    mkdirSync(deps.backupDir, { recursive: true });
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    await deps.sqlite.backup(tmpPath, {
      progress: () => deps.pagesPerStep ?? DEFAULT_PAGES_PER_STEP,
    });
    // Atomic publish: readers never observe a half-written snapshot.
    renameSync(tmpPath, finalPath);
    pruneOldBackups(deps.backupDir, deps.retentionDays, deps.logger);
    deps.logger.info({ path: finalPath }, "backup complete");
    return { ok: true, path: finalPath };
  } catch (error) {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    const err = error instanceof Error ? error : new Error(String(error));
    deps.logger.error({ err }, "backup failed");
    return { ok: false, error: err };
  }
}

function pruneOldBackups(
  dir: string,
  retentionDays: number,
  logger: Logger,
): void {
  const snapshots = readdirSync(dir)
    .filter((name) => BACKUP_RE.test(name))
    .sort();
  const excess = snapshots.slice(
    0,
    Math.max(0, snapshots.length - retentionDays),
  );
  for (const name of excess) {
    rmSync(join(dir, name), { force: true });
    logger.info({ name }, "backup pruned");
  }
}
