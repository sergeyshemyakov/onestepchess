import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// §4.3 pinned index.html content (server CA-7, web side).

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
  "utf8",
);

describe("index.html pinned content snapshot (#27)", () => {
  it("carries the agent comment", () => {
    expect(html).toContain("Agent? You don't need this UI. Start at /llms.txt");
  });

  it("links /llms.txt as the machine-readable alternate", () => {
    expect(html).toMatch(
      /<link rel="alternate" type="text\/markdown" href="\/llms\.txt"\s+title="One Step Chess — agent guide">/,
    );
  });

  it("carries the pinned meta description", () => {
    expect(html).toContain(
      'content="strangers and machines share a chess game — you play exactly one of its moves. paid per move in USDC on Algorand."',
    );
  });

  it("declares the site icons the Bazaar crawler reads for the logo", () => {
    expect(html).toContain(
      '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    );
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    );
  });

  it("carries the osc:og placeholder for server-side OG injection", () => {
    expect(html).toContain("<!-- osc:og -->");
  });

  it("loads no external fonts or scripts (self-hosted posture, §4.3)", () => {
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toMatch(/<script[^>]+src="https?:\/\//);
  });
});
