import { expect, it } from "vitest";
import packageJson from "../package.json";

it("keeps core runtime dependencies limited to chess.js and zod", () => {
  expect(Object.keys(packageJson.dependencies).sort()).toEqual([
    "chess.js",
    "zod",
  ]);
});
