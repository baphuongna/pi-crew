# test/unit/ — unit-test cluster map

Unit tests for pi-crew, organized to **mirror `src/`**. After the v0.9.x
reorg, 566 `.test.ts` files moved into 35 leaf subdirectories; the remaining
cross-cutting tests stay at this root by design.

## Clustered directories (mirror `src/`)

| Dir | Tests | Mirrors |
|-----|-------|---------|
| [`runtime/`](./runtime/) | 244 | `src/runtime/` — 14 subclusters (broker/, child-pi/, compaction/, core/, goal-workflow/, heartbeat/, live-session/, model/, output/, process/, recovery/, scheduling/, task-runner/, verification/) |
| [`state/`](./state/) | 53 | `src/state/` — 3 subclusters (coordination/, event-log/, stores/) |
| [`extension/`](./extension/) | 110 | `src/extension/` — 3 subclusters (core/, registration/, team-tool/) |
| [`ui/`](./ui/) | 22 | `src/ui/` — TUI, dashboard, overlays |
| [`config/`](./config/) | 17 | `src/config/` — schema, defaults, sanitizer |
| [`observability/`](./observability/) | 16 | `src/observability/` — metrics, exporters, OTLP |
| [`teams/`](./teams/) | 15 | `src/teams/` — team definitions |
| [`workflows/`](./workflows/) | 15 | `src/workflows/` — workflow topology/preflight |
| [`utils/`](./utils/) | 37 | `src/utils/` — shared helpers |
| [`schema/`](./schema/) | 9 | `src/schema/` — validation schemas |
| [`agents/`](./agents/) | 6 | `src/agents/` — discovery/overrides |
| [`hooks/`](./hooks/) | 5 | `src/hooks/` — hook system |
| [`worktree/`](./worktree/) | 5 | `src/worktree/` — worktree isolation |
| [`tools/`](./tools/) | 4 | `src/tools/` — custom tool definitions |
| [`security/`](./security/) | 3 | pre-existing (security invariants) |
| [`skills/`](./skills/) | 2 | `src/skills/` — SKILL.md validation |
| [`prompt/`](./prompt/) | 2 | `src/prompt/` — prompt building |

## Cross-cutting tests (stay at root — by design)

151 tests are intentionally **flat at `test/unit/` root** because they span
multiple clusters or cover package/infra concerns:

- `round*.test.ts` — cross-cutting regression rounds (round15–round30)
- `v0-*-*.test.ts` — version interop / policy-unification tests
- `package-*.test.ts` — npm-package integrity (ships-src, snapshot, no-dev-scripts)
- `errors.test.ts`, `i18n*.test.ts`, `bundle-*.test.ts` — shared infra
- plus assorted misc (crew-*, discover-*, atomic-write-*, etc.)

## Test runner

`npm test` (unit) runs `node scripts/test-runner.mjs 'test/unit/**/*.test.ts'`.
The runner **expands recursive `**` globs itself** — Node v22's `--test` only
expands single-level `*`, so without this, tests in subdirectories (e.g.
`test/unit/security/`) were **invisible** to `npm test`. Keep new tests in
the matching cluster; when a test is genuinely cross-cutting, leave it at
the root.
