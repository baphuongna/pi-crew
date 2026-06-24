# Harness Backlog

Use when an agent discovers a missing harness capability but should not change the operating model immediately.

## Items

### HB-001: Integration test harness

**Discovered while**: Review round 9 — all tests are unit tests, no multi-module integration tests exist.

**Current pain**: Cannot verify team-runner → state-store → child-process integration end-to-end without manual testing.

**Suggested improvement**: Add `test/integration/` with real file-system state, real child processes (with timeout).

**Risk**: normal

**Status**: ✅ PARTIALLY DONE (2026-06-24). The bulk of HB-001 was already
covered by 21 existing `test/integration/` files (team-runner path via
`mock-child-run`, `full-feature-smoke`, `phase3-6-*`). The genuine remaining
gap — interleaved manifest+task+event writes reloaded consistently (the
realistic run-load pattern) — is now covered by
`test/integration/state-durability-hb001.test.ts`. Child-process exit →
state-store reconcile is covered by `async-restart-recovery.test.ts`.

### HB-002: Windows-specific test coverage

**Discovered while**: RR-002 Windows EBUSY fix — only tested manually, no automated Windows-specific tests.

**Current pain**: Windows bugs only caught in CI, not locally.

**Suggested improvement**: Add `test/platform/` with Windows-specific tests (EBUSY retry, path handling).

**Risk**: normal

**Status**: ✅ DONE (2026-06-24). `test/platform/` ships with two files:
`windows-rename.test.ts` (EBUSY/EPERM rename retry path via `renameWithRetry`,
self-skips off win32) and `posix-tools.test.ts` (BSD-vs-GNU grep, /var →
/private/var realpath, POSIX-shell resolution — self-skips on win32).
Runbook in `test/platform/README.md`. The CI OS matrix (ubuntu/windows/macos)
exercises each platform's tests.

### HB-003: Performance regression baseline

**Discovered while**: Review noted `sleepSync` busy-wait on Windows — no perf benchmarks exist.

**Current pain**: Cannot detect performance regressions.

**Suggested improvement**: Add benchmark suite for critical paths (state writes, event append, task dispatch).

**Risk**: tiny

**Status**: ✅ DONE (2026-06-24). `test/bench/` now has 6 benchmarks:
the pre-existing `register-startup`, `render-flush`, `snapshot-cache`, plus
three new ones covering the gaps HB-003 flagged — `atomic-write.bench.ts`
(`atomicWriteJson` cold/warm), `event-append.bench.ts` (serial lock
contention vs batch), `task-graph-scheduler.bench.ts` (DAG build/refresh/
full-run). All run via `npm run bench` → `test/bench/results.json`; baseline
via `npm run bench:capture`. Each prints min/p50/p95/p99/max percentiles.

### HB-004: Real-binary smoke tests for ctx.agent() paths

**Discovered while**: Real-world `team action='run'` smoke testing on 2026-06-24
caught three bugs that the unit suite (which mocks child-pi) missed entirely.

**Current pain**: The unit tests for `dynamic-workflow-context.ts` and
`child-pi.ts` use `PI_TEAMS_MOCK_CHILD_PI` and never shell out to the real `pi`
binary. As a result they cannot catch:
  - argv flags the real `pi` rejects (e.g. the `--crew-subagent` regression),
  - env/persona interactions that change real model output (e.g. the
    schema+systemPrompt drop),
  - exit-code races in the real spawn lifecycle (e.g. the
    `disableTools:true` → `exit null` race).

**Suggested improvement**: Add `test/smoke/` (gated behind a `PI_CREW_SMOKE=1`
env so CI doesn't bill tokens by default) that runs real `.dwf.ts` workflows
end-to-end via `team action='run'` and asserts on the resulting
`events.jsonl` + `summary.md`. One workflow per feature family
(phase/log/pipeline/agent/schema/worktree). Document the runbook in
`docs/troubleshooting.md`.

**Risk**: normal (token cost when run; otherwise read-only)

**Status**: ✅ DONE (2026-06-24). `test/smoke/` shipped with 5 smoke tests
(argv-flags, agent-plain, agent-schema, agent-disabletools, dwf-workflow),
all gated behind `PI_CREW_SMOKE=1`. `npm run test:smoke` runs them. CI
manual-dispatch workflow at `.github/workflows/smoke.yml` (requires
`PI_AUTH_JSON` secret). Runbook in `docs/troubleshooting.md`. Each smoke test
maps to a real bug it would have caught (HB-003a, the schema+systemPrompt
drop, the `--crew-subagent` argv regression).
