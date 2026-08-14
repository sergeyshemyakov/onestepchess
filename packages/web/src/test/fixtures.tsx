import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type {
  ClaimView,
  Meta,
  PlayerView,
  ProfileView,
} from "../api/schemas.js";
import { SessionProvider } from "../auth/SessionContext.jsx";
import { ToastProvider } from "../components/Toasts.jsx";
import { LiveProvider } from "../live/LiveContext.jsx";
import { MetaProvider } from "../meta/MetaContext.jsx";

export const metaFixture: Meta = {
  name: "One Step Chess",
  network: {
    caip2: "mock:local",
    usdcAssetId: "31566704",
    treasuryAddress: "TREASURY",
    facilitatorUrl: "http://localhost:4402",
    explorerBaseUrl: "https://explorer.example",
    algodUrl: "http://localhost:4001",
  },
  economics: {
    humanStakeMicroUsdc: 10_000,
    agentStakeMicroUsdc: 1_000,
    endspielStakeMicroUsdc: 200,
    drawFeeMicroUsdc: 0,
    protocolFeeBps: 0,
    humanTargetMult: 2,
  },
  timing: {
    claimTtlSeconds: { human: 600, agent: 60, endspiel: 15 },
    timerRevealSeconds: 120,
    minPlyIntervalSeconds: 3,
    cooldownPlies: 4,
    nextGameNudgeSeconds: 20,
  },
  quotas: { human: null, agent: 60, demo: 10, windowMinutes: 60 },
  status: { mode: "running", banner: null },
  turnstileSiteKey: "",
  banners: { tower: true, championship: true },
  rules: "one move at a time.",
  docs: {
    llms: "http://localhost:3000/llms.txt",
    openapi: "http://localhost:3000/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
    botRepo: "https://github.com/sergeyshemyakov/onestepchess-bot",
    repo: "https://github.com/sergeyshemyakov/onestepchess",
  },
};

export const playerFixture: PlayerView = {
  address: "PLAYERADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  kind: "human",
  nickname: "night-owl",
  createdAt: "2026-07-01T00:00:00Z",
};

export function claimFixture(overrides: Partial<ClaimView> = {}): ClaimView {
  return {
    claimId: "clm_test1",
    yourSide: "white",
    phase: "normal",
    demo: false,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    legalMoves: [
      { uci: "e2e4", san: "e4" },
      { uci: "e2e3", san: "e3" },
      { uci: "g1f3", san: "Nf3" },
    ],
    stakeMicroUsdc: 10_000,
    deadline: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

export function profileFixture(
  overrides: Partial<ProfileView> = {},
): ProfileView {
  return {
    ...playerFixture,
    stats: {
      moves: 24,
      wins: 12,
      draws: 3,
      losses: 9,
      winratePct: 57.14285714285714,
    },
    netPnlMicroUsdc: 0,
    quotas: {
      staked: { limit: null, remaining: null, resetsAt: null },
      demo: { limit: 10, remaining: 10, resetsAt: null },
    },
    deprioritizedUntil: null,
    points: 120,
    refCode: "gentle-rook-042",
    referrals: { joined: 2, qualified: 1 },
    ...overrides,
  };
}

export const emptyGamesPage = { items: [], page: 1, pageCount: 0, total: 0 };

export function ongoingItemFixture(
  overrides: Partial<import("../api/schemas.js").OngoingGameItem> = {},
): import("../api/schemas.js").OngoingGameItem {
  return {
    yourMove: { uci: "e2e4", san: "e4" },
    yourSide: "white",
    demo: false,
    fenBeforeYourMove:
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    stakeMicroUsdc: 10_000,
    claimedAt: "2026-07-20T10:00:00Z",
    movedAt: "2026-07-20T10:01:00Z",
    payTxid: "STAKETX1",
    ...overrides,
  };
}

export function finishedStakedFixture(
  overrides: Partial<import("../api/schemas.js").FinishedStakedItem> = {},
): import("../api/schemas.js").FinishedStakedItem {
  return {
    yourMoves: [{ uci: "g1f3", san: "Nf3", ply: 5 }],
    yourSide: "white",
    demo: false,
    stakeMicroUsdc: 10_000,
    thinkingTimeMs: 150_000,
    startedAt: "2026-07-19T09:47:00Z",
    gameId: "gm_fin_ok",
    gameName: "crimson-rook-217",
    finalFen: "8/8/8/8/3k4/8/3K4/3Q4 b - - 0 61",
    result: "white",
    termination: "checkmate",
    repetitionAdjudication: null,
    payTxid: "STAKETX2",
    payoutMicroUsdc: 20_000,
    payoutTxid: "PAYOUTTX1",
    payoutStatus: "confirmed",
    statsCounted: true,
    finishedAt: "2026-07-19T11:00:00Z",
    ...overrides,
  };
}

export function finishedDemoFixture(
  overrides: Partial<import("../api/schemas.js").FinishedDemoItem> = {},
): import("../api/schemas.js").FinishedDemoItem {
  return {
    yourMoves: [{ uci: "b8c6", san: "Nc6" }],
    yourSide: "black",
    demo: true,
    stakeMicroUsdc: 0,
    thinkingTimeMs: 60_000,
    startedAt: "2026-07-18T09:47:00Z",
    result: "white",
    termination: "checkmate",
    repetitionAdjudication: null,
    payoutMicroUsdc: 0,
    payoutStatus: null,
    statsCounted: false,
    finishedAt: "2026-07-18T11:00:00Z",
    ...overrides,
  };
}

export function replayFixture(
  gameId: string,
  plyCount = 4,
): import("../api/schemas.js").ReplayView {
  const plies = Array.from({ length: plyCount }, (_, index) => {
    const ply = index + 1;
    const file = index % 8;
    const rank8 = file === 0 ? "Q7" : file === 7 ? "7Q" : `${file}Q${7 - file}`;
    return {
      ply,
      side: (ply % 2 === 1 ? "white" : "black") as "white" | "black",
      move: { uci: "e2e4", san: `M${ply}` },
      fenAfter: `${rank8}/8/8/8/8/8/8/4K2k ${ply % 2 === 1 ? "b" : "w"} - - 0 ${ply}`,
      stakeMicroUsdc: 10_000,
      demo: false,
      author: {
        nickname: `author-${ply}`,
        kind: "human" as const,
        winratePct: 50,
        movesTotal: 24,
      },
    };
  });
  return {
    gameId,
    name: "crimson-rook-217",
    result: "white",
    termination: "checkmate",
    repetitionAdjudication: null,
    endspielPly: null,
    createdAt: "2026-07-19T10:00:00Z",
    finishedAt: "2026-07-19T11:00:00Z",
    plies,
    pgn: '[Event "One Step Chess"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n',
  };
}

export function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = {
    getMeta: vi.fn(async () => metaFixture),
    authChallenge: vi.fn(),
    authVerify: vi.fn(),
    authLogout: vi.fn(async () => undefined),
    suggestNickname: vi.fn(async () => "gentle-rook-042"),
    probeProfile: vi.fn(async () => playerFixture),
    getProfile: vi.fn(async (options?: { readonly balances?: boolean }) =>
      profileFixture(
        options?.balances === true
          ? {
              balances: {
                usdcMicroUsdc: 1_000_000,
                algoMicroAlgo: 1_000_000,
              },
            }
          : {},
      ),
    ),
    renameProfile: vi.fn(async () => playerFixture),
    getOngoingGames: vi.fn(async () => emptyGamesPage),
    getFinishedGames: vi.fn(async () => emptyGamesPage),
    getReplay: vi.fn(async () => {
      throw new Error("no replay fixture");
    }),
    createClaim: vi.fn(async () => ({
      kind: "claim" as const,
      claim: claimFixture(),
      created: true,
    })),
    getCurrentClaim: vi.fn(async () => null),
    getClaimStatus: vi.fn(async () => null),
    postMove: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as ApiClient;
}

export function Providers(props: {
  readonly client: ApiClient;
  readonly children: ReactNode;
}) {
  return (
    <MemoryRouter>
      <ToastProvider>
        <MetaProvider client={props.client}>
          <SessionProvider client={props.client}>
            <LiveProvider client={props.client}>{props.children}</LiveProvider>
          </SessionProvider>
        </MetaProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}
