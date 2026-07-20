import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db/open.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, "../node_modules/.bin/tsx");
const entry = join(here, "index.ts");
const children: ChildProcess[] = [];

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

    // A pre-existing Release-1 database on the persistent volume: opening it
    // once runs the full migration chain, then we boot the server against it.
    const seeded = openDatabase({ path: dbPath });
    seeded.sqlite.close();
    expect(existsSync(dbPath)).toBe(true);

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
