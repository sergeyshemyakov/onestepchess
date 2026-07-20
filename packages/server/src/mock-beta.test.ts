import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { createLogger } from "./logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, "../node_modules/.bin/tsx");
const entry = join(here, "index.ts");
const children: ChildProcess[] = [];

function seedRelease1Database(volume: string, dbPath: string): void {
  const source = join(here, "../drizzle");
  const migrations = join(volume, "release1-migrations");
  mkdirSync(join(migrations, "meta"), { recursive: true });
  writeFileSync(
    join(migrations, "0000_init.sql"),
    readFileSync(join(source, "0000_init.sql")),
  );
  const journal = JSON.parse(
    readFileSync(join(source, "meta/_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  writeFileSync(
    join(migrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
  );
  const sqlite = new Database(dbPath);
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.close();
}

function boot(env: Record<string, string>): ChildProcess {
  const child = spawn(tsxBin, [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForListeningPort(child: ChildProcess): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error("server did not report listening")),
      15_000,
    );
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.includes("listening")) continue;
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === "listening" && typeof parsed.port === "number") {
            clearTimeout(timer);
            resolvePort(parsed.port);
          }
        } catch {
          // partial line; keep buffering
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`exited early with code ${code}`));
    });
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("mock-beta deployment profile (R2-04)", () => {
  it("mock_beta_boots_from_release1_database_with_persistent_paths", async () => {
    const volume = mkdtempSync(join(tmpdir(), "osc-beta-"));
    const dbPath = join(volume, "osc.sqlite");
    const backupDir = join(volume, "backups");

    // Build an actual Release-1 database by applying only migration 0000.
    seedRelease1Database(volume, dbPath);
    expect(existsSync(dbPath)).toBe(true);
    const release1 = new Database(dbPath, { readonly: true });
    const release1Columns = release1
      .pragma("table_info(players)")
      .map((column: { name: string }) => column.name);
    release1.close();
    expect(release1Columns).not.toContain("linked_address");

    const adminToken = "beta-admin-token-value";
    const banner = "mock beta — no real USDC";
    const child = boot({
      RAIL: "mock",
      PORT: "0",
      DB_PATH: dbPath,
      BACKUP_DIR: backupDir,
      PUBLIC_BASE_URL: "https://beta.onestepchess.example",
      ADMIN_TOKEN: adminToken,
      SYSTEM_BANNER: banner,
    });
    const port = await waitForListeningPort(child);
    const base = `http://127.0.0.1:${port}`;

    // Boots and stays healthy on the pre-migrated database.
    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toEqual({ status: "ok", mode: "running" });

    // No real rail: the mock network is advertised and the banner is honest.
    const meta = (await (await fetch(`${base}/api/v1/meta`)).json()) as {
      network: { caip2: string };
      status: { banner: string | null };
    };
    expect(meta.network.caip2).toBe("mock:local");
    expect(meta.status.banner).toBe(banner);

    // Boot applied the Release-2 migration to the persistent database.
    const migrated = new Database(dbPath, { readonly: true });
    const migratedColumns = migrated
      .pragma("table_info(players)")
      .map((column: { name: string }) => column.name);
    expect(migratedColumns).toContain("linked_address");

    // An online backup uses the configured persistent sibling while the game
    // server remains healthy.
    const backup = await runBackup({
      sqlite: migrated,
      backupDir,
      retentionDays: 7,
      now: () => Date.parse("2026-07-20T03:00:00Z"),
      logger: createLogger({ level: "silent" }),
    });
    migrated.close();
    expect(backup.ok).toBe(true);
    expect(existsSync(join(backupDir, "osc-2026-07-20.sqlite"))).toBe(true);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    // Discovery surfaces are live.
    const llms = await fetch(`${base}/llms.txt`);
    expect(llms.headers.get("content-type")).toContain("text/markdown");
    const openapi = (await (
      await fetch(`${base}/api/v1/openapi.json`)
    ).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(openapi.paths).length).toBeGreaterThan(0);

    // Metrics require the admin token.
    expect((await fetch(`${base}/api/v1/metrics`)).status).toBe(404);
    const metrics = await fetch(`${base}/api/v1/metrics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(metrics.status).toBe(200);
    expect((await metrics.json()).mode).toBe("running");

    // The database still lives at the configured persistent path.
    expect(existsSync(dbPath)).toBe(true);
  }, 30_000);
});
