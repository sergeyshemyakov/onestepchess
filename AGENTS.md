# AGENTS.md

One Step Chess (OSC): plain pnpm workspaces TypeScript monorepo (no Turborepo),
Node 22 LTS, strict TS. npm packages are scoped `@onestepchess/*` — never `osc-*`.
Packages: `core` (pure domain, zero I/O), `rail-avm`/`rail-mock` (payment rail),
`server` (Hono + better-sqlite3 + Drizzle), `web` (React 19 + Vite), `mcp`,
`agent-kit`; plus `e2e/` (Playwright + chain smoke) outside `packages/`.
Full architecture: `docs/spec/` (stack pins:
`docs/spec/2026-07-10-tech-stack-and-monorepo.md`). Decisions: `docs/adr/`.
If `docs/spec/` does not cover your task, stop and ask — do not invent
architecture or design decisions on the fly.

## Commands

- Install: `pnpm install`
- Lint: `pnpm lint` (Biome — also the formatter; no ESLint/Prettier)
- Typecheck: `pnpm typecheck`
- Test: `pnpm test` (vitest; `core` also uses fast-check property tests)
- Build: `pnpm build`

Run lint, typecheck, test, and build before opening or updating a PR — CI
runs the same four and all must pass locally first.

## Code style

- Zod for all API and config schemas; no hand-rolled validation.
- `core` has zero I/O — pure functions only, everything else is an adapter.
- Structured logs via `pino`, no `console.log`.
- Comments explain *why*, not *what* — invariants, non-obvious constraints,
  workarounds. Do not narrate what the next line does. No comments at all is
  the default; only add one if removing it would let a future reader make a
  mistake.

## Task tracking

- The board is the One Step Chess GitHub Project; cards are GitHub Issues in
  this repo. Columns: Backlog → Ready → In Progress → In Review → Done.
- Use the `gh` CLI to read and update cards (`gh issue view <id>`,
  `gh issue comment`, `gh project item-edit`).
- In Codex, run `gh` with escalated host access because the sandbox cannot
  read macOS Keychain credentials even when terminal authentication works.
- Only pick up cards in Ready; move your card to In Progress when you start
  and to In Review when the PR is open.
- Project: repo `sergeyshemyakov/onestepchess`, GitHub Project #2 "One Step
  Chess project" (owner `sergeyshemyakov`, project id
  `PVT_kwHOBeXyvc4BdCel`); list cards with `gh project item-list 2 --owner
  sergeyshemyakov`.
- Status field id `PVTSSF_lAHOBeXyvc4BdCelzhXm8QY`, option ids: Backlog
  `f75ad846`, Ready `61e4505c`, In progress `47fc9ee4`, In review
  `df73e18b`, Done `98236657` — set with `gh project item-edit --project-id
  PVT_kwHOBeXyvc4BdCel --id <item-id> --field-id
  PVTSSF_lAHOBeXyvc4BdCelzhXm8QY --single-select-option-id <option-id>`.

## Branch & PR conventions

- Open PRs as draft until local lint/typecheck/test all pass.
- PR description links the card (`Fixes #<id>`), lists acceptance criteria
  as a checklist, and includes test evidence.
- Never push to `main` directly; squash-merge on approval.

## Testing policy

- Each acceptance criterion on a card gets one named test — coverage % is
  not the target, acceptance-criteria coverage is.
- Write the failing test from the acceptance criterion before/alongside the
  implementation, not after.
- "No change needed" is a valid outcome for a card — do not manufacture a
  diff to look busy.

## Security

- Never commit secrets: `TREASURY_MNEMONIC`, `JWT_SECRET`, `ADMIN_TOKEN`,
  wallet mnemonics or keyfiles. Secrets live in env / untracked `.env`
  (including `.env.testnet`) only.
- Tests, CI, and local dev run against `rail-mock` — never Algorand mainnet,
  and never any real facilitator or chain in CI. Testnet smoke scripts
  (free testnet USDC) run only on an explicit request; mainnet smoke scripts
  (real USDC) run only when a human explicitly asks. (ADR 0001)

## Out of scope for an agent session

- Do not edit files under `docs/adr/` other than adding a new, numbered ADR.
  Past decisions are immutable; supersede them with a new ADR instead of
  editing the old one.
- Architectural decisions belong in `docs/adr/`, not inline in code or PR
  descriptions only.
