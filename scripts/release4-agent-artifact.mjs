import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages/agent-kit");
const manifest = JSON.parse(
  readFileSync(join(packageDirectory, "package.json"), "utf8"),
);
const destinationArgument = process.argv[2];
if (destinationArgument === undefined) {
  throw new Error(
    "usage: pnpm release4:agent-artifact -- <fresh-destination-directory>",
  );
}
const destination = resolve(destinationArgument);
if (existsSync(destination)) {
  if (readdirSync(destination).length > 0) {
    throw new Error("release artifact destination must be fresh and empty");
  }
} else {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
}
if (!existsSync(join(packageDirectory, "dist/index.js"))) {
  throw new Error("agent-kit dist is missing; run pnpm build first");
}

const output = execFileSync(
  "pnpm",
  ["pack", "--pack-destination", destination],
  { cwd: packageDirectory, encoding: "utf8" },
).trim();
const archive = output.split("\n").at(-1);
if (archive === undefined || !existsSync(archive)) {
  throw new Error("pnpm pack did not produce an agent-kit archive");
}
const entries = execFileSync("tar", ["-tzf", archive], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
for (const entry of entries) {
  if (
    entry !== "package/package.json" &&
    entry !== "package/README.md" &&
    entry !== "package/LICENSE" &&
    !entry.startsWith("package/dist/")
  ) {
    throw new Error(`agent-kit artifact contains non-public file ${entry}`);
  }
}
const packedManifest = JSON.parse(
  execFileSync("tar", ["-xOf", archive, "package/package.json"], {
    encoding: "utf8",
  }),
);
const dependencyValues = Object.values(packedManifest.dependencies ?? {});
if (
  packedManifest.name !== "@onestepchess/agent-kit" ||
  packedManifest.version !== manifest.version ||
  packedManifest.bin?.["osc-agent"] !== "./dist/cli.js" ||
  packedManifest.exports?.["."]?.default !== "./dist/index.js" ||
  dependencyValues.some(
    (value) => typeof value === "string" && value.startsWith("workspace:"),
  )
) {
  throw new Error("agent-kit artifact manifest is not release-safe");
}

const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const archiveName = basename(archive);
const checksumPath = join(destination, `${archiveName}.sha256`);
const provenancePath = join(destination, `${archiveName}.provenance.json`);
for (const path of [checksumPath, provenancePath]) {
  const descriptor = openSync(path, "wx", 0o600);
  writeFileSync(
    descriptor,
    path === checksumPath
      ? `${sha256}  ${archiveName}\n`
      : `${JSON.stringify(
          {
            package: packedManifest.name,
            version: packedManifest.version,
            archive: archiveName,
            sha256,
            source: "https://github.com/sergeyshemyakov/onestepchess",
            build: "pnpm build && pnpm release4:agent-artifact -- <fresh-dir>",
            node: process.version,
          },
          null,
          2,
        )}\n`,
    { encoding: "utf8" },
  );
  closeSync(descriptor);
}
process.stdout.write(
  `${JSON.stringify({ archive, checksumPath, provenancePath, sha256 })}\n`,
);
