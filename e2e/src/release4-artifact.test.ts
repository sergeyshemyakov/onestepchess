import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("release4_agent_artifact_is_immutable_checksummed_and_contains_only_dist_public_files", () => {
  if (!existsSync(join(root, "packages/agent-kit/dist/index.js"))) {
    execFileSync("pnpm", ["exec", "tsc", "-b", "packages/agent-kit"], {
      cwd: root,
      stdio: "pipe",
    });
  }
  const destination = mkdtempSync(join(tmpdir(), "osc-agent-release4-"));
  directories.push(destination);
  const result = JSON.parse(
    execFileSync("node", ["scripts/release4-agent-artifact.mjs", destination], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1) ?? "{}",
  ) as {
    readonly archive: string;
    readonly checksumPath: string;
    readonly provenancePath: string;
    readonly sha256: string;
  };
  const digest = createHash("sha256")
    .update(readFileSync(result.archive))
    .digest("hex");
  expect(result.sha256).toBe(digest);
  expect(readFileSync(result.checksumPath, "utf8")).toContain(digest);
  expect(JSON.parse(readFileSync(result.provenancePath, "utf8"))).toMatchObject(
    {
      package: "@onestepchess/agent-kit",
      version: "0.2.1",
      sha256: digest,
    },
  );
  const entries = execFileSync("tar", ["-tzf", result.archive], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  expect(entries).toContain("package/dist/index.js");
  expect(entries).toContain("package/dist/index.d.ts");
  expect(entries).toContain("package/dist/cli.js");
  expect(
    entries.every(
      (entry) =>
        entry === "package/package.json" ||
        entry === "package/README.md" ||
        entry === "package/LICENSE" ||
        entry.startsWith("package/dist/"),
    ),
  ).toBe(true);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", result.archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  expect(manifest).toMatchObject({
    name: "@onestepchess/agent-kit",
    version: "0.2.1",
    bin: { "osc-agent": "./dist/cli.js" },
  });
  expect(JSON.stringify(manifest)).not.toContain("workspace:");
  expect(Object.keys(manifest.dependencies)).not.toContain(
    "@onestepchess/server",
  );
});
