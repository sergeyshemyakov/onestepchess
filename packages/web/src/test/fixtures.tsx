import type { ReactNode } from "react";
import { vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { ClaimView, Meta, PlayerView } from "../api/schemas.js";
import { SessionProvider } from "../auth/SessionContext.jsx";
import { ToastProvider } from "../components/Toasts.jsx";
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
  quotas: { human: 10, agent: 60, demo: 10, windowMinutes: 60 },
  status: { mode: "running", banner: null },
  turnstileSiteKey: "",
  rules: "one move at a time.",
  docs: {
    llms: "http://localhost:3000/llms.txt",
    openapi: "http://localhost:3000/api/v1/openapi.json",
    mcpPackage: "@onestepchess/mcp",
    agentKitPackage: "@onestepchess/agent-kit",
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

export function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = {
    getMeta: vi.fn(async () => metaFixture),
    authChallenge: vi.fn(),
    authVerify: vi.fn(),
    authLogout: vi.fn(async () => undefined),
    suggestNickname: vi.fn(async () => "gentle-rook-042"),
    probeProfile: vi.fn(async () => playerFixture),
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
    <ToastProvider>
      <MetaProvider client={props.client}>
        <SessionProvider client={props.client}>
          {props.children}
        </SessionProvider>
      </MetaProvider>
    </ToastProvider>
  );
}
