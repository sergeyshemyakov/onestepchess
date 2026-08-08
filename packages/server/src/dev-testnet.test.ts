import { describe, expect, it } from "vitest";
import { createTestnetDevLaunch } from "./dev-testnet.js";

describe("testnet dev launcher", () => {
  it("passes_the_testnet_profile_to_the_recursive_pnpm_dev_process", () => {
    const launch = createTestnetDevLaunch({
      root: "/repo",
      runtimeEnv: { PATH: "/bin", PORT: "4123" },
      readProfile: (path) => {
        expect(path).toBe("/repo/.env.testnet");
        return [
          "RAIL=avm",
          "DB_PATH=osc-testnet.sqlite",
          "PORT=3000",
          "CAIP2=algorand:testnet",
          "USDC_ASA=10458941",
        ].join("\n");
      },
    });

    expect(launch).toMatchObject({
      command: "pnpm",
      args: ["-r", "--parallel", "run", "dev"],
      options: {
        cwd: "/repo",
        stdio: "inherit",
        env: {
          PATH: "/bin",
          RAIL: "avm",
          DB_PATH: "osc-testnet.sqlite",
          PORT: "4123",
          CAIP2: "algorand:testnet",
          USDC_ASA: "10458941",
        },
      },
    });
  });
});
