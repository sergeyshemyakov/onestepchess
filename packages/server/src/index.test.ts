import { STARTING_FEN } from "@onestepchess/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

describe("server placeholder", () => {
  it("serves the health endpoint", async () => {
    const res = await createApp().request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("resolves @onestepchess/core through the workspace", async () => {
    const res = await createApp().request("/api/v1/meta");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ startingFen: STARTING_FEN });
  });

  it("loads the native sqlite driver", () => {
    const db = new Database(":memory:");
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
  });
});
