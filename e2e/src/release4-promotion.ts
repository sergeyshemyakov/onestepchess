import { MAINNET_CAIP2, TESTNET_CAIP2 } from "@onestepchess/agent-kit";
import { z } from "zod";
import {
  mainnetMicroSmokeEvidenceSchema,
  testnetReleaseCandidateEvidenceSchema,
} from "./release4-evidence.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const recordedAtSchema = z.iso.datetime({ offset: true });
const httpsUrlSchema = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", "must use HTTPS");
const absolutePathSchema = z.string().startsWith("/").min(2);
const algorandAddressSchema = z.string().regex(/^[A-Z2-7]{58}$/);
const passedSchema = z.literal("passed");
const secretRefSchema = z
  .string()
  .regex(
    /^(?:fly|vault|secret-manager|test-fixture):\/\/[A-Za-z0-9._/-]+@[A-Za-z0-9._-]+$/,
    "must be a versioned secret-manager reference, never a secret value",
  );

const deploymentSecretRefsSchema = z
  .object({
    treasuryMnemonic: secretRefSchema,
    jwt: secretRefSchema,
    adminToken: secretRefSchema,
    turnstile: secretRefSchema,
    alertWebhook: secretRefSchema,
  })
  .strict();

const deploymentProfileBase = z.object({
  rail: z.literal("avm"),
  publicOrigin: httpsUrlSchema,
  databasePath: absolutePathSchema,
  backupDirectory: absolutePathSchema,
  treasuryAddress: algorandAddressSchema,
  adminAddresses: z.array(algorandAddressSchema).min(1),
  algodOrigin: httpsUrlSchema,
  indexerOrigin: httpsUrlSchema,
  facilitatorOrigin: httpsUrlSchema,
  explorerOrigin: httpsUrlSchema,
  turnstileSiteKey: z.string().min(8),
  secretRefs: deploymentSecretRefsSchema,
  copy: z
    .object({
      rulesSha256: sha256Schema,
      incentivesSha256: sha256Schema,
      shareSha256: sha256Schema,
    })
    .strict(),
  treasuryThresholds: z
    .object({
      minimumAlgoMicro: z.number().int().positive(),
      maximumUsdcMicro: z.number().int().positive(),
    })
    .strict(),
});

const testnetDeploymentProfileSchema = deploymentProfileBase
  .extend({
    profile: z.literal("testnet"),
    caip2: z.literal(TESTNET_CAIP2),
    usdcAssetId: z.literal("10458941"),
    database: z
      .object({
        initialization: z.enum(["fresh", "release3_migration"]),
        importSource: z.string().min(1).nullable(),
        identityPinnedBeforeRecovery: z.literal(true),
      })
      .strict(),
  })
  .strict();

const mainnetDeploymentProfileSchema = deploymentProfileBase
  .extend({
    profile: z.literal("mainnet"),
    caip2: z.literal(MAINNET_CAIP2),
    usdcAssetId: z.literal("31566704"),
    database: z
      .object({
        initialization: z.literal("fresh"),
        importSource: z.null(),
        moneyHistoryRowsBeforeEnablement: z.literal(0),
        identityPinnedBeforeRecovery: z.literal(true),
      })
      .strict(),
    preEnableIngress: z.literal("closed"),
  })
  .strict();

function addDistinctIssue(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: `${label} must be distinct between testnet and mainnet`,
    });
  }
}

export const release4DeploymentManifestSchema = z
  .object({
    check: z.literal(
      "release4_deployment_manifest_requires_distinct_testnet_and_mainnet_identity_database_and_secrets",
    ),
    schemaVersion: z.literal(1),
    recordedAt: recordedAtSchema,
    sourceCommit: sourceCommitSchema,
    artifact: z
      .object({
        imageDigest: imageDigestSchema,
        webSha256: sha256Schema,
        walletConnectProjectId: z.string().min(16),
        profileIndependent: z.literal(true),
      })
      .strict(),
    profiles: z
      .object({
        testnet: testnetDeploymentProfileSchema,
        mainnet: mainnetDeploymentProfileSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const { testnet, mainnet } = manifest.profiles;
    addDistinctIssue(
      [testnet.caip2, mainnet.caip2],
      "network identity",
      context,
    );
    addDistinctIssue(
      [testnet.usdcAssetId, mainnet.usdcAssetId],
      "asset identity",
      context,
    );
    addDistinctIssue(
      [testnet.treasuryAddress, mainnet.treasuryAddress],
      "treasury identity",
      context,
    );
    addDistinctIssue(
      [testnet.databasePath, mainnet.databasePath],
      "database paths",
      context,
    );
    addDistinctIssue(
      [testnet.backupDirectory, mainnet.backupDirectory],
      "backup directories",
      context,
    );
    addDistinctIssue(
      [
        ...Object.values(testnet.secretRefs),
        ...Object.values(mainnet.secretRefs),
      ],
      "secret references",
      context,
    );
  });

const artifactScanSectionSchema = z
  .object({
    status: passedSchema,
    filesScanned: z.number().int().nonnegative(),
    findings: z.literal(0),
  })
  .strict();

export const release4ArtifactEvidenceSchema = z
  .object({
    check: z.literal(
      "release4_image_and_web_artifact_are_profile_independent_and_secret_free",
    ),
    recordedAt: recordedAtSchema,
    sourceCommit: sourceCommitSchema,
    imageDigest: imageDigestSchema,
    imageManifestSha256: sha256Schema,
    webSha256: sha256Schema,
    buildInputs: z
      .object({
        walletConnectProjectId: z.string().min(16),
        networkProfile: z.null(),
        caip2: z.null(),
        usdcAssetId: z.null(),
        treasuryAddress: z.null(),
        secretValues: z.null(),
      })
      .strict(),
    scans: z
      .object({
        imageLayers: artifactScanSectionSchema.refine(
          (value) => value.filesScanned > 0,
          "must scan at least one image-layer file",
        ),
        imageManifest: artifactScanSectionSchema.refine(
          (value) => value.filesScanned > 0,
          "must scan the image manifest",
        ),
        webChunks: artifactScanSectionSchema.refine(
          (value) => value.filesScanned > 0,
          "must scan at least one web chunk",
        ),
        sourceMaps: artifactScanSectionSchema,
        staticAssets: artifactScanSectionSchema.refine(
          (value) => value.filesScanned > 0,
          "must scan at least one static asset",
        ),
        environmentExposure: artifactScanSectionSchema,
      })
      .strict(),
    sourceMapsPublished: z.literal(false),
    reviewedSupportedNetworkConstants: z
      .object({
        status: passedSchema,
        markers: z.literal(4),
        reviewSha256: sha256Schema,
      })
      .strict(),
    secretFindings: z.literal(0),
    networkProfileFindings: z.literal(0),
  })
  .strict();

export type ArtifactEntry = {
  readonly kind:
    | "image_layer"
    | "image_manifest"
    | "web_chunk"
    | "source_map"
    | "static_asset"
    | "environment";
  readonly path: string;
  readonly contents: string | Uint8Array;
};

export type ArtifactInspection = {
  readonly files: Readonly<Record<ArtifactEntry["kind"], number>>;
  readonly secretFindings: readonly string[];
  readonly networkProfileFindings: readonly string[];
};

const RELEASE_PROFILE_MARKERS = [
  TESTNET_CAIP2,
  MAINNET_CAIP2,
  "https://testnet-api.4160.nodely.dev",
  "https://mainnet-api.4160.nodely.dev",
  "https://testnet-idx.4160.nodely.dev",
  "https://mainnet-idx.4160.nodely.dev",
];

function isReviewedSupportTableMarker(path: string, marker: string): boolean {
  const file = path.split("/").at(-1) ?? "";
  if (marker.startsWith("algorand:")) return file.startsWith("x402-");
  if (marker.includes("-api.4160.nodely.dev")) {
    return file.startsWith("provider-");
  }
  return false;
}

export function inspectRelease4Artifact(
  entries: readonly ArtifactEntry[],
  forbiddenSecretValues: readonly string[],
): ArtifactInspection {
  const files: Record<ArtifactEntry["kind"], number> = {
    image_layer: 0,
    image_manifest: 0,
    web_chunk: 0,
    source_map: 0,
    static_asset: 0,
    environment: 0,
  };
  const secretFindings: string[] = [];
  const networkProfileFindings: string[] = [];
  const secrets = forbiddenSecretValues.filter((value) => value.length > 0);

  for (const entry of entries) {
    files[entry.kind] += 1;
    const text =
      typeof entry.contents === "string"
        ? entry.contents
        : Buffer.from(entry.contents).toString("utf8");
    if (/(?:^|\/)(?:\.env|[^/]+\.env)(?:\.|$)/.test(entry.path)) {
      secretFindings.push(`${entry.path}: environment file`);
    }
    for (const secret of secrets) {
      if (text.includes(secret)) {
        secretFindings.push(`${entry.path}: forbidden secret value`);
      }
    }
    if (entry.kind === "web_chunk" || entry.kind === "source_map") {
      for (const marker of RELEASE_PROFILE_MARKERS) {
        if (
          text.includes(marker) &&
          !isReviewedSupportTableMarker(entry.path, marker)
        ) {
          networkProfileFindings.push(
            `${entry.path}: profile marker ${marker}`,
          );
        }
      }
    }
  }

  return { files, secretFindings, networkProfileFindings };
}

const walletCertificationSchema = z
  .object({
    wallet: z.enum(["pera", "defly"]),
    platform: z.enum([
      "ios-safari",
      "android-chrome",
      "desktop-chrome",
      "desktop-firefox",
    ]),
    status: passedSchema,
  })
  .strict();

export const release4SecurityEvidenceSchema = z
  .object({
    check: z.literal(
      "release4_security_surface_has_only_reviewed_wallet_turnstile_and_algod_origins",
    ),
    recordedAt: recordedAtSchema,
    productionOrigin: httpsUrlSchema,
    algodOrigin: httpsUrlSchema,
    walletConnectRelayOrigin: z.string().url(),
    headers: z
      .object({
        csp: passedSchema,
        hsts: passedSchema,
        referrerPolicy: passedSchema,
        nosniff: passedSchema,
        cors: z.literal("same_origin_only"),
      })
      .strict(),
    walletMatrix: z.array(walletCertificationSchema).min(2),
    reviewedConnectOriginsSha256: sha256Schema,
    findings: z.literal(0),
  })
  .strict()
  .superRefine((evidence, context) => {
    const required = ["pera:ios-safari", "defly:android-chrome"];
    const recorded = new Set(
      evidence.walletMatrix.map((row) => `${row.wallet}:${row.platform}`),
    );
    for (const entry of required) {
      if (!recorded.has(entry)) {
        context.addIssue({
          code: "custom",
          path: ["walletMatrix"],
          message: `missing wallet certification ${entry}`,
        });
      }
    }
  });

const mockEvidenceSchema = z
  .object({
    ci: z
      .object({
        lint: passedSchema,
        typecheck: passedSchema,
        test: passedSchema,
        build: passedSchema,
      })
      .strict(),
    release3: z
      .object({
        publicClients: passedSchema,
        mixedEndspiel: passedSchema,
        soak: passedSchema,
        chaos: passedSchema,
        web: passedSchema,
        docker: passedSchema,
      })
      .strict(),
    publicNetworkCalls: z.literal(0),
    evidenceSha256: sha256Schema,
  })
  .strict();

const botFleetEvidenceSchema = z
  .object({
    release4Artifact: passedSchema,
    publicAgentApiOnly: passedSchema,
    testnetSingleBot: passedSchema,
    testnetRecoveryMatrix: passedSchema,
    testnetSmallFleet: passedSchema,
    dashboardRedaction: passedSchema,
    serviceBackupRestore: passedSchema,
    mainnetPaidWork: z.literal("not_authorized"),
    mockSoak50Bots: passedSchema,
    evidenceSha256: sha256Schema,
  })
  .strict();

const migrationEvidenceSchema = z
  .object({
    emptyDatabase: passedSchema,
    release3ToRelease4: passedSchema,
    testnetRestore: passedSchema,
    mainnetFreshDatabase: passedSchema,
    crossNetworkRestoreRefused: passedSchema,
    evidenceSha256: sha256Schema,
  })
  .strict();

const moneySafetyEvidenceSchema = z
  .object({
    forcedCrashMatrix: passedSchema,
    exactPaymentAmbiguity: passedSchema,
    payoutRecovery: passedSchema,
    bonusRecovery: passedSchema,
    reconciliation: passedSchema,
    unresolvedDefects: z.literal(0),
    evidenceSha256: sha256Schema,
  })
  .strict();

export const mainnetOperatorDrillSchema = z
  .object({
    check: z.literal(
      "fresh_mainnet_backup_restore_identity_pin_and_operator_recovery_pass",
    ),
    recordedAt: recordedAtSchema,
    network: z.literal(MAINNET_CAIP2),
    publicTrafficDuringDrill: z.literal(false),
    freshDatabase: passedSchema,
    restoreBeforeEnablement: passedSchema,
    identityPin: passedSchema,
    manualPause: passedSchema,
    settledPaymentRecovery: passedSchema,
    payoutRetry: passedSchema,
    bonusRetry: passedSchema,
    reconciliation: passedSchema,
    alertDelivery: passedSchema,
    rollback: passedSchema,
    sanitizedEvidenceSha256: sha256Schema,
  })
  .strict();

export const treasuryFundingReviewSchema = z
  .object({
    check: z.literal(
      "release4_treasury_is_deliberately_funded_above_refund_and_algo_thresholds",
    ),
    recordedAt: recordedAtSchema,
    network: z.literal(MAINNET_CAIP2),
    treasuryAddress: algorandAddressSchema,
    algoBalanceMicro: z.number().int().nonnegative(),
    minimumAlgoMicro: z.number().int().positive(),
    usdcBalanceMicro: z.number().int().nonnegative(),
    unresolvedGameRefundsMicro: z.number().int().nonnegative(),
    pendingPreparedPayoutsMicro: z.number().int().nonnegative(),
    discretionaryStarterStakesMicro: z.number().int().nonnegative(),
    obligationsCovered: z.literal(true),
    deliberateFundingApprovedBy: z.array(z.string().min(1)).min(1),
    publicBalanceEvidenceSha256: sha256Schema,
  })
  .strict()
  .superRefine((review, context) => {
    if (review.algoBalanceMicro < review.minimumAlgoMicro) {
      context.addIssue({
        code: "custom",
        path: ["algoBalanceMicro"],
        message: "treasury ALGO balance is below its operational threshold",
      });
    }
    const obligations =
      review.unresolvedGameRefundsMicro + review.pendingPreparedPayoutsMicro;
    if (review.usdcBalanceMicro < obligations) {
      context.addIssue({
        code: "custom",
        path: ["usdcBalanceMicro"],
        message: "treasury USDC balance does not cover player obligations",
      });
    }
  });

const gateBaseSchema = z.object({
  check: z.literal(
    "release4_4c_enablement_is_explicitly_approved_with_no_unresolved_money_safety_defect",
  ),
  recordedAt: recordedAtSchema,
  issue: z.literal(
    "https://github.com/sergeyshemyakov/onestepchess/issues/106",
  ),
  unresolvedMoneySafetyDefects: z.literal(0),
  reviewedPromotionEvidenceSha256: sha256Schema,
});

export const release4EnablementGateSchema = z.discriminatedUnion("decision", [
  gateBaseSchema
    .extend({
      decision: z.literal("withheld"),
      approvalId: z.null(),
      approvedAt: z.null(),
      reviewers: z.array(z.string()).max(0),
      publicTraffic: z.literal("closed"),
      reason: z.string().min(1),
    })
    .strict(),
  gateBaseSchema
    .extend({
      decision: z.literal("approved"),
      approvalId: z.string().min(1),
      approvedAt: recordedAtSchema,
      reviewers: z.array(z.string().min(1)).min(1),
      publicTraffic: z.enum(["closed", "open"]),
      reason: z.string().min(1),
    })
    .strict(),
]);

const releaseIssueLinksSchema = z
  .object({
    "75": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/75",
    ),
    "95": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/95",
    ),
    "96": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/96",
    ),
    "97": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/97",
    ),
    "98": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/98",
    ),
    "99": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/99",
    ),
    "100": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/100",
    ),
    "101": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/101",
    ),
    "102": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/102",
    ),
    "103": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/103",
    ),
    "104": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/104",
    ),
    "105": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/105",
    ),
    "106": z.literal(
      "https://github.com/sergeyshemyakov/onestepchess/issues/106",
    ),
  })
  .strict();

export const release4NotesSchema = z
  .object({
    title: z.literal("One Step Chess Release 4"),
    recordedAt: recordedAtSchema,
    issues: releaseIssueLinksSchema,
    evidence: z
      .object({
        mock: httpsUrlSchema,
        testnet4A: httpsUrlSchema,
        mainnet4B: httpsUrlSchema,
        botFleet: httpsUrlSchema,
        migration: httpsUrlSchema,
        moneySafety: httpsUrlSchema,
        operatorDrill: httpsUrlSchema,
        treasuryReview: httpsUrlSchema,
        enablementGate: httpsUrlSchema,
      })
      .strict(),
    artifacts: z
      .object({
        sourceCommit: sourceCommitSchema,
        imageDigest: imageDigestSchema,
        webSha256: sha256Schema,
        packages: z
          .array(
            z
              .object({
                name: z.string().startsWith("@onestepchess/"),
                version: z.string().regex(/^\d+\.\d+\.\d+$/),
                sha256: sha256Schema,
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    knownLimitations: z.array(z.string().min(1)).min(1),
    mainnetSmoke: z
      .object({
        approvedRuns: z.literal(1),
        evidenceSha256: sha256Schema,
        repeatedRunAuthorized: z.literal(false),
      })
      .strict(),
    furtherMainnetSmokeAuthorized: z.literal(false),
    botMainnetActionAuthorized: z.literal(false),
  })
  .strict();

export const release4PromotionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    release: z.literal("4"),
    recordedAt: recordedAtSchema,
    deployment: release4DeploymentManifestSchema,
    artifact: release4ArtifactEvidenceSchema,
    security: release4SecurityEvidenceSchema,
    evidence: z
      .object({
        mock: mockEvidenceSchema,
        testnet4A: testnetReleaseCandidateEvidenceSchema,
        mainnet4B: mainnetMicroSmokeEvidenceSchema,
        botFleet: botFleetEvidenceSchema,
        migration: migrationEvidenceSchema,
        moneySafety: moneySafetyEvidenceSchema,
      })
      .strict(),
    operatorDrill: mainnetOperatorDrillSchema,
    treasuryReview: treasuryFundingReviewSchema,
    enablement: release4EnablementGateSchema,
    releaseNotes: release4NotesSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.deployment.sourceCommit !== manifest.artifact.sourceCommit) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "sourceCommit"],
        message: "deployment and artifact must pin the same source commit",
      });
    }
    if (
      manifest.deployment.artifact.imageDigest !== manifest.artifact.imageDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "imageDigest"],
        message: "deployment and scan must pin the same image digest",
      });
    }
    if (
      manifest.deployment.artifact.webSha256 !== manifest.artifact.webSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "webSha256"],
        message: "deployment and scan must pin the same web artifact",
      });
    }
    if (
      manifest.deployment.artifact.walletConnectProjectId !==
      manifest.artifact.buildInputs.walletConnectProjectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "buildInputs", "walletConnectProjectId"],
        message: "deployment and build must pin one WalletConnect project id",
      });
    }
    if (
      manifest.enablement.publicTraffic === "open" &&
      manifest.enablement.decision !== "approved"
    ) {
      context.addIssue({
        code: "custom",
        path: ["enablement"],
        message: "public traffic requires explicit 4C approval",
      });
    }
  });

export type Release4PromotionManifest = z.infer<
  typeof release4PromotionManifestSchema
>;

export function assertRelease4PromotionRecordIsSecretFree(
  value: unknown,
): void {
  const visit = (candidate: unknown, path: readonly string[]): void => {
    if (typeof candidate === "string") {
      if (
        /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)
      ) {
        throw new Error(
          `Release 4 promotion record contains a JWT at ${path.join(".")}`,
        );
      }
      if (/^(?:[a-z]+\s+){24}[a-z]+$/i.test(candidate.trim())) {
        throw new Error(
          `Release 4 promotion record contains mnemonic-shaped material at ${path.join(".")}`,
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => {
        visit(entry, [...path, String(index)]);
      });
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (
        !path.includes("secretRefs") &&
        /mnemonic|private.?key|jwt.?secret|admin.?token|turnstile.?secret|payment.?signature|signed.?txn|payload.?b64/i.test(
          key,
        )
      ) {
        throw new Error(
          `Release 4 promotion record contains forbidden secret field ${[...path, key].join(".")}`,
        );
      }
      visit(entry, [...path, key]);
    }
  };
  visit(value, []);
}

export function assertRelease4MayEnable(
  value: unknown,
): Release4PromotionManifest {
  assertRelease4PromotionRecordIsSecretFree(value);
  const manifest = release4PromotionManifestSchema.parse(value);
  if (manifest.enablement.decision !== "approved") {
    throw new Error(
      "Release 4 public traffic remains closed: 4C approval is withheld",
    );
  }
  return manifest;
}
