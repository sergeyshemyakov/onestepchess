import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startStdio } from "../../../mcp/src/stdio-server.js";
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
  "PAYMENT_PENDING",
  "BUDGET_EXCEEDED",
];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("/llms.txt (agent spec §9)", () => {
  it("llms_txt_has_exact_sections_unique_anchors_and_every_error", () => {
    const sectionHeadings = headings("##").filter((h) => !h.startsWith("##"));

    expect(sectionHeadings).toEqual(PINNED_SECTIONS);

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

    // Production copy names the final packages and their pinned environment.
    expect(LLMS_TXT).toContain("@onestepchess/mcp");
    expect(LLMS_TXT).toContain("@onestepchess/agent-kit");
    expect(LLMS_TXT).toContain("OSC_SERVER_URL");
    expect(LLMS_TXT).toContain('method: "txn"');
    expect(LLMS_TXT).toContain("fallbackTxnB64");
    expect(LLMS_TXT).toContain('meta.network.caip2 === "mock:local"');
    expect(LLMS_TXT).toContain("Release 4 supports");
    expect(LLMS_TXT).toContain("two-transaction fee-payer group");
    expect(LLMS_TXT).not.toMatch(
      /https:\/\/play\.onestepchess\.com|OSC_EXPECT_NETWORK": "mainnet"/,
    );
  });

  it("every_server_error_docs_url_resolves_to_llms_anchor", () => {
    const anchors = new Set(
      headings("####").map((heading) => `#${slug(heading)}`),
    );
    for (const code of REQUIRED_ERROR_CODES) {
      const docs = new URL(
        `https://osc.example/llms.txt#err-${code.toLowerCase()}`,
      );
      expect(docs.pathname, code).toBe("/llms.txt");
      expect(anchors.has(docs.hash), code).toBe(true);
    }
  });

  it("mcp_quickstart_configuration_is_copy_paste_runnable", async () => {
    const block = LLMS_TXT.match(
      /## Quickstart: MCP[\s\S]*?```json\n([\s\S]*?)\n```/,
    )?.[1];
    expect(block).toBeDefined();
    const config = JSON.parse(block ?? "{}") as {
      mcpServers: {
        "one-step-chess": {
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };
    const documented = config.mcpServers["one-step-chess"];
    expect(documented.command).toBe("npx");
    expect(documented.args).toEqual(["-y", "@onestepchess/mcp"]);
    expect(documented.env.OSC_EXPECT_NETWORK).toBe("mock");

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const output = new Promise<string>((resolve) => {
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    const server = await startStdio({
      env: {
        ...documented.env,
        OSC_KEYFILE: "/tmp/osc-documented-config-test/keyfile.json",
      },
      stdin,
      stdout,
      stderr: new PassThrough(),
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "documented-config-test", version: "1" },
        },
      })}\n`,
    );
    const response = JSON.parse(await output) as {
      result: { serverInfo: { name: string } };
    };
    expect(response.result.serverInfo.name).toBe("onestepchess");
    await server.close();
  });

  it("skill_and_readmes_reference_only_public_surfaces", () => {
    const files = [
      "README.md",
      "packages/agent-kit/README.md",
      "packages/mcp/README.md",
      "skills/one-step-chess/SKILL.md",
    ];
    const copy = files.map((file) =>
      readFileSync(join(REPO_ROOT, file), "utf8"),
    );
    for (const [index, text] of copy.entries()) {
      expect(text, files[index]).toMatch(/\/llms\.txt/);
      expect(text, files[index]).not.toMatch(
        /\/Users\/|docs\/spec|docs\/adr|TREASURY_MNEMONIC|JWT_SECRET|ADMIN_TOKEN|private bot/i,
      );
      expect(text, files[index]).not.toMatch(
        /Release 3 supports (testnet|mainnet)|live exact payments are enabled/i,
      );
    }
    expect(copy[3]).toContain("name: one-step-chess");
    expect(copy[3]).toContain("final, no undo");
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
