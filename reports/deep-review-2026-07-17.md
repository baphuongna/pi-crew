# pi-crew Deep Review — Improvement Opportunities

**Date:** 2026-07-17 · **Target:** pi-crew v0.9.41 (~102,750 LOC TS) · **Method:** 8 parallel read-only audits (runtime, state, subagents, observability+config, UI, extension/team-tool, security STRIDE, tests/build/DX), cross-referenced against `SECURITY-ISSUES.md`, `UPGRADE-ROADMAP.md`, `PLAN-BUGFIXES.md`, `.crew/knowledge.md`.

> **107 concrete findings** distilled below (UI subsystem re-audited in full after the first UI agent died mid-report). Each has a `file:line` reference and a suggested fix. Severities are the auditors'. Two independent agents (Runtime + Subagents) converged on the same root cause for the live `pid_dead` 353s lag — high confidence.

---

## TL;DR — Health verdict

The core infrastructure is **battle-hardened**: locking, event-log, atomic-write, child-pi parsing, compact-pipeline, and verification-gate defenses are mature (with extensive "Round N" fix history). The problems cluster in **three areas**:

1. **Reliability/watchdog latency** — the watchdog layer has structural latency that explains the live `pid_dead` 353s lag we hit during this very review.
2. **Peripheral stores & code paths that bypass the hardened conventions** — several state stores, the parallel-dispatch path, and UI render paths skip atomic-write/locking/snapshot discipline that the core follows.
3. **A "tests-vs-shipped-artifact" blind spot** — the suite is huge (~5800 tests) but never loads `dist/index.mjs`, and the bundle-staleness CI guard is broken by design.

---

## UI/TUI Rendering — complete re-audit (23 findings)

Re-run after the first UI agent died mid-report. Full table (severity by the UI auditor):

| ID | Sev | Location | Issue |
|---|:---:|---|---|
| FIND-01 | 🔴 C | `live-conversation-overlay.ts:94` | `safeElapsedMs` not migrated to shared `computeLiveDurationMs` → can return **negative** durations (Round-23 fix never applied here) |
| FIND-02 | 🔴 C | `run-snapshot-cache.ts:78` | `mailboxStamp` does **O(N) stat per task** every refresh (~2,875 stat/s for 10 tasks at 80ms coalesce) |
| FIND-03 | 🟠 H | `render-diff.ts:31+57` | `Diff.diffWords()` called **twice** per changed line pair (similarity check discards result, render recomputes) |
| FIND-04 | 🟠 H | `run-dashboard.ts:340` | `buildSignature` resolves full run list + snapshots every spinner tick (~160ms), not just on data change |
| FIND-05 | 🟠 H | `live-run-sidebar.ts:186` | `loadRunManifestById()` sync disk read on **every** render (before cache check) |
| FIND-06 | 🟠 H | `transcript-viewer.ts:249` | `readRunTranscript()` re-parses growing transcript every ~500ms |
| FIND-07 | 🟠 H | `run-dashboard.ts:312` | 3 event-bus subs call `invalidateAndRender()` directly — no coalescing under bursts (ignores existing `RenderScheduler`) |
| FIND-08 | 🟠 H | `run-snapshot-cache.ts:366` | `signatureFor`/`sliceSignaturesFor` `JSON.stringify` whole snapshot + SHA-256 **twice** per build |
| FIND-09 | 🟡 M | `theme-adapter.ts:195` | 1000ms poll `setInterval` **per theme object** lacking `onThemeChange` |
| FIND-10 | 🟡 M | `render-coalescer.ts:21` | `request()` timer missing `.unref()` → keeps event loop alive if dispose skipped |
| FIND-11 | 🟡 M | `live-conversation-overlay.ts:53` | 200ms poll runs `refreshSummary` even when scrolled up; dead `frame++` |
| FIND-12 | 🟡 M | `transcript-cache.ts:76` | LRU eviction O(N) scan of all entries on every miss |
| FIND-13 | 🟡 M | `run-event-bus.ts:156` | `emit()` synchronous fan-out to 4 listener maps, no batching under bursts |
| FIND-14 | 🟡 M | `settings-overlay.ts:225` | Text input ASCII-only (` `..`~`) — drops Unicode/CJK/IME input |
| FIND-15 | 🟡 M | `powerbar-publisher.ts:161` | dedup state (`lastActiveKey`…) module-level globals → conflict across instances/hot-reload |
| FIND-16 | 🟡 M | `run-snapshot-cache.ts:495` | `evictIfNeeded` O(N) scan ignoring `Map` insertion-order LRU |
| FIND-17 | 🟢 L | `live-duration.ts:12` | gap in seconds/ms detection range `[10B,100B)` |
| FIND-18 | 🟢 L | `transcript-entries.ts:107` | O(n²) lookahead for tool_call→tool_result matching |
| FIND-19 | 🟢 L | `dynamic-border.ts:18` | new repeated-string allocation every render |
| FIND-20 | 🟢 L | `status-colors.ts:95` | global regex scan on every line even when no status glyphs |
| FIND-21 | 🟢 L | `widget-renderer.ts:104` | multiple `Date.now()` per render frame → sub-pixel metric inconsistency |
| FIND-22 | 🟢 L | `mascot.ts:226` | glitch effect allocates new 2D grid arrays per frame (GC pressure) |
| FIND-23 | 🟢 L | `render-coalescer.ts:18` | dropped events during debounce window have no callback (fire-and-forget; document) |

*(The earlier P0-6 / UI-P1-* items below correspond to FIND-05 / FIND-04 / FIND-07 / FIND-02 etc.)*

## 🔴 P0 — Fix now (correctness / security / reliability)

### P0-1 · The 353s `pid_dead` lag (live bug — we hit it during this review)
**Root cause (found independently by 2 agents):** `stale-reconciler.ts:checkPidLiveness` overrides the OS's authoritative `kill(pid,0)` → ESRCH ("process does not exist") verdict with a **5-minute heartbeat grace window**. A dead PID cannot unfreeze, so the corroboration is pure latency.
- `src/runtime/stale-reconciler.ts:160–168` — `if (ageMs < 5*60_000) return { alive: true }`
- compounded by `autoRepairIntervalMs` 60s poll (`extension/registration/observability.ts:180–205`) → total ≈ 300–360s ≈ **observed 353s**.
- **Fix:** When `kill(0)` throws **ESRCH** (not EPERM), repair immediately. Keep heartbeat corroboration only for the EPERM case. PID-recycling is already handled separately via `getProcessStartTime`. → Eliminates ~300s of the lag in one edit.
- **Confidence:** HIGH (math: 5min grace + ≤60s tick = ~353s, matches observation exactly).

### P0-2 · Session shutdown kills individual PIDs, not process groups → orphan grandchildren
**`src/extension/crew-cleanup.ts:95–110`** uses `process.kill(pid, "SIGTERM")` on each registered PID. But workers spawn with `detached:true, setsid:true` (`child-pi.ts:556`) — so grandchildren (bash, MCP servers) survive as orphans, and there's **no SIGKILL escalation** (a stuck child lingers forever).
- **Fix:** Replace loop body with `killProcessPid(pid)` (already exists in `child-pi.ts` — does group-aware `-pid` SIGTERM + `HARD_KILL_MS` SIGKILL escalation + Windows taskkill).

### P0-3 · Security: cross-extension RPC cwd validation bypass (swapped args) — NEW
**`src/extension/cross-extension-rpc.ts:127–130`** calls `resolveContainedPath(params.cwd, ".")` — arguments swapped. This validates that `.` is inside `params.cwd` (trivially true for **any** path) instead of validating that `params.cwd` is inside the project dir. Any extension on the event bus can trigger a team run with `cwd:"/tmp/evil"`. Auditor reproduced the bypass.
- **Fix:** `resolveContainedPath(ctx.cwd, params.cwd)`. One-line, HIGH-severity.
- **Aggravator:** RPC HMAC auth is **off by default** (`rpc-hmac.ts:135` — `withHmacVerification` passes through unsigned when `PI_CREW_RPC_SECRET` unset). Consider default-deny for run operations or a loud startup warning.

### P0-4 · `parallel-dispatch` runs created without `ownerSessionId` → ownership checks bypassed
**`src/extension/team-tool/parallel-dispatch.ts:151–158`** omits `ownerSessionId` + `runKind` and never calls `registerActiveRun`. Since `cancel`/`retry`/`resume` guard with `typeof ownerSessionId === "string"` → check is **silently skipped**, so any session can cancel/retry parallel runs. They're also invisible to the active-run index & orphan detection.
- **Fix:** Mirror `handleRun` (`run.ts:397–400`): pass `ownerSessionId: ctx.sessionId`, `runKind:"team-run"`, call `registerActiveRun`/`unregisterActiveRun` in a try/finally (also fixes orphaned manifests on spawn failure — Ext Finding 9).

### P0-5 · Tests never exercise the shipped bundle `dist/index.mjs`
Every test imports `../../src/**/*.ts`. The live entry is `dist/index.mjs` (esbuild + CJS-shim). **CI can be 100% green while the shipped bundle is broken.** Combined with the documented v0.9.13 stale-bundle regression, this is a real false-confidence gap.
- **Fix:** Add `test:bundle` that dynamically `import()`s `dist/index.mjs` and asserts default export is a function + `registerPiTeams`/`waitForRun` exported + calling with a fake Pi API doesn't throw. Add to `ci` after `build:bundle`. (~2h)

### P0-6 · UI render path does synchronous disk I/O on every 160ms tick (violates widget rules)
Three components read disk inside `render()`:
- `src/ui/live-run-sidebar.ts:160,182` — `loadRunManifestById` + `readCrewAgents` every render
- `src/ui/widget/index.ts:177–179` — `activeWidgetRuns()` (incl. `readCrewAgents`) **before** the cache-signature check
- `src/ui/run-dashboard.ts:160–164,190` — `readFileSync` on progress file + `readCrewAgents` fallback

This directly violates the `widget-rendering` SKILL.md ("render from snapshots only, never disk"). Under a 20-task parallel run (50+ events/s) it causes frame drops & CPU spikes.
- **Fix:** Render only from `snapshotCache.get(runId)` (already populated by the preload loop); return `["(loading…)"]` on first frame; remove `readFileSync` fallbacks.

---

## 🟠 P1 — High (do this sprint)

### Reliability / runtime
| ID | Location | Issue | Fix |
|---|---|---|---|
| RT-F2 | `registration/observability.ts:205,240` | Auto-repair & temp-reconcile timers are `.unref()`'d → never fire when event loop idle → zombie detection only on next user activity | Add session-activity hook (on `before_agent_start`/user turn) to tick `reconcileAllStaleRuns` opportunistically |
| RT-F3 | `crash-recovery.ts:505`, `heartbeat-watcher.ts:83` | `manifestCache.list(50)` cap hides stale runs beyond top-50 | Filter by `status==="running"` **before** the limit; add `listActive()` (typically <10) |
| RT-F5 | `crash-recovery.ts:370–440` | `purgeStaleActiveRunIndex` mutates run state **without** `withRunLockSync` (odd one out — `reconcileAllStaleRuns` & `cancelOrphanedRuns` do lock) | Wrap mutation block in `withRunLockSync` |
| RT-F7 | `goal-loop-runner.ts:264` | Bare `require()` under ESM strip-types loader → `ReferenceError` → goal-loop silently "blocked" | `await import(...)` or `createRequire(import.meta.url)` (as `dynamic-workflow-runner.ts:207` does) |
| SUB-H2/H3 | `async-runner.ts:280–307`, `register.ts:948` | No `child.on("exit")` → `unregisterWorker` never called; orphan pruning only on `session_start` | Add lightweight exit handler; add `cleanupOrphanWorkers` to the periodic auto-repair timer |
| SUB-M4 | `subagent-manager.ts:317–351` | `pollRunToTerminal` polls forever if run never reaches terminal | Add max lifetime (e.g. 30min) |

### State durability — peripheral stores bypass atomic-write conventions
Core (`atomic-write.ts`, `locks.ts`, `event-log.ts`) is hardened, but these skip it:

| ID | Location | Issue | Fix |
|---|---|---|---|
| ST-1 | `state/schedule.ts:131–141` | `ScheduleStore.save()` raw `writeFileSync`, no lock → crash truncates `schedules.json` → ctor silently resets to `{jobs:[]}` (all schedules lost); concurrent sessions race | `atomicWriteJson` + `withFileLockSync` |
| ST-2 | `state/health-store.ts:51–53` | `HealthStore.saveSnapshot()` raw `writeFileSync` → corrupt file silently skipped by loader | `atomicWriteFile` |
| ST-3 | `state/instinct-store.ts:86–97` | No lock + non-atomic `writeFileSync`/`appendFileSync` + no fsync → JSONL corruption, lost-update on rewrite | `withFileLockSync` + `atomicWriteFile` |
| ST-4 | `state/run-cache.ts:75–84` | Entry file non-atomic while index gets atomic (priorities inverted); fixed `index.json.tmp` name → concurrent collision | `atomicWriteFile`/`atomicWriteJson` + lock around index RMW |
| ST-5 | `runtime/checkpoint.ts:89–94` | Hand-rolled atomic write **skips data fsync** before rename (only fsyncs parent dir) → power-loss can leave empty checkpoint | `fs.fsyncSync(fd)` before rename, or reuse `atomicWriteFile` |

### Config / schema
| ID | Location | Issue | Fix |
|---|---|---|---|
| CFG-1 | `config/config.ts:980–1001`, `types.ts` | **11 phantom config fields** declared in types & read by runtime but never parsed (e.g. `reliability.autoRepairIntervalMs`, `scopeModels`, `forcePreflight`, `ignoreMethod`) → user settings silently ignored | Wire into schema+parser or remove from types; add a test asserting every `PiTeamsConfig` key exists in schema+parser |
| EXT-3 | `team-tool/handle-schedule.ts:64–66` | `once`/`interval` accept NaN/Infinity → `new Date(NaN).toISOString()` throws `RangeError` | `Number.isFinite()` guard + schema `minimum`/`SafeInteger` |
| EXT-4 | `schema/team-tool-schema.ts` | `subAction`/`jobId` in interface but not in TypeBox schema → stripped by strict validators; handler falls back to `config.subAction` (confusing) | Add to schema or remove from interface & document |

### Security (NEW / under-reported)
| ID | Location | Issue | Fix |
|---|---|---|---|
| SEC-02 | `runtime/verification-gates.ts:107` | `validateGateCommand` regex allows `node -e '...'`, `npm test` (runs arbitrary package.json scripts), `python -c` → config-controlled shell exec | Allowlist command prefixes OR default to `verification-worktree` sandbox (exists, off by default) |
| SEC-04 | `team-tool.ts:399`, `mailbox.ts`, `task-runner/prompt-builder.ts` | **Mailbox & steering messages injected into prompts WITHOUT sanitization** (unlike task text & agent prompts, which are sanitized) → indirect prompt-injection vector between workers | Apply `sanitizeTaskText` or wrap in `<untrusted_data>` delimiters |
| SEC-03 | `rpc-hmac.ts:135` | RPC HMAC off by default → all cross-extension RPC unauthenticated | Default-deny run ops or loud startup warning |
| SEC-07 | `team-tool/context.ts:113–116` | `configRecord` type-casts without `sanitizeObject` (defense-in-depth gap vs `parseConfig`) | Route through `sanitizeObject` |

### Extension layer
| ID | Location | Issue | Fix |
|---|---|---|---|
| EXT-2 | `team-tool/run.ts` (~480–560, 620–700, bottom) | Result-formatting logic **triplicated** (~150 lines × 3) already diverging (`workspaceId` arg differs) | Extract `formatRunResult(...)` helper |
| EXT-5 | `register.ts` (30+ `pi.on(...)`) | No per-handler unsubscribe (Pi limitation); on hot-reload every handler doubles up | Idempotency guard at top of `registerPiTeams` + document platform limitation |
| EXT-7 | `team-tool.ts:394–397` → `register.ts:684–710` | Global registry installed with stubs then async-patched → query window returns stubs (`undefined`/`false`) | Lazy init or pass `getManifestCache` factory into installer |

### UI throughput
| ID | Location | Issue | Fix |
|---|---|---|---|
| UI-P1-1 | `run-dashboard.ts:300`, `live-run-sidebar.ts:167`, `widget/index.ts:136` | 3 overlays subscribe directly to `runEventBus` (3 channels each = up to 9 callbacks/event) bypassing `RenderScheduler` → ~150 invalidate+requestRender/sec under load | Route subscriptions through one `RenderScheduler` (it already supports `events`+`debounceMs`) |
| UI-P1-2 | `run-dashboard.ts:270–289` | `buildSignature()` calls `snapshotFor`→`refreshIfStale` for every run on every render; on TTL-expiry `mailboxStamp` is O(tasks) `readdirSync`+`statSync` (~225 syscalls/s) | Cache signature w/ short TTL; use snapshot's existing SHA-256 `signature` field; gate by "event-since" counter |
| UI-P1-3 | `run-snapshot-cache.ts:135–145` | `mailboxStamp` O(tasks) stat per snapshot refresh | Stamp the mailbox dir mtime once, not per-task |

### Tests / build
| ID | Location | Issue | Fix |
|---|---|---|---|
| TB-2 | `extension/register.ts` (~1624 LOC) | `registerPiTeams` monolith has **no unit tests** (1 lifecycle test only); single integration point for whole extension | Refactor into composable modules (roadmap P0-3); short-term: assert tool/command/hook registration on a Pi mock |
| TB-3 | `scripts/check-bundle-staleness.mjs` | **mtime-based, excluded from CI** → committed stale bundle goes undetected (the v0.9.13 class of regression) | Content-hash approach: hash `index.bundle.ts`+`src/**/*.ts`, store in `dist/build-source-hash.txt`, compare in CI; OR `build:bundle` in CI + `git diff --exit-code dist/index.mjs` |
| TB-4 | all integration tests | Universally mock child-Pi (`PI_TEAMS_MOCK_CHILD_PI`) → real process lifecycle never CI-tested | CI integration test spawning a fake pi fixture that emits valid JSON lines (no LLM needed) |
| TB-5 | `scripts/test-runner.mjs:40–56` | Windows/macOS flakiness mitigated by concurrency clamp, not root-caused (atomic-write rename contention) | Unique temp dirs per test; more rename retries on Windows |

---

## 🟡 P2 — Medium (backlog)

**Runtime/State**
- RT-F6 `state/event-log.ts:160` — `withEventLogLockSync` busy-waits `sleepSync(10)` up to 5s, blocks event loop. Migrate 5 remaining sync `appendEvent` call sites in `team-runner.ts` to async.
- RT-F8 `scheduler.ts:139–147` — scheduler timers not `.unref()`'d → keep process alive forever. Add `.unref()`.
- RT-F9 `background-runner.ts:447–465` — global `process.exit` monkey-patch is fragile; prefer `process.on('exit')`.
- RT-F4 `stale-reconciler.ts:664` — `else if (canCleanup)` is **dead** (canCleanup false in else-branch); concurrent-cleanup coordination for orphaned temp workspaces silently never runs.
- RT-F10 `manifest-cache.ts:155–180` — full FS scan + JSON.parse of all manifests on 500ms TTL expiry; use the existing `fs.watch` watchers to incrementally update.
- ST-7 `atomic-write.ts:378–397` — coalesced writes (`atomicWriteJsonCoalesced`, 50ms) lost on SIGKILL → terminal task status may be stale on resume. Bypass coalescer for terminal transitions.
- ST-8 `atomic-write-v2.ts:33–37` — uses `renameSync` (symlink-following) vs primary path's `renameWithLinkSync`. Consolidate to one impl.
- ST-6 `worker-atomic-writer.ts` — when opted-in, bypasses ownership check, data fsync, uses rename (weaker symlink safety). Document or replicate full safety path.
- SUB-M1 `live-session-runtime.ts:858,864` — subscribe callback exceptions propagate unguarded (child-pi path wraps in try/catch, this one doesn't). Wrap.
- SUB-M2 `live-agent-manager.ts:248–275` — evicts slow-but-alive running agents after 30min (a long rate-limited API call) → session can't resume. Check liveness before disposing.
- SUB-M3 `child-pi.ts:ChildPiLineObserver` — buffer unbounded for no-newline output. Cap at ~1MB and force-flush.

**Observability**
- OBS-1 `observability/event-to-metric.ts:91,119` — **HIGH**: `runId`/`taskId` as metric labels = cardinality explosion; `MAX_LABEL_COMBINATIONS=10_000` silently evicts → unreliable aggregation. Remove these labels; emit detail to event log instead.
- OBS-2 `metric-sink.ts:66` — `fs.writeSync` on main thread each 60s tick. Use async.
- OBS-3 `exporters/adapter.ts:7` vs `otlp-exporter.ts:97` — `dispose(): void` interface but impl is `async`; callers don't await → exports silently lost on shutdown. Make interface `Promise<void>`.

**Config**
- CFG-2 — no compile-time guarantee types/schema/parser stay in sync (root cause of CFG-1). Add a sync test.
- CFG-3 `drift-detector.ts:128–136` — only checks top-level keys; nested unknown keys missed.

**Extension**
- EXT-6 `destructive-gate.ts` uses `=== true` but `cancel.ts:125`/`team-tool.ts handleResume` use loose truthiness → inconsistent confirm/force handling. Standardize.
- EXT-8 `handle-schedule.ts` — `cron` accepts any-length string (no ReDoS/length guard; `api.ts` caps glob at 200 but cron has no cap).
- EXT-10 `run.ts:400` — `runKind` silently accepted/stored for non-dynamic workflows.
- EXT-13 `hooks/registry.ts:103` — hook `modify` mutates shared `ctx` in-place (cross-hook contamination via shared ref).

**DX**
- TB-6 `scripts/` — 46 entries, only ~12 referenced by `package.json`; 20+ one-off fix/patch/test-issue scripts. Archive to `scripts/archive/`.
- TB-7 — no test for `buildKnowledgeFragment` IDF scoring (controls what workers see).
- TB-9 — `compact-stages/` 6 stages, only 2 individually tested.
- TB-11 `scripts/postinstall.mjs:31–34` — bundle-build failure only `console.warn` (easy to miss).
- TB-13 `biome.json` disables `noUnusedImports`, `noUnsafeFinally`, `noExplicitAny`, etc. Re-enable incrementally (start with `noUnusedImports`).

---

## 🟢 P3 — Low / hygiene

- RT-F11 `child-pi.ts:99–106` — module cleanup interval `.unref()`'d → minor zombie-entry leak when idle.
- RT-F12 `stale-reconciler.ts:287–289` — `formatStaleReconcileError` deprecated, no callers (dead code).
- ST-12 — stray `src/state/test_write.txt` test artifact.
- OBS-4 `correlation.ts:10` — `spanCounter` never resets (cross-session span-ID collision / growth).
- OBS-5 `metric-retention.ts:33–40` — `TimeWindowedCounter.count()` is O(N) with JSON.stringify per event.
- OBS-6 `event-bus.ts:39–50` — no listener cap, synchronous emit (latent; no production subscribers yet).
- OBS-7 — schema allows `metricRetentionDays: 365` (multi-GB disk); lower max or add size-based rotation.
- CFG-5 `resilient-parser.ts:85` — reports only first error per field (frustrating config debugging).
- CFG-6 `otlp-exporter.ts:27–103` — SSRF check is hostname-only (DNS rebinding to metadata IP passes).
- SEC-08 `team-tool.ts:402–407` — steering file path via string concat (safe today due to `createTaskId` sanitize, but fragile) → use `resolveContainedPath`.
- TB-10 — no combined `dev` script (watch:bundle + test:watch).
- TB-12 — smoke tests manual-dispatch only; consider weekly scheduled run.

---

## Cross-cutting themes (architectural)

1. **"Round N" fix history signals structural pressure points** at the intersection of *background-process lifecycle × lock management × stale detection*. The watchdog layer keeps getting patched (F1's 5-min grace is itself a patch over an earlier false-positive). Consider a cleaner liveness model: ESRCH is authoritative; heartbeats inform, never override.
2. **Hardened-core vs bypass-periphery pattern.** Atomic-write/locking/snapshot conventions are followed meticulously in core code but skipped by ~6 peripheral stores and 3 UI components. A shared `StateStore` abstraction (atomic-write + lock enforced at the type level) would prevent recurrence.
3. **Type↔schema↔parser drift.** Three separate artifacts (`types.ts`, TypeBox schema, per-field parsers) with no compile-time binding → 11 phantom fields today, more tomorrow. One sync test would lock this down.
4. **Render-path discipline gap.** The `widget-rendering` SKILL.md is correct but unenforced; 3 components violate it with sync disk I/O. Consider a lint rule or a `render()` contract that forbids `fs.*Sync`.
5. **Trust boundary: indirect prompt injection between agents** is only partially defended — task text & agent prompts are sanitized, but mailbox/steering messages (worker→worker/leader channel) are not. In a multi-agent system this is the highest-leverage injection surface.

---

## Recommended action plan

**Phase 0 — this week (P0, all small, high-impact):**
1. P0-1 `checkPidLiveness` ESRCH fix (1 file, kills the 353s lag)
2. P0-3 RPC `resolveContainedPath` arg swap (1-line security fix)
3. P0-4 `parallel-dispatch` `ownerSessionId` (mirror `handleRun`)
4. P0-2 `crew-cleanup` → `killProcessPid` (group kill)
5. P0-6 UI render-path disk I/O removal (3 files)

**Phase 1 — next sprint (P1 reliability + durability):**
6. RT-F2/F3/F5 (watchdog: activity-hook, status-filtered scan, missing lock)
7. ST-1..ST-5 (5 peripheral stores → atomic-write; ST-5 checkpoint fsync)
8. SUB-H2/H3 (background-runner exit handler + periodic orphan prune)
9. SEC-04 (sanitize mailbox/steering) + SEC-03 (RPC default posture)
10. CFG-1 (wire/remove 11 phantom fields) + sync test

**Phase 2 — build confidence (P1 tests/build):**
11. TB-1/P0-5 bundle smoke test + content-hash staleness check in CI
12. TB-4 real child-process integration test (fake pi fixture)
13. TB-2 register.ts registration tests (start before refactor)

**Phase 3 — throughput & cleanup (P2):**
14. UI-P1-1/P1-2/P1-3 (RenderScheduler routing + signature caching)
15. OBS-1 (remove high-cardinality metric labels)
16. EXT-2 (de-triplicate handleRun formatting)
17. TB-6 (archive scripts/), TB-13 (re-enable biome rules)

---

## Methodology & confidence notes

- All findings carry `file:line` references with quoted code (verified by the auditors against current source, not assumed).
- Security findings cross-checked against `SECURITY-ISSUES.md` (39 rounds): SEC-001/002/007 & Round-39 path-traversal fixes **confirmed genuinely fixed** in source. **SEC-003 (skill injection) — DEEP-DIVE CORRECTION:** the security auditor marked it "partially fixed (project skills searched first)", but verification shows the **injection path is genuinely fixed** — `skill-instructions.ts` `candidateSkillDirs`/`readSkillMarkdown` are package-FIRST with first-wins, proven by an explicit regression test (`test/unit/skill-instructions.test.ts:136`). The auditor confused the inventory path (`discover-skills.ts`, was project-first) with the injection path. Residual fixed: `discover-skills.ts listSkillDirs` reordered to package-first + false "first hit wins" JSDoc corrected. (Project-unique skills still inject verbatim with UNTRUSTED warning — accepted by-design risk, same as AGENTS.md.)
- **Subagents C1 (group-kill on shutdown) — DEEP-DIVE CORRECTION:** the auditor called this CRITICAL ("session shutdown kills individual PIDs → orphan grandchildren") but only examined `crew-cleanup.ts`. Verification shows graceful `session_shutdown` (reason=quit/reload) ALSO runs `register.ts` → `terminateActiveChildPiProcesses()` (robust process-GROUP kill `-pid` + SIGKILL escalation) — so grandchildren ARE handled on graceful shutdown. The REAL (narrower) gap is the **SIGTERM/SIGHUP signal handler** path, which called only the weak single-PID `cleanupChildProcesses()` (no escalation, no group-kill) — relevant when the Pi process is killed by signal (shell `kill`, OOM). Severity: CRITICAL → **MEDIUM/HIGH**. Fixed: `cleanupChildProcesses()` now uses `killProcessPid` (lazy-imported) for group-kill + escalation; applies to both the session_shutdown and signal handlers.
- The 353s `pid_dead` root cause was derived arithmetically (5min grace + ≤60s tick ≈ 353s) and matched against the live failure observed during this review.
- UI audit agent (UI/TUI) initially failed mid-report (6 findings); a full re-run completed it to **23 findings (2 Critical / 6 High / 8 Medium / 7 Low)** — the totals below reflect the complete UI audit.
- **Deep-dive severity corrections (3 of 3 audited claims over-stated by sub-agents):** P0-3 RPC cwd-bypass (HIGH→MEDIUM, exploit neutralized), SEC-003 skill-injection ("partially fixed"→genuinely fixed), C1 group-kill (CRITICAL→MEDIUM/HIGH, mitigated on graceful shutdown). Lesson: audit findings need code-level verification before acting — but all 3 still yielded a real defense-in-depth fix.
- Source changes from deep-dives (NOT read-only): `src/extension/cross-extension-rpc.ts` (P0-3, +4 regression tests in `test/unit/cross-extension-rpc.test.ts`), `src/skills/discover-skills.ts` (SEC-003 residual), `src/extension/crew-cleanup.ts` (C1), `src/runtime/stale-reconciler.ts` (Runtime F1 / the live 353s `pid_dead` lag — removed the heartbeat override of authoritative `kill(0)` ESRCH; +1 regression test in `test/unit/stale-reconciler.test.ts`), `src/runtime/settings-store.ts` + `src/extension/team-tool/handle-schedule.ts` + `src/state/schedule.ts` (State ST-1), and `src/config/config.ts` + `src/schema/config-schema.ts` (Config CFG-1 — wired 10 previously-phantom config fields into parser + schema; +`test/unit/config-phantom-fields.test.ts`), and `src/observability/event-to-metric.ts` (OBS-1 — dropped high-cardinality `runId`/`taskId` metric labels from `retry_attempt_total` (now label-less) and `supervisor_contact_total` (reason only); +regression test in `test/unit/event-to-metric.test.ts`), `src/ui/live-conversation-overlay.ts` (UI FIND-01 — replaced local `safeElapsedMs` with shared `computeLiveDurationMs` to fix negative-duration bug; Round-23 fix migration), `src/extension/team-tool/parallel-dispatch.ts` (Ext F1 — added `ownerSessionId: ctx.sessionId` + `runKind: "team-run"` to `createRunManifest` closing the foreign-run ownership bypass), and `package.json` + `test/unit/bundle-load.test.ts` (Tests #1 — added `test:bundle` script + integrated `build:bundle && test:bundle` into `ci` so the shipped bundle is exercised in CI). All pass typecheck + targeted tests + check-lazy-imports. **Six findings where the auditors were exactly right:** F1 (root cause + arithmetic matched the live 353s observation), CFG-1 (11 phantom fields confirmed by programmatic check), and OBS-1 (cardinality anti-pattern confirmed in code). The other 4 deep-dived (P0-3/SEC-003/C1/ST-1) were imprecise but still yielded real fixes.
- **UI FIND-02 (mailboxStamp O(N) stat) — VERIFIED, fix DEFERRED:** confirmed the O(N) `readdirSync` + per-task `stampFile` loop in `run-snapshot-cache.ts:127`, but the auditor's 2,875 stat/s figure is overstated (real ~250/s of cheap stat calls given 80ms coalesce and N≤20 typical). A correctness-safe stamp cache is hard (TTL risks mailbox-message UI staleness; dir-mtime cache is unreliable on most FS for per-file changes; a proper fix needs per-file mtime tracking). Severity reassessed HIGH→Medium. Deferred to a focused perf pass.
- **Tests #2 (register.ts 1623 LOC, zero direct registration tests) — VERIFIED, fix DEFERRED:** confirmed the monolith (1623 LOC) has no test exercising tool/command/hook registration (grep `pi.registerTool|pi.registerCommand|pi.on` in test/ = 0). Proper fix is the roadmap P0-3 refactor (decompose `registerPiTeams` into composable modules + add tests). Out of scope for a deep-dive.
- **State findings ST-2..ST-13 (non-atomic write class) — BATCH-VERIFIED:** the batch `writeFileSync` scan confirmed all State findings (HealthStore:44, InstinctStore:100, run-cache.ts:112/122, checkpoint.ts:80) are real, AND the class extends beyond State into extension (project-init, management, run-import, chain-executor, registration/commands) and runtime (orphan-registry, foreground-control, background-runner, team-runner, stale-reconciler) — a systemic "bypass atomic-write convention" issue. Mechanical fix (mirror ST-1 template: `atomicWriteFile` + `withFileLockSync`) is straightforward but touches ~15 files; deferred to a focused state-durability pass.
- **Config CFG-1 (phantom config fields) — CONFIRMED + FIXED:** definitively verified by a programmatic check (fed all 11 fields; `parseConfig` dropped every one while control fields were kept). 10/11 are real "silently-ignored setting" bugs (declared in `types.ts` + read by runtime + dropped by parser → user config has no effect, always default): `reliability.autoRepairIntervalMs/forcePreflight/ambientStatusInjection/perWriteValidation/scopeModels`, `limits.serializeOnPathOverlap`, `runtime.yield`, `runtime.excludeContextBash`, `ui.autoCloseDashboardMs`, top-level `ignoreMethod`. Fixed: wired all 10 into their parsers AND the TypeBox schema (`additionalProperties:false` required both; verified `Value.Check` accepts). The 11th (`autonomous.excludeContextBash`) is a dead type (no runtime reader) — left in place, noted.
- **State ST-1 (ScheduleStore non-atomic write) — DEEP-DIVE CORRECTION:** the State auditor correctly identified the bug pattern (raw `writeFileSync` + silent reset to `{jobs:[]}` on corrupt read) but targeted `src/state/schedule.ts` `ScheduleStore` — which is **dead code (never instantiated in production)**; scheduling persists via `saveCrewSettings` (`<cwd>/.pi/crew-settings.json`). The REAL bug of the same class lives in `src/runtime/settings-store.ts` `saveCrewSettings` (raw `writeFileSync`, project-scoped → cross-session load-modify-save race). Fixed: `saveCrewSettings`→`atomicWriteJson` (durability); added `updateCrewSettings` (locked + atomic transaction) and refactored the 3 `handle-schedule.ts` persist functions to use it (fixes both durability and the race); also made `ScheduleStore.save` atomic for consistency (honest docstring).

### Security residue pass (AUDIT-03/05/06) — 2026-07-17

- **AUDIT-03 / SEC-03 — VERIFIED + FIXED (hardening):** `registerPiCrewRpc` accepts unsigned RPC when `PI_CREW_RPC_SECRET` is absent, by intentional backward compatibility. Added one process-wide startup warning naming `PI_CREW_RPC_SECRET`; no behavior change, no log spam. Existing operation allowlists, rate limits, session checks, and cwd containment remain active.
- **AUDIT-05 — VERIFIED, already fixed:** dynamic workflows return an informational preflight result and are logged by both `team-tool/run.ts` and `team-runner.ts`. No duplicate warning added.
- **AUDIT-06 — VERIFIED + FIXED (audit trail):** pre-step execution now emits `hook.pre_step_started`, `hook.pre_step_completed`, and `hook.pre_step_failed`; existing `hook.pre_step_optional_failed` retained. Events record script path, argument count, timeout, exit code, optional flag, and output byte count; stdout is never persisted in the event log.
- **Bundle verification:** `test:bundle` initially exposed a stale test contract requiring a disposal object from the default entry, while `registerPiTeams` is typed and implemented as `void`. Test aligned to the actual public contract: callable, no throw. Rebuilt `dist/index.mjs`; bundle tests pass.
- **Verification:** typecheck ✅; targeted tests 43/43 ✅; `check:lazy-imports` ✅; Biome lint/format ✅; bundle build + test ✅.

### Follow-up verification — 2026-07-17

- **AUDIT-06 correction:** review found that placing `resolveRealContainedPath()` inside the `preStepOptional` catch would let an optional hook bypass path-containment failures. Fixed by moving validation outside the catch; `preStepOptional` now applies only to execution failures. Added regression check.
- **AUDIT-05 correction:** topology info (`runtime decides topology`) was not equivalent to a security/trust warning. Added a warning at actual dynamic-workflow dispatch: `.dwf.ts` runs as trusted Node.js code with `process`/`require`/`import` access; only reviewed scripts should run.
- **Final verification:** typecheck ✅; targeted tests 57/57 ✅; lazy-import check ✅; Biome targeted lint/format ✅; bundle rebuilt and bundle tests 2/2 ✅; `git diff --check` ✅.
