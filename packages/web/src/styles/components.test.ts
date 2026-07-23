import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "components.css"),
  "utf8",
);

it("slightly rounds rectangular controls while keeping board squares square", () => {
  expect(css).toMatch(
    /button:not\(\.sq\),\s*a\.btn,\s*a\.chip\.click \{\s*border-radius: 3px/,
  );
  expect(css).not.toMatch(/button\.sq \{[^}]*border-radius/);
});
