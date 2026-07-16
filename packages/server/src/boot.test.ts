import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

function collectOutput(child: ChildProcess): () => string {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
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
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

describe("boot", () => {
  it("boots with defaults on a clean checkout and serves /healthz", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-boot-"));
    const child = boot({ PORT: "0", DB_PATH: join(dir, "osc.sqlite") });
    const port = await waitForListeningPort(child);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", mode: "running" });
  }, 30_000);

  it("exits non-zero naming a bad knob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-boot-bad-"));
    const path = join(dir, "osc.config.json");
    writeFileSync(path, JSON.stringify({ HUMAN_STAKE: -5 }));
    const child = boot({
      PORT: "0",
      DB_PATH: join(dir, "osc.sqlite"),
      OSC_CONFIG_PATH: path,
    });
    const output = collectOutput(child);
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).not.toBe(0);
    expect(output()).toContain("HUMAN_STAKE");
  }, 30_000);

  it("exits non-zero naming an unknown key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osc-boot-unknown-"));
    const path = join(dir, "osc.config.json");
    writeFileSync(path, JSON.stringify({ NOT_A_KNOB: true }));
    const child = boot({
      PORT: "0",
      DB_PATH: join(dir, "osc.sqlite"),
      OSC_CONFIG_PATH: path,
    });
    const output = collectOutput(child);
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).not.toBe(0);
    expect(output()).toContain("NOT_A_KNOB");
  }, 30_000);
});
