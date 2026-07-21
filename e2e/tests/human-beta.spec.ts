import { expect, type Page, test } from "@playwright/test";
import algosdk from "algosdk";

async function chooseE4(page: Page) {
  await expect(page.getByText(/YOU PLAY WHITE/)).toBeVisible();
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.getByText("FINAL MOVE?")).toBeVisible();
}

test("human_beta_guest_to_registered_mock_move", async ({ page }) => {
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
  await expect(page.getByText(/txid mocktx_/)).toBeVisible();
});
