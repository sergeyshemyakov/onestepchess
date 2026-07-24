import { afterEach, expect, it } from "vitest";
import { loadWalletModule, resetWalletModuleForTests } from "./lazy.js";

const runtime = globalThis as typeof globalThis & {
  global?: typeof globalThis;
};
const originalGlobal = runtime.global;

afterEach(() => {
  resetWalletModuleForTests();
  runtime.global = originalGlobal;
});

it("wallet intent installs the browser global alias before loading Pera", async () => {
  Reflect.deleteProperty(runtime, "global");

  await expect(loadWalletModule()).resolves.toBeDefined();
  expect(runtime.global).toBe(globalThis);
});
