# pi-crew v0.9.42 — Authoritative Upgrade Review

**Date:** 2026-07-18 · **Version reviewed:** v0.9.42 · **LOC:** ~87K TS across ~431 source files

**Methodology (three independent passes):**
1. **Parallel-research** (3 explorers + analyst + writer) — structural review across core/UI/runtime.
2. **Cold verification** (3 `cold-verifier` agents) — every claim re-derived from live source; 1 agent re-covered a failed shard. Caught 3 false findings, 4 miscounts, added 14 findings.
3. **Deep dig** (2 `security-reviewer` + 1 `explorer`) — concurrency/race audit, STRIDE security audit, bundle-deadcode + error/leak sweep. Added 28 findings.

Every finding below is **source-verified** (file:line + code). Findings marked ❌ in the audit trail were removed after cold verification.

---

## Executive Summary

pi-crew v0.9.42 is a **mature, battle-hardened** multi-agent orchestration extension (40+ security-hardening rounds, 400+ unit tests, 3-OS CI). **Security rating "Excellent" is independently CONFIRMED** — 0 CRITICAL, 0 HIGH vulnerabilities in pi-crew's own code.

This review identifies **77 verified upgrade opportunities** across 10 dimensions. The highest-leverage themes:

| # | Theme | Why it matters |
|---|-------|----------------|
| 1 | **Lock re-entrance correctness** (CONC-1) | A single architectural bug enables state corruption, lost updates, and zombie-masking. Root cause of 3 other findings. |
| 2 | **Sync I/O elimination** | 8 `sleepSync` sites + sync `readFileSync` in UI render block the event loop, defeating AbortSignal/graceful shutdown. |
| 3 | **Lock mechanism unification** | 3 parallel lock systems (~800 LOC) with documented deadlock history. |
| 4 | **Bundle bloat** | `acorn` (225KB) + `@sinclair/typebox` (245 modules) wrongly bundled ≈ **~470KB removable** with 2 one-line fixes. |
| 5 | **Dead/scaffolded infra** | Plugin registry, coalesced dispatch, prometheus exporter, stream-preview, child-pi-pool — designed but producing zero value. |
| 6 | **Prompt-injection surface** | 2 sanitizer-bypass spots (`step.task` raw, unauthenticated live-control channel). |

---

## Priority Legend
- **🔴 HIGH** — correctness/reliability/security/bundle impact, affects production
- **🟡 MEDIUM** — significant quality/perf/maintainability impact
- **🟢 LOW** — polish, small wins, forward-looking

---

# 🔴 HIGH Priority

### H-1 · Lock re-entrance guard is process-global, not per-callstack → lock bypass
**File:** `src/state/locks.ts:288-324` (`withRunLock`, `withRunLockSync`) · **Theme:** Concurrency
The re-entrance guard (`runLockHeldByUs: Map<filePath, token>`) is meant for same-callstack re-entrance, but is a process-global Map. In Node's async model, when an async `withRunLock` holder `await`s, a concurrent `withRunLockSync` for the **same run** sees the holder's token and **bypasses lock acquisition entirely**.
**Repro:** team-runner merge acquires lock → `await saveRunManifestAsync(...)` yields → auto-repair timer's `reconcileAllStaleRuns` calls `withRunLockSync` → sees token → runs `reconcileStaleRun` + `updateRunStatus("failed")` + `saveRunTasks` **without the lock** → merge resumes and overwrites "failed" with "running". Also cancels in-flight worker heartbeats via `cancelPendingCoalescedWrite`.
**Fix:** Track re-entrance via `AsyncLocalStorage<Set<string>>` instead of a process-global Map. ~50 LOC. Eliminates H-6, M-3, M-4 as a class.

### H-2 · Iterative retrieval loop is non-functional (wastes 2–3× ripgrep per task)
**File:** `src/runtime/task-runner/retrieval-orchestrator.ts:220-245` · **Theme:** Runtime correctness/perf
The "4-phase iterative retrieval" runs up to `MAX_CYCLES=3` but: (1) `refineQuery()` (`context-retrieval.ts:112`) is **never called** — every cycle uses identical keywords/`rg --files`/scores; (2) `evaluations` accumulates across cycles (only `seenInThisCycle` is per-cycle), so `hasConverged()` counts duplicates → **false convergence**. Produces zero value, wastes ripgrep spawns on every task prompt render (critical path).
**Fix:** Call `refineQuery()` between cycles; dedupe `evaluations` by path; or collapse to single-pass.

### H-3 · `acorn` (225KB, 7% of bundle) wrongly bundled
**File:** `scripts/build-bundle.mjs:48-58` (external array), `src/runtime/deterministic-ast.ts:20` · **Theme:** Bundle
`acorn` is absent from the external array; `dist/build-meta.json` proves `"node_modules/acorn/dist/acorn.mjs": { "bytesInOutput": 224912 }` — the single largest non-src contributor. Used only by `deterministic-ast.ts` for `.dwf.ts` determinism checks (rarely hit), which is reached only via dynamic `await import(...)`. esbuild folds dynamic imports into the single output chunk.
**Fix:** Add `"acorn"` to the external array. It is a direct dependency so resolves at runtime. **~225KB saved.**

### H-4 · `@sinclair/typebox` external name mismatch (245 modules bundled)
**File:** `scripts/build-bundle.mjs:58` (`"typebox"`) vs `package.json:108` (`@sinclair/typebox`) · **Theme:** Bundle
esbuild external matching is exact-package-name; `"typebox"` does not match `@sinclair/typebox`. `dist/build-meta.json` shows **245 typebox input files** bundled.
**Fix:** `"typebox"` → `"@sinclair/typebox"`. **~245KB saved.** (Cold-verified via build-meta.json.)

### H-5 · Plugin system is dead infrastructure (zero runtime value)
**File:** `src/runtime/team-runner.ts:60-67`, `src/plugins/` · **Theme:** Dead infra
`src/plugins/plugin-context.ts` **does not exist**. `team-runner.ts` creates `builtInRegistry` (NextJs/Vitest/Vite) with a "planned" comment. `activePlugins()`, `allPlugins()`, `getPluginContext` are **never called** in non-test code (cold-verified).
**Fix:** Implement `getPluginContext(cwd)` (read package.json deps → `builtInRegistry.activePlugins(deps)` → inject `<framework-context>` into prompt-builder). 2–3d, additive, low risk.

### H-6 · Unify the three lock mechanisms
**File:** `src/state/locks.ts` (file locks), `src/state/event-log.ts:89,435` (mkdir locks + promise-chain locks) · **Theme:** Architecture
Three non-interoperating systems, each with own stale-detection/token/retry, ~800 LOC parallel. CHANGELOG v0.9.26 documents deadlocks from mixing them. **Do after H-1** (they share the re-entrance root cause).
**Fix:** Unified `AsyncFileLock` with `acquire/release/withLock`, incremental dual-running. 3–4d, **high risk**.

### H-7 · Decompose `runChildPi` megafunction (934 lines)
**File:** `src/runtime/child-pi.ts:903-1836` (brace-tracked, cold-verified) · **Theme:** Architecture
Single `new Promise()` constructor spanning **934 lines** with 20+ closure variables and interdependent signal handlers/timers.
**Fix:** Extract `ChildPiLifecycle` state machine (`spawning→running→draining→exiting→settled`). 3–5d, medium risk (integration tests exist).

### H-8 · 27 `__test__` exports shipped in production bundle
**Files:** `event-log.ts`(6), `config.ts`(4), `state-store.ts`(4), `atomic-write.ts`(2), `visual.ts`(2), `adaptive-plan.ts`(2), + `register.ts`, `subagent-helpers.ts`, `notification-sink.ts`, `i18n.ts`, `team-runner.ts`, `verification-gates.ts`, `crew-init.ts`, `goal-loop-runner.ts:63` (`stubGoalEvaluator`), `branch-freshness.ts:110` · **Theme:** API hygiene
Test-only internals (cache manipulation, internal state, stubs) are part of the public bundle surface.
**Fix:** Move to `test/utils/test-internals.ts` or gate with `NODE_ENV === 'test'`. 1–2d, low risk.

### H-9 · Documentation sprawl (120+ files, 432KB CHANGELOG)
**Theme:** Docs · 120+ `.md` in `docs/`, many referencing v0.5/v0.8.x; `archive/` alone has 18; 7+ overlapping plan docs.
**Fix:** Archive pre-v0.9; create `docs/INDEX.md`; consolidate plans into `docs/roadmap.md`; yearly CHANGELOG archival. 1–2d, low risk.

### H-10 · `settings-overlay.ts` — 1047-line monolith, 0 tests, 8/9 overlays lack `dispose()`
**File:** `src/ui/settings-overlay.ts` (1047 lines, 35 settings across 7 tabs) · **Theme:** UI quality
Cold-verified: only `live-conversation-overlay.ts` has `dispose()`. Confirm/Help/Mailbox-compose/Settings/Agent-management/Agent-picker/Mailbox-detail/Mailbox-compose-preview all lack it.
**Fix:** Extract `SETTINGS` to `settings-defs.ts`; split submenus; add tests; enforce `dispose()` via shared `OverlayComponent` interface. ~2d.

---

# 🟡 MEDIUM Priority

## Concurrency & Reliability

### M-1 · `renameWithLinkAsync` ENOENT window (async read-hole)
**File:** `src/state/atomic-write.ts:279-296` · `await unlink` then `await link` yields with the file absent → concurrent async readers get false "run not found". Sync variant is safe.
**Fix:** Use `fs.promises.rename()` (atomic on POSIX, doesn't follow dest symlink; symlink-safety check already runs before). ~5 lines.

### M-2 · `appendEventAsync` has no cross-process lock → dup seqs + line interleaving
**File:** `src/state/event-log.ts:430-530` · Serializes in-process only via `asyncQueues`; never acquires `withEventLogLockSync`. Two processes sharing `events.jsonl` → seq collisions + corrupt JSONL for >4KB events (exceeds `PIPE_BUF`).
**Fix:** Acquire cross-process lock for reserve+append+persist-sequence, or audit/document that cross-process appending to the same events file is unsupported.

### M-3 / M-4 · Lost-update during merge; heartbeat cancellation
**File:** `src/runtime/team-runner.ts:1539-1552`, `task-runner/state-helpers.ts` · Direct consequence of H-1 (worker `persistSingleTaskUpdate` → `withRunLockSync` bypasses during merge `await`; merge's `saveRunTasksAsync` → `cancelPendingCoalescedWrite` drops the buffered heartbeat). **Resolved by H-1.**

### M-5 · Sync I/O elimination (8 `sleepSync` sites)
**Files:** `locks.ts:278,367`, `event-log.ts:165`, `active-run-registry.ts:89`, `atomic-write.ts:374,457`, `foreground-control.ts:152`, `crew-agent-records.ts:141` (cold-verified full list — original report undercounted at 3).
**Fix:** Migrate to the existing proven async variants. 1–2d, medium risk.

### M-6 · Sync I/O in UI render path
**Files:** `run-dashboard.ts:186,223`, `live-run-sidebar.ts:42`, `powerbar-publisher.ts:61`, `run-snapshot-cache.ts` (10+ sites), `theme-discovery.ts:76-132`. Falls through to `readFileSync`/`statSync` when no snapshot, stuttering renders.
**Fix:** Render exclusively from `RunSnapshotCache`. ~4h, medium risk.

### M-7 · `metric-sink.ts` sync I/O on 60s interval + fd-lifecycle race
**File:** `src/observability/metric-sink.ts:48-55,82-83` · `ensureFd` does `mkdirSync/readdirSync/statSync/unlinkSync/openSync` synchronously inside an async function on every 60s tick; at UTC midnight rollover, concurrent write+close race loses a snapshot (EBADF).
**Fix:** Make `ensureFd` fully async, or gate the interval to skip if a previous write is in-flight.

### M-8 · Coalesced dispatch is wired but **completely dead** (0 built-in workflows enable it)
**File:** `src/runtime/team-runner.ts:1182,1345` · `runCoalescedTaskGroup` IS wired, but `coalesceMicroTasks` defaults false and **none** of the 9 built-in workflows set it (cold-verified across all `.workflow.md`). Micro-task batches spawn N child Pi processes instead of 1 merged worker (each cold-start 2–5s).
**Fix:** Enable for `parallel-research`; add metrics; verify merged-task prompt construction. 1–2d, medium risk.

### M-9 · Unify `run-snapshot-cache.ts` sync/async duplicates
**File:** `src/ui/run-snapshot-cache.ts` (1058 lines, 16 sync/async pairs — cold-verified) · Any change applied twice.
**Fix:** Unify on async-only API. ~8h, medium risk.

### M-10 · No per-model circuit breaker
**File:** `src/runtime/model-fallback.ts` · Cold-verified: only per-**agent** tool-failure tracking exists; no per-model consecutive-failure/blacklist/cooldown. Each task independently exhausts its fallback chain.
**Fix:** Process-level circuit breaker tracking consecutive failures per model. ~1d, low risk.

### M-11 · O(N log N) event-log cache eviction + O(N) manifest-cache eviction
**Files:** `event-log.ts:191-204` (`.sort()` all entries — cold-verified worse than the O(N) originally claimed), `state-store.ts:123-131` (linear scan). ❌ Note: `transcript-cache.ts:111-115` is **already O(1)** (`FIND-12` — do NOT re-flag).
**Fix:** `Map.keys().next()` insertion-order eviction for O(1). ~0.5d, low risk.

### M-12 · Declarative merge transition table
**File:** `src/runtime/team-runner.ts:267-330` · 60-line `shouldMergeTaskUpdate` with 10+ sequential boolean guards.
**Fix:** `Map<Status, Set<AllowedTransition>>` table. 1–2d, low risk.

### M-13 · `discover-workflows.ts` silently swallows ALL parse errors
**File:** `src/workflows/discover-workflows.ts:161,196,234` · 3 catch blocks `return undefined`, zero diagnostics. Contrast `discover-agents.ts:445` which logs. Malformed `.workflow.md` silently vanishes.
**Fix:** Add `logInternalError("discoverWorkflows.parseWorkflowFile", error, filePath)`.

### M-14 · `walkFilesFallback` lowerCwd bug (wrong relative paths on case-sensitive FS)
**File:** `src/runtime/task-runner/retrieval-orchestrator.ts:187,212` · `path.relative(lowerCwd, full)` lowercases cwd but not `full` → absolute instead of relative paths on Linux with mixed-case paths.
**Fix:** `path.relative(cwd, full)`.

### M-15 · `hasConverged` critical-gap branch is dead
**File:** `src/runtime/task-runner/context-retrieval.ts:83-89` · Orchestrator always passes `missingContext: []`, so the missing-context dimension never fires (coupled with H-2).

### M-16 · `stream-preview.ts` entirely dead in production
**File:** `src/runtime/stream-preview.ts` (161 lines) · All 4 exports have zero production importers (only 2 test files). Tree-shaken from bundle but maintained. Delete or mark `@deprecated`.

### M-17 · `prometheus-exporter.ts` dead — no wiring
**File:** `src/observability/exporters/prometheus-exporter.ts` · `formatPrometheus` has zero production importers (OTLP exporter is properly wired; Prometheus is not). Wire it or delete.

### M-18 · `event-log.ts` buffered flush timer — only timer missing `.unref()`
**File:** `src/state/event-log.ts:995-1000` · Cold-verified: the ONLY timer in the codebase without `.unref()` (violates the project's own "never let a timer keep the event loop alive" pattern).
**Fix:** `timer.unref();` — 1 line.

### M-19 · `worker-atomic-writer.ts` dead worker not reset → hangs
**File:** `src/state/worker-atomic-writer.ts:136-139` · `'error'` handler clears `pending` but does **not** set `worker = undefined`; `getWorker()` returns the dead worker; new `dispatch()` calls hang forever. (Only when `PI_CREW_WORKER_ATOMIC_WRITER=1`.)
**Fix:** `worker = undefined;` after `pending.clear()` — 1 line.

### M-20 · `seenFinishedRunIds` Set grows without bound
**File:** `src/extension/async-notifier.ts:12,128,141-142` · Never `.delete()`/`.clear()`; accumulates every completed run ID for the session lifetime (significant under goal-loop runs). No cap.
**Fix:** Cap (`MAX_SEEN=500`, evict oldest) or clear on `session_start`. ~5 lines.

### M-21 · Graceful drain for in-flight workers on SIGTERM
**Theme:** Reliability · SIGTERM → abort → SIGKILL after 3s; workers editing files lose work.
**Fix:** Add a "graceful drain" phase (steering message to child Pi to save state; configurable grace). 1–2d, medium risk.

## Security (defense-in-depth gaps — rating still Excellent)

### M-22 · `pi-crew:live-control` event channel has NO authentication
**File:** `src/extension/cross-extension-rpc.ts:285-288` · Unlike all 4 sibling channels (`pi-crew:rpc:*`), this raw `on()` handler has no `withHmacVerification` wrapper. A malicious co-installed extension sharing the event bus can steer/stop/follow-up/resume any live agent session (state-mutating ops) bypassing all crypto auth. Bounded by runId/taskId matching + `seenRequestIds` replay guard, but the auth gap is real.
**Fix:** Wrap with `withHmacVerification(handler, "pi-crew:live-control")` — 1 line.

### M-23 · Raw `step.task` injected unsanitized (prompt-injection bypass)
**File:** `src/runtime/task-runner/prompt-builder.ts:264` · The task packet sanitizes `step.task` via `sanitizeTaskText()`, but the raw string is ALSO injected at the bottom of the dynamic suffix (`step.task.replaceAll("{goal}", ...)`), bypassing the sanitizer. Trusted-input mitigates (workflow `.md` is commit-reviewed), but the bypass is real.
**Fix:** `sanitizeTaskText(step.task)` at both injection sites — 1 line.

### M-24 · HMAC nonce not tracked for replay prevention
**File:** `src/extension/rpc-hmac.ts:88` · Random nonce is signed but `verifyRpcSignature()` never tracks seen nonces → captured request replayable within the 10-min validity window (rate-limited).
**Fix:** TTL-bounded `Set<string>` of seen nonces; reject duplicates.

### M-25 · HMAC channel binding not enforced
**File:** `src/extension/rpc-hmac.ts:137` · `withHmacVerification(handler, _channel)` ignores the channel param; a signature valid for channel A is accepted by a handler for channel B (body also signed, so practical impact low).
**Fix:** `verifyRpcSignature` accepts `expectedChannel`; reject mismatch.

## Code Quality / DX

### M-26 · Type UI renderer interfaces (eliminate `any`)
**Files:** `subagent-tools.ts:229-236`, `team-tool.ts:147-151`, `viewers.ts:89` (`args: any, theme: any, context: any`).
**Fix:** Import `ToolRenderArgs`, `Theme`, `RenderContext` from `@earendil-works/pi-tui`. ~0.5d, low risk.

### M-27 · Migrate deprecated `withEventLogLockSync` callers
**Files:** `mailbox.ts` (8 sites), `decision-ledger.ts` (3), `run-cache.ts` (2), `blob-store.ts` (1). Async path exists and is preferred.
**Fix:** Biome lint rule flagging it; migrate mailbox to async path. 1–2d, medium risk.

### M-28 · `markers.ts` strips ALL HTML comments (overly aggressive)
**File:** `src/config/markers.ts:125-128` · Strips every `<!-- ... -->` from trusted guidance content, damaging legitimate doc comments.
**Fix:** Strip only directive-like patterns (`SYSTEM:`, `IGNORE`, …).

### M-29 · Background-runner shutdown orchestration
**File:** `src/runtime/background-runner.ts` · ~300 lines of shutdown with 15+ signal handlers, monkey-patched `process.exit`, module-level `exitDueToRejection`, watchdog, parent-guard.
**Fix:** Structured `ShutdownCoordinator` with ordered handler registry. 2–3d, medium risk.

### M-30 · Single-source-of-truth config schema
Config fields defined in 3+ places (`config/types.ts`, `schema/config-schema.ts`, `settings-overlay.ts SETTINGS`). Manual sync.
**Fix:** Code-gen schema from TS types via `@sinclair/typebox` `Type.Object`. 2d, medium risk.

### M-31 · Structured debug/trace logging
Scattered `console.debug/warn` + file-local `PI_CREW_DEBUG`. 35 `console.error/warn` across non-test src.
**Fix:** Lightweight structured logger with levels + module namespacing. 1–2d, low risk.

---

# 🟢 LOW Priority (consolidated)

**Runtime / workflows**
- **L-1** `output-splitter.ts:125,136` — identical regex compiled & executed twice.
- **L-2** `discover-workflows.ts:169,176` — double `readdirSync` per dir.
- **L-3** `cost-estimator.ts` — hardcoded estimates, zero tests, never calibrated (observability records `crew.task.tokens_total`).
- **L-4** `validate-workflow.ts`, `workflow-serializer.ts` — pure logic (cycle-detection!), zero dedicated tests.
- **L-5** `event-bus.ts:60-62` — emits 4 event types, **zero production subscribers** (comment admits it).
- **L-6** `metric-retention.ts:9` — `TimeWindowedCounter` exported but never imported (dead); O(N²) pattern.
- **L-7** `discover-agents.ts:199-201` — O(N) `Array.shift()` eviction.
- **L-8** `prompt-runtime.ts:240` — steering poll interval hardcoded 500ms.
- **L-9** `claude/codex/cursor-adapter.ts` — zero dedicated unit tests.

**Concurrency (incremental)**
- **L-10** PID reuse undetectable on macOS/Windows (`stale-reconciler.ts:148-175`, no `/proc` startTime) — use `ps -o lstart`/`GetProcessTimes` or a birth-token.
- **L-11** `reconcileOrphanedTempWorkspaces` writes manifest/tasks without lock (`stale-reconciler.ts:440-470`, `/tmp` only — low impact).
- **L-12** `flushBufferedQueuesSync` calls async `appendEventBatchInsideLock` with `void` (`event-log.ts:1010-1025`) — latent fragility if an `await` is ever added to the body.
- **L-13** `compactEventLog` called from async path uses sync lock (`event-log.ts:470`) → up to 5s event-loop stall under >50MB log contention.
- **L-14** `writeBlob` content-write outside metadata lock (`blob-store.ts:175-210`) → orphan metadata on concurrent cleanup.

**Security (defense-in-depth, accept/document)**
- **L-15** HMAC disabled by default (`rpc-hmac.ts:152-160`); RPC accepts unsigned requests (backward-compat). Consider auto-generating a secret.
- **L-16** `.dwf.ts` runs in plain module scope with full `require`/`process` access (`dynamic-workflow-runner.ts:9-16`) — by-design, documented, planned v1.5 fix (isolated-vm).
- **L-17** Peer/dev dependency vulnerabilities (undici, protobufjs, esbuild, ws, `pi-coding-agent` ≤0.79.7) — pi-crew is clean but users inherit them. Bump devDeps to `pi-coding-agent@>=0.80.10`.
- **L-18** `sse-parser.ts:122-128` silently drops malformed SSE JSON — add `logInternalError`.

**Bundle / dead-code**
- **L-19** `cli-highlight` eagerly imported at `syntax-highlight.ts:6` (external, so 0 bundle bytes, but module-load cost) — lazy-import on first code-block render.
- **L-20** `child-pi-pool.ts` skeleton disabled pending Pi-side `PI_CREW_POOL_HEALTH` — coordinate with Pi runtime team.
- **L-21** `jiti` hard dependency; native strip-types fallback exists for worker-spawning (`async-runner.ts:81`) but **NOT** for `.dwf.ts` loading (`dynamic-workflow-runner.ts:126-128` hard-`require("jiti")`). Make jiti `optionalDependencies`.

**DX / tooling**
- **L-22** No bundle size budget in CI (`check-bundle-staleness.mjs` is mtime-only; `build-bundle.mjs` logs size but never enforces).
- **L-23** Add `team dry-run` action (preview workflow expansion / task graph / est. cost).
- **L-24** `renderLines()` duplicated across `run-dashboard.ts`, `widget-renderer.ts`, `live-run-sidebar.ts` → move to `layout-primitives.ts`.
- **L-25** `require()` in ESM (`theme-discovery.ts:76,113,126`) → top-level `import`.
- **L-26** Module-level mutable state (`run-dashboard.ts:100 lastActivePane`, powerbar dedup globals) → instance-scoped.
- **L-27** 30+ inline "Round N (BUG M)" comment blocks → consolidate to `docs/bug-history.md`.
- **L-28** `task-runner.ts` inline `runtimeKind === ...` branching → `WorkerRuntimeStrategy` interface.

---

## Dimensional Health Assessment

| # | Dimension | Rating | Key evidence |
|---|-----------|--------|--------------|
| 1 | Architecture & Design | ✅ Excellent | `register.ts` decomposed (108 LOC), plugin system scaffolded (H-5) |
| 2 | Code Quality & Tech Debt | 🟡 Good | H-8 `__test__` exports, M-26 `any` in UI, H-7 megafunction |
| 3 | Performance & Scalability | 🟡 Good | M-5/M-6 sync I/O, M-11 O(N log N) eviction; ❌ P-3/O(n²) and transcript-cache O(N) already fixed |
| 4 | Dependencies & Tooling | 🟡 Good | H-3/H-4 ~470KB wrongly bundled; M-8 dead coalescing; L-21 jiti |
| 5 | Security | ✅ Excellent (CONFIRMED) | 40+ hardening rounds; 0 CRITICAL/HIGH; M-22/M-23 are defense-in-depth gaps |
| 6 | Developer Experience | 🟡 Good | M-31 no structured logger, L-23 no dry-run; good tooling (biome, bundle gates, CI) |
| 7 | Test Coverage & CI | ✅ Very Good | 400+ unit, 27 integration, 3-OS CI; H-10 settings-overlay 0 tests |
| 8 | TypeScript / Modern JS | ✅ Very Good | TS 5.8 strict, strip-types native; minor `any` leakage |
| 9 | Async / Worker Reliability | 🟠 Needs work | **H-1 lock bypass** (root of M-3/M-4), M-1/M-2 races, M-21 no graceful drain |
| 10 | Extensibility | 🟡 Good | H-5 plugin registry designed but unwired, L-28 strategy pattern absent |

**Net change from original review:** Async/Worker Reliability drops a tier (H-1 is a real correctness bug, not just tech debt). Security stays Excellent but gains 2 concrete one-line fixes (M-22/M-23).

---

## Prioritized Roadmap (revised)

### Sprint 1 — One-line quick wins (~0.5d, near-zero risk)
| Item | Fix | Impact |
|------|-----|--------|
| H-4 | `"typebox"` → `"@sinclair/typebox"` in external | ~245KB bundle |
| H-3 | add `"acorn"` to external | ~225KB bundle |
| M-18 | `timer.unref()` on buffered flush timer | event-loop hygiene |
| M-19 | `worker = undefined` after error | prevent worker hang |
| M-23 | `sanitizeTaskText(step.task)` at prompt-builder:264 | close injection bypass |
| M-22 | wrap `live-control` with `withHmacVerification` | close auth gap |
| L-25 | ESM import in theme-discovery | cleanup |
| L-24 | dedup `renderLines()` | cleanup |

### Sprint 2 — High-leverage correctness (~7d)
| Item | Effort | Risk |
|------|--------|------|
| **H-1** AsyncLocalStorage re-entrance (eliminates M-3/M-4) | 1–2d | Medium |
| **H-2** retrieval orchestrator: call refineQuery + dedupe | 1d | Low |
| M-1 `renameWithLinkAsync` → `fs.promises.rename` | 0.5d | Low |
| H-8 extract `__test__` exports | 1–2d | Low |
| H-5 wire plugin context | 2–3d | Low |
| M-13/M-14/M-15 retrieval + workflow error-handling | 1d | Low |

### Sprint 3 — Reliability & performance (~9d)
| Item | Effort | Risk |
|------|--------|------|
| M-5 eliminate 8 `sleepSync` sites | 1–2d | Medium |
| M-6 sync I/O out of UI render path | 0.5d | Medium |
| M-7 metric-sink async + fd race | 1d | Medium |
| M-2 cross-process event-log lock (or document limit) | 1–2d | Medium |
| M-11 O(1) cache eviction | 0.5d | Low |
| M-10 model circuit breaker | 1d | Low |
| M-8 enable coalesced dispatch + metrics | 1–2d | Medium |
| H-10 settings-overlay: split + tests + dispose() | 2d | Low |

### Sprint 4 — Architecture deepening (~13d)
| Item | Effort | Risk |
|------|--------|------|
| **H-6** unify three lock mechanisms (after H-1) | 3–4d | **High** |
| **H-7** decompose `runChildPi` (934 lines) | 3–5d | Medium |
| M-29 ShutdownCoordinator | 2–3d | Medium |
| M-9 unify snapshot cache sync/async | 1d | Medium |
| M-27 migrate `withEventLogLockSync` callers | 1–2d | Medium |

### Sprint 5 — Strategic / cleanup (ongoing)
M-12 transition table · M-16/M-17 delete dead stream-preview/prometheus · M-20 cap seenFinishedRunIds · M-24/M-25 HMAC nonce+channel · M-30 config schema codegen · M-31 structured logging · M-21 graceful drain · H-9 doc consolidation · L-10 PID-reuse detection · L-17 bump devDeps.

**Total:** ~38–42 days. The single highest-leverage item is **H-1** (fixes a correctness class) followed by **Sprint 1** (~470KB bundle removed in 8 one-line edits).

---

## Audit Trail — what changed from the v1 report and why

**Removed as FALSE (cold-verified):**
- ❌ `U-5` "settings-overlay drops Unicode/CJK" — fabricated; actual `data >= " "` accepts all Unicode (comment says "including Unicode").
- ❌ `P-3` "O(n²) transcript matching" — **already fixed** to O(n) (`FIND-18` comment).
- ❌ `P-1 (transcript-cache)` "O(N) eviction" — **already fixed** to O(1) (`FIND-12`, `Map.keys().next()`).

**Corrected (cold-verified):**
- `L-1` runChildPi: ~600 → **934 lines** (brace-tracked).
- `S-2`/`M-5` sleepSync: 3 → **8 sites** (added `active-run-registry:89`, `atomic-write:374,457`, `foreground-control:152`, `crew-agent-records:141`).
- `U-1` UI untested: ~70% → **~38% (22/58)** — overstated ~2×. (settings-overlay 0-test gap remains real → H-10.)
- `P-1 (event-log)` O(N) → actually **O(N log N)** (`.sort()`).
- `T-2`/`L-21` strip-types fallback exists for worker-spawning but **NOT** for `.dwf.ts` loading.

**Confirmed with stronger evidence:** T-1/H-4 (build-meta.json: 245 typebox files), D-1/H-5 (activePlugins/allPlugins/getPluginContext never called), Q-1/H-8 (27 exports), and all 4 of the v1 self-corrections re-confirmed.

**Added (deep-dig):** H-1, H-2, H-3, M-1, M-2, M-7, M-13–M-25, L-1–L-28 (28 new findings from concurrency/STRIDE/bundle sweeps).

## Caveats
- Estimates assume a developer familiar with the codebase.
- H-6 (lock unification) is the only High-risk item; do it last, after H-1, with dual-running + integration coverage.
- No integration tests exercise built-in workflows end-to-end (per `.crew/knowledge.md`); validate M-8/M-2/M-21 changes with E2E workflow runs, not only unit tests.
- STRIDE coverage is strong but assumed a single-user deployment; M-22/M-23 matter more in shared/multi-extension setups.

---

# Round 2 — Deep-Dig & Independent Verification (2026-07-18)

**Method:** 5 background agents — 2 cold-verifiers re-derived the Round-1 HIGH/MEDIUM claims from source; 3 new deep-digs covered worktree/live-session, event-log/state durability, and config/hooks/prompt. This section **supersedes** the Round-1 text where marked. Added **35 new findings (3 HIGH, 12 MED, 20 LOW)**. Grand total now **~112 verified findings (~13 HIGH)**.

## 🔧 Corrections to Round-1 findings (from independent verification)

| ID | Correction | Evidence |
|----|-----------|----------|
| **H-1** | Candidate writer was WRONG. Not the auto-repair timer / heartbeat watcher (`heartbeat-watcher.ts` is read-only). The real concurrent writer is the **child-process stdout handler**: `onJsonEvent`→`persistSingleTaskUpdate` (`task-runner.ts:593`) and `persistHeartbeat` (`:415`) — **stronger** (not timer-gated, fires on any child output, same event loop). Interleaving T0–T7 reconstructed with real names; no guard prevents it. | `locks.ts:404` (global Map), `:419/422/423` (set/yield/clear), `team-runner.ts:1618/1636/1637`, `state-helpers.ts:67` |
| **H-1 severity** | Impact is **transient/self-healing, NOT permanent data loss** (≤500ms for non-terminal via next progress event; terminal self-heals via next merge). The lock **contract is genuinely broken** (two writers in the critical section) — still a real bug, just not data-loss severity. | — |
| **M-1** | WRONG LINE: `renameWithLinkAsync` is at `atomic-write.ts:384`, not 279–296. `readJsonFileAsync` ENOENT→undefined is at `state-store.ts:709`, not atomic-write.ts. Substance CONFIRMED. | — |
| **M-18** | OVERSTATED: not the "only" timer missing `.unref()`. `team-runner.ts:113` (heartbeat 60s) + `background-runner.ts:528` (keepAlive 5s) are also non-unref'd — **by design** (they want to keep the loop alive). The event-log buffered-timer fix is still valid (it's a short flush, not a keepAlive), but reframe as "missing among short-lived timers." | — |
| **M-3 / M-4** | **WRONG: "Resolved by H-1" is FALSE.** See NEW-D1 below — the coalesced-write-cancellation lost-update bug has a second, independent root cause that H-1 does not fix. | — |
| **H-2** | CONFIRMED with **live smoking-gun**: verifier's own task packet showed 3 distinct files × 3 cycles = duplicate entries in "Suggested files," score 0.44 < 0.7 → never converges → loop exhausts all 3 cycles, duplicate paths injected into worker prompt. Nuance: cycle 1 works; the *iterative refinement* (cycles 2–3) is the broken part. | `context-retrieval.ts:112` (refineQuery never called), `retrieval-orchestrator.ts:245/252/272` |
| **H-3** | CONFIRMED exact: `dist/build-meta.json` `bytesInOutput = 224912` matches to the byte. | — |

---

## ➕ New findings — Worktree & Live-Session (read-only audit)

### 🔴 N-1 · Dirty-data loss when `snapshotDirtyWorktree` fails
**File:** `src/worktree/worktree-manager.ts:588-621` (snapshot), callers `~766`/`~880`
`snapshotDirtyWorktree` is best-effort (whole body `try/catch` → `logInternalError` only). If `writeArtifact` throws (ENOSPC / EACCES / EROFS / symlink-rejection), the caller **unconditionally** proceeds to `git checkout -- .` + `git clean -fd` → worker's uncommitted work **permanently destroyed with no recovery artifact**.
**Fix:** Return `false` on snapshot failure; caller skips discard + preserves worktree (`dirtyPreserved: true`). One-function fix.

### 🔴 N-2 · `evictStaleLiveAgentHandles` liveness check is broken for in-process sessions
**File:** `src/runtime/live-agent-manager.ts:208-223`, `process-status.ts:35-37`
For active handles idle >30min, it reads `handle.session.pid`. But in-process live-session agents (`registerLiveAgent` in `runLiveSessionTask`) **never have a pid** (Pi SDK `createAgentSession()` returns an in-process object). So `sessionPid` is always `undefined` → `checkProcessLiveness(undefined)` returns `{alive:false}` → **legitimately-running live agents killed after 30min idle** (long builds/tests). Subsequent steer/follow-up fail with "not registered."
**Fix:** Session-level heartbeat (`session.isStreaming`/`pendingMessageCount`, confirmed in `live-extension-bridge.ts:56-57`) instead of PID; or drop the PID check and rely on idle timeout alone.

### 🟡 N-3 · `cleanupRunWorktrees({force:true})` commit path is dead code
**File:** `src/worktree/cleanup.ts:163-175`
After `git add -A`, it compares raw porcelain `statusBefore !== statusAfter`. But `git add -A` *stages* changes, transforming porcelain (` M`→`M `, `??`→`A `), so the comparison is **always true when any unstaged/untracked change exists** → throw → commit never happens → falls through to preserve. `force=true` ("auto-commit and remove") **never works** for typical dirty worktrees → they accumulate on disk.
**Fix:** Compare path sets, not raw status; or drop the guard.

### 🟡 N-4 · Unhandled rejection from control-request application
**File:** `src/runtime/live-agent-control.ts:82-100` (no try/catch), `live-session-runtime.ts:798-806` (realtime `void`), `809-811` (polling `void pollControl()`)
`applyLiveAgentControlRequest` has no try/catch around `session.steer/prompt/abort`. SDK throw (disposed session, API error) → unhandledRejection. Batch loop (`live-agent-control.ts:117`) one failing request **aborts the whole batch**. Plus TOCTOU `existsSync`→`readFileSync`.
**Fix:** Wrap session ops in try/catch (`logInternalError`, return false); `.catch()` the `void` calls.

### 🟡 N-5 · `controlTimer` (500ms setInterval) missing `.unref()`
**File:** `src/runtime/live-session-runtime.ts:809-811` — same class as M-18, different site. If `session.abort()` hangs, the 500ms interval keeps the loop alive → process can't exit.
**Fix:** `controlTimer.unref();`

### 🟡 N-6 · Sync I/O storm + unbounded growth on live-control file
**File:** `src/runtime/live-agent-control.ts:65,90-95`, `crew-agent-records.ts:29-36`, polled every 500ms via `live-session-runtime.ts:786`
Each 500ms poll: `ensureAgentStateDir` does mkdir+lstat ×2–5 + realpath, then `existsSync`+`readFileSync` of the **entire** `live-control.jsonl`. File is **never truncated/rotated** → O(N) per poll, O(N²) cumulative; N concurrent live tasks = 6N sync syscalls every 500ms.
**Fix:** Cache idempotent `ensureAgentStateDir`; incremental file read (byte offset); rotate the file.

### 🟢 N-7 · `writeSidechainEntry` sync I/O on every streaming event (`sidechain-output.ts:15-17`) — make async like `appendTranscript`.
### 🟢 N-8 · `bindExtensions` race timeout timer not unref'd/cleared (`live-session-runtime.ts:716`) — extract, unref, clearTimeout in finally.
### 🟢 N-9 · `snapshotDirtyWorktree` follows symlinks when reading untracked files (`worktree-manager.ts:605-610`) → potential secret leak to recovery artifact. Use `lstatSync`, skip symlinks.
### 🟢 N-10 · `prepareAgentWorktreeAsync` swallows ALL errors silently (`worktree-manager.ts:1059-1061`) → isolation silently defeated, no diagnostic. Add `logInternalError`.

---

## ➕ New findings — Durability & Task Lifecycle (read-only audit)

### 🔴 NEW-D1 · Coalesced-write cancellation loses non-terminal updates (M-3/M-4 is NOT fixed by H-1)
**Files:** `team-runner.ts:1617-1637` (merge), `state-helpers.ts:135` (persistSingleTaskUpdate), `atomic-write.ts:662,858` (cancel)
The merge path **never calls `flushPendingAtomicWrites()`** before `loadRunManifestById` (grep: zero calls in team-runner.ts). Trace (even WITH H-1's proper locking): worker heartbeat → `persistSingleTaskUpdate` → `saveRunTasksCoalesced` buffers write (50ms timer, not yet on disk) → releases lock → merge acquires lock → `loadRunManifestById` reads **stale disk** (misses buffered write) → `saveRunTasksAsync` → `cancelPendingCoalescedWrite(tasksPath)` **cancels the worker's buffered write** → heartbeat/progress/attempts enrichment **lost**. `state-store.ts:473-477` docstring explicitly requires callers to flush first — the merge violates its own contract. (`state-helpers.ts:77` correctly flushes before its own CAS read, proving the team knows the hazard.)
**Impact:** false zombie detection (stale heartbeats), lost progress tracking, inconsistent retry state.
**Fix:** One line — `flushPendingAtomicWrites()` before `loadRunManifestById` in the merge path (or make `loadRunManifestById` always flush).

### 🟡 NEW-D2 · Compaction silently drops terminal events → breaks crash recovery
**File:** `src/state/event-log-rotation.ts:106` — `slice(-compactToCount=1000)` keeps last 1000 events with **no terminal-preservation**. Long runs with high-frequency `task.progress` events (20ms buffer) easily exceed 1000 between terminals → early-completed tasks' `task.completed` events compacted away → `reconstructTasksFromEvents` shows them as "running" if `tasks.json` is ever corrupted/missing. `dedupeTerminalEvents` (`event-log.ts:1244`) is exported but **never called**.
**Fix:** Preserve terminal events outside the window (merge back by seq).

### 🟢 NEW-D3 · `appendEventBatchInsideLock` dup seq when first buffered event has explicit `metadata.seq` (`event-log.ts:728-734`) — off-by-one; latent (no current caller sets seq on buffered events).
### 🟢 NEW-D4 · `shouldMergeTaskUpdate` allows 15/20 invalid terminal→terminal transitions (`team-runner.ts:254-330`; only 5 blocked). Mitigated by `finishedAt` comparison. Replace with contract-driven check (also simplifies — aligns with M-12).
### 🟢 NEW-D5 · Compaction recovery check uses `>=` length not seq (`event-log-rotation.ts:141`) → masks events lost during the rename-window (rare, requires M-2's cross-lock race).

---

## ➕ New findings — Config / Hooks / Prompt / i18n (read-only audit)

**Framework observation:** the **hooks framework has ZERO production registrations** (like H-5 plugin system) — `registerHook` has no caller in src/; every `executeHook` short-circuits. Hooks-layer findings below are latent until built-in hooks ship.

### 🟡 NEW-C1 · Phantom field `PiTeamsAutonomousConfig.excludeContextBash` (declared in `types.ts:18`, absent from schema + `parseAutonomousConfig`) — TS accepts, parser drops, behavior unchanged. Delete it (the working field is `CrewRuntimeConfig.excludeContextBash`).
### 🟡 NEW-C2 · Schema↔parser upper-bound drift (silent capping) — 5 fields: `runtime.maxTurns` (capped 10000), `runtime.graceTurns` (1000), `runtime.groupJoinAckTimeoutMs`, `notifications.dedupWindowMs`, `observability.metricRetentionDays` (schema max 90, parser 365). Schema accepts huge values; parser silently caps. Add matching `maximum` or remove ceiling.
### 🟡 NEW-C3 · `config-schema-sync.test.ts` only checks **top-level keys** (50 LOC) — nested-field removal/bound-drift passes silently. Make it recursive (reuse `drift-detector.ts:findUnknownConfigKeyPaths`). Extends M-30.
### 🟡 NEW-C4 · Shallow `sanitizeContext` in `executeHook` leaves nested prototype-pollution open between hooks (`hooks/registry.ts`). Deep-sanitize or freeze ctx. (Latent — no prod hooks.)
### 🟡 NEW-C5 · `before_provider_request` token cap only handles `max_tokens` (`prompt-runtime.ts:114-124`) — missing `max_completion_tokens` (OpenAI o1/o3/gpt-5), `generationConfig.max_output_tokens` (Gemini), `max_output_tokens`. Cap silently bypassed → unbounded output tokens (the thing `PI_CREW_MAX_OUTPUT` exists to prevent).
### 🟡 NEW-C6 · No prompt-budget pre-flight (`prompt-builder.ts:renderTaskPrompt`) — huge `step.task` / monorepo workspace tree / large dependency-context can exceed model context window → model error → burns fallback chain. Add `MAX_PROMPT_CHARS` check; truncate `suggestedFiles` + `dependencyContext` first.
### 🟡 NEW-C7 · `TailCaptureStage` byte-cap returns EMPTY STRING for multibyte input + small maxBytes (`compact-stages/tail-capture-stage.ts:65-72`) — `tail.slice(1024)` on a <1024-char tail returns `""`. Concrete repro: `"😂".repeat(400)` + `maxBytes:100` → empty. Fix: char-by-char or buffer-boundary walk.
### 🟡 NEW-C8 · Parser bypasses schema validation; no `strict` mode (`config.ts:parseConfigWithWarnings`) — invalid values silently used; warnings collected but ignored. Add `strict:true` to `loadConfig`; wire to `team doctor`.

**LOW (13):** NEW-C9 `dedupWindowMs` lower-bound drift (schema min 1000, parser accepts 1) · NEW-C10 OTLP endpoint pattern not enforced at parse (mitigated by runtime `validateEndpoint`) · NEW-C11 `parseRuntimeConfig` uniquely substitutes `{inheritContext:true}` on invalid input (masks misconfig) · NEW-C12 undocumented config-file precedence (`.crew/config.json` > `.pi/pi-crew.json`) · NEW-C13 **`PI_CREW_HOME` env unsupported** (only `PI_TEAMS_HOME`) — add `?? process.env.PI_CREW_HOME` at 3 sites · NEW-C14 `parseConfigResilient` dead (zero prod callers; wire to `team doctor`) · NEW-C15 hooks: no priority/ordering primitive · NEW-C16 hooks: non-blocking `outcome:"block"` silently dropped · NEW-C17 doc comment references non-existent `PI_CREW_MAX_OUTPUT_TOKENS` (actual: `PI_CREW_MAX_OUTPUT`) · NEW-C18 steering sanitizer allows CR (0x0D) → terminal line-overwrite UI spoofing · NEW-C19 `TailCaptureStage`/`HeadSnapStage` minor edge cases · NEW-C20 i18n: no locale-variant fallback (`es-ES`→`es`, `zh-Hans`→`zh`); missing-key only logs, no user signal; no interpolation escaping · NEW-C21 markers: `extractGuidanceIds` regex allows IDs violating `VALID_BLOCK_ID`; existing block content not re-sanitized on re-parse · NEW-C22 `readBooleanEnv` ambiguous values (`on`/`y`) silently fall through to legacy var · NEW-C23 `PI_CREW_DWF_SCRIPT_TIMEOUT_MS=0` silently becomes 10-min default (`0 || 600000`).

---

## Revised roadmap deltas (from Round 2)

**Promote to Sprint 1 (one-liners / one-function, high value):**
- **NEW-D1** — `flushPendingAtomicWrites()` before merge read (corrects M-3/M-4; prevents silent heartbeat loss).
- **N-1** — skip discard on snapshot failure (prevents permanent dirty-data loss).
- **N-2** — fix in-process live-agent eviction (drop/replace PID check).
- **NEW-C1** — delete phantom `excludeContextBash` field.
- **NEW-C13** — add `PI_CREW_HOME` alias (3 sites).
- **NEW-C17** — fix doc-comment env-var name.
- **NEW-C7** — fix `TailCaptureStage` empty-tail slice bug.
- **NEW-C5** — extend token cap to `max_completion_tokens`/`max_output_tokens`.

**Promote to Sprint 2/3:**
- **NEW-C2/C3/C8** — schema↔parser drift class (recursive sync test + strict load mode).
- **NEW-C6** — prompt-budget pre-flight.
- **N-3** — fix `cleanupRunWorktrees` force=true dead commit path.
- **N-6** — live-control sync I/O storm + rotation.
- **NEW-D2** — compaction terminal-event preservation.

**Keep but de-prioritize:** H-1 stays HIGH (lock contract broken) but reframe as transient-inconsistency, not data-loss. M-3/M-4 → folded into NEW-D1 (the real fix).

## Updated trust assessment
Round 1's authoritative report was **directionally correct but still had 1 wrong causal claim** (M-3/M-4 "resolved by H-1") and **2 framing errors** (H-1 candidate + severity; M-18 "only timer"), all caught by independent re-verification. Round 2 deep-digs found **35 new findings including 2 new HIGH data-loss/correctness bugs (N-1, N-2)** that the structural review entirely missed — worktree dirty-data loss and broken live-agent eviction. **The codebase has real reliability bugs concentrated in the worktree/live-session + durability layers**, which the original review under-weighted.

---

# Round 3 — Observability / Discovery / Tools Deep-Dig + Runtime Test (2026-07-18)

**Method:** 3 read-only deep-digs (observability runtime, discovery/skill loading, tools/extension) + live `npm test` run. Added **35 new findings (5 HIGH, ~16 MED, ~14 LOW)**. **Two findings reframe prior assessments** (see ⚡ below). Grand total now **~147 verified findings (~18 HIGH)**.

## ⚡ Reframes of prior assessments

1. **Observability is NOT "Very Good" — much of it is non-functional.** Dimensional rating §7 (Test/CI) stands, but the observability *runtime* (originally folded into "good tooling") is largely dead or wrong: task-level metrics are **always 0** (OBS-NEW-1), run duration **always 0** (OBS-NEW-2), multiple double-counting bugs, OTLP spec violations, no shutdown drain. The "40+ rounds of hardening" produced strong *security* but the *metrics pipeline* was never validated end-to-end.
2. **The round-13 P0-2 "determinism enforcement" security feature is dead code** (DISC-1). acorn can't parse TypeScript → every real `.dwf.ts` throws → silent catch → `Date.now()`/`Math.random()`/`new Date()` freely allowed. SECURITY-ISSUES.md should be updated.

## ➕ Tools & Extension surface (read-only)

### 🔴 T-A1 · `handleSteer` writes tasks.json WITHOUT any lock
**File:** `src/extension/team-tool.ts:492-542` · Every sibling handler (`handleCancel/Retry/Respond/Resume`) uses `withRunLockSync`; `handleSteer` does not → concurrent steers to the same task **lose messages** (read-modify-write race).
**Fix:** Wrap in `withRunLockSync`, re-read manifest inside the lock (mirror `handleRespond`).

### 🔴 T-C2 · `handleParallel` never persists `async.pid` → orphans on crash
**File:** `src/extension/team-tool/parallel-dispatch.ts:155-170` · `spawnBackgroundTeamRun` returns `{pid, logPath}` but it's **ignored** — manifest never gets `async:{pid,...}`. Contrast `run.ts:370-373` which persists it. Consequences: `markDeadAsyncRunIfNeeded` short-circuits (no `run.async`), `handleStatus` shows no liveness, no early-exit guard, no `registerActiveRun` → crash recovery can't find these runs → **`team action='parallel'` runs sit at "queued" forever if the runner dies silently.**
**Fix:** Persist async metadata + `registerActiveRun` + `scheduleBackgroundEarlyExitGuard` after spawn (mirror `run.ts`).

### 🟡 T-A2 · `handleStatus` (read action) writes manifest+tasks without lock on async death (`status.ts:52-71`) — races with locked writes; duplicates async-notifier's `markDeadAsyncRunIfNeeded`.
### 🟡 T-S1 · `handleSteer` accepts steers for terminal tasks (`team-tool.ts:510-525`) → stale steer delivered on retry/resume, confusing the re-spawned worker. Add status guard.
### 🟡 T-V1 · `globMatch` ReDoS via consecutive wildcards (`team-tool/api.ts:47-54`) — `*.*.*.*.*` → exponential backtracking; 200-char cap insufficient. Filter is user-controllable via `metrics-snapshot` API. Use linear-time matcher (picomatch).
### 🟡 T-R1 · `get_subagent_result` wait loop hangs on deleted manifest (`subagent-tools.ts:275-312`) — `loadRunManifestById` returns undefined → record unchanged → spins to 5-min timeout instead of "run deleted".
### 🟡 T-C1 · `startGoalWrappedRun` skips `isWorkspaceBusy` check (`goal-wrap.ts:161-250`) → two concurrent goal-wrap runs on same cwd clobber edits. Mirror `goal.ts:114`.
### 🟢 T-S2 steering file never truncated/rotated (O(N) per 500ms poll). · T-R2 `readSubagentRunResult` unbounded read (no size cap vs `formatRunResult`'s 500-char). · T-R3 `Object.assign(inMemory,current)` overwrites live fields with stale snapshot. · T-P1 `fetchProviderUsage` cache not keyed by provider → cross-provider wrong-data.

## ➕ Observability runtime (read-only) — largely non-functional

### 🔴 OBS-NEW-1 · Five task/subagent event subscriptions are DEAD (never emitted)
**File:** `observability/event-to-metric.ts:79,87,88,90,139` · `crew.task.completed/failed/needs_attention`, `crew.task.retry_attempt`, `crew.subagent.failed` are subscribed but **never emitted** via `pi.events.emit` (grep: zero emission sites; `retry_attempt` is written to the event-log *file* via `appendEventAsync`, not bridged to `pi.events`). **Impact:** `crew.task.count`, `crew.task.duration_ms`, `crew.task.tokens_total` histograms are **always 0/empty** — task-level observability entirely non-functional. (foreground-run-controller correctly emits run-level events; task-level was never wired.)
**Fix:** Emit `crew.task.completed/failed/needs_attention` from `runTeamTask` terminal transitions; bridge or remove the dead `retry_attempt`/`subagent.failed` subscriptions.

### 🔴 OBS-NEW-2 · `crew.run.duration_ms` always records 0
**File:** `event-to-metric.ts:63` (reads `item.durationMs`) vs `foreground-run-controller.ts:179` (payload has **no** `durationMs` field) → `numberValue(undefined,0)=0`. p50/p95/p99 all 0.
**Fix:** Add `durationMs` to the emitted payload (compute from `manifest.startedAt`).

### 🟡 OBS-NEW-3 · `crew.run.cancelled` reason always "unknown" (payload lacks `reason`).
### 🟡 OBS-NEW-4 · Heartbeat-dead deadletter **double-counted** (direct inc at `observability.ts:169` + event round-trip). Count = 2× actual.
### 🟡 OBS-NEW-5 · Overflow metric split across two counter names (`overflow_recovery_total` direct + `overflow_phase_total` via event) → dashboard sees half.
### 🟡 OBS-NEW-6 · `crew.heartbeat.level_total` double-counted (watcher + UI aggregator).
### 🟡 OBS-NEW-7 · OBS-1 fix incomplete: **8 direct emission sites** still use unbounded `runId`/`taskId` labels (team-runner ×4, heartbeat-watcher ×3, heartbeat-aggregator ×2) → cardinality hits `MAX_LABEL_COMBINATIONS=10000` after ~500 runs × 20 tasks → silent eviction.
### 🟡 OBS-NEW-8 · `Histogram.observe` doesn't MRU-protect existing entries (`metrics-primitives.ts:159-167`) → `enforceLabelCap` can evict an actively-observed histogram (counters/gauges are immune via delete-before-set). Add delete-before-set.
### 🟡 OBS-NEW-9 · **No final metric drain on shutdown** (metric-sink `dispose` + OTLP `dispose`) → up to 60s of data (final task completion, run summary, terminal heartbeats) silently lost.
### 🟡 OBS-NEW-10 · OTLP `explicitBounds` includes +Inf (spec violation; `otlp-exporter.ts:219`) → strict collectors reject/phantom-bucket. Slice off the last entry.
### 🟡 OBS-NEW-11 · OTLP counters missing `isMonotonic:true` + `aggregationTemporality:2` (`otlp-exporter.ts:241-252`) → collectors mis-treat as non-monotonic gauge → wrong rates.
### 🟢 OBS-NEW-12 `correlatedEvent()` exported, never called → tracing inert. · OBS-NEW-13 correlation context doesn't cross child-process boundary (no traceId arg/env to child). · OBS-NEW-14 EventBus listener cap is advisory-only (always adds past cap). · OBS-NEW-15 label values not length-capped at registry (10KB label × 10k combos = 100MB; OTLP caps post-hoc at export).

## ➕ Discovery & skill loading (read-only)

### 🔴 DISC-1 · Determinism AST check is a complete no-op for ALL TypeScript `.dwf.ts`
**File:** `src/runtime/deterministic-ast.ts:38-48` (acorn `parse`+silent catch), called from `dynamic-workflow-runner.ts:117-119` · acorn is a **JavaScript** parser; `.dwf.ts` files are TypeScript. Every real workflow (with `import type`, `: WorkflowCtx`, generics) makes acorn throw → silent catch → check **never runs**. **End-to-end proven:** `assertDeterministicScript` on TS source containing `Date.now()` + `Math.random()` + `new Date()` → **NO ERROR**; the reference `hello.dwf.ts` itself fails acorn at line 10. Tests miss it (only plain-JS inputs). The round-13 P0-2 reproducibility/safety feature is dead code.
**Fix:** Transpile `.ts`→`.js` before acorn parse — use esbuild (already a dep): `transformSync(scriptSource,{loader:"ts"}).code`, then `assertDeterministicScript(js)`.

### 🟡 DISC-2 · Team discovery silently swallows ALL parse errors (`discover-teams.ts:102` bare `catch{return undefined}`) — same class as M-13/WF-1; zero diagnostics. Add `logInternalError`.
### 🟡 DISC-3 · `readdirSync` unguarded in agent/workflow/team discovery (`discover-agents.ts:454`, `discover-workflows.ts:169,176`, `discover-teams.ts:110`) → crash on EACCES/broken-symlink/TOCTOU. Contrast `discover-skills.ts:124` is wrapped. Wrap each.
### 🟡 DISC-4 · No symlink rejection in agent/workflow/team discovery (inconsistent with skills' two `lstatSync` checks) → committed symlink in `.crew/agents/` is followed; user-scope agent overrides builtin with less-strict sanitization. Add `lstatSync`.
### 🟡 DISC-5 · Agent systemPrompt sanitization trust **inversion** (`discover-agents.ts:312-370`) — "user" scope gets *less* sanitization than "project" but has *higher* override priority (user > builtin). Regex is trivially bypassable. Rename to `stripKnownInjectionPatterns`; apply strictest level to all non-builtin.
### 🟢 DISC-6 · Workflow/team cache dir-stamp uses parent-dir mtime → **doesn't detect in-place edits** on POSIX (proven: `stat -c %Y` identical before/after edit). Stamp at file level. Agent cache has no mtime at all (5s TTL only). · DISC-7 skill inventory cache no mtime (30s TTL). · DISC-8 determinism misses `crypto.randomUUID`/`performance.now`/`process.hrtime`/indirect access. · DISC-9 lowercase-heading false positives can split task text into steps.

## Runtime test status (live `npm test`)
Started in background (PID). At time of writing: **3,102 unit tests passed, 0 failures**; integration suite (27 tests, 300s timeout each) in progress. This empirically confirms the unit layer is green — but note the *coverage gaps*: existing tests do **not** exercise H-1 (cross-callstack lock bypass), H-2 (duplicate-path retrieval output), NEW-D1 (coalesced-write cancellation), N-1/N-2 (worktree/live-session), OBS-NEW-1/2 (dead metrics), or DISC-1 (TS determinism bypass). **Green tests ≠ covered critical paths.**

## Revised roadmap deltas (from Round 3)

**Promote to Sprint 1 (one-liners):**
- **OBS-NEW-2** — add `durationMs` to run-completed payload.
- **OBS-NEW-4** — delete direct deadletter inc (`observability.ts:169`).
- **OBS-NEW-10** — slice `explicitBounds` (drop +Inf).
- **OBS-NEW-8** — delete-before-set in `Histogram.observe`.
- **T-A1** — wrap `handleSteer` in `withRunLockSync`.
- **T-S1** — status guard in `handleSteer`.
- **DISC-1** — esbuild transpile before acorn parse (restores P0-2 feature).

**Promote to Sprint 2/3:**
- **T-C2** — persist async metadata in `handleParallel` (fixes silent orphans).
- **OBS-NEW-1** — wire task-level event emission (unblocks task/duration/token dashboards).
- **OBS-NEW-7** — strip runId/taskId from 8 direct emission sites.
- **OBS-NEW-9** — final drain in both `dispose()` methods.
- **DISC-2/3/4** — consistent error logging + readdir guards + symlink rejection across discovery.

## Updated dimensional assessment
- **Observability**: 🟠 **Needs work** (was implicit "good"). Metrics pipeline largely non-functional; strong security but never validated end-to-end.
- **Discovery/loading**: 🟡 **Good with dead spots** (DISC-1 determinism no-op; inconsistent error/symlink handling).
- **Tools/extension**: 🟡 **Good** but two real correctness bugs (T-A1 steer race, T-C2 parallel orphans).

---

# Round 4 — Child-Pi / Goal-Loop / Dynamic-Workflow / Adapters-Lifecycle Deep-Dig (2026-07-18)

**Method:** 3 read-only deep-digs (child-pi subprocess lifecycle; goal-loop + dynamic-workflow + adaptive-plan + coalesced-group; adapters + command surface + extension lifecycle + crew-vibes). Added **57 new findings (9 HIGH, 21 MED, 27 LOW)**. Grand total now **~204 verified findings (~27 HIGH)**.

## ⚡ Major reframe — dynamic-workflow / goal-loop is the "wild west"
This layer has **significantly less hardening** than team-runner/state despite equal trust (both run commit-reviewed code). Cross-cutting defects:
- **Budget enforcement is systematically leaky** (4 independent under-counting paths: BDG-1 judge, BDG-2 race, BDG-3 coalesced, COAL-3 broadcast). The budget-abort threshold is effectively a *suggestion*, not a guarantee.
- **The global worker cap (`PI_CREW_MAX_WORKERS`) does NOT bound `ctx.agent()`** despite its docstring explicitly claiming it does (DLOCK-1). Fork-storm DoS vector for `.dwf.ts`.
- **The coalesced path (M6) is not production-ready** (COAL-1/2/3/4) — the M-8 finding ("0 workflows enable it") is *protective*: the code is wired but unsafe to turn on.
- **Dynamic-workflow resume re-runs the entire script** (PERS-1) — non-idempotent agent calls duplicate artifacts/mailbox edits and re-spend tokens.

## ➕ Child-Pi subprocess lifecycle (read-only)

### 🔴 CP-1 · Turn-limit hard-abort has NO SIGKILL escalation + NO process-group kill
**File:** `src/runtime/child-pi.ts:1338-1348` · The ONLY kill path that doesn't use `killProcessTree` or arm a `hardKillTimer`. A child that ignores/delays SIGTERM runs **forever** — and `onJsonEvent` keeps calling `restartNoResponseTimer()`, so the 5-min response timeout never fires either. (Every other path — abort/noResponseTimer — uses `killProcessTree` + SIGKILL escalation.)
**Fix:** Replace `child.kill("SIGTERM")` with `killProcessTree(child.pid, child)` + set `hardAbortInitiated` flag to stop `restartNoResponseTimer()` post-abort.

### 🟡 CP-2 · Drain paths use `child.kill()` not `killProcessTree` → grandchild orphans (`child-pi.ts:1402,1442`). · CP-4 · `forcedFinalDrain` exit-code override **masks crashes during the drain window** (`child-pi.ts:1497` — `finalExitCode=0` regardless of signal/crash; contradicts `crashClass`).
### 🟢 CP-3 orphaned hardKillTimer when both drain paths fire · CP-5 `PI_CREW_ROLE`/`PI_TEAMS_ROLE` filtered out by env allowlist (zombie-scan can't show role) · CP-6 multi-byte UTF-8 split across stdout chunks corrupts JSON events (use `TextDecoder` stream) · CP-7 module-scoped transcript batch buffer → cross-run flush race · CP-8 multiple untracked timers never cleared · CP-9 `killProcessTree` logs error-level stack on EVERY call (noise) · CP-10 steeringFile append sync + no path validation.

## ➕ Goal-loop / dynamic-workflow / adaptive-plan / coalesced (read-only)

### 🔴 GL-1 · Goal-loop ignores turn status → burns maxTurns on blocked/failed turns
**File:** `src/runtime/goal-loop-runner.ts:651-685` · After `executeTeamRun`, loop never checks `turnResult.manifest.status`. A `blocked` turn (plan-approval gate) or `failed` turn still spawns the LLM judge, records `not-achieved`, and re-enters — hitting the **same block condition** every turn. A 20-turn goal burns ~40K judge tokens doing zero work.
**Fix:** Check status; on `blocked`/`failed` set goal state + `break`.

### 🔴 BDG-1 · Goal-judge token usage NOT counted in budget
**File:** `src/runtime/goal-loop-runner.ts:375-382` (accumulateBudget sums task.usage only) vs `goal-evaluator.ts:198` (judge spawned via runChildPi with synthetic runId — NOT a task; `parsed.usage` discarded). Budget systematically under-counts. For 20-turn goal with 2K-token judge: actual 200K vs counted 160K → **never aborts even when over budget**.
**Fix:** Return `parsed.usage` from `evaluateGoal`; accumulate in loop.

### 🔴 BDG-2 · Dynamic-workflow token budget check-then-spend race
**File:** `src/runtime/dynamic-workflow-context.ts:329-367` · Budget check is BEFORE spawn, accumulation AFTER. With `concurrency=4` at 90% budget: all 4 acquire semaphore, all 4 pass check, all 4 spawn (~10% each) → **130% spend**. Tool description claims `ctx.agent()` "auto-rejects once exhausted" — **not guaranteed under concurrency**.
**Fix:** Reserve estimated budget before spawn (compare-and-swap), adjust after.

### 🔴 COAL-1 · `buildCoalescedPrompt` injects raw `step.task` (new M-23 instance, WORSE)
**File:** `src/runtime/run-coalesced-task-group.ts:183-198` · Separate prompt builder, does NOT import `sanitizeTaskText`. N tasks' raw text concatenated — a single malicious `step.task` poisons all N result partitions.
**Fix:** `sanitizeTaskText(step.task)` at line 191 (same as M-23 fix).

### 🔴 COAL-2 · Coalesced dispatch has NO retry → one transient failure fails all N tasks
**File:** `src/runtime/run-coalesced-task-group.ts:104-125` · Singleton path wraps in `executeWithRetry`; coalesced path calls `runChildPi` directly. One 429/OOM/pipe-race → all N read-only tasks `"failed"`. Coalesced path is **less reliable** than singleton for the same workload.
**Fix:** Wrap in `executeWithRetry`, or fall back to singletons on failure.

### 🔴 ERR-1 · Dynamic-workflow script timeout LEAKS child processes
**File:** `src/runtime/dynamic-workflow-runner.ts:200-215` · On timeout, `Promise.race` rejects but `script(frozenCtx)` stays pending; the `signal` is NOT aborted. A script that called `ctx.fanOut(items,4,fn→ctx.agent())` leaks up to 4 children — they **keep consuming tokens + mutating files** in the now-unlocked cwd. Comment admits "v1.5: use Worker threads."
**Fix:** On timeout, abort a combined signal (`AbortSignal.any`) so `runChildPi` terminates its children.

### 🔴 DLOCK-1 · `ctx.agent()` BYPASSES the global worker cap → fork-storm DoS
**File:** `src/runtime/dynamic-workflow-context.ts:340-367` calls `runChildPi` directly; `withWorkerSlot` has ZERO callers in dynamic-workflow-*.ts (grep-confirmed; only `goal-loop-runner.ts:652`). The `global-worker-cap.ts` docstring **explicitly claims** to bound `ctx.agent()/fanOut` — **that claim is false**. A `.dwf.ts` with `ctx.fanOut(Array(100),50,fn→ctx.agent())` spawns 50 children, ignoring `PI_CREW_MAX_WORKERS`.
**Fix:** Wrap `runChildPi` in `withWorkerSlot` in `ctx.agent()`.

### 🟡 GL-2 no timeout on evaluator (hung judge hangs the loop + holds workspace lock forever). · BDG-3 coalesced worker `task.usage` never recorded. · CTX-1 `ctx.agent()` returns `ok:true` on empty stdout (silent success). · CTX-2 `ctx.retry()` hardcodes role "executor" + `backoffMs:0` (broken). · COAL-3 broadcast fallback gives all tasks the full combined output (wrong attribution). · COAL-4 unbounded workspace tree in coalesced prompt. · ERR-2 no error type classification (can't distinguish transient/permanent/abort). · ERR-3 `ctx.review()` spawns up to 2 agents per call (cost 2×). · PERS-1 DWF resume re-runs entire script (duplicate artifacts/mailbox, re-spent tokens). · PERS-2 goal-loop doesn't clear `currentRunId` on crash → orphaned turn manifests. · CONC-1 `yieldBetweenTurns` busy-polls 50ms. · DLOCK-2 `gatherReplies` busy-polls 500ms, no deadline cap, not unref'd.
### 🟢 GL-3 verdict history O(N²) realloc. · CTX-3 fanOut/pipeline bypass semaphore for non-agent stages. · AP-1 adaptive plan silently truncates at 12 tasks. · AP-2 alias map hardcoded (custom roles silently dropped). · AP-3 phases strictly sequential (no DAG). · CONC-2/3 steering is per-turn only; review/retry unbounded recursion. · PERS-3 verdicts array unbounded (50MB at maxTurns=10000). · SEM-1 Semaphore over-release silently absorbed.

## ➕ Adapters / commands / extension lifecycle / crew-vibes (read-only)

### 🔴 CV-NEW-1 · `isWebTerminal()` does uncached sync I/O (up to 12 reads) on EVERY render tick
**File:** `src/extension/crew-vibes/font-detect.ts:36-52` · Walks up to 6 ancestors, `readFileSync(/proc/<pid>/cgroup)` + `(/proc/<pid>/status)` each = up to 12 sync reads, NO cache (unlike `hasCrewFontFile()`). Called from `capacityIcons`→footer render. **72+ syscalls/sec on Linux** during active runs.
**Fix:** `let _isWebTerminal: boolean|null = null` cache (1 line).

### 🟡 ADP-NEW-1 codex AGENTS.md export clobbers existing user content (no read-merge-write). · CMD-NEW-1 `parseRunArgs` silently appends unknown `--flags` to goal text (typo `--asyne`→becomes instruction; mild injection). · CMD-NEW-2 `skill-create --var` truncates values containing `=` (`"a=b=c".split("=",2)` → `["a","b"]` — data loss). · LC-NEW-1 unguarded `register*` calls → partial init on throw (no /team-* commands, no lifecycle, Pi shows no error). · LC-NEW-2 fire-and-forget `configure*` → early notifications silently dropped (router still undefined during ~50-200ms import). · CV-NEW-2 `CAPACITY_STATUS_ID`==`PROVIDER_STATUS_ID`==`"pi-crew-bar"` (collision). · CV-NEW-3 `session_shutdown` UI calls not in `safeUiCall`. · PB-NEW-1 `buildStepsPayload` calls `discoverWorkflows` every render tick. · PI-NEW-1 postinstall font-install return value ignored.
### 🟢 ADP-NEW-2/3/4 markdown injection in headers / empty slug filenames / no dedup by id. · CMD-NEW-3/4/5/6 team-config accepts arbitrary keys (typos) / unknown sub-actions silently no-op / parseScalar no floats + comma→array coercion / no escape in quoted strings. · LC-NEW-3/4/5 primePeerDep swallowed / initI18n crashes extension / getManifestCache partial state. · CTX-NEW-1/2 telemetryEnabled uncached sync I/O / wasted initial caches. · CV-NEW-4/5 resolveHome empty fallback / dead cgroup var. · PI-NEW-2 spawnSync no timeout. · ERR-NEW-1 tool_result hook empty catch.

## Revised roadmap deltas (from Round 4)

**Sprint 1 one-liners (add to the growing quick-win set):**
- **DLOCK-1** — wrap `runChildPi` in `withWorkerSlot` (makes the worker-cap docstring true; closes fork-storm vector).
- **GL-1** — check turn status + break (stops judge-token waste on blocked goals).
- **COAL-1** — `sanitizeTaskText` in `buildCoalescedPrompt` (close injection bypass).
- **CV-NEW-1** — cache `isWebTerminal()` (kills 72 syscalls/sec).
- **CMD-NEW-2** — `indexOf("=")` split (fixes `--var` data loss).
- **CP-1** — use `killProcessTree` + hardAbortInitiated flag (closes runaway-child).
- **ERR-1** — abort combined signal on dwf timeout (stops leaked children spending tokens).

**Sprint 2/3 (budget + coalesced correctness class):**
- **BDG-1 + BDG-2 + BDG-3** — close the 4-path budget leak (judge usage + reserve-then-adjust + coalesced usage).
- **COAL-2** — retry or singleton-fallback for coalesced dispatch.
- **PERS-1** — per-agent-call idempotency for DWF resume.
- **CP-2/CP-4** — `killProcessTree` in drain paths + fix exit-code override.

## Updated dimensional assessment
- **Async/Worker Reliability**: 🔴 **Needs serious work** (was 🟠). Dynamic-workflow path is under-hardened: worker cap bypassed, timeouts leak children, resume re-runs everything, budget systematically leaky.
- **Budget/Cost enforcement**: 🔴 **Not trustworthy** (new dimension). 4 independent under-counting paths; abort threshold is advisory only.
- **Coalesced dispatch (M6)**: 🔴 **Not production-ready** — keep disabled (the 0-enabled default is protective).
- **DX/command surface**: 🟡 **Good with paper cuts** (unknown-flag→goal, --var truncation, team-config typos).

## Final trust note
After 8 passes (parallel-research → cold-verify×3 → deep-dig×4 rounds with inter-round verification), the codebase is **exhaustively audited**: ~204 verified findings across every layer, with the major reliability/cost-correctness gaps now mapped. Remaining un-audited niches (benchmark/, a few custom-tools, deeper parser edge cases) are low-value. **The dominant pattern: the team-runner/state core is hardened; the dynamic-workflow + coalesced + observability paths are not.** Further digging has diminishing returns — the highest-leverage move now is to fix Sprint 1.
