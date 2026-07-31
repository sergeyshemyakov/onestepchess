import { readFile } from "node:fs/promises";
import {
  assertEvidenceIsSecretFree,
  mainnetMicroSmokeEvidenceSchema,
  testnetReleaseCandidateEvidenceSchema,
} from "./release4-evidence.js";

const path = process.argv[2];
if (path === undefined) {
  throw new Error("usage: verify-release4-evidence <evidence.json>");
}
const value: unknown = JSON.parse(await readFile(path, "utf8"));
assertEvidenceIsSecretFree(value);
const testnet = testnetReleaseCandidateEvidenceSchema.safeParse(value);
const mainnet = mainnetMicroSmokeEvidenceSchema.safeParse(value);
if (!testnet.success && !mainnet.success) {
  throw new Error("Release 4 evidence does not match the 4A or 4B contract");
}
process.stdout.write(
  `${testnet.success ? testnet.data.check : mainnet.data?.check}\n`,
);
