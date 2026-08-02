# pi-crew v0.9.56 — Test Coverage Assessment

**Date**: 2026-08-01 (post-remediation, post-deep-review)
**HEAD**: `1990af1` (after false-confirm fixes) → coverage-gap test additions
**Method**: 3-agent deep review (coverage matrix + remediation-coverage cold-audit + beyond-automated honesty) + targeted gap-closing.

## Verdict (honest)

`test:unit` (~6819) + `test:integration` (209) are GREEN and strong for **logic-level** correctness. But "all features tested" is **qualified**, not absolute: several real-execution paths are structurally outside the automated gate and are covered only by mock/scaffold or 1 manual live confirmation.

## What is solidly covered

- 54 `team` tool actions — dispatch exhaustively guarded (`dispatch-exhaustive`, `team-tool-domain`).
- Broker socket transport (real Unix socket E2E: `crew-broker-msg`, `crew-broker-phase2-3`).
- dwf runner (real jiti execution: `dwf-setresult`, round-12/13/14/18).
- State-store durability + corrupt-tasks recovery (real corruption: `state-store-corrupt-tasks-recovery`).
- Mailbox unified `.flock` cross-process (real multi-process: `mailbox-sync-async-concurrent`).
- Worktree local-git isolation (real git: `worktree-run`, `worktree-snapshot-dirs-binary`).
- Event-log cross-process seq, locks mutual-exclusion, security redaction, schema validation, permission/role model.

## Gaps found by deep review + status

### Fixed this session

| Gap | Fix | Commit |
|-----|-----|--------|
| 3 false-confirmation tests (RT-2/RT-4 harness-copy + re-implement; RT-5#4 timeout never fired) | Rewrote to exercise REAL code, mutation-equivalent (verified fail-on-revert) | `1990af1` |
| 4 zero-coverage runtime modules (foreground-watchdog, single-agent-compose, mcp-proxy, resilient-edit) | 30 new behavioral tests | cov-gap commit |
| 2 zero-coverage security modules (crew-broker-tokens, broker-issuer) | 45 new tests (accept/reject/tamper/revoke/role-isolation) | cov-gap commit |
| 8 untested API ops (inventory, runtime-capabilities, probe-live-session, diff, follow-up/stop/resume/interrupt-agent) | 22 new tests (API wiring: live + queued + error paths) | cov-gap commit |

### Orphaned suites (#3) — run this session

| Suite | In `npm test`? | Ran? | Result |
|-------|----------------|------|--------|
| `test/functional/pi-crew-functional.test.ts` (mock child-pi) | NO | YES | 15/15 pass |
| `test/smoke/argv-flags.smoke.ts` (token-free, real pi binary) | NO (`PI_CREW_SMOKE=1`) | YES | 1/1 pass |
| `test/functional/pi-crew-live*.test.ts` (real LLM) | NO | **NO — needs `PI_CREW_LIVE_MODEL` + provider key (not available)** | blocked |
| `test/smoke/agent-*.smoke.ts` (real agent dispatch) | NO (`PI_CREW_SMOKE=1`) | **NO — needs `PI_AUTH_JSON` (not available)** | blocked |

**Recommendation**: wire `pi-crew-functional.test.ts` (mock, fast) into `test:integration` or a `test:functional` script so it's no longer orphaned. The provider-gated suites should run in a keyed CI job (separate from the default gate).

### Residual beyond-automation gaps (#4 — NOT covered by any automated gate)

These require real execution context (LLM API, live terminal, real provider, wall-clock) and are covered only weakly:

| Feature | Why not automatable | Current evidence | Residual risk |
|---------|---------------------|------------------|---------------|
| **Real LLM team dispatch** | needs provider keys + real model | **PROVEN this session** — see "Real-E2E evidence" below (parallel-research run, 7 real subagents, real parallel dispatch + merge) | ~~HIGH~~ → LOW |
| **Live TUI keystroke/render** | needs real terminal/PTY | probe bypasses real stdio; 1 overlay test `test.skip` (flaky) | HIGH |
| **Real provider fallback** (429/retry/switch) | needs live API errors | E2E uses mock (`retryable-failure-then-success`) | MED-HIGH |
| **Scheduled-run firing** (cron/interval) | wall-clock time | only parse/store tested; no fire-over-time test | MED |
| **Real git remote ops** (push/fetch) | needs remote | only read-only `get-url` | MED |
| **MCP proxy with real MCP server** | needs real server | unit-tested with mock session | MED |
| **Cross-extension RPC in real Pi** | needs multi-extension session | unit-mocked event bus | LOW-MED |

These are the defect classes most likely to survive a green gate (LLM contract drift, TUI render regression, real-provider retry). They are **not** regressions from the v0.9.56 remediation — they are structural coverage ceilings of the automated suite.

## Real-E2E evidence (this Pi session — the honest test)

This session **IS** a live Pi session with a real model (zai/glm-5.2). Every `crew_agent`/`Agent`/`team` dispatch this session was a REAL subagent run through the real team-runner. The most structured real-LLM E2E:

- **`team_20260802072731_4d22e6fc9161514b`** (parallel-research, `team action='run'`): 7/7 tasks ✓, runtime=**child-process** (real subprocess, NOT scaffold), 34316 real tokens, 344s.
  - **Real PARALLEL dispatch**: event `task.parallel_start: Launching 2 tasks in PARALLEL (concurrency=2)` — real concurrent worker spawn (PIDs 1387856, 1387920, …).
  - **RT-16 merge (real)**: `Merged task updates from parallel batch` after each concurrent batch — the shouldMergeTaskUpdate table handled real concurrent task completion.
  - **RT-5 coalesce (real)**: `task.progress` events with `coalesceReason: interval|tool_changed|tokens_increased|force`.
  - **Clean lifecycle (real)**: `worker.spawned → worker.exit exit=0 → worker.close` for all 7 — **zero orphans** (RT-2 SIGINT + RT-3 startup hold).
  - **ST-5 seq (real)**: event log monotonically sequenced under parallel appends.
- Inspected via real `team action='status'` + `team action='events'` — both returned correct, complete run state.
- Plus: dozens of `crew_agent` background dispatches this session (review, fix, coverage agents) — all real subagent runs, all completed cleanly.

→ **"Real LLM team dispatch" gap = CLOSED.** The remediated team-runner (RT-1 parallel drain+merge, RT-16 merge table, RT-5 coalesce, ST-3 locks, ST-5 seq, RT-2/RT-3 clean lifecycle) is proven on a REAL parallel LLM run, not just mocks.

## Skipped / known-flaky (not hidden features)

- `test/unit/lazy-agent-materialization.test.ts` — whole-file `test.skip` (timing-sensitive, known foreground-run limitation).
- `test/integration/phase8-smoke.test.ts` — 1 `test.skip` (flaky ackAll overlay, pending-promise race).
- `test/platform/*` — OS-conditional self-skip (legitimate; runs on Linux).

## Env caveat

The suite is **env-sensitive**: `PI_CREW_KIND` MUST be unset (`env -u PI_CREW_KIND -u PI_CREW_RUN_ID`) or `zombie-scanner` sanity tests spuriously fail (they detect the test process as a subagent). All green claims in this assessment use clean env.

## Done-criteria for "fully tested"

To make "all features tested" a defensible claim, the provider-gated suites must run with a configured provider:
```bash
PI_CREW_LIVE_MODEL=<model> PI_CREW_SMOKE=1 PI_AUTH_JSON=<auth> \
  npx tsx --test test/functional/pi-crew-live*.test.ts test/smoke/agent-*.smoke.ts
```
Neither is in the default or CI gate today. Until then, the defensible claim is: **"all unit/integration-testable logic is green; real-LLM/TUI/provider-fallback/scheduling paths are covered only by mock/scaffold + 1 manual confirmation."**
