import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostMoveResult } from "../api/client.js";
import type { MoveReceipt } from "../api/schemas.js";
import { writeClaimDraft } from "../lib/storage.js";
import {
  claimFixture,
  metaFixture,
  mockClient,
  Providers,
  playerFixture,
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

  // TODO(spec F-W4): asserts the interim from→to runner; rewrite when CONFIRM
  // gets the whole-board loop shared with the F-W3 ongoing hero card.
  it("shows a looping move animation beneath the final-move description", async () => {
    await playDemoToConfirm();
    const description = screen.getByText(/e2→e4/);
    const animation = screen.getByTestId("confirm-move-animation");
    expect(description.compareDocumentPosition(animation)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(animation.getAttribute("aria-label")).toBe(
      "move animation e2 to e4",
    );
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
  it("NO_BOARDS auto-retry countdown loops from Retry-After", async () => {
    const createClaim = vi.fn(async () => ({
      kind: "none" as const,
      retryAfterSeconds: 1,
    }));
    const client = mockClient({ createClaim } as never);
    renderHub(client);
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/NO BOARDS FREE :: retrying in/);
    // The countdown reaches zero and automatically re-claims.
    await waitFor(
      () => {
        expect(createClaim.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 4_000 },
    );
  });

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
      reason: "board reserved — return ▸",
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

  it("hides both play CTAs and the board-reserved return control after a claim", async () => {
    renderHub();
    fireEvent.click(await screen.findByRole("button", { name: /▸ PLAY/ }));
    await screen.findByText(/YOU PLAY WHITE/);
    expect(screen.queryByRole("button", { name: /▸ PLAY/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /DEMO PLAY/ })).toBeNull();
    expect(screen.queryByText(/board reserved — return/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /return to board/ }),
    ).toBeNull();
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
