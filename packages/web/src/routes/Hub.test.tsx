import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostMoveResult } from "../api/client.js";
import type { MoveReceipt } from "../api/schemas.js";
import { writeClaimDraft } from "../lib/storage.js";
import {
  claimFixture,
  finishedDemoFixture,
  finishedStakedFixture,
  metaFixture,
  mockClient,
  ongoingItemFixture,
  Providers,
  playerFixture,
  replayFixture,
} from "../test/fixtures.jsx";
import { assertNoGameIdentity } from "../test/leak.js";
import { resetHeaderCacheForTests } from "../wallet/x402.js";
import { Hub } from "./Hub.jsx";
import { playCtaState } from "./hubCta.js";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetHeaderCacheForTests();
});

// Strings that would only appear if a payload regression delivered game
// identity to a pre-terminal surface (I7 defense in depth).
const IDENTITY_SEEDS = ["gm_secret777", "gentle-rook-042-secret", "ply 17"];

function renderHub(client = mockClient()) {
  const view = render(
    <Providers client={client}>
      <Hub client={client} meta={metaFixture} player={playerFixture} />
    </Providers>,
  );
  return { view, client };
}

const demoReceipt: MoveReceipt = {
  status: "moved",
  move: { uci: "e2e4", san: "e4" },
  debitMicroUsdc: 0,
  txid: null,
  explorerUrl: null,
  fenAfterYourMove:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};

async function playDemoToConfirm(client = mockClient()) {
  const { view } = renderHub(client);
  fireEvent.click(await screen.findByRole("button", { name: /DEMO PLAY/ }));
  await screen.findByText(/YOU PLAY WHITE/);
  fireEvent.click(
    view.container.querySelector('[data-square="e2"]') as Element,
  );
  await waitFor(() => {
    expect(view.container.querySelector(".dot")).not.toBeNull();
  });
  fireEvent.click(
    view.container.querySelector('[data-square="e4"]') as Element,
  );
  await screen.findByText("FINAL MOVE?");
  return { view, client };
}

describe("demo path end-to-end against a scripted server (#31)", () => {
  it("claim → move → receipt, demo confirm sends no PAYMENT-SIGNATURE and shows no wallet UI", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "claim" as const,
        claim: claimFixture({ demo: true, stakeMicroUsdc: 0 }),
        created: true,
      })),
      postMove: vi.fn(async () => ({ kind: "receipt", receipt: demoReceipt })),
    } as never);
    const { view } = await playDemoToConfirm(client);

    // Demo confirm renders Y/N — never a wallet box or signing CTA.
    expect(screen.queryByText(/sign & commit/)).toBeNull();
    expect(screen.getByText(/nothing staked, not counted/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
    await screen.findByTestId("receipt");
    expect(screen.getByTestId("receipt").textContent).toContain(
      "nothing staked · not counted",
    );
    // Network spy: the demo move was a plain POST with no payment header.
    const postMove = client.postMove as ReturnType<typeof vi.fn>;
    expect(postMove).toHaveBeenCalledTimes(1);
    expect(postMove.mock.calls[0]?.[2]).toBeUndefined();
    assertNoGameIdentity(view.container, IDENTITY_SEEDS);
  });

  it("aligns the demo confirmation pair and centers the lone receipt action", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "claim" as const,
        claim: claimFixture({ demo: true, stakeMicroUsdc: 0 }),
        created: true,
      })),
      postMove: vi.fn(async () => ({ kind: "receipt", receipt: demoReceipt })),
    } as never);
    await playDemoToConfirm(client);
    const yes = screen.getByRole("button", { name: /Y — make it so/ });
    const no = screen.getByRole("button", { name: /N — rethink/ });
    const pair = yes.closest(".modal-actions");
    expect(pair?.className).toContain("pair");
    expect(pair?.lastElementChild).toBe(no);

    fireEvent.click(yes);
    await screen.findByTestId("receipt");
    const close = screen.getByRole("button", { name: "close" });
    expect(close.closest(".modal-actions")?.className).toContain("single");
  });

  it("shows the full claim board loop beneath the final-move description", async () => {
    await playDemoToConfirm();
    const description = screen.getByText(/e2→e4/);
    const animation = screen.getByTestId("confirm-move-animation");
    expect(description.compareDocumentPosition(animation)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(animation.getAttribute("aria-label")).toBe(
      "move animation e2 to e4",
    );
    expect(animation.querySelectorAll("svg.pc")).toHaveLength(32);
    expect(animation.querySelector('[data-square="d8"] svg.pc')).not.toBeNull();
    expect(animation.querySelector('[data-square="d2"] svg.pc')).not.toBeNull();
    expect(animation.querySelector('[data-square="e2"] svg.pc')).toBeNull();
    expect(animation.querySelector(".boardloop-piece svg.pc")).not.toBeNull();
  });

  it("tells the player they will be notified when the moved game ends", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "claim" as const,
        claim: claimFixture({ demo: true, stakeMicroUsdc: 0 }),
        created: true,
      })),
      postMove: vi.fn(async () => ({ kind: "receipt", receipt: demoReceipt })),
    } as never);
    await playDemoToConfirm(client);
    fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
    await screen.findByText("> you will be notified when the game ends");
  });
});

describe("I7 leak tests (#31)", () => {
  it("FOCUS renders board + side + stake + timer and no game identity", async () => {
    // A regressed payload smuggling identity fields must not render (the
    // mock client bypasses zod stripping — worst case for the UI).
    const poisoned = {
      ...claimFixture(),
      gameId: "gm_secret777",
      gameName: "gentle-rook-042-secret",
      yourPly: "ply 17",
    };
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "claim" as const,
        claim: poisoned,
        created: true,
      })),
    } as never);
    const { view } = renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    assertNoGameIdentity(view.container, IDENTITY_SEEDS);
    expect(view.container.querySelector(".timer")).not.toBeNull();
    expect(screen.getByText("stake $0.01")).not.toBeNull();
  });

  it("puts the piece-and-target prompt inside the YOUR MOVE pane", async () => {
    const { view } = renderHub();
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    const prompt = await screen.findByText("> tap a piece, then a target");
    const panel = prompt.closest(".panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector("h3")?.textContent).toBe("YOUR MOVE");
    expect(view.container.querySelector(".boardwrap + .console")).toBeNull();
  });

  it("CONFIRM and staked RECEIPT render no game identity", async () => {
    const receipt: MoveReceipt = {
      ...demoReceipt,
      debitMicroUsdc: 10_000,
      txid: "mocktx_9",
      explorerUrl: "https://explorer.example/tx/mocktx_9",
    };
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "http://localhost:3000/api/v1/claims/clm_test1/move" },
        accepts: [
          {
            scheme: "mock",
            network: "mock:local",
            asset: "31566704",
            amount: "10000",
            payTo: "TREASURY",
          },
        ],
      }),
    );
    const script: PostMoveResult[] = [
      {
        kind: "payment_required",
        challengeHeader: challenge,
        envelope: { error: "PAYMENT_REQUIRED", hint: "", docs: "" },
      },
      { kind: "receipt", receipt },
    ];
    let call = 0;
    const client = mockClient({
      postMove: vi.fn(async () => script[Math.min(call++, script.length - 1)]),
    } as never);
    const { view } = renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    fireEvent.click(
      view.container.querySelector('[data-square="e2"]') as Element,
    );
    fireEvent.click(
      view.container.querySelector('[data-square="e4"]') as Element,
    );
    await screen.findByText("FINAL MOVE?");
    assertNoGameIdentity(view.container, IDENTITY_SEEDS);
    fireEvent.click(screen.getByRole("button", { name: /sign & commit/ }));
    await screen.findByTestId("receipt");
    expect(screen.getByTestId("receipt").textContent).toContain("mocktx_9");
    assertNoGameIdentity(view.container, IDENTITY_SEEDS);
  });
});

describe("edge states (#31, F-W10 rows)", () => {
  it("highlights the player's side while a board is ready", async () => {
    renderHub();
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));

    const side = await screen.findByText(/YOU PLAY WHITE/);
    expect(side.classList).toContain("ready-side");
  });

  it("NO_BOARDS manual retry has its own cooldown and does not reset the auto-retry timer", async () => {
    const createClaim = vi.fn(async () => ({
      kind: "none" as const,
      retryAfterSeconds: 8,
    }));
    const client = mockClient({ createClaim } as never);
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));

    const retry = await screen.findByRole("button", { name: /retry now/i });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry.classList).toContain("cooling");

    await waitFor(
      () => expect((retry as HTMLButtonElement).disabled).toBe(false),
      { timeout: 2_000 },
    );
    await screen.findByText("NO BOARDS FREE :: retrying in 00:04");
    fireEvent.click(retry);

    await waitFor(() => expect(createClaim).toHaveBeenCalledTimes(2));
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.queryByText("NO BOARDS FREE :: retrying in 00:05"),
    ).toBeNull();
    await waitFor(
      () => expect((retry as HTMLButtonElement).disabled).toBe(false),
      { timeout: 2_000 },
    );
  });

  it("NO_BOARDS centers its countdown and explains why a board may be unavailable", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "none" as const,
        retryAfterSeconds: 5,
      })),
    } as never);
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));

    const countdown = await screen.findByText(/NO BOARDS FREE :: retrying in/);
    expect(countdown.classList).toContain("no-boards-countdown");
    expect(
      screen.getByText("> you can't play different sides in a game"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "> you can't play soon after your previous move in a game",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("> other humans or bots could be thinking long"),
    ).not.toBeNull();
  });

  it("NO_BOARDS auto-retry countdown loops from the five-second backoff", async () => {
    const createClaim = vi.fn(async () => ({
      kind: "none" as const,
      retryAfterSeconds: 1,
    }));
    const client = mockClient({ createClaim } as never);
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText("NO BOARDS FREE :: retrying in 00:05");
    // The countdown reaches zero and automatically re-claims.
    await waitFor(
      () => {
        expect(createClaim.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 7_000 },
    );
  }, 10_000);

  it("QUOTA_OUT renders next-at from Retry-After", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "quota" as const,
        retryAfterSeconds: 1_800,
      })),
    } as never);
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/OUT OF BOARDS THIS HOUR/);
    expect(
      screen.getAllByText(/next at \d\d:\d\d/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("EXPIRED: position passed on — nothing charged → IDLE on ack", async () => {
    const client = mockClient({
      createClaim: vi.fn(async () => ({
        kind: "claim" as const,
        claim: claimFixture({ demo: true, stakeMicroUsdc: 0 }),
        created: true,
      })),
      postMove: vi.fn(async () => ({ kind: "expired" as const })),
    } as never);
    const { view } = await playDemoToConfirm(client);
    fireEvent.click(screen.getByRole("button", { name: /Y — make it so/ }));
    await screen.findByText("POSITION PASSED ON");
    expect(screen.getByText(/nothing was charged/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /back ▸/ }));
    await waitFor(() => {
      expect(
        view.container.querySelector('[data-testid="play-surface"]'),
      ).toBeNull();
    });
  });
});

describe("payment edge-state matrix (#32, F-W10 rows)", () => {
  const challenge = btoa(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://localhost:3000/api/v1/claims/clm_test1/move" },
      accepts: [
        {
          scheme: "mock",
          network: "mock:local",
          asset: "31566704",
          amount: "10000",
          payTo: "TREASURY",
        },
      ],
    }),
  );
  const paymentRequired: PostMoveResult = {
    kind: "payment_required",
    challengeHeader: challenge,
    envelope: { error: "PAYMENT_REQUIRED", hint: "", docs: "" },
  };

  async function stakedConfirm(script: readonly PostMoveResult[]) {
    let call = 0;
    const client = mockClient({
      postMove: vi.fn(async () => script[Math.min(call++, script.length - 1)]),
    } as never);
    const { view } = renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    fireEvent.click(
      view.container.querySelector('[data-square="e2"]') as Element,
    );
    fireEvent.click(
      view.container.querySelector('[data-square="e4"]') as Element,
    );
    await screen.findByText("FINAL MOVE?");
    fireEvent.click(screen.getByRole("button", { name: /sign & commit/ }));
    return { view, client };
  }

  it("202 PAYMENT_PENDING stays SETTLING and polls claim status — never re-signs", async () => {
    const getClaimStatus = vi.fn(async () => ({
      status: "moved" as const,
      receipt: {
        ...demoReceipt,
        debitMicroUsdc: 10_000,
        txid: "mocktx_2",
        explorerUrl: "https://explorer.example/tx/mocktx_2",
      },
    }));
    const { view, client } = await stakedConfirm([
      paymentRequired,
      { kind: "pending", retryAfterSeconds: 1 },
    ]);
    (client.getClaimStatus as ReturnType<typeof vi.fn>).mockImplementation(
      getClaimStatus,
    );
    await waitFor(() => {
      expect(view.container.querySelector(".settling")).not.toBeNull();
    });
    await screen.findByTestId("receipt", undefined, { timeout: 5_000 });
    const postMove = client.postMove as ReturnType<typeof vi.fn>;
    // one bare POST (402) + one header POST — polling never re-signed
    expect(postMove.mock.calls.length).toBe(2);
  });

  it("402 verify/settle failure returns to CONFIRM with the envelope hint", async () => {
    await stakedConfirm([
      paymentRequired,
      {
        kind: "payment_failed",
        code: "PAYMENT_INVALID",
        envelope: {
          error: "PAYMENT_INVALID",
          hint: "payment didn't land — nothing was charged",
          docs: "",
        },
        challengeHeader: null,
      },
    ]);
    await screen.findByText(/payment didn't land/);
    expect(screen.getByText("FINAL MOVE?")).not.toBeNull();
  });

  it("409 lands in SETTLING with the poll discipline", async () => {
    const { view } = await stakedConfirm([
      paymentRequired,
      { kind: "in_flight" },
    ]);
    await waitFor(() => {
      expect(view.container.querySelector(".settling")).not.toBeNull();
    });
  });

  it("503 PAYMENT_UNAVAILABLE returns to CONFIRM, definitively uncharged", async () => {
    await stakedConfirm([
      paymentRequired,
      { kind: "unavailable", retryAfterSeconds: 7 },
    ]);
    await screen.findByText(/nothing was charged/);
    expect(screen.getByText("FINAL MOVE?")).not.toBeNull();
  });
});

describe("disabled-CTA reason matrix (#31)", () => {
  it("encodes open-claim / quota / paused reasons", () => {
    expect(playCtaState({ phase: "FOCUS", paused: false })).toEqual({
      disabled: true,
      reason: "board is yours — return ▸",
    });
    expect(
      playCtaState({
        phase: "QUOTA_OUT",
        paused: false,
        quotaRetryAfterSeconds: 60,
      }).reason,
    ).toMatch(/next at \d\d:\d\d/);
    expect(playCtaState({ phase: "IDLE", paused: true })).toEqual({
      disabled: true,
      reason: null,
    });
    expect(playCtaState({ phase: "IDLE", paused: false })).toEqual({
      disabled: false,
      reason: null,
    });
  });

  it("keeps the hub visible and reopens the reserved board without reclaiming", async () => {
    const client = mockClient();
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    expect(screen.getByTestId("hub-panes")).not.toBeNull();
    const pane = screen.getByRole("dialog", { name: "game" });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Close game pane" }),
    );
    expect(screen.queryByRole("dialog", { name: "game" })).toBeNull();
    expect(screen.getByText(/board is yours — return/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /▸ PLAY/ }));
    const reopened = await screen.findByRole("dialog", { name: "game" });
    expect(within(reopened).getByText(/YOU PLAY WHITE/)).not.toBeNull();
    expect(client.createClaim).toHaveBeenCalledTimes(1);
  });

  it("paused meta disables both CTAs — the banner owns the message", async () => {
    const client = mockClient({
      getMeta: vi.fn(async () => ({
        ...metaFixture,
        status: { mode: "paused" as const, banner: null },
      })),
    } as never);
    render(
      <Providers client={client}>
        <Hub
          client={client}
          meta={{ ...metaFixture, status: { mode: "paused", banner: null } }}
          player={playerFixture}
        />
      </Providers>,
    );
    const play = await screen.findByRole("button", { name: /▸ PLAY/ });
    expect(play).toHaveProperty("disabled", true);
    await screen.findByText(/settlement offline/);
  });
});

describe("claim rehydration (#31)", () => {
  it("reload in CONFIRM rehydrates board + chosen move + deadline via one /claims/current", async () => {
    const claim = claimFixture();
    writeClaimDraft({ claimId: claim.claimId, moveUci: "e2e4", savedAt: "t" });
    const getCurrentClaim = vi.fn(async () => claim);
    const client = mockClient({ getCurrentClaim } as never);
    const { view } = renderHub(client);
    await screen.findByText("FINAL MOVE?");
    expect(screen.getByText(/e2→e4/)).not.toBeNull();
    expect(view.container.querySelector(".timer")).not.toBeNull();
    expect(getCurrentClaim).toHaveBeenCalledTimes(1);
    expect(client.getClaimStatus).not.toHaveBeenCalled();
  });
});

describe("responsive treatment (#31)", () => {
  it("CONFIRM is a bottom sheet and CRT effects drop below 768px (CSS contract)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const components = readFileSync(
      join(dir, "../styles/components.css"),
      "utf8",
    );
    const tokens = readFileSync(join(dir, "../styles/tokens.css"), "utf8");
    const mobileBlock = components.slice(
      components.indexOf("@media (max-width: 768px)"),
    );
    expect(mobileBlock).toContain("place-items: end stretch");
    const fxMobile = tokens.slice(tokens.indexOf("@media (max-width: 768px)"));
    expect(fxMobile).toContain("filter: none");
    expect(fxMobile).toMatch(/\.overlay\.scan \{\s*display: none/);
  });

  it("adds desktop side margins to the CRT page frame", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(join(dir, "../styles/tokens.css"), "utf8");
    const desktop = tokens.slice(tokens.indexOf("@media (min-width: 769px)"));
    expect(desktop).toMatch(/\.crt \{[\s\S]*width: min\(1240px/);
    expect(desktop).toContain("margin-inline: auto");
  });

  it("keeps PLAY and DEMO PLAY side-by-side, equal-sized, and highlights PLAY", async () => {
    const { view } = renderHub();
    const actions = view.container.querySelector(".hub-actions");
    const buttons = actions?.querySelectorAll(".bigplay");
    expect(actions).not.toBeNull();
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.className).toContain("primary");
    expect(buttons?.[1]?.className).toContain("demo");

    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, "../styles/components.css"), "utf8");
    expect(css).toMatch(
      /\.hub-actions \{[\s\S]*grid-template-columns: repeat\(2/,
    );
    expect(css).toMatch(/\.hub-actions \.bigplay \{[\s\S]*height: 100%/);
    expect(css).toMatch(
      /\.bigplay\.primary \{[\s\S]*background: var\(--faint\)/,
    );
  });
});

describe("hub panes chrome (playtest UI fixes)", () => {
  it("renames the tabs and links to the archive below the panel", async () => {
    renderHub();
    expect(
      await screen.findByRole("tab", { name: /LAST ACTIVE/ }),
    ).not.toBeNull();
    expect(screen.getByRole("tab", { name: /LAST FINISHED/ })).not.toBeNull();
    const link = screen.getByRole("link", { name: /full archive/ });
    expect(link.getAttribute("href")).toBe("/archive");
  });

  it("pins the panes to a fixed width so tab switches cannot reflow", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, "../styles/components.css"), "utf8");
    expect(css).toMatch(
      /\.panes \{[\s\S]*?width: min\(760px, calc\(100% - 32px\)\)/,
    );
  });

  it("shows only the latest active and finished entries; older entries stay in the archive", async () => {
    const client = mockClient({
      getOngoingGames: vi.fn(async () => ({
        items: [
          ongoingItemFixture(),
          ongoingItemFixture({ yourMove: { uci: "d2d4", san: "d4" } }),
        ],
        page: 1,
        pageCount: 1,
        total: 2,
      })),
      getFinishedGames: vi.fn(async () => ({
        items: [
          finishedStakedFixture(),
          finishedStakedFixture({
            gameId: "gm_archived",
            gameName: "archived-game",
            yourMoves: [{ uci: "d2d4", san: "d4", ply: 7 }],
          }),
        ],
        page: 1,
        pageCount: 1,
        total: 2,
      })),
      getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
    } as never);
    renderHub(client);

    await screen.findByTestId("active-hero");
    expect(screen.queryByText("d4")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "LAST FINISHED" }));
    await screen.findByTestId("finished-hero");
    expect(screen.queryByText("Game archived")).toBeNull();
  });

  it("shows a latest demo result without falling back to an older staked entry", async () => {
    const client = mockClient({
      getFinishedGames: vi.fn(async () => ({
        items: [
          finishedDemoFixture({
            termination: "threefold",
            repetitionAdjudication: {
              whiteMaterialPoints: 12,
              blackMaterialPoints: 8,
              winMargin: 3,
            },
          }),
          finishedStakedFixture(),
        ],
        page: 1,
        pageCount: 1,
        total: 2,
      })),
      getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
    } as never);
    renderHub(client);

    fireEvent.click(await screen.findByRole("tab", { name: "LAST FINISHED" }));
    await screen.findByTestId("finished-demo-hero");
    expect(screen.getByText("— demo —")).not.toBeNull();
    expect(
      screen.getByText("White won on repetition · material White 12 – Black 8"),
    ).not.toBeNull();
    expect(screen.queryByText("Game fin_ok")).toBeNull();
    expect(client.getReplay).not.toHaveBeenCalled();
  });

  it("last_finished_replay_explains_a_material_win_on_its_final_board", async () => {
    const adjudication = {
      whiteMaterialPoints: 12,
      blackMaterialPoints: 8,
      winMargin: 3,
    };
    const client = mockClient({
      getFinishedGames: vi.fn(async () => ({
        items: [
          finishedStakedFixture({
            gameId: "gm_material_hub",
            termination: "threefold",
            repetitionAdjudication: adjudication,
          }),
        ],
        page: 1,
        pageCount: 1,
        total: 1,
      })),
      getReplay: vi.fn(async (gameId: string) => ({
        ...replayFixture(gameId, 1),
        termination: "threefold" as const,
        repetitionAdjudication: adjudication,
      })),
    } as never);
    renderHub(client);

    fireEvent.click(await screen.findByRole("tab", { name: "LAST FINISHED" }));
    expect(
      (await screen.findByTestId("replayer-final-notice")).textContent,
    ).toBe("White won on repetition · material White 12 – Black 8");
  });

  it("shows aggregated owned plies, stake, thinking time, and replay link", async () => {
    const client = mockClient({
      getFinishedGames: vi.fn(async () => ({
        items: [
          finishedStakedFixture({
            yourMoves: [
              { uci: "g1f3", san: "Nf3", ply: 5 },
              { uci: "f1b5", san: "Bb5", ply: 9 },
            ],
            stakeMicroUsdc: 20_000,
            thinkingTimeMs: 240_000,
            payTxid: null,
          }),
        ],
        page: 1,
        pageCount: 1,
        total: 1,
      })),
      getReplay: vi.fn(async (gameId: string) => replayFixture(gameId, 12)),
    } as never);
    renderHub(client);

    fireEvent.click(await screen.findByRole("tab", { name: "LAST FINISHED" }));
    expect(await screen.findByText("plies 5, 9")).not.toBeNull();
    expect(screen.getAllByText("$0.02").length).toBeGreaterThan(0);
    expect(screen.getByText("4m 0s")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "full replay ▸" }).getAttribute("href"),
    ).toBe("/replay/gm_fin_ok?plies=5,9");
    expect(screen.getAllByRole("link", { name: "tx ↗" })).toHaveLength(1);
  });

  it("last_finished_identifies_the_side_you_played", async () => {
    const client = mockClient({
      getFinishedGames: vi.fn(async () => ({
        items: [finishedStakedFixture({ yourSide: "black" })],
        page: 1,
        pageCount: 1,
        total: 1,
      })),
      getReplay: vi.fn(async (gameId: string) => replayFixture(gameId)),
    } as never);
    renderHub(client);

    fireEvent.click(await screen.findByRole("tab", { name: "LAST FINISHED" }));
    const label = await screen.findByText("you played");
    expect(label.nextElementSibling?.textContent).toBe("black");
  });
});

describe("active-pane board loop context (playtest UI fixes)", () => {
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const ongoingPage = {
    items: [ongoingItemFixture({ fenBeforeYourMove: startFen })],
    page: 1,
    pageCount: 1,
    total: 1,
  };

  it("loops the move over the pre-move position from the ongoing payload", async () => {
    const client = mockClient({
      getOngoingGames: vi.fn(async () => ongoingPage),
    } as never);
    const { view } = renderHub(client);
    const loop = await screen.findByTestId("board-loop");
    // Real position renders around the mover…
    expect(loop.querySelector('[data-square="d8"] svg.pc')).not.toBeNull();
    // …but the mover's source square is empty on the base board (the
    // overlay piece is the only e2 pawn).
    expect(loop.querySelector('[data-square="e2"] svg.pc')).toBeNull();
    expect(view.container.querySelector(".boardloop-piece")).not.toBeNull();
  });

  it("uses the payload after a fresh render with no browser move cache", async () => {
    localStorage.clear();
    const client = mockClient({
      getOngoingGames: vi.fn(async () => ongoingPage),
    } as never);
    renderHub(client);
    const loop = await screen.findByTestId("board-loop");
    expect(loop.querySelector('[data-square="d8"] svg.pc')).not.toBeNull();
    expect(loop.querySelector(".boardloop-piece")).not.toBeNull();
  });
});
