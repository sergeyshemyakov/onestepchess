import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    command: "pnpm --dir .. dev",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DB_PATH: ":memory:",
      JWT_SECRET: "playwright-fixture-secret-0123456789",
      PUBLIC_BASE_URL: "http://localhost:5173",
    },
  },
});
