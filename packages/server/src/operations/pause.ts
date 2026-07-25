import { eq } from "drizzle-orm";
import type { CommandContext } from "../coordinator/queue.js";
import type { Db } from "../db/open.js";
import { schema } from "../db/open.js";

export type PauseState = {
  readonly mode: "running" | "paused";
  readonly causes: readonly string[];
  readonly banner: string | null;
};

const DEFAULT_BANNERS: Readonly<Record<string, string>> = {
  manual: "Maintenance in progress",
  reconciliation: "Gameplay paused while treasury records are reconciled",
  facilitator: "Gameplay paused while payment service recovers",
  reconciliation_dependency:
    "Gameplay paused while treasury balance checks recover",
  treasury: "Gameplay paused to protect player funds",
  conservation: "Gameplay paused for an accounting safety check",
};

function parseCauses(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed.filter((cause): cause is string => typeof cause === "string"),
    ),
  ];
}

export function readPauseState(db: Db): PauseState {
  const row = db
    .select({
      causes: schema.systemState.pauseCausesJson,
      banner: schema.systemState.banner,
    })
    .from(schema.systemState)
    .get();
  const causes = row === undefined ? [] : parseCauses(row.causes);
  return {
    mode: causes.length === 0 ? "running" : "paused",
    causes,
    banner: causes.length === 0 ? null : (row?.banner ?? defaultBanner(causes)),
  };
}

function defaultBanner(causes: readonly string[]): string | null {
  for (const cause of [
    "reconciliation",
    "facilitator",
    "reconciliation_dependency",
    "treasury",
    "conservation",
  ]) {
    if (
      causes.some((value) => value === cause || value.startsWith(`${cause}:`))
    ) {
      return DEFAULT_BANNERS[cause] ?? "Gameplay paused";
    }
  }
  return causes.length === 0 ? null : "Gameplay paused";
}

export function updatePauseCause(
  db: Db,
  ctx: CommandContext,
  input: {
    readonly cause: string;
    readonly active: boolean;
    readonly manualBanner?: string | null;
  },
): { readonly changed: boolean; readonly state: PauseState } {
  const before = readPauseState(db);
  const causes = new Set(before.causes);
  if (input.active) causes.add(input.cause);
  else causes.delete(input.cause);
  const nextCauses = [...causes];

  let banner: string | null;
  if (nextCauses.includes("manual")) {
    if (input.cause === "manual" && input.active) {
      banner =
        input.manualBanner?.trim() ||
        DEFAULT_BANNERS.manual ||
        "Maintenance in progress";
    } else {
      banner =
        before.banner ?? DEFAULT_BANNERS.manual ?? "Maintenance in progress";
    }
  } else {
    banner = defaultBanner(nextCauses);
  }
  const next: PauseState = {
    mode: nextCauses.length === 0 ? "running" : "paused",
    causes: nextCauses,
    banner,
  };
  const changed =
    before.mode !== next.mode ||
    before.banner !== next.banner ||
    before.causes.join("\0") !== next.causes.join("\0");
  if (!changed) return { changed: false, state: before };

  db.update(schema.systemState)
    .set({
      pauseCausesJson: JSON.stringify(next.causes),
      banner: next.banner,
      updatedAt: ctx.now,
    })
    .where(eq(schema.systemState.id, 1))
    .run();
  if (before.mode !== next.mode || before.banner !== next.banner) {
    ctx.appendEvent("system_banner", null, {
      mode: next.mode,
      banner: next.banner,
    });
  }
  return { changed: true, state: next };
}
