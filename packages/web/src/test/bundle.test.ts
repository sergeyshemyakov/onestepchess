import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #28/#32: the wallet subtree (use-wallet, wallet SDKs, algosdk) must never
// be statically reachable from the root bundle — it loads via dynamic
// import on first wallet intent (§5.6). This walks the static import graph
// from main.tsx.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PACKAGES = [
  /^algosdk/,
  /^@txnlab\//,
  /^@x402-avm\//,
  /^@perawallet\//,
];
const FORBIDDEN_FILES = ["wallet/provider"];

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type[\s{])[^;'"]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function staticImports(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = join(dirname(from), specifier)
    .replace(/\.jsx$/, ".tsx")
    .replace(/\.js$/, ".ts");
  for (const candidate of [base, base.replace(/\.ts$/, ".tsx")]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function walk(entry: string): {
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.endsWith(".css")) continue;
      const local = resolveLocal(file, specifier);
      if (local === null) packages.add(specifier);
      else queue.push(local);
    }
  }
  return { files, packages };
}

describe("root bundle static import graph (§5.6)", () => {
  const graph = walk(join(SRC, "main.tsx"));

  it("contains no wallet chunk (no use-wallet, wallet SDKs, or algosdk)", () => {
    for (const pkg of graph.packages) {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(pkg).not.toMatch(forbidden);
      }
    }
    for (const file of graph.files) {
      for (const forbidden of FORBIDDEN_FILES) {
        expect(file.replaceAll("\\", "/")).not.toContain(forbidden);
      }
    }
  });

  it("still reaches the app itself (sanity check on the walker)", () => {
    const names = [...graph.files].map((file) => file.replaceAll("\\", "/"));
    expect(names.some((name) => name.endsWith("App.tsx"))).toBe(true);
    expect(names.some((name) => name.endsWith("play/usePlayFlow.ts"))).toBe(
      true,
    );
    // the mock x402 module is wallet-free and may live in the root graph
    expect(names.some((name) => name.endsWith("wallet/x402.ts"))).toBe(true);
  });
});
