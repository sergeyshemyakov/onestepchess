import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = mkdtempSync(join(tmpdir(), "osc-package-smoke-"));

const packages = [
  {
    directory: join(root, "packages/agent-kit"),
    name: "@onestepchess/agent-kit",
    bin: ["osc-agent", "package/dist/cli.js"],
  },
  {
    directory: join(root, "packages/mcp"),
    name: "@onestepchess/mcp",
    bin: ["osc-mcp", "package/dist/stdio.js"],
  },
];

try {
  for (const item of packages) {
    const output = execFileSync(
      "pnpm",
      ["pack", "--pack-destination", destination],
      { cwd: item.directory, encoding: "utf8" },
    ).trim();
    const archive = output.split("\n").at(-1);
    if (archive === undefined)
      throw new Error(`pack produced no ${item.name} archive`);
    const entries = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    }).split("\n");
    for (const required of [
      "package/README.md",
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      item.bin[1],
    ]) {
      if (!entries.includes(required)) {
        throw new Error(`${item.name} tarball omitted ${required}`);
      }
    }
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    if (manifest.name !== item.name || manifest.exports?.["."] === undefined) {
      throw new Error(`${item.name} tarball manifest has invalid exports`);
    }
    if (
      manifest.bin?.[item.bin[0]] !==
      `./${item.bin[1].slice("package/".length)}`
    ) {
      throw new Error(
        `${item.name} tarball manifest has invalid ${item.bin[0]} bin`,
      );
    }
    const readme = execFileSync("tar", ["-xOf", archive, "package/README.md"], {
      encoding: "utf8",
    });
    if (!readme.includes(`npx ${item.name}`)) {
      throw new Error(`${item.name} README omits its published invocation`);
    }
  }
  process.stdout.write(
    "agent-kit and MCP package tarballs match documented bins and exports\n",
  );
} finally {
  rmSync(destination, { recursive: true, force: true });
}
