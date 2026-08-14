import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MAINNET_CAIP2, TESTNET_CAIP2 } from "@onestepchess/agent-kit";
import { describe, expect, it } from "vitest";
import {
  type ArtifactEntry,
  assertRelease4MayEnable,
  assertRelease4PromotionRecordIsSecretFree,
  inspectRelease4Artifact,
  mainnetOperatorDrillSchema,
  release4ArtifactEvidenceSchema,
  release4DeploymentManifestSchema,
  release4EnablementGateSchema,
  release4NotesSchema,
  release4PromotionManifestSchema,
  treasuryFundingReviewSchema,
} from "./release4-promotion.js";

const root = resolve(import.meta.dirname, "../..");
const at = "2026-08-01T12:00:00.000+00:00";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const commit = "c".repeat(40);
const testnetTreasury = "A".repeat(58);
const mainnetTreasury = "B".repeat(58);
const transaction = {
  txid: "RELEASE4_TXID_ABCDEFGH",
  confirmedRound: 20_001,
  latencyMs: 1_250,
};

function secretRefs(profile: string) {
  return {
    treasuryMnemonic: `test-fixture://${profile}/treasury@v1`,
    jwt: `test-fixture://${profile}/jwt@v1`,
    adminToken: `test-fixture://${profile}/admin@v1`,
    turnstile: `test-fixture://${profile}/turnstile@v1`,
    alertWebhook: `test-fixture://${profile}/alert@v1`,
  };
}

function deploymentManifest() {
  const common = {
    rail: "avm",
    adminAddresses: ["C".repeat(58)],
    facilitatorOrigin: "https://facilitator.example",
    turnstileSiteKey: "public-turnstile-site-key",
    copy: {
      rulesSha256: shaA,
      incentivesSha256: shaA,
      shareSha256: shaA,
    },
    treasuryThresholds: {
      minimumAlgoMicro: 1_000_000,
      maximumUsdcMicro: 50_000_000,
    },
  };
  return {
    check:
      "release4_deployment_manifest_requires_distinct_testnet_and_mainnet_identity_database_and_secrets",
    schemaVersion: 1,
    recordedAt: at,
    sourceCommit: commit,
    artifact: {
      imageDigest: `sha256:${shaA}`,
      webSha256: shaB,
      walletConnectProjectId: "walletconnect-public-id",
      profileIndependent: true,
    },
    profiles: {
      testnet: {
        ...common,
        profile: "testnet",
        caip2: TESTNET_CAIP2,
        usdcAssetId: "10458941",
        publicOrigin: "https://testnet.osc.example",
        databasePath: "/data/testnet/osc.sqlite",
        backupDirectory: "/data/testnet/backups",
        treasuryAddress: testnetTreasury,
        algodOrigin: "https://testnet-algod.example",
        indexerOrigin: "https://testnet-indexer.example",
        explorerOrigin: "https://testnet-explorer.example",
        secretRefs: secretRefs("testnet"),
        database: {
          initialization: "release3_migration",
          importSource: "release3-testnet-copy",
          identityPinnedBeforeRecovery: true,
        },
      },
      mainnet: {
        ...common,
        profile: "mainnet",
        caip2: MAINNET_CAIP2,
        usdcAssetId: "31566704",
        publicOrigin: "https://osc.example",
        databasePath: "/data/mainnet/osc.sqlite",
        backupDirectory: "/data/mainnet/backups",
        treasuryAddress: mainnetTreasury,
        algodOrigin: "https://mainnet-algod.example",
        indexerOrigin: "https://mainnet-indexer.example",
        explorerOrigin: "https://mainnet-explorer.example",
        secretRefs: secretRefs("mainnet"),
        database: {
          initialization: "fresh",
          importSource: null,
          moneyHistoryRowsBeforeEnablement: 0,
          identityPinnedBeforeRecovery: true,
        },
        preEnableIngress: "closed",
      },
    },
  };
}

function artifactEvidence() {
  return {
    check:
      "release4_image_and_web_artifact_are_profile_independent_and_secret_free",
    recordedAt: at,
    sourceCommit: commit,
    imageDigest: `sha256:${shaA}`,
    imageManifestSha256: shaA,
    webSha256: shaB,
    buildInputs: {
      walletConnectProjectId: "walletconnect-public-id",
      networkProfile: null,
      caip2: null,
      usdcAssetId: null,
      treasuryAddress: null,
      secretValues: null,
    },
    scans: {
      imageLayers: { status: "passed", filesScanned: 20, findings: 0 },
      imageManifest: { status: "passed", filesScanned: 1, findings: 0 },
      webChunks: { status: "passed", filesScanned: 10, findings: 0 },
      sourceMaps: { status: "passed", filesScanned: 0, findings: 0 },
      staticAssets: { status: "passed", filesScanned: 8, findings: 0 },
      environmentExposure: {
        status: "passed",
        filesScanned: 1,
        findings: 0,
      },
    },
    sourceMapsPublished: false,
    reviewedSupportedNetworkConstants: {
      status: "passed",
      markers: 4,
      reviewSha256: shaA,
    },
    secretFindings: 0,
    networkProfileFindings: 0,
  };
}

function testnetEvidence() {
  return {
    check:
      "testnet_release_candidate_completes_payments_payouts_bonus_recovery_and_reconciliation",
    network: TESTNET_CAIP2,
    recordedAt: at,
    freshDatabaseSha256: shaA,
    restoredDatabaseSha256: shaB,
    wallets: { pera: "passed", defly: "passed" },
    humanPayment: transaction,
    agentPayment: transaction,
    payout: transaction,
    starterStake: {
      algo: transaction,
      optIn: transaction,
      usdc: transaction,
    },
    crashRecovery: {
      afterSettleBeforeMoveCommit: "converged",
      afterOutgoingPreparation: "converged",
      afterSubmission: "converged",
      beforeConfirmation: "converged",
    },
    adminPauseRecovery: "passed",
    reconciliation: { clean: true, driftMicroUsdc: 0 },
    backupRestore: "passed",
    mockRegression: {
      publicClients: "passed",
      mixedEndspiel: "passed",
      soak: "passed",
      chaos: "passed",
      web: "passed",
    },
    sanitizedLogsSha256: shaA,
    unresolvedMoneyDefects: 0,
  };
}

function mainnetEvidence() {
  return {
    check:
      "human_approved_mainnet_micro_smoke_matches_testnet_contracts_and_reconciles_cleanly",
    recordedAt: at,
    approvalRecordedAt: at,
    aggregateBudgetMicroUsdc: 100_000,
    supportedNetwork: "passed",
    payment: transaction,
    payout: transaction,
    payoutNoteLookup: "passed",
    reconciliation: { clean: true, driftMicroUsdc: 0 },
    excludedActions: { bonus: true, fleet: true, publicTraffic: true },
    sanitizedLogsSha256: shaA,
  };
}

function operatorDrill() {
  return {
    check:
      "fresh_mainnet_backup_restore_identity_pin_and_operator_recovery_pass",
    recordedAt: at,
    network: MAINNET_CAIP2,
    publicTrafficDuringDrill: false,
    freshDatabase: "passed",
    restoreBeforeEnablement: "passed",
    identityPin: "passed",
    manualPause: "passed",
    settledPaymentRecovery: "passed",
    payoutRetry: "passed",
    bonusRetry: "passed",
    reconciliation: "passed",
    alertDelivery: "passed",
    rollback: "passed",
    sanitizedEvidenceSha256: shaA,
  };
}

function treasuryReview() {
  return {
    check:
      "release4_treasury_is_deliberately_funded_above_refund_and_algo_thresholds",
    recordedAt: at,
    network: MAINNET_CAIP2,
    treasuryAddress: mainnetTreasury,
    algoBalanceMicro: 2_000_000,
    minimumAlgoMicro: 1_000_000,
    usdcBalanceMicro: 2_000_000,
    unresolvedGameRefundsMicro: 500_000,
    pendingPreparedPayoutsMicro: 250_000,
    discretionaryStarterStakesMicro: 1_000_000,
    obligationsCovered: true,
    deliberateFundingApprovedBy: ["release-owner"],
    publicBalanceEvidenceSha256: shaA,
  };
}

function enablementGate() {
  return {
    check:
      "release4_4c_enablement_is_explicitly_approved_with_no_unresolved_money_safety_defect",
    recordedAt: at,
    issue: "https://github.com/sergeyshemyakov/onestepchess/issues/106",
    unresolvedMoneySafetyDefects: 0,
    reviewedPromotionEvidenceSha256: shaA,
    decision: "approved",
    approvalId: "approval-4c-1",
    approvedAt: at,
    reviewers: ["release-owner"],
    publicTraffic: "closed",
    reason:
      "All reviewed promotion evidence passed; ingress remains closed until deployment.",
  };
}

function releaseNotes() {
  const issue = (number: number) =>
    `https://github.com/sergeyshemyakov/onestepchess/issues/${number}`;
  return {
    title: "One Step Chess Release 4",
    recordedAt: at,
    issues: Object.fromEntries(
      [75, ...Array.from({ length: 12 }, (_, index) => 95 + index)].map(
        (number) => [String(number), issue(number)],
      ),
    ),
    evidence: {
      mock: "https://evidence.example/mock",
      testnet4A: "https://evidence.example/4a",
      mainnet4B: "https://evidence.example/4b",
      botFleet: "https://evidence.example/bot",
      migration: "https://evidence.example/migration",
      moneySafety: "https://evidence.example/money",
      operatorDrill: "https://evidence.example/operator",
      treasuryReview: "https://evidence.example/treasury",
      enablementGate: "https://evidence.example/4c",
    },
    artifacts: {
      sourceCommit: commit,
      imageDigest: `sha256:${shaA}`,
      webSha256: shaB,
      packages: [
        {
          name: "@onestepchess/agent-kit",
          version: "0.2.1",
          sha256: shaA,
        },
      ],
    },
    knownLimitations: ["Public traffic remains a separate operator action."],
    mainnetSmoke: {
      approvedRuns: 1,
      evidenceSha256: shaA,
      repeatedRunAuthorized: false,
    },
    furtherMainnetSmokeAuthorized: false,
    botMainnetActionAuthorized: false,
  };
}

function promotionManifest() {
  return {
    schemaVersion: 1,
    release: "4",
    recordedAt: at,
    deployment: deploymentManifest(),
    artifact: artifactEvidence(),
    security: {
      check:
        "release4_security_surface_has_only_reviewed_wallet_turnstile_and_algod_origins",
      recordedAt: at,
      productionOrigin: "https://osc.example",
      algodOrigin: "https://mainnet-algod.example",
      walletConnectRelayOrigin: "wss://relay.walletconnect.org",
      headers: {
        csp: "passed",
        hsts: "passed",
        referrerPolicy: "passed",
        nosniff: "passed",
        cors: "same_origin_only",
      },
      walletMatrix: [
        { wallet: "pera", platform: "ios-safari", status: "passed" },
        {
          wallet: "defly",
          platform: "android-chrome",
          status: "passed",
        },
      ],
      reviewedConnectOriginsSha256: shaA,
      findings: 0,
    },
    evidence: {
      mock: {
        ci: {
          lint: "passed",
          typecheck: "passed",
          test: "passed",
          build: "passed",
        },
        release3: {
          publicClients: "passed",
          mixedEndspiel: "passed",
          soak: "passed",
          chaos: "passed",
          web: "passed",
          docker: "passed",
        },
        publicNetworkCalls: 0,
        evidenceSha256: shaA,
      },
      testnet4A: testnetEvidence(),
      mainnet4B: mainnetEvidence(),
      botFleet: {
        release4Artifact: "passed",
        publicAgentApiOnly: "passed",
        testnetSingleBot: "passed",
        testnetRecoveryMatrix: "passed",
        testnetSmallFleet: "passed",
        dashboardRedaction: "passed",
        serviceBackupRestore: "passed",
        mainnetPaidWork: "not_authorized",
        mockSoak50Bots: "passed",
        evidenceSha256: shaA,
      },
      migration: {
        emptyDatabase: "passed",
        release3ToRelease4: "passed",
        testnetRestore: "passed",
        mainnetFreshDatabase: "passed",
        crossNetworkRestoreRefused: "passed",
        evidenceSha256: shaA,
      },
      moneySafety: {
        forcedCrashMatrix: "passed",
        exactPaymentAmbiguity: "passed",
        payoutRecovery: "passed",
        bonusRecovery: "passed",
        reconciliation: "passed",
        unresolvedDefects: 0,
        evidenceSha256: shaA,
      },
    },
    operatorDrill: operatorDrill(),
    treasuryReview: treasuryReview(),
    enablement: enablementGate(),
    releaseNotes: releaseNotes(),
  };
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("Release 4 deployment and promotion gate (#106)", () => {
  it("release4_deployment_manifest_requires_distinct_testnet_and_mainnet_identity_database_and_secrets", () => {
    const manifest = deploymentManifest();
    expect(release4DeploymentManifestSchema.parse(manifest)).toBeDefined();

    const sharedDatabase = structuredClone(manifest);
    sharedDatabase.profiles.mainnet.databasePath =
      sharedDatabase.profiles.testnet.databasePath;
    expect(
      release4DeploymentManifestSchema.safeParse(sharedDatabase).success,
    ).toBe(false);

    const sharedSecret = structuredClone(manifest);
    sharedSecret.profiles.mainnet.secretRefs.jwt =
      sharedSecret.profiles.testnet.secretRefs.jwt;
    expect(
      release4DeploymentManifestSchema.safeParse(sharedSecret).success,
    ).toBe(false);

    const importedMainnet = structuredClone(manifest) as Record<
      string,
      unknown
    >;
    const profiles = importedMainnet.profiles as Record<string, unknown>;
    const mainnet = profiles.mainnet as Record<string, unknown>;
    mainnet.database = {
      initialization: "release3_migration",
      importSource: "testnet.sqlite",
      moneyHistoryRowsBeforeEnablement: 3,
      identityPinnedBeforeRecovery: true,
    };
    expect(
      release4DeploymentManifestSchema.safeParse(importedMainnet).success,
    ).toBe(false);
  });

  it("release4_image_and_web_artifact_are_profile_independent_and_secret_free", () => {
    const webDist = join(root, "packages/web/dist");
    if (!existsSync(join(webDist, "index.html"))) {
      execFileSync("pnpm", ["--filter", "@onestepchess/web", "build"], {
        cwd: root,
        stdio: "pipe",
      });
    }
    const webEntries: ArtifactEntry[] = filesUnder(webDist)
      .filter((path) => !path.endsWith(".br") && !path.endsWith(".gz"))
      .map((path) => ({
        kind: path.endsWith(".map")
          ? "source_map"
          : /\/assets\/.*\.(?:js|css)$/.test(path)
            ? "web_chunk"
            : "static_asset",
        path: relative(root, path),
        contents: readFileSync(path),
      }));
    const report = inspectRelease4Artifact(
      [
        {
          kind: "image_manifest",
          path: "image/manifest.json",
          contents: '{"config":"runtime"}',
        },
        {
          kind: "image_layer",
          path: "image/layers/app/packages/server/dist/index.js",
          contents: "runtime server",
        },
        {
          kind: "environment",
          path: "image/config.json",
          contents: '{"Env":["NODE_ENV=production"]}',
        },
        ...webEntries,
      ],
      ["release-four-secret-sentinel"],
    );
    expect(report.secretFindings).toEqual([]);
    expect(report.networkProfileFindings).toEqual([]);
    expect(report.files.web_chunk).toBeGreaterThan(0);
    expect(report.files.source_map).toBe(0);
    expect(
      release4ArtifactEvidenceSchema.parse(artifactEvidence()),
    ).toBeDefined();

    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/^ENV (?:RAIL|CAIP2|USDC_ASA)=/m);
    expect(dockerfile).not.toMatch(
      /ARG (?:TREASURY_MNEMONIC|JWT_SECRET|ADMIN_TOKEN)/,
    );
    expect(readFileSync(join(root, ".dockerignore"), "utf8")).toContain(
      ".env.*",
    );

    const unsafe = inspectRelease4Artifact(
      [
        {
          kind: "image_layer",
          path: "layer/.env.production",
          contents: "JWT_SECRET=release-four-secret-sentinel",
        },
        {
          kind: "web_chunk",
          path: "web/assets/app.js",
          contents: TESTNET_CAIP2,
        },
      ],
      ["release-four-secret-sentinel"],
    );
    expect(unsafe.secretFindings).not.toEqual([]);
    expect(unsafe.networkProfileFindings).not.toEqual([]);
  }, 30_000);

  it("release4_promotion_manifest_rejects_missing_mock_4a_4b_bot_migration_or_money_safety_evidence", () => {
    const complete = promotionManifest();
    expect(release4PromotionManifestSchema.parse(complete)).toBeDefined();
    for (const section of [
      "mock",
      "testnet4A",
      "mainnet4B",
      "botFleet",
      "migration",
      "moneySafety",
    ]) {
      const partial = structuredClone(complete) as Record<string, unknown>;
      const evidence = partial.evidence as Record<string, unknown>;
      delete evidence[section];
      expect(
        release4PromotionManifestSchema.safeParse(partial).success,
        section,
      ).toBe(false);
    }
  });

  it("fresh_mainnet_backup_restore_identity_pin_and_operator_recovery_pass", () => {
    expect(mainnetOperatorDrillSchema.parse(operatorDrill())).toBeDefined();
    const partial = structuredClone(operatorDrill()) as Record<string, unknown>;
    delete partial.settledPaymentRecovery;
    expect(mainnetOperatorDrillSchema.safeParse(partial).success).toBe(false);
    expect(
      mainnetOperatorDrillSchema.safeParse({
        ...operatorDrill(),
        publicTrafficDuringDrill: true,
      }).success,
    ).toBe(false);
  });

  it("release4_treasury_is_deliberately_funded_above_refund_and_algo_thresholds", () => {
    const review = treasuryReview();
    expect(treasuryFundingReviewSchema.parse(review)).toBeDefined();
    expect(
      treasuryFundingReviewSchema.safeParse({
        ...review,
        algoBalanceMicro: 999_999,
      }).success,
    ).toBe(false);
    expect(
      treasuryFundingReviewSchema.safeParse({
        ...review,
        usdcBalanceMicro: 749_999,
      }).success,
    ).toBe(false);
    expect(review.discretionaryStarterStakesMicro).toBeGreaterThan(0);
    expect(JSON.stringify(review)).not.toMatch(/mnemonic/i);
  });

  it("release4_4c_enablement_is_explicitly_approved_with_no_unresolved_money_safety_defect", () => {
    const approved = promotionManifest();
    expect(
      release4EnablementGateSchema.parse(approved.enablement),
    ).toBeDefined();
    expect(assertRelease4MayEnable(approved)).toBeDefined();

    const withheld = structuredClone(promotionManifest()) as Record<
      string,
      unknown
    >;
    withheld.enablement = {
      check:
        "release4_4c_enablement_is_explicitly_approved_with_no_unresolved_money_safety_defect",
      recordedAt: at,
      issue: "https://github.com/sergeyshemyakov/onestepchess/issues/106",
      unresolvedMoneySafetyDefects: 0,
      reviewedPromotionEvidenceSha256: shaA,
      decision: "withheld",
      approvalId: null,
      approvedAt: null,
      reviewers: [],
      publicTraffic: "closed",
      reason: "No contemporaneous 4C approval has been supplied.",
    };
    expect(release4PromotionManifestSchema.parse(withheld)).toBeDefined();
    expect(() => assertRelease4MayEnable(withheld)).toThrow(
      /public traffic remains closed/,
    );
  });

  it("release4_release_notes_never_authorize_repeated_live_actions", () => {
    const notes = releaseNotes();
    expect(release4NotesSchema.parse(notes)).toBeDefined();
    const missingIssue = structuredClone(notes) as Record<string, unknown>;
    delete (missingIssue.issues as Record<string, unknown>)["103"];
    expect(release4NotesSchema.safeParse(missingIssue).success).toBe(false);
    expect(
      release4NotesSchema.safeParse({
        ...notes,
        mainnetSmoke: {
          ...notes.mainnetSmoke,
          repeatedRunAuthorized: true,
        },
      }).success,
    ).toBe(false);
    expect(notes.furtherMainnetSmokeAuthorized).toBe(false);
    expect(notes.botMainnetActionAuthorized).toBe(false);
  });

  it("release4_promotion_records_reject_secret_values_and_secret_bearing_fields", () => {
    expect(() =>
      assertRelease4PromotionRecordIsSecretFree(promotionManifest()),
    ).not.toThrow();
    expect(() =>
      assertRelease4PromotionRecordIsSecretFree({
        ...promotionManifest(),
        treasuryMnemonic: `${"word ".repeat(24)}word`,
      }),
    ).toThrow(/forbidden secret field/);
  });
});
