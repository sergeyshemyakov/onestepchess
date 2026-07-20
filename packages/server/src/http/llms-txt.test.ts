import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { createApp, ERROR_STATUS } from "./app.js";
import { LLMS_TXT, registerLlmsRoute } from "./llms-txt.js";

/** GitHub's heading-slug algorithm (the anchor contract — agent spec §9):
 * downcase, drop punctuation except word chars/space/hyphen, spaces → hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headings(prefix: string): string[] {
  const marker = `${prefix} `;
  return LLMS_TXT.split("\n")
    .filter((line) => line.startsWith(marker) && !line.startsWith(`${prefix}#`))
    .map((line) => line.slice(marker.length).trim());
}

const PINNED_SECTIONS = [
  "What this is",
  "Quickstart: MCP",
  "Quickstart: HTTP",
  "Wallet and funding",
  "Rules for agents",
  "Etiquette",
  "Errors",
  "Interactive play",
];

// The server emits `docs = {base}/llms.txt#err-{code}` for every envelope code
// (CA-M1); the file must anchor all of them, plus the §6.2 204 code and the
// client-side budget code the agent spec pins.
const REQUIRED_ERROR_CODES = [
  ...Object.keys(ERROR_STATUS),
  "NO_BOARDS",
  "BUDGET_EXCEEDED",
];

describe("/llms.txt (agent spec §9)", () => {
  it("llms_txt_has_stable_headings_and_every_error_anchor", () => {
    const sectionHeadings = headings("##").filter((h) => !h.startsWith("##"));

    for (const section of PINNED_SECTIONS) {
      expect(sectionHeadings).toContain(section);
    }

    const errorHeadings = headings("####");
    for (const code of REQUIRED_ERROR_CODES) {
      const anchor = `err-${code.toLowerCase()}`;
      const match = errorHeadings.find((h) => slug(h) === anchor);
      expect(match, `missing #### heading for ${code}`).toBeDefined();
    }

    const allAnchors = [...headings("##"), ...headings("###"), ...errorHeadings]
      .map(slug)
      .filter((a) => a.length > 0);
    expect(new Set(allAnchors).size, "anchor collision").toBe(
      allAnchors.length,
    );

    // Honest Release 2 copy: the MCP/agent-kit packages are not published yet.
    expect(LLMS_TXT).toContain("@onestepchess/mcp");
    expect(LLMS_TXT).toContain("@onestepchess/agent-kit");
    expect(LLMS_TXT).toMatch(/not yet published/i);
    expect(LLMS_TXT).not.toMatch(/available now/i);
  });

  it("serves /llms.txt as text/markdown", async () => {
    const app = createApp({
      logger: createLogger({ level: "silent" }),
      publicBaseUrl: "https://osc.example",
      mode: () => "running",
    });
    registerLlmsRoute(app);
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(LLMS_TXT);
  });
});
