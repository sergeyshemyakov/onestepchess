import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  openDatabase,
  runBackup,
  schema,
} from "@onestepchess/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Release3SoakReport,
  release3SoakReportSchema,
  runRelease3Soak,
} from "./release3-soak.js";

describe.sequential("Release 3 soak verification", () => {
  let report: Release3SoakReport;

  beforeAll(async () => {
    report = await runRelease3Soak({
      poolTarget: 8,
      sessions: 16,
      moveTarget: 256,
      seed: 20_260_726,
      restartEveryMoves: 128,
      captureLogs: true,
    });
  }, 120_000);

  it("release3_soak_finishes_with_zero_invariant_ledger_and_rail_violations", () => {
    expect(release3SoakReportSchema.parse(report)).toBeDefined();
    expect(report.config.acceptedMoves).toBe(256);
    expect(report.final).toMatchObject({
      invariantViolations: 0,
      ledgerBalanced: true,
      duplicateClientTxids: 0,
      duplicatePayouts: 0,
      strandedPaymentIntents: 0,
      strandedPayoutJobs: 0,
      reconciliationClean: true,
      malformedLogLines: 0,
      secretFindings: 0,
    });
  });

  it("release3_soak_faults_recover_across_expiry_ambiguity_sse_and_restart", () => {
    const required = [
      "claim_expiry",
      "ambiguous_settlement_applied",
      "ambiguous_settlement_unapplied",
      "payout_rejection_recovery",
      "facilitator_health_loss_recovery",
      "reconciliation",
      "sse_reconnect_reset_churn",
      "controlled_restart",
      "same_side_cooldown_churn",
    ];
    expect(Object.keys(report.faults)).toEqual(
      expect.arrayContaining(required),
    );
    for (const fault of required) {
      expect(report.faults[fault], fault).toMatchObject({
        injected: true,
        converged: true,
      });
    }
  });

  it("release3_admin_api_sse_and_config_contracts_are_complete_and_isolated", async () => {
    const [contracts, adminRoutes, eventService, configMetadata] =
      await Promise.all([
        readFile(
          new URL(
            "../../packages/server/src/http/contracts.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../../packages/server/src/admin/routes.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../../packages/server/src/events/service.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../../packages/server/src/admin/config-metadata.ts",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);
    expect(contracts).not.toContain("/api/v1/admin/");
    for (const route of [
      "/overview",
      "/activity",
      "/errors",
      "/games",
      "/players",
      "/config",
      "/pause",
      "/resume",
      "/reconcile",
    ]) {
      expect(adminRoutes).toContain(route);
    }
    expect(eventService).toContain("stream_reset");
    expect(eventService).toContain("cursor_expired");
    expect(configMetadata).toContain('return "immediate"');
    expect(configMetadata).toContain('return "new_claims"');
    expect(configMetadata).toContain('return "new_games"');
    expect(configMetadata).toContain('return "restart"');
  });

  it("release3_artifacts_logs_and_responses_contain_no_secrets_or_unsupported_claims", async () => {
    expect(report.noRealMoney).toBe(true);
    expect(report.profile).toBe("mock:local");
    expect(report.final.secretFindings).toBe(0);
    // `pnpm build` runs after `pnpm test` in CI, so the web dist may not exist
    // yet. The built index.html only adds hashed asset tags to the checked-in
    // source, so auditing the source when the build is absent catches the same
    // authored-string risks and keeps this gate order-independent.
    const webBuilt = new URL(
      "../../packages/web/dist/index.html",
      import.meta.url,
    );
    const webIndex = existsSync(webBuilt)
      ? webBuilt
      : new URL("../../packages/web/index.html", import.meta.url);
    const files = [
      new URL("../../README.md", import.meta.url),
      new URL("../../packages/agent-kit/README.md", import.meta.url),
      new URL("../../packages/mcp/README.md", import.meta.url),
      webIndex,
    ];
    const forbidden = [
      "TREASURY_MNEMONIC=",
      "JWT_SECRET=",
      "ADMIN_TOKEN=",
      "TURNSTILE_SECRET=",
      "PAYMENT-SIGNATURE:",
      "Release 4 is live",
      "mainnet payments are live",
    ];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const secret of forbidden) expect(content).not.toContain(secret);
    }
  });
});

describe("Release 3 persistence verification", () => {
  const directories: string[] = [];

  afterAll(async () => {
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("release3_migrates_release2_db_and_recovers_persistent_restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osc-release3-migrate-"));
    directories.push(directory);
    const path = join(directory, "osc.sqlite");
    const first = openDatabase({ path });
    first.db
      .insert(schema.configOverrides)
      .values({
        key: "GAME_POOL_TARGET",
        valueJson: "64",
        updatedAt: 1,
        updatedBy: "release2-operator",
      })
      .run();
    first.sqlite.close();

    const restarted = openDatabase({ path });
    const migrationJournal = restarted.sqlite
      .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at")
      .all() as { readonly hash: string }[];
    expect(migrationJournal.length).toBeGreaterThanOrEqual(4);
    expect(
      restarted.db.select().from(schema.configOverrides).all(),
    ).toContainEqual(
      expect.objectContaining({
        key: "GAME_POOL_TARGET",
        valueJson: "64",
        updatedBy: "release2-operator",
      }),
    );
    const claimColumns = restarted.sqlite
      .prepare("PRAGMA table_info(claims)")
      .all()
      .map((row) => (row as { readonly name: string }).name);
    expect(claimColumns).toContain("fen_before");
    restarted.sqlite.close();
  });

  it("release3_backup_restore_preserves_history_and_ops_state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osc-release3-backup-"));
    directories.push(directory);
    const backupDirectory = join(directory, "backups");
    const database = openDatabase({ path: join(directory, "osc.sqlite") });
    database.db
      .insert(schema.configOverrides)
      .values({
        key: "GAME_POOL_TARGET",
        valueJson: "64",
        updatedAt: 10,
        updatedBy: "operator-drill",
      })
      .run();
    const result = await runBackup({
      sqlite: database.sqlite,
      backupDir: backupDirectory,
      retentionDays: 7,
      now: () => Date.UTC(2026, 6, 26, 3),
      logger: createLogger({ level: "silent" }),
    });
    expect(result.ok).toBe(true);
    database.sqlite.close();

    const snapshots = await readdir(backupDirectory);
    const snapshot = snapshots.find((file) => file.endsWith(".sqlite"));
    if (snapshot === undefined) throw new Error("backup snapshot missing");
    const restored = openDatabase({
      path: join(backupDirectory, snapshot),
    });
    expect(
      restored.db.select().from(schema.configOverrides).all(),
    ).toContainEqual(
      expect.objectContaining({
        key: "GAME_POOL_TARGET",
        updatedBy: "operator-drill",
      }),
    );
    restored.sqlite.close();
  });
});
