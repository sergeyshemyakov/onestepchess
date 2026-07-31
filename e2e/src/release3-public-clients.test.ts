import { readFile } from "node:fs/promises";
import {
  claimStatusViewSchema,
  claimViewSchema,
  errorEnvelopeSchema,
  finishedGameItemSchema,
  metaSchema,
  moveReceiptSchema,
  OSC_SERVER_ERROR_CODES,
  type OscApiError,
  ongoingGameItemSchema,
  pageSchema,
  paymentRequiredSchema,
  profileSchema,
  replayViewSchema,
} from "@onestepchess/agent-kit";
import { schema } from "@onestepchess/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicAgentDriver,
  createPublicHumanDriver,
  type PublicAgentDriver,
  type PublicHumanDriver,
} from "./public-driver.js";
import {
  createRelease3Harness,
  ledgerConservation,
  type Release3Harness,
} from "./release3-harness.js";

const DEFAULT_ENDSPIEL_SCRIPT = [
  "c2c3",
  "b7b5",
  "f2f4",
  "f7f6",
  "c3c4",
  "b5c4",
  "h2h3",
  "b8c6",
  "b1a3",
  "a7a6",
  "a3c4",
  "c6d4",
  "c4a3",
  "d4f3",
  "g1f3",
  "e7e6",
  "f3d4",
  "f8a3",
  "d4e6",
  "a3b2",
  "e6d8",
  "b2a1",
  "d8b7",
  "c8b7",
  "e2e3",
  "b7g2",
  "f1a6",
  "g2h1",
  "e1f1",
  "a8a6",
  "d1g4",
  "a6a2",
  "g4g7",
  "f6f5",
  "g7d7",
  "e8d7",
  "e3e4",
  "f5e4",
  "d2d4",
  "a1d4",
  "c1b2",
  "a2b2",
  "f1e1",
  "b2a2",
  "f4f5",
  "g8f6",
  "e1d1",
  "a2b2",
  "d1e1",
  "f6g8",
  "e1f1",
  "h1g2",
  "f1e1",
  "g2h3",
  "f5f6",
  "b2b6",
  "e1e2",
  "b6f6",
  "e2e1",
  "f6f4",
  "e1e2",
  "h3e6",
  "e2d1",
  "e4e3",
  "d1e2",
  "f4f3",
  "e2f3",
  "e6f7",
  "f3g4",
  "g8h6",
  "g4g3",
  "d4c5",
  "g3h3",
  "f7g6",
  "h3g3",
  "d7e8",
  "g3f4",
  "g6h5",
  "f4g3",
  "e8e7",
  "g3h4",
  "c7c6",
  "h4h5",
  "e7d6",
  "h5h6",
  "e3e2",
  "h6h5",
  "h7h6",
  "h5g4",
  "c5f2",
  "g4f3",
  "d6e5",
  "f3f2",
  "e2e1r",
  "f2f3",
  "h8c8",
  "f3g2",
  "c8d8",
  "g2h3",
  "e5d6",
  "h3h2",
  "d6e5",
  "h2g3",
  "e5d5",
  "g3f3",
  "e1e7",
  "f3g3",
  "d5d6",
  "g3h4",
  "e7c7",
  "h4g4",
  "d8a8",
  "g4f3",
  "c7f7",
  "f3g2",
  "a8g8",
  "g2h3",
  "f7f3",
  "h3h2",
  "g8g5",
  "h2h1",
  "f3h3",
] as const;
const ENDSPIEL_ENTRY_PLY = 58;

type Scenario = {
  readonly stack: Release3Harness;
  readonly human: PublicHumanDriver;
  readonly whiteAgents: readonly PublicAgentDriver[];
  readonly blackAgents: readonly PublicAgentDriver[];
  readonly preterminalClaim: unknown;
  readonly preterminalStatus: unknown;
  readonly preterminalReceipt: unknown;
  readonly preterminalGames: unknown;
  readonly replay: unknown;
  readonly finishedGameId: string;
};

async function buildScenario(): Promise<Scenario> {
  const stack = await createRelease3Harness();
  let nonce = 0;
  const nextNonce = () => `release3_${String(++nonce).padStart(6, "0")}`;
  const human = createPublicHumanDriver({
    serverUrl: stack.baseUrl,
    fetch: stack.fetchFor("10.74.0.1"),
    nickname: "release3-human",
    turnstileToken: "fixture-human",
    nonce: nextNonce,
  });
  const whiteAgents = Array.from({ length: 3 }, (_, index) =>
    createPublicAgentDriver({
      serverUrl: stack.baseUrl,
      fetch: stack.fetchFor(`10.74.1.${index + 1}`),
      nickname: `release3-white-${index + 1}`,
      nonce: nextNonce,
    }),
  );
  const blackAgents = Array.from({ length: 3 }, (_, index) =>
    createPublicAgentDriver({
      serverUrl: stack.baseUrl,
      fetch: stack.fetchFor(`10.74.2.${index + 1}`),
      nickname: `release3-black-${index + 1}`,
      nonce: nextNonce,
    }),
  );
  await human.register();
  await Promise.all(
    [...whiteAgents, ...blackAgents].map((driver) => driver.register()),
  );

  let preterminalClaim: unknown;
  let preterminalStatus: unknown;
  let preterminalReceipt: unknown;
  let preterminalGames: unknown;

  for (const [index, move] of DEFAULT_ENDSPIEL_SCRIPT.entries()) {
    const ply = index + 1;
    let actor: PublicHumanDriver | PublicAgentDriver;
    if (ply % 2 === 0) {
      actor = blackAgents[
        (ply / 2 - 1) % blackAgents.length
      ] as PublicAgentDriver;
    } else if (ply <= ENDSPIEL_ENTRY_PLY) {
      const whiteBeforeEndspiel = [human, whiteAgents[0], whiteAgents[1]];
      actor = whiteBeforeEndspiel[
        ((ply - 1) / 2) % whiteBeforeEndspiel.length
      ] as PublicHumanDriver | PublicAgentDriver;
    } else {
      const whiteAfterEndspiel = [
        whiteAgents[2],
        whiteAgents[1],
        whiteAgents[0],
      ];
      actor = whiteAfterEndspiel[
        ((ply - (ENDSPIEL_ENTRY_PLY + 1)) / 2) % whiteAfterEndspiel.length
      ] as PublicAgentDriver;
    }

    const claim = await actor.claim();
    if (claim === null) throw new Error(`no claim for scripted ply ${ply}`);
    expect(
      claim.legalMoves.some((candidate) => candidate.uci === move),
      `scripted ply ${ply} remains legal`,
    ).toBe(true);
    if (ply === 11) {
      preterminalClaim = claim;
      preterminalStatus = await actor.claimStatus(claim.claimId);
    }
    const receipt = await actor.play(claim, move);
    if (ply === 11) {
      preterminalReceipt = receipt;
      preterminalGames = await actor.games("ongoing");
    }
    stack.advancePacing();

    if (ply === ENDSPIEL_ENTRY_PLY) {
      expect(await human.claim(), "humans are excluded at endspiel").toBeNull();
    }
  }

  await stack.runPayouts();
  const finished = stack.database.db
    .select()
    .from(schema.games)
    .all()
    .find((game) => game.status === "finished");
  if (finished === undefined) throw new Error("script did not finish a game");
  const replayAgent = blackAgents[0];
  if (replayAgent === undefined) throw new Error("replay agent missing");
  const replay = await replayAgent.replay(finished.id);
  return {
    stack,
    human,
    whiteAgents,
    blackAgents,
    preterminalClaim,
    preterminalStatus,
    preterminalReceipt,
    preterminalGames,
    replay,
    finishedGameId: finished.id,
  };
}

describe.sequential("Release 3 public clients", () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await buildScenario();
  }, 120_000);

  afterAll(() => {
    scenario?.stack.close();
  });

  it("mixed_public_clients_cross_endspiel_and_resolve_once", async () => {
    const { stack } = scenario;
    const games = stack.database.db.select().from(schema.games).all();
    const finished = games.find((game) => game.id === scenario.finishedGameId);
    expect(finished?.ply).toBe(DEFAULT_ENDSPIEL_SCRIPT.length);
    expect(finished?.endspielPly).toBe(ENDSPIEL_ENTRY_PLY);
    expect(finished?.result).toBe("black");
    expect(finished?.termination).toBe("checkmate");
    expect(
      stack.database.db
        .select()
        .from(schema.claims)
        .all()
        .some(
          (claim) =>
            claim.player === scenario.human.address &&
            (claim.movedPly ?? 0) > ENDSPIEL_ENTRY_PLY,
        ),
    ).toBe(false);
    expect(
      stack.database.db
        .select()
        .from(schema.paymentIntents)
        .all()
        .filter((intent) => intent.status === "settled"),
    ).toHaveLength(DEFAULT_ENDSPIEL_SCRIPT.length);
    expect(
      stack.database.db
        .select()
        .from(schema.events)
        .all()
        .filter((event) => event.type === "game_resolved").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      stack.database.db
        .select()
        .from(schema.payoutJobs)
        .all()
        .every((job) => job.status === "confirmed"),
    ).toBe(true);
    expect(stack.invariantViolations()).toEqual([]);
    const conservation = ledgerConservation(stack.database);
    expect(conservation, JSON.stringify(conservation)).toMatchObject({
      balanced: true,
      differences: {},
    });
    expect(
      (await stack.rail.getBalances(stack.rail.treasuryAddress)).usdcMicroUsdc,
    ).toBe(conservation.totalDelta);
  });

  it("two_agent_kit_clients_register_claim_play_recover_and_receive_payout", async () => {
    const [first, second] = scenario.blackAgents;
    if (first === undefined || second === undefined)
      throw new Error("two black clients missing");
    const [firstProfile, secondProfile] = await Promise.all([
      first.client.whoami(),
      second.client.whoami(),
    ]);
    expect(firstProfile.address).toBe(first.address);
    expect(secondProfile.address).toBe(second.address);
    expect(firstProfile.address).not.toBe(secondProfile.address);
    expect(firstProfile.kind).toBe("agent");
    expect(secondProfile.kind).toBe("agent");
    expect(first.budget).not.toBe(second.budget);
    const restarted = first.restart();
    expect((await restarted.client.whoami()).address).toBe(first.address);
    const [firstGames, secondGames] = await Promise.all([
      restarted.games("finished"),
      second.games("finished"),
    ]);
    for (const games of [firstGames, secondGames]) {
      expect(games.items.length).toBeGreaterThan(0);
      expect(
        games.items.some(
          (item) =>
            "payoutStatus" in item &&
            item.payoutMicroUsdc > 0 &&
            item.payoutStatus === "confirmed",
        ),
      ).toBe(true);
    }
  });

  it("mixed_game_surfaces_remain_position_only_until_resolution", () => {
    expect(claimViewSchema.parse(scenario.preterminalClaim)).toBeDefined();
    expect(claimStatusViewSchema.parse(scenario.preterminalStatus).status).toBe(
      "open",
    );
    expect(moveReceiptSchema.parse(scenario.preterminalReceipt)).toBeDefined();
    expect(
      pageSchema(ongoingGameItemSchema).parse(scenario.preterminalGames),
    ).toBeDefined();
    for (const value of [
      scenario.preterminalClaim,
      scenario.preterminalStatus,
      scenario.preterminalReceipt,
      scenario.preterminalGames,
    ]) {
      const encoded = JSON.stringify(value);
      expect(encoded).not.toContain("gameId");
      expect(encoded).not.toContain("gameName");
      expect(encoded).not.toContain('"history"');
    }
    const events = scenario.stack.database.db
      .select()
      .from(schema.events)
      .all();
    const firstResolutionId = events
      .filter((event) => event.type === "game_resolved")
      .reduce((minimum, event) => Math.min(minimum, event.id), Infinity);
    const preterminalEvents = events.filter(
      (event) => event.id < firstResolutionId,
    );
    for (const event of preterminalEvents) {
      expect(event.payloadJson).not.toContain("gameId");
      expect(event.payloadJson).not.toContain("gameName");
      expect(event.payloadJson).not.toContain('"fen"');
      expect(event.payloadJson).not.toContain('"history"');
    }
    expect(replayViewSchema.parse(scenario.replay).gameId).toBe(
      scenario.finishedGameId,
    );
  });

  it("published_agent_schemas_parse_release4_server_and_openapi_fixtures", async () => {
    const agent = scenario.blackAgents[0];
    if (agent === undefined) throw new Error("agent missing");
    expect(metaSchema.parse(await agent.client.meta())).toBeDefined();
    expect(profileSchema.parse(await agent.client.profile())).toBeDefined();
    expect(replayViewSchema.parse(scenario.replay)).toBeDefined();

    const response = await scenario.stack.app.request("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      readonly paths?: Readonly<Record<string, unknown>>;
      readonly components?: {
        readonly schemas?: Readonly<Record<string, unknown>>;
      };
      readonly "x-agent-kit-examples"?: {
        readonly meta: unknown;
        readonly profile: unknown;
        readonly claim: unknown;
        readonly moveReceipt: unknown;
        readonly claimStatus: unknown;
        readonly ongoingGames: unknown;
        readonly finishedGames: unknown;
        readonly replay: unknown;
        readonly paymentRequired: unknown;
        readonly errors: Readonly<Record<string, unknown>>;
      };
    };
    const consumed = [
      "/api/v1/auth/challenge",
      "/api/v1/auth/verify",
      "/api/v1/auth/logout",
      "/api/v1/meta",
      "/api/v1/my/profile",
      "/api/v1/my/games",
      "/api/v1/games/{id}/replay",
      "/api/v1/claims",
      "/api/v1/claims/current",
      "/api/v1/claims/{id}/status",
      "/api/v1/claims/{id}/move",
    ];
    expect(Object.keys(document.paths ?? {})).toEqual(
      expect.arrayContaining(consumed),
    );
    expect(document.components?.schemas?.ErrorEnvelope).toBeDefined();
    expect(document.components?.schemas?.ClaimView).toBeDefined();
    expect(document.components?.schemas?.MoveReceipt).toBeDefined();
    const examples = document["x-agent-kit-examples"];
    if (examples === undefined) throw new Error("OpenAPI examples missing");
    expect(metaSchema.parse(examples.meta)).toBeDefined();
    expect(profileSchema.parse(examples.profile)).toBeDefined();
    expect(claimViewSchema.parse(examples.claim)).toBeDefined();
    expect(moveReceiptSchema.parse(examples.moveReceipt)).toBeDefined();
    expect(claimStatusViewSchema.parse(examples.claimStatus)).toBeDefined();
    expect(
      pageSchema(ongoingGameItemSchema).parse(examples.ongoingGames),
    ).toBeDefined();
    expect(
      pageSchema(finishedGameItemSchema).parse(examples.finishedGames),
    ).toBeDefined();
    expect(replayViewSchema.parse(examples.replay)).toBeDefined();
    expect(paymentRequiredSchema.parse(examples.paymentRequired)).toBeDefined();
    expect(Object.keys(examples.errors).sort()).toEqual(
      [...OSC_SERVER_ERROR_CODES].sort(),
    );
    for (const error of OSC_SERVER_ERROR_CODES) {
      expect(errorEnvelopeSchema.parse(examples.errors[error]).error).toBe(
        error,
      );
    }
  });

  it("e2e_driver_has_no_server_core_or_rail_imports", async () => {
    const source = await readFile(
      new URL("./public-driver.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /@onestepchess\/(?:server|core|rail-avm|rail-mock)/,
    );
    expect(source).not.toMatch(/(?:\.\.\/)+(?:packages|server|core|rail)/);
  });
});

describe("Release 3 public client recovery", () => {
  it("agent_restart_with_payment_inflight_polls_status_and_never_constructs_a_fresh_payment", async () => {
    const stack = await createRelease3Harness({
      config: { COOLDOWN_PLIES: 1 },
    });
    let nonce = 0;
    const driver = createPublicAgentDriver({
      serverUrl: stack.baseUrl,
      fetch: stack.fetchFor("10.74.3.1"),
      nickname: "recovery-agent",
      nonce: () => `recovery_${++nonce}`,
    });
    try {
      await driver.register();
      const claim = await driver.claim();
      if (claim === null) throw new Error("recovery claim missing");
      const restarted = driver.restart();
      expect((await restarted.currentClaim())?.claimId).toBe(claim.claimId);

      stack.rail.control.queueSettle({
        ok: false,
        reason: "unavailable",
        applied: true,
      });
      await expect(restarted.play(claim)).rejects.toMatchObject({
        code: "PAYMENT_PENDING",
      } satisfies Partial<OscApiError>);
      expect(await restarted.claimStatus(claim.claimId)).toMatchObject({
        status: "open",
        paymentState: "settling",
      });

      const withoutCachedHeader = driver.restart();
      await expect(withoutCachedHeader.play(claim)).rejects.toMatchObject({
        code: "PAYMENT_IN_FLIGHT",
      } satisfies Partial<OscApiError>);
      await stack.recoverPayments();
      expect(
        await withoutCachedHeader.claimStatus(claim.claimId),
      ).toMatchObject({ status: "moved" });
      expect(
        stack.database.db.select().from(schema.paymentIntents).all(),
      ).toHaveLength(1);
      expect(
        stack.database.db.select().from(schema.stakeEntries).all(),
      ).toHaveLength(1);
      expect(stack.invariantViolations()).toEqual([]);
    } finally {
      stack.close();
    }
  });
});
