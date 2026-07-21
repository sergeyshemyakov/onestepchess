import { expect, type Page, test } from "@playwright/test";
import algosdk from "algosdk";

async function chooseE4(page: Page) {
  await expect(page.getByText(/YOU PLAY WHITE/)).toBeVisible();
  const playSurface = page.getByTestId("play-surface");
  await playSurface.locator('[data-square="e2"]').click();
  await playSurface.locator('[data-square="e4"]').click();
  await expect(page.getByText("FINAL MOVE?")).toBeVisible();
}

test("release2_human_happy_path", async ({ page }) => {
  const account = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
  page.on("dialog", (dialog) => dialog.accept(mnemonic));

  await page.goto("/");
  await page.getByRole("button", { name: /PLAY A DEMO GAME/ }).click();
  await chooseE4(page);
  await page.getByRole("button", { name: /Y — make it so/ }).click();
  await expect(
    page.getByText(/connect an Algorand wallet to see how it ends/),
  ).toBeVisible();

  await page.getByRole("button", { name: "I have a wallet" }).click();
  await page.getByRole("button", { name: /dev wallet \(mnemonic\)/ }).click();
  await expect(page.getByRole("dialog", { name: "register" })).toBeVisible();
  await page.getByRole("button", { name: /▸ register/ }).click();
  await expect(page.getByRole("button", { name: /▸ PLAY/ })).toBeVisible();
  await expect(page.getByText(/your demo game is linked/)).toBeVisible();

  await page.getByRole("button", { name: /DEMO PLAY/ }).click();
  await chooseE4(page);
  await page.getByRole("button", { name: /Y — make it so/ }).click();
  await expect(page.getByText(/demo move committed/)).toBeVisible();
  await page.getByRole("button", { name: "close" }).click();

  await page.getByRole("button", { name: /▸ PLAY/ }).click();
  await chooseE4(page);
  await page.getByRole("button", { name: /sign & commit/ }).click();
  await expect(page.getByText(/stake .* debited/)).toBeVisible();
  await expect(page.getByRole("link", { name: /txid mocktx_/ })).toBeVisible();
  await page.getByRole("button", { name: "close" }).click();
  await page.getByRole("link", { name: "ARCHIVE" }).click();
  await expect(page.getByRole("heading", { name: "ACTIVE" })).toBeVisible();
  await page.getByRole("link", { name: "BOARDS" }).click();
  await page.getByTitle(account.addr.toString()).click();
  await page.getByRole("button", { name: "log out" }).click();
  await expect(
    page.getByRole("button", { name: /I HAVE AN ALGORAND WALLET/ }),
  ).toBeVisible();
});

test.describe("release2_human_edge_matrix", () => {
  test("reload and app-switch restore the chosen move", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /PLAY A DEMO GAME/ }).click();
    await chooseE4(page);
    await page.reload();
    await expect(page.getByText("FINAL MOVE?")).toBeVisible();
    await expect(page.getByText(/e2→e4/)).toBeVisible();
  });
});

test("release2_mobile_snapshots_420_and_768", async ({ page }, testInfo) => {
  for (const width of [420, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /ONLY ONE MOVE/ }),
    ).toBeVisible();
    await testInfo.attach(`landing-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.goto("/start");
    await expect(
      page.getByRole("heading", { name: "GET SET UP" }),
    ).toBeVisible();
    await testInfo.attach(`start-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});
