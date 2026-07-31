import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "components.css"),
  "utf8",
);

it("rounds only landing and Hub play CTAs beyond the base control radius", () => {
  expect(css).toMatch(
    /button:not\(\.sq\),\s*a\.btn,\s*a\.chip\.click \{\s*border-radius: 3px/,
  );
  expect(css).toMatch(
    /\.ctas \.bigplay,\s*\.hub-actions \.bigplay \{\s*border-radius: 12px/,
  );
  expect(css).not.toMatch(/button\.sq \{[^}]*border-radius/);
});

it("keeps the final-move board preview compact", () => {
  expect(css).toMatch(
    /\.confirm-board-loop \{\s*width: min\(220px, 100%\);\s*margin: 8px 0 12px;\s*margin-inline: auto/,
  );
});

it("gives payout notifications enough width for the confirmation link", () => {
  expect(css).toMatch(
    /#toasts \{[^}]*width: min\(380px, calc\(100vw - 40px\)\)/s,
  );
});

it("centers the setup heading while left-aligning its centered copy column", () => {
  expect(css).toMatch(/\.guide \{\s*text-align: center;/);
  expect(css).toMatch(
    /\.checklist \{[^}]*max-width: 62ch;[^}]*margin: 14px auto 0;[^}]*text-align: left;/s,
  );
  expect(css).toMatch(
    /\.guide-full \{[^}]*max-width: 62ch;[^}]*margin: 18px auto 0;[^}]*text-align: left;/s,
  );
});

it("removes the dashed coach box", () => {
  const coach = css.match(/\.coach \{([^}]*)\}/)?.[1] ?? "";
  expect(coach).toContain("white-space: pre-line");
  expect(coach).not.toContain("border");
});
