import { expect, type Page, test } from "@playwright/test";
import algosdk from "algosdk";

const player = {
  address: "PLAYERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  kind: "human",
  nickname: "night-owl",
  createdAt: "2026-07-01T00:00:00Z",
};

const profile = {
  ...player,
  stats: { moves: 24, wins: 12, draws: 3, losses: 9, winratePct: 50 },
  netPnlMicroUsdc: 0,
  quotas: {
    staked: { limit: 10, remaining: 8, resetsAt: null },
    demo: { limit: 10, remaining: 10, resetsAt: null },
  },
  deprioritizedUntil: null,
  points: 120,
  refCode: "gentle-rook-042",
  referrals: { joined: 2, qualified: 1 },
};

const finishedGame = {
  yourMoves: [{ uci: "g1f3", san: "Nf3", ply: 3 }],
  yourSide: "white",
  demo: false,
  stakeMicroUsdc: 10_000,
  thinkingTimeMs: 150_000,
  startedAt: "2026-07-19T10:00:00Z",
  gameId: "gm_release2",
  gameName: "crimson-rook-217",
  finalFen: "8/8/8/8/3k4/8/3K4/3Q4 b - - 0 61",
  result: "white",
  termination: "checkmate",
  payTxid: "STAKETX2",
  payoutMicroUsdc: 20_000,
  payoutTxid: "PAYOUTTX1",
  payoutStatus: "confirmed",
  statsCounted: true,
  finishedAt: "2026-07-19T11:00:00Z",
};

const replay = {
  gameId: finishedGame.gameId,
  name: finishedGame.gameName,
  result: "white",
  termination: "checkmate",
  endspielPly: null,
  createdAt: "2026-07-19T10:00:00Z",
  finishedAt: "2026-07-19T11:00:00Z",
  plies: [
    {
      ply: 1,
      side: "white",
      move: { uci: "e2e4", san: "e4" },
      fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      stakeMicroUsdc: 10_000,
      demo: false,
      author: {
        nickname: "night-owl",
        kind: "human",
        winratePct: 50,
        movesTotal: 24,
      },
    },
    {
      ply: 2,
      side: "black",
      move: { uci: "e7e5", san: "e5" },
      fenAfter: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      stakeMicroUsdc: 10_000,
      demo: false,
      author: {
        nickname: "quiet-bishop",
        kind: "human",
        winratePct: 52,
        movesTotal: 31,
      },
    },
    {
      ply: 3,
      side: "white",
      move: { uci: "g1f3", san: "Nf3" },
      fenAfter:
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
      stakeMicroUsdc: 10_000,
      demo: false,
      author: {
        nickname: "night-owl",
        kind: "human",
        winratePct: 50,
        movesTotal: 24,
      },
    },
  ],
  pgn: '[Event "One Step Chess"]\n\n1. e4 e5 2. Nf3 1-0\n',
};

async function mockFinishedSurfaces(page: Page) {
  await page.route("**/api/v1/my/games?status=finished*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [finishedGame],
        page: 1,
        pageCount: 1,
        total: 1,
      }),
    }),
  );
  await page.route(`**/api/v1/games/${finishedGame.gameId}/replay`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(replay),
    }),
  );
}

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
  await mockFinishedSurfaces(page);
  await page.reload();
  await page.getByTestId("finished-card").click();
  await expect(page.getByTestId("quick-view")).toBeVisible();
  await page.getByRole("link", { name: "full replay ▸" }).click();
  await expect(page.getByTestId("replay-page")).toBeVisible();
  await page.goto("/");
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

test("release2_mobile_snapshots_420_and_768", async ({
  browser,
  page,
}, testInfo) => {
  await page.route(/\/api\/v1\/my\/profile(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(profile),
    }),
  );
  await page.route("**/api/v1/claims/current", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: "NO_OPEN_CLAIM",
        hint: "no open claim",
        docs: "",
      }),
    }),
  );
  await page.route("**/api/v1/claims", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        claim: {
          claimId: `clm_mobile_${Date.now()}`,
          yourSide: "white",
          phase: "normal",
          demo: false,
          fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          legalMoves: [
            { uci: "e2e4", san: "e4" },
            { uci: "e2e3", san: "e3" },
          ],
          stakeMicroUsdc: 10_000,
          deadline: new Date(Date.now() + 600_000).toISOString(),
        },
      }),
    }),
  );
  await page.route("**/api/v1/my/games?status=ongoing*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], page: 1, pageCount: 0, total: 0 }),
    }),
  );
  await mockFinishedSurfaces(page);

  for (const width of [420, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const landingPage = await browser.newPage();
    await landingPage.setViewportSize({ width, height: 900 });
    await landingPage.route(/\/api\/v1\/my\/profile(?:\?.*)?$/, (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          error: "UNAUTHORIZED",
          hint: "login",
          docs: "",
        }),
      }),
    );
    await landingPage.goto("/");
    await landingPage.evaluate(() => localStorage.clear());
    await landingPage.reload();
    await expect(
      landingPage.getByRole("heading", { name: /ONLY ONE MOVE/ }),
    ).toBeVisible();
    await testInfo.attach(`landing-${width}`, {
      body: await landingPage.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await landingPage.close();
    const profileProbe = page.waitForResponse(/\/api\/v1\/my\/profile$/);
    await page.goto("/");
    expect((await profileProbe).status()).toBe(200);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: /▸ PLAY/ })).toBeVisible();
    await testInfo.attach(`hub-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByTitle(player.address).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await testInfo.attach(`wallet-popover-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "close" }).click();
    await page.getByRole("button", { name: /▸ PLAY/ }).click();
    await expect(page.getByText(/YOU PLAY WHITE/)).toBeVisible();
    await testInfo.attach(`focus-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await chooseE4(page);
    await testInfo.attach(`confirm-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.goto("/archive");
    await expect(page.getByTestId("finished-card")).toBeVisible();
    await testInfo.attach(`archive-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByTestId("finished-card").click();
    await expect(page.getByTestId("quick-view")).toBeVisible();
    await testInfo.attach(`quick-view-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByRole("link", { name: "full replay ▸" }).click();
    await expect(page.getByTestId("replay-page")).toBeVisible();
    await testInfo.attach(`replay-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});
