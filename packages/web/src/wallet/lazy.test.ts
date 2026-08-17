import algosdk from "algosdk";
import { afterEach, expect, it, vi } from "vitest";
import { loadWalletModule, resetWalletModuleForTests } from "./lazy.js";

const runtime = globalThis as typeof globalThis & {
  global?: typeof globalThis;
};
const originalGlobal = runtime.global;

afterEach(() => {
  resetWalletModuleForTests();
  runtime.global = originalGlobal;
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("wallet intent installs the browser global alias before loading Pera", async () => {
  Reflect.deleteProperty(runtime, "global");

  await expect(loadWalletModule("mock:local")).resolves.toBeDefined();
  expect(runtime.global).toBe(globalThis);
});

it("wallet module load resumes the persisted session before resolving", async () => {
  const account = algosdk.generateAccount();
  vi.stubGlobal(
    "prompt",
    vi.fn(() => algosdk.secretKeyToMnemonic(account.sk)),
  );
  const first = await loadWalletModule("mock:local");
  await first.connect("mnemonic");
  // A page reload drops the memoised module but keeps localStorage.
  resetWalletModuleForTests();

  const reloaded = await loadWalletModule("mock:local");

  expect(reloaded.current()?.address).toBe(account.addr.toString());
});
