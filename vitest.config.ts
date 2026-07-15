import { defineConfig } from "vitest/config";

// Unit tests only, straight from sources: compiled output must never be
// re-run, and e2e's Playwright specs (which need a running app) stay out
// of the root test command.
function project(name: string, root: string) {
  return {
    test: {
      name,
      root,
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      project("@onestepchess/core", "packages/core"),
      project("@onestepchess/rail-avm", "packages/rail-avm"),
      project("@onestepchess/rail-mock", "packages/rail-mock"),
      project("@onestepchess/server", "packages/server"),
      project("@onestepchess/web", "packages/web"),
      project("@onestepchess/mcp", "packages/mcp"),
      project("@onestepchess/agent-kit", "packages/agent-kit"),
      project("@onestepchess/e2e", "e2e"),
    ],
  },
});
