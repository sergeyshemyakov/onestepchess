import { expect, test } from "@playwright/test";

// Placeholder until the server card lands: e2e specs need a running app,
// so this suite is skipped and is never part of the root unit-test run.
test.skip("app serves the SPA shell", async ({ page }) => {
  await page.goto("http://localhost:3000/");
  await expect(page.locator("#root")).toBeAttached();
});
