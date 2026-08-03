import { readFile } from "node:fs/promises";
import {
  assertRelease4MayEnable,
  assertRelease4PromotionRecordIsSecretFree,
  release4PromotionManifestSchema,
} from "./release4-promotion.js";

const requireApproved = process.argv.includes("--require-approved");
const paths = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--"));
const path = paths[0];
if (path === undefined || paths.length !== 1) {
  throw new Error(
    "usage: verify-release4-promotion <promotion-manifest.json> [--require-approved]",
  );
}

const value: unknown = JSON.parse(await readFile(path, "utf8"));
assertRelease4PromotionRecordIsSecretFree(value);
const manifest = requireApproved
  ? assertRelease4MayEnable(value)
  : release4PromotionManifestSchema.parse(value);
process.stdout.write(
  `${JSON.stringify({
    release: manifest.release,
    sourceCommit: manifest.deployment.sourceCommit,
    imageDigest: manifest.artifact.imageDigest,
    decision: manifest.enablement.decision,
    publicTraffic: manifest.enablement.publicTraffic,
  })}\n`,
);
