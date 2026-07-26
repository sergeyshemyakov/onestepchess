import { readdirSync, readFileSync, statSync } from "node:fs";
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
const FORBIDDEN_FILES = [
  "wallet/provider",
  "ContextualApp",
  "routes/Landing",
  "routes/Hub",
  "routes/Start",
  "routes/Archive",
  "routes/Championship",
  "routes/Replay",
];

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

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) {
      return [];
    }
    return [path];
  });
}

describe("root bundle static import graph (§5.6)", () => {
  const graph = walk(join(SRC, "main.tsx"));

  it("public_routes_exclude_wallet_and_admin_chunks", () => {
    for (const pkg of graph.packages) {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        expect(pkg).not.toMatch(forbidden);
      }
    }
    for (const file of graph.files) {
      for (const forbidden of FORBIDDEN_FILES) {
        expect(file.replaceAll("\\", "/")).not.toContain(forbidden);
      }
      expect(file.replaceAll("\\", "/")).not.toContain("/admin/");
    }

    for (const entry of [
      join(SRC, "routes/Landing.tsx"),
      join(SRC, "routes/Replay.tsx"),
    ]) {
      const publicGraph = walk(entry);
      for (const pkg of publicGraph.packages) {
        for (const forbidden of FORBIDDEN_PACKAGES) {
          expect(pkg).not.toMatch(forbidden);
        }
      }
      expect(
        [...publicGraph.files].some((file) =>
          file.replaceAll("\\", "/").includes("/admin/"),
        ),
      ).toBe(false);
    }
    const replayGraph = walk(join(SRC, "routes/Replay.tsx"));
    for (const file of replayGraph.files) {
      const normalized = file.replaceAll("\\", "/");
      expect(normalized).not.toContain("/live/LiveContext");
      expect(normalized).not.toContain("/auth/SessionContext");
      expect(normalized).not.toContain("/ContextualApp");
    }
  });

  it("public_components_never_reference_admin_route_or_chunk", () => {
    const references = sourceFiles(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("/admin"),
    );
    const violations = references.filter((file) => {
      const normalized = file.replaceAll("\\", "/");
      return (
        !normalized.endsWith("/ContextualApp.tsx") &&
        !normalized.includes("/admin/")
      );
    });
    expect(violations).toEqual([]);

    for (const entry of [
      join(SRC, "main.tsx"),
      join(SRC, "routes/Landing.tsx"),
      join(SRC, "routes/Replay.tsx"),
      join(SRC, "routes/Start.tsx"),
    ]) {
      const publicGraph = walk(entry);
      expect(
        [...publicGraph.files].filter((file) =>
          file.replaceAll("\\", "/").includes("/admin/"),
        ),
      ).toEqual([]);
    }
  });

  it("still reaches the app itself (sanity check on the walker)", () => {
    const names = [...graph.files].map((file) => file.replaceAll("\\", "/"));
    expect(names.some((name) => name.endsWith("App.tsx"))).toBe(true);
    // Routes cross a dynamic boundary; staked confirmation crosses another
    // one inside the play chunk only on demand.
    expect(names.some((name) => name.endsWith("play/usePlayFlow.ts"))).toBe(
      false,
    );
    expect(names.some((name) => name.endsWith("wallet/x402.ts"))).toBe(false);
  });
});
