# pi-crew v0.9.56 — Remediation Plan

> **Note (2026-08-02)**: post-remediation source reorganization moved `src/runtime/child-pi-*.ts` → `src/runtime/child-pi/` and `src/runtime/crew-broker-*.ts` → `src/runtime/broker/`, and removed 4 dead-code modules. Paths in this plan are pre-reorg. See `docs/COVERAGE-ASSESSMENT-2026-08-01.md` § Source reorganization + `src/runtime/README.md` (cluster map).

**Date:** 2026-07-30
**Source audit:** `AUDIT-2026-07-30.md` (corrected, 3 verify rounds)
**Baseline:** 6489 unit tests (6486 pass, 3 skip, 0 fail, 839 suites), typecheck 0 errors, 2.4 MB tarball
**Scope:** ALL findings — Tier 1 (SEC-1..5), Tier 2 (ST-1..6, RT-1..5, EXT-1..2), Tier 3 (RT-6..19, ST-7..15, EXT-3..12, UI-1..14, QA-1..12)

---

## 1. Sprint Breakdown

| Sprint | Theme | Findings Covered | Est. Effort | Priority |
|--------|-------|-----------------|-------------|----------|
| **A** | Security — Critical | SEC-1, SEC-2, SEC-4, SEC-5 *(SEC-3 detached — decision item, §4)* | ~3h | P0 |
| **B** | Quick wins & cleanup | RT-2, RT-3, RT-4, RT-10, RT-11, RT-18, RT-19, ST-6, EXT-3, EXT-7, UI-8, QA-1, QA-3, QA-4, QA-5 | ~1 day | P1 |
| **C** | Data-loss & correctness core | ST-1, RT-1, ST-4, ST-5, ST-7, ST-12, RT-6, RT-8, RT-9 | ~2 days | P1 |
| **D** | Reliability & LLM ergonomics | RT-5, ST-3, EXT-1, EXT-2 | ~2 days | P1 |
| **E** | State/durability hardening | ST-8, ST-9, ST-10, ST-11, ST-13, ST-14, ST-15 | ~1.5 days | P2 |
| **F** | UI, extension & quality cleanup | UI-1, UI-2, UI-4..7, UI-9..14, EXT-4, EXT-5, EXT-6, EXT-8, EXT-10, EXT-11, EXT-12, QA-2, QA-6, QA-7, QA-8, QA-9, QA-10, QA-11, QA-12 | ~2 days | P2/P3 |
| **G** | Structural debt (deferred) | RT-7/12/13/14/15/16/17 *(split: G1a/G1b/G1c)*, EXT-9, UI-3, UI-4 | ~3 days | P2/P3 |

**Total: 52 PRs across 7 sprints covering 72 findings.** (G1 split into G1a/G1b/G1c sequential sub-PRs; SEC-3 detached as decision item — does not block Sprint A.)

---

## 2. PR Batches

### Sprint A — Security (4 PRs, all disjoint files)

#### PR-A1 | SEC-1 + SEC-4 | Critical + Medium
| Field | Value |
|-------|-------|
| **Findings** | SEC-1 (Critical — RCE via project agent `extensions:`), SEC-4 (Medium — O(n²) DoS on agent-file sanitizer) |
| **Files/symbols** | `src/agents/discover-agents.ts`: `parseAgentFile` (~:420 — strip `extensions`/`excludeExtensions` for `source:"project"`); sanitize regexes at ~:320,340 (cap input, bound quantifiers `{0,8192}?`, add 256KB file-size cap in `readAgentDir`); `src/runtime/pi-args.ts`: `buildPiWorkerArgs` (~:303-313 — deny `--extension` from project agents behind `PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1`) |
| **Effort** | S–M, ~3h |
| **Depends on** | none |
| **Can parallelize with** | PR-A2, PR-A3, PR-A4 (disjoint files) |
| **Test** | Add: `test/security/project-agent-extensions-rce.test.ts` (assert project agents cannot set extensions → `--extension` not in argv); `test/security/agent-sanitizer-dos.test.ts` (assert 320KB agent file short-circuits in <100ms) |
| **Risk** | SEC-1 same pattern as F-01 (`.dwf.ts` deny). SEC-4: 7 additional call sites with same regex pattern — only fix agent-file path now (highest risk); mark others (markers.ts, prose-compressor.ts, etc.) as follow-up. **Same file** (`discover-agents.ts`) → must be one PR to avoid conflict. |

#### PR-A2 | SEC-2 | Critical
| Field | Value |
|-------|-------|
| **Findings** | SEC-2 (Critical — `.crew/knowledge.md` injected verbatim into system prompt) |
| **Files/symbols** | `src/extension/knowledge-injection.ts`: `registerKnowledgeInjection` (~:389-402) and `buildKnowledgeFragment` (~:360 — call `sanitizeAgentSystemPrompt(content, "project")` on the knowledge text before joining); wrap output in `<untrusted-project-data>` demarcation; reframe "respect project conventions" as "reference-only"; cap conventions section to 2KB |
| **Effort** | S, ~2h |
| **Depends on** | none |
| **Can parallelize with** | PR-A1, PR-A3, PR-A4 |
| **Test** | Add: `test/security/knowledge-injection-sanitization.test.ts` (assert `<script>` tags stripped, prompt-injection directives neutralized, byte cap enforced) |
| **Risk** | Must not break legitimate knowledge injection — test with real `.crew/knowledge.md` content. Existing `buildKnowledgeFragment` is called from both `registerKnowledgeInjection` (main session) and `prompt-builder.ts` (workers). Both paths need sanitization. |

#### PR-A3 | SEC-3 | Medium — ⚠️ DECISION POINT
| Field | Value |
|-------|-------|
| **Findings** | SEC-3 (Medium — Redaction fail-open on >100 markers or >2MB is INTENTIONAL) |
| **Files/symbols** | `src/utils/redaction.ts`: `redactSecrets` (~:272-280) — **NOT a blind fix**. Trade-off decision: (a) keep current fail-open (DoS-resistance) or (b) fail-closed (replace oversized region with `***`) or (c) linear `indexOf` window-scan O(n) |
| **Effort** | S, ~1h (if option chosen) |
| **Depends on** | **HUMAN SIGN-OFF** — escalate to maintainer before implementing |
| **Can parallelize with** | PR-A1, PR-A2, PR-A4 |
| **Test** | Existing `redaction-redos-regression.test.ts` #4/#5 already test intentional behavior. If switching to fail-closed: update those tests. |
| **Risk** | Changing to fail-closed loses the ~50ms DoS-resistance bound. Recommendation: option (c) linear window-scan — O(n) with no DoS risk AND no fail-open. But requires performance benchmarking. |

#### PR-A4 | SEC-5 | Medium
| Field | Value |
|-------|-------|
| **Findings** | SEC-5 (Medium — `handleCleanup` lacks `confirm:true` self-enforcement) |
| **Files/symbols** | `src/extension/team-tool/lifecycle-actions.ts`: `handleCleanup` (~:266-289) — add `if (params.confirm !== true) return result("cleanup requires confirm: true …", ...)` at function top, matching `handleForget` (~:168) and `handlePrune` (~:129) pattern |
| **Effort** | S, ~30min |
| **Depends on** | none |
| **Can parallelize with** | PR-A1, PR-A2, PR-A3 |
| **Test** | Add: `test/destructive-gate-cleanup-self-enforce.test.ts` (assert cleanup returns error without confirm:true, matching forget/prune behavior) |
| **Risk** | Low — defense-in-depth only. Sole barrier currently is `pi.on("tool_call")` hook. All sibling actions self-enforce. |

**Sprint A Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm test` → 6489 tests, 0 new failures
- Manual: clone hostile repo, open pi, verify agent extension NOT loaded (SEC-1); verify `.crew/knowledge.md` injection sanitized (SEC-2)
- **SEC-3 is a DECISION item (§4) — does NOT block Sprint A 

---

### Sprint B — Quick Wins & Cleanup (10 PRs, all disjoint files)

#### PR-B1 | RT-2 + RT-3 + RT-4 + RT-18 | P1
| Field | Value |
|-------|-------|
| **Findings** | RT-2 (SIGINT bypasses runCleanup), RT-3 (startup failures exit 0), RT-4 (interrupt guard never acks, re-fires 4×/s), RT-18 (18 signal handlers each doing sync appendEvent) |
| **Files/symbols** | `src/runtime/background-runner.ts`: SIGINT handler (~:425-428 → mirror :146-151 pattern: `abortController.abort(); process.exitCode = 130`); module-level catch (~:828-839 → write `async.failed` event + set `process.exitCode = 1`); interrupt guard (~:122 → write `acknowledged: true` to foreground-control.json, add module-local `interruptHandled` gate); signal handler loop (~:430-457 → consolidate to single `appendEventFireAndForget`) |
| **Effort** | M, ~4h |
| **Depends on** | none (Sprint A should complete first for clean merge base) |
| **Can parallelize with** | ALL other Sprint B PRs (disjoint files) |
| **Test** | Add: `test/background-runner-sigint-cleanup.test.ts`, `test/background-runner-startup-fail.test.ts`, `test/interrupt-guard-ack.test.ts` |
| **Risk** | Medium — background-runner is the async execution spine. RT-2 fix is trivial (pattern already exists at :146-151). RT-4 ack write must be sync (can't await in polling callback). |

#### PR-B2 | ST-6 | P1
| Field | Value |
|-------|-------|
| **Findings** | ST-6 (transient read error quarantines healthy manifest) |
| **Files/symbols** | `src/runtime/crash-recovery.ts`: catch block (~:379-404) — distinguish `SyntaxError` (quarantine) from `ErrnoException` (retry with backoff); add `.corrupt-*` age sweep in `pruneFinishedRuns` |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | Add: `test/crash-recovery-transient-read.test.ts` (mock EBUSY → assert manifest NOT quarantined) |

#### PR-B3 | QA-4 + QA-5 | P2
| Field | Value |
|-------|-------|
| **Findings** | QA-4 (309 warnings hidden by `--diagnostic-level=error`), QA-5 (5 disabled lint rules have 0-1 violations → re-enable) |
| **Files/symbols** | `biome.json`: re-enable `noDuplicateElseIf`, `noVoidTypeReturn`, `noUnsafeFinally`, `noUselessTernary`, `noShadowRestrictedNames`, `noNonNullAssertedOptionalChain`, `noUselessSwitchCase`, `noConfusingVoidType`, `useIterableCallbackReturn`, `noImplicitAnyLet`; `package.json` lint script (~:74 → remove `--diagnostic-level=error`); fix the ~20 violations from re-enabled rules |
| **Effort** | S, ~2h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | `npm run lint` → 0 errors AND visible warnings (not hidden) |
| **Risk** | Low — rules with 0-1 violations. The 1-violation rules need small fixes (rename a shadowed var, remove useless ternary, etc.) |

#### PR-B4 | QA-1 | P2
| Field | Value |
|-------|-------|
| **Findings** | QA-1 (`check:bundle-size` NOT wired into CI) |
| **Files/symbols** | `.github/workflows/ci.yml`: add `npm run check:bundle-size` step after `npm run build:bundle` |
| **Effort** | S, ~15min |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | CI green on PR |

#### PR-B5 | UI-8 | P3
| Field | Value |
|-------|-------|
| **Findings** | UI-8 (TEMP DIAGNOSTIC code left in production) |
| **Files/symbols** | `src/ui/run-dashboard.ts`: ~:404-407, 434-445, 825-832 — remove `PI_CREW_BROKER_DIAG_UI` gated diagnostic blocks |
| **Effort** | S, ~15min |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | `npm run typecheck` + existing UI tests pass |

#### PR-B6 | EXT-3 | P1
| Field | Value |
|-------|-------|
| **Findings** | EXT-3 (dead code — `src/adapters/` 7 files, 260 lines, only test imports) |
| **Files/symbols** | `src/adapters/` (claude-adapter.ts, codex-adapter.ts, cursor-adapter.ts, export-util.ts, index.ts, registry.ts, types.ts) — delete entire directory; update test imports |
| **Effort** | S, ~30min |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | `npm run typecheck` + `npm test` → 0 failures; verify `handleExport` uses `run-export.ts` not adapters |
| **Risk** | Low — verify no production code imports from `src/adapters/` via grep first |

#### PR-B7 | EXT-7 | P2
| Field | Value |
|-------|-------|
| **Findings** | EXT-7 (Action enum verbose `anyOf`+`const` → compact `enum`, saves ~325 tokens/tool def) |
| **Files/symbols** | `src/schema/team-tool-schema.ts`: ~:172-176 (`runActions`, `statusActions`, etc. — replace `Type.Unsafe({ anyOf: [{ const: "run" }] })` with compact union/literal form); verify `allActionLiterals` still works |
| **Effort** | S, ~1h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | `npm run typecheck`; verify `Value.Check(TeamToolParams, ...)` still validates correctly |
| **Risk** | Medium — TypeBox schema changes affect LLM tool definition. Must verify the flattened schema still serializes to valid JSON schema. `allActionLiterals` extraction logic (~:358) depends on `.anyOf` structure. |

#### PR-B8 | QA-3 | P2
| Field | Value |
|-------|-------|
| **Findings** | QA-3 (TEST_MATRIX.md numbers wrong: claims 2703/133, actual 6489/839) |
| **Files/symbols** | `TEST_MATRIX.md` — update counts to match actual baseline |
| **Effort** | S, ~15min |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | Manual: `npm test 2>&1 | tail -5` → copy real numbers |

#### PR-B9 | RT-10 + RT-11 | P2
| Field | Value |
|-------|-------|
| **Findings** | RT-10 (~35 lines dead operation-tracking + dead steering branch), RT-11 (2 of 4 spawn sites invisible to host-SIGTERM cleanup) |
| **Files/symbols** | `src/runtime/child-pi.ts`: remove `PendingOperation` interface + `startOperation`/`completeOperation`/`rejectPendingOperations` (~:479-509, only `json_event` type used, no rejection logic depends on it); remove `steerInjectionFailed` const (~:509, always false); fix spawn sites (~:433-435 — add `runId`/`agentId` to 2 missing `registerChildProcess` calls) |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint B PRs |
| **Test** | `npm run typecheck` + `npm test`; add `test/child-pi-spawn-registration.test.ts` (assert all spawn sites register with runId+agentId) |

#### PR-B10 | RT-19 | P2
| Field | Value |
|-------|-------|
| **Findings** | RT-19 (parent-guard doc aspirational vs reality — root cause of RT-2 orphan class) |
| **Files/symbols** | `src/runtime/parent-guard.ts`: ~:4,91 — fix doc comments to reflect reality (guard only runs in `background-runner.ts:508`, NOT in workers); `src/runtime/child-pi-spawn.ts`: ~:134 — document that `PI_CREW_PARENT_PID` env var is set but has NO consumer (pi-crew nor Pi binary reads it) |
| **Effort** | S, ~30min (doc-only) |
| **Depends on** | PR-B1 (RT-2 fix should be applied first — the SIGINT fix in background-runner.ts is the actionable mitigation) |
| **Can parallelize with** | ALL other Sprint B PRs except PR-B1 (RT-19 references RT-2's fix pattern) |
| **Test** | `npm run typecheck` (doc-only, no behavioral change) |
| **Risk** | None — doc correction only. Deeper fix (wire `startParentGuard` into Pi worker entry point) is HARD (worker is external `pi` binary — pi-crew doesn't control its entry point). Mark as **DEFERRED**. |

**Sprint B Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm run lint` → 0 errors (now visible warnings)
- `npm test` → ≥6489 pass, 0 new failures
- `npm run build:bundle` → success
- CI green on all 3 OS × Node 22

---

### Sprint C — Data-Loss & Correctness Core (7 PRs, all disjoint files)

#### PR-C1 | ST-1 | P0
| Field | Value |
|-------|-------|
| **Findings** | ST-1 (worktree reuse destroys untracked directories and binary files) |
| **Files/symbols** | `src/worktree/worktree-manager.ts`: `snapshotDirtyWorktree` (~:604-612) — use `git status --porcelain -uall` instead of default (don't collapse dirs); `git diff HEAD --binary` for tracked binary diffs; base64-encode non-UTF-8 files instead of `readFileSync(abs, "utf-8")`; cap per-file bytes |
| **Effort** | M, ~4h |
| **Depends on** | none (Sprint B should merge first) |
| **Can parallelize with** | PR-C2, PR-C3, PR-C4, PR-C5, PR-C6, PR-C7 (all disjoint files) |
| **Test** | Add: `test/worktree-snapshot-dirs-binary.test.ts` (create `packages/newmod/` + `assets/logo.png`, crash, retry → assert snapshot captures both) |
| **Risk** | Medium — worktree snapshot is P0 data-loss path. Fix must handle: untracked dirs, binary files, tracked binary diffs. |

#### PR-C2 | RT-1 | P1
| Field | Value |
|-------|-------|
| **Findings** | RT-1 (scheduler early-returns clobber in-flight tasks to `skipped`) |
| **Files/symbols** | `src/runtime/team-runner.ts`: `handleFailedTask` (~:1098-1138) — before `markBlocked` + `saveRunTasksAsync` at ~:1137-1138, call `await drainPendingUnits(ctx.pendingUnits, ctx.runController)` and merge settled results; use `cancelNonTerminalTasks` for in-flight IDs instead of `markBlocked` (which maps `queued → skipped` blindly) |
| **Effort** | M, ~4h |
| **Depends on** | none |
| **Can parallelize with** | PR-C1, PR-C3, PR-C4, PR-C5, PR-C6, PR-C7 (disjoint files) **+ PR-D1 (RT-5)** cross-sprint — files disjoint |
| **Test** | Add: `test/team-runner-failed-task-while-siblings-inflight.test.ts` (3-task parallel batch, A fails when B in-flight → B NOT marked skipped; B results merged) |
| **Risk** | **HIGH** — team-runner.ts is the scheduler spine (2372 lines). This PR must complete BEFORE any Sprint G PR that also touches team-runner.ts. Also touches `drainPendingUnits` call in `finally` block (~:2419) — ensure no double-drain. |

#### PR-C3 | ST-4 | P1
| Field | Value |
|-------|-------|
| **Findings** | ST-4 (corrupt `tasks.json` silently becomes EMPTY, then overwritten) |
| **Files/symbols** | `src/state/state-store.ts`: `loadRunManifestById` sync (~:816) and async (~:936) — distinguish `ENOENT` from `SyntaxError`; on parse failure, quarantine corrupt file + call `reconstructTasksFromEvents` from `src/state/event-reconstructor.ts`; add `Array.isArray` guard; refuse to persist `[]` over non-empty tasks |
| **Effort** | S, ~2h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint C PRs |
| **Test** | Add: `test/state-store-corrupt-tasks-recovery.test.ts` (write malformed JSON to tasks.json → assert reconstruction from events.jsonl, NOT empty array) |
| **Risk** | Medium — `reconstructTasksFromEvents` is dead code that needs to be verified to compile and produce correct output. Test the reconstruction path explicitly. |

#### PR-C4 | ST-5 + ST-12 | P1 + P2
| Field | Value |
|-------|-------|
| **Findings** | ST-5 (sync + buffered paths use in-process-only sequence counter), ST-12 (`nextSequence` full-scans log even with valid sidecar) |
| **Files/symbols** | `src/state/event-log.ts`: `reserveSequence` (~:359-368) — replace body with `reserveSequenceUnderLock` body (re-read sidecar each call); `nextSequence` (~:296-330) — trust sidecar without full-scan when valid; call sites at ~:926 (buffered) and ~:1017 (sync) |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint C PRs |
| **Test** | Add: `test/event-log-cross-process-seq-sync.test.ts` (two processes, assert no duplicate seq numbers via sync path) |
| **Risk** | Low — `reserveSequenceUnderLock` already exists and works for async path. Just wire sync/buffered paths to use it. |

#### PR-C5 | RT-9 | P2
| Field | Value |
|-------|-------|
| **Findings** | RT-9 (line-buffer overflow flushes entire buffer as one "line" — destroys JSON events) |
| **Files/symbols** | `src/runtime/child-pi-streams.ts`: `LineAccumulator.append` (~:192-209) — on overflow, split buffer on `\n` BEFORE force-flushing; emit complete lines individually; only force-flush the trailing partial line |
| **Effort** | S, ~1h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint C PRs |
| **Test** | Add: `test/child-pi-streams-buffer-overflow.test.ts` (write 1MB buffer with embedded newlines → assert each JSON line parsed, not one giant blob) |

#### PR-C6 | ST-7 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-7 (`atomicWriteFile` leaks temp file on rename failure) |
| **Files/symbols** | `src/state/atomic-write.ts`: ~:595,621,679,684 — `fd` is set to `undefined` at ~:621 (after close) but cleanup at ~:679 checks `fd !== undefined`; fix: capture `tempPath` before `fd` is cleared and `fs.unlinkSync(tempPath)` on rename failure |
| **Effort** | S, ~1h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint C PRs |
| **Test** | Add: `test/atomic-write-temp-leak.test.ts` (mock rename failure → assert temp file cleaned up) |

#### PR-C7 | RT-6 + RT-8 | P2
| Field | Value |
|-------|-------|
| **Findings** | RT-6 (spawn budget uses `DEFAULT_RETRY_POLICY.maxAttempts` instead of configured policy), RT-8 (in-place mutation of `TeamTaskState`) |
| **Files/symbols** | `src/runtime/task-runner/child-executor.ts`: ~:248-251 (replace `DEFAULT_RETRY_POLICY.maxAttempts` with actual configured `retryPolicy.maxAttempts` from `input.runtimeConfig`); ~:422,462-466 (spread `{...task}` before mutation instead of in-place `.status =`) |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint C PRs |
| **Test** | Add: `test/child-executor-spawn-budget-config.test.ts` (configured maxAttempts=10 → budget uses 10, not default 3) |
| **Risk** | Low — RT-6 is a value-passing fix. RT-8 is an immutability fix (spread before mutation). |

**Sprint C Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm test` → ≥6489 pass, 0 new failures
- Manual: run `team action='run', workflow='research', goal='test RT-1 fix'` → verify no in-flight tasks marked `skipped` when sibling fails
- Manual: verify `reconstructTasksFromEvents` produces valid output on a corrupt tasks.json

---

### Sprint D — Reliability & LLM Ergonomics (4 PRs, all disjoint files)

#### PR-D1 | RT-5 | P1
| Field | Value |
|-------|-------|
| **Findings** | RT-5 (coalesced dispatch diverges from singleton in 5 unsafe ways) |
| **Files/symbols** | `src/runtime/run-coalesced-task-group.ts`: ~:139-166,230 — (1) branch cancel → `"cancelled"` not `"failed"`; (2) `success = exitCode === 0 && !error` (not just `exitCode === 0`); (3) pass `runtimeConfig.maxTurns` instead of hardcoded `5` (~:147); (4) arm `taskTimeoutMs` from config; (5) use `shouldUseRetry`/`retryPolicyFromConfig` instead of `DEFAULT_RETRY_POLICY` (~:151) |
| **Effort** | M, ~4h |
| **Depends on** | none — files **disjoint** (RT-1 = `team-runner.ts`/`state-store.ts`; RT-5 = `run-coalesced-task-group.ts`). **Can run concurrently with PR-C2.** Add integration test at merge verifying both green. |
| **Can parallelize with** | PR-D2, PR-D3, PR-D4 (disjoint files) |
| **Test** | Add: `test/run-coalesced-cancel-status.test.ts`, `test/run-coalesced-maxturns-config.test.ts`, `test/run-coalesced-timeout.test.ts`, `test/run-coalesced-retry-config.test.ts` |
| **Risk** | Medium — coalesced path is a separate executor with its own dispatch logic. Must read `runCoalescedTaskGroup` signature carefully to know which params are available. |

#### PR-D2 | ST-3 | P1
| Field | Value |
|-------|-------|
| **Findings** | ST-3 (mailbox: one file, three disjoint locks → message loss) |
| **Files/symbols** | `src/state/mailbox.ts`: collapse three lock mechanisms to one namespace (`.flock`); sync append; async append (~:677 → currently uses `withFileLockAsync` — replace in-process promise chain with `withFileLockAsync` consistently); full-file rewrite (~:815/875 → currently uses `.flock`); add O_EXCL tier to `withFileLockAsync` for cross-process safety |
| **Effort** | M, ~3h |
| **Depends on** | none |
| **Can parallelize with** | PR-D1, PR-D3, PR-D4 |
| **Test** | Add: `test/mailbox-sync-async-concurrent.test.ts` (sync append + async rewrite concurrently → no message loss) |
| **Risk** | Medium — mailbox is critical coordination infrastructure. Lock unification must not deadlock. |

#### PR-D3 | EXT-1 | P1
| Field | Value |
|-------|-------|
| **Findings** | EXT-1 (typo'd field names silently ignored — `additionalProperties: true`) |
| **Files/symbols** | `src/extension/registration/team-tool.ts`: ~:105-106 (after `Value.Check` passes, scan `Object.keys(params)` for unrecognized keys, use `findClosestKey` from `src/config/suggestions.ts:52` to suggest correction); `src/config/suggestions.ts`: export `findClosestKey` if not already exported |
| **Effort** | M, ~2h |
| **Depends on** | none |
| **Can parallelize with** | PR-D1, PR-D2, PR-D4 |
| **Test** | Add: `test/team-tool-typo-detection.test.ts` (pass `{action:"run", goals:"fix bug"}` → assert error "Unrecognized field 'goals' — did you mean 'goal'?") |
| **Risk** | Low — post-validation scan. Must build a set of known param keys from schema to diff against `Object.keys(params)`. |

#### PR-D4 | EXT-2 | P1
| Field | Value |
|-------|-------|
| **Findings** | EXT-2 (per-action validation errors lack examples — 11+ handler files) |
| **Files/symbols** | `src/extension/team-tool/param-error.ts`: add `paramRequired(action, field, example?)` helper; apply across handler files: `run.ts` (~:388), `status.ts` (~:22), `cancel.ts` (~:87,179), `respond.ts` (~:19), `inspect.ts` (~:12,36,59), `lifecycle-actions.ts` (~:24,77,167), `handle-schedule.ts` (~:103), `parallel-dispatch.ts` (~:32), `goal.ts` (~:299,328,389,513), `api.ts` (~:124) |
| **Effort** | M, ~3h |
| **Depends on** | none |
| **Can parallelize with** | PR-D1, PR-D2, PR-D3 (disjoint files — param-error.ts is separate from team-tool.ts and run-coalesced-task-group.ts) |
| **Test** | Existing handler tests should cover; add spot-check `test/handler-error-examples.test.ts` (assert error messages include example shapes) |
| **Risk** | Low — mechanical refactor. Many handler files touched but change is uniform (wrap error string with helper). |

**Sprint D Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm test` → ≥6489 pass, 0 new failures
- Manual: call `team action='run', goals='test'` → verify typo hint returned (EXT-1)
- Manual: call `team action='status'` without runId → verify error includes example (EXT-2)

---

### Sprint E — State/Durability Hardening (5 PRs)

#### PR-E1 | ST-8 + ST-11 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-8 (rotation copy+truncate window loses appends), ST-11 (compaction reads whole event log twice under lock) |
| **Files/symbols** | `src/state/event-log-rotation.ts`: ~:300-301 (use rename+create instead of copy+truncate; or atomic-rename approach); ~:104,137 (stream event log line-by-line instead of full `readFileSync` + `JSON.parse` per line under append lock) |
| **Effort** | M, ~3h |
| **Depends on** | none (disjoint from event-log.ts which was PR-C4) |
| **Can parallelize with** | PR-E2, PR-E3, PR-E4, PR-E5 (disjoint files) |
| **Test** | Add: `test/event-log-rotation-append-race.test.ts`, `test/event-log-compaction-memory.test.ts` |

#### PR-E2 | ST-9 + ST-10 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-9 (only manifest.json versioned; no migration), ST-10 (`ArtifactDescriptor.retention`/`expiresAt` never enforced) |
| **Files/symbols** | `src/state/types.ts`: ~:167 (add `schemaVersion` to tasks.json/goal-state/mailbox types); ~:19-20 (wire `retention`/`expiresAt` enforcement in artifact cleanup); `src/state/state-store.ts`: ~:849-853 (add version check + migration stub for tasks.json) |
| **Effort** | M, ~3h |
| **Depends on** | **PR-C3** (ST-4 also touches `state-store.ts` — must merge first) |
| **Can parallelize with** | PR-E1, PR-E3, PR-E4, PR-E5 (after C3 merges) |
| **Test** | Add: `test/tasks-json-version-migration.test.ts`, `test/artifact-retention-enforcement.test.ts` |

#### PR-E3 | ST-13 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-13 (`spliceConflict` rewrites every line ending in mixed-EOL file) |
| **Files/symbols** | `src/state/conflict-detect.ts`: ~:346-360 — detect and preserve original EOL style; only rewrite conflicting lines, not the entire file |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint E PRs |
| **Test** | Add: `test/conflict-detect-mixed-eol.test.ts` |

#### PR-E4 | ST-14 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-14 (`withFileLockSync` re-entrance map process-global, not async-context-scoped) |
| **Files/symbols** | `src/state/locks.ts`: ~:448,391-394 — scope re-entrance map to async context (same fix class as H-1 for `withRunLockSync`) |
| **Effort** | S, ~1.5h |
| **Depends on** | none |
| **Can parallelize with** | ALL other Sprint E PRs |
| **Test** | Add: `test/locks-reentrance-async-context.test.ts` |

#### PR-E5 | ST-15 | P2
| Field | Value |
|-------|-------|
| **Findings** | ST-15 (`prepareAgentWorktree` silently drops isolation on 2nd call) |
| **Files/symbols** | `src/worktree/worktree-manager.ts`: ~:1066-1088 — make branch name non-deterministic (append timestamp or counter); return error instead of `undefined` when worktree already exists |
| **Effort** | S, ~1h |
| **Depends on** | **PR-C1** (ST-1 also touches `worktree-manager.ts` — must merge first) |
| **Can parallelize with** | PR-E1, PR-E2, PR-E3, PR-E4 (after C1 merges) |
| **Test** | Add: `test/worktree-prepare-twice-isolation.test.ts` |

**Sprint E Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm test` → ≥6489 pass, 0 new failures

---

### Sprint F — UI, Extension & Quality Cleanup (17 PRs)

#### UI Performance & Leak Cleanup

| PR ID | Findings | Files/Symbols | Effort | Depends | Parallel With |
|-------|----------|---------------|--------|---------|---------------|
| **PR-F1** | UI-6, UI-11, UI-14 | `src/ui/theme-adapter.ts`: ~:215-220 (addEventListener leak), ~:223-229 (1s polling fallback), ~:98 (dead `thinkingColorForLevel`) | S | none | F2–F17 |
| **PR-F2** | UI-1, UI-5 | `src/ui/run-snapshot-cache.ts`: ~:925-935 (wire async path instead of sync statSync/readFileSync), ~:445-470 (`mailboxFrom` → async readdirSync) | M | none | F1, F3–F17 |
| **PR-F3** | UI-7 | `src/ui/widget/index.ts`: ~:107-108,128-129 (resize listener leak — guard `off()`) | S | none | F1,F2,F4–F17 |
| **PR-F4** | UI-9 | `src/ui/transcript-viewer.ts`: ~:310-315 (debounce `readRunTranscript` on keypress) | S | none | F1–F3,F5–F17 |
| **PR-F5** | UI-10 | `src/ui/widget-formatters.ts`: ~:179 (comprehensive NO_COLOR / non-TTY mode) | M | none | F1–F4,F6–F17 |
| **PR-F6** | UI-2 | `src/ui/keybinding-map.ts`: ~:35-65 (read overrides from `.crew/config.json` or env) | M | none | F1–F5,F7–F17 |

#### Extension DX

| PR ID | Findings | Files/Symbols | Effort | Depends | Parallel With |
|-------|----------|---------------|--------|---------|---------------|
| **PR-F7** | EXT-4, EXT-8 | `src/extension/team-tool/action-suggestions.ts`: ~:22-76 (drift test vs `allActionLiterals`); `src/schema/team-tool-schema.ts`: single source of truth for action list | M | **PR-B7** (EXT-7 touches same file) | F1–F6,F8–F17 |
| **PR-F8** | EXT-5 | `src/extension/team-tool/dispatch/*.ts` (5 files — add `assertNever` exhaustiveness checking) | S | none | F1–F7,F9–F17 |
| **PR-F9** | EXT-6 | 9+ handler files (extract `locateRunCwd` + `loadRunManifestById` pattern to shared helper) | M | **PR-D4** (EXT-2 touches same handler files) | F1–F8,F10–F17 |
| **PR-F10** | EXT-10 | `src/subagents/` (8 files — evaluate if re-export shims add value; if not, inline) | S | none | F1–F9,F11–F17 |
| **PR-F11** | EXT-11 | `src/extension/registration/team-tool.ts`: ~:41-48 (remove stale performance benchmarks) | S | **PR-D3** (EXT-1 touches same file) | F1–F10,F12–F17 |
| **PR-F12** | EXT-12 | `src/i18n.ts` + team-tool handlers (add i18n to team tool for consistency) | S | none | F1–F11,F13–F17 |

#### Quality/Packaging

| PR ID | Findings | Files/Symbols | Effort | Depends | Parallel With |
|-------|----------|---------------|--------|---------|---------------|
| **PR-F13** | QA-2, QA-10 | `package.json`: ~:31 (`files` field — replace `*.ts`/`*.mjs` with explicit file list; exclude dev scripts like `build-bundle.mjs`); peer deps update 0.82.1→0.83.0 | S | none | F1–F12,F14–F17 |
| **PR-F14** | QA-6 | `biome.json`: staged fix of `noExplicitAny` (122 violations — fix incrementally, enable rule) | M | **PR-B3** (biome.json touched in B3) | F1–F13,F15–F17 |
| **PR-F15** | QA-7, QA-8, QA-9, QA-12 | Test files: fix `setMaxConcurrent` weak assertion; optimize RetryRunner 49.1s test; track 2 skipped tests; fix timing-dependent flaky tests | S | none | F1–F14,F16–F17 |
| **PR-F16** | QA-11 | `.npmignore`: exclude `src/**/*.d.ts` conflict with `clean-strip-types.mjs` "must be preserved" | S | none | F1–F15,F17 |
| **PR-F17** | UI-12, UI-13 | `src/ui/settings-overlay.ts` + `src/ui/live-conversation-overlay.ts` — add basic test coverage | S | none | F1–F16 |

**Sprint F Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm run lint` → improved (fewer `any`, visible warnings)
- `npm test` → ≥6489 pass, 0 new failures, test suite faster (RetryRunner fix)
- `npm pack --dry-run` → verify tarball excludes dev scripts

---

### Sprint G — Structural Debt / Deferred (3 PRs)

#### PR-G1a | RT-13 + RT-15 | P2 — state-consistency (sub-PR 1/3)

**⚠️ Sequential with G1b/G1c — all touch `team-runner.ts`.**

| Field | Value |
|-------|-------|
| **Findings** | RT-13 (`updateRunStatus` status-rewrite hack), RT-15 (SchedulerContext dual-state: 8 manual sync points) |
| **Files/symbols** | `src/runtime/team-runner.ts`: ~:2326-2327 (remove `manifest = {...manifest, status: "running"}` hack — add legal-transition path to `updateRunStatus`); ~:2247-2312 (reduce dual-state sync points) |
| **Effort** | M, ~1 day |
| **Depends on** | **PR-C2** (RT-1 — MUST merge first; both modify team-runner.ts scheduler flow) |
| **Can parallelize with** | PR-G2, PR-G3 (disjoint files) |
| **Test** | extend `team-runner-*`; mutation (revert legal-transition → throw test fails) |
| **Risk** | HIGH — state-transition consistency. Do FIRST (foundation for G1b/G1c). |

#### PR-G1b | RT-16 | P2 — table refactor (sub-PR 2/3)

| Field | Value |
|-------|-------|
| **Findings** | RT-16 (`shouldMergeTaskUpdate` 78 lines / 13 guards) |
| **Files/symbols** | `src/runtime/team-runner.ts`: ~:283-361 (refactor to use `TEAM_TASK_STATUS_TRANSITIONS` table) |
| **Effort** | M, ~0.5 day |
| **Depends on** | **PR-G1a** (same file, sequential) |
| **Can parallelize with** | PR-G2, PR-G3 |
| **Test** | extend `team-runner-*`; add `test/team-runner-should-merge-table.test.ts`; mutation |
| **Risk** | MEDIUM — behavior-equivalent refactor; assert transitions identical to old 13-guard logic. |

#### PR-G1c | RT-7 + RT-12 + RT-14 + RT-17 | P2 — perf/cleanup (sub-PR 3/3)

| Field | Value |
|-------|-------|
| **Findings** | RT-7 (writeProgress WeakMap identity cache never hits), RT-12 (mergeUnitResult rebuilds wrapper array), RT-14 (cancelNonTerminalTasks module-private + 10 inline), RT-17 (batch-summary filename ENAMETOOLONG) |
| **Files/symbols** | `src/runtime/team-runner.ts`: ~:445-530 (key cache on runId string), ~:1707-1721 (hoist wrapper array), ~:250 + 10 sites (export helper, replace inline), ~:2385-2390 (hash/truncate filename) |
| **Effort** | M, ~1 day |
| **Depends on** | **PR-G1b** (same file, sequential) |
| **Can parallelize with** | PR-G2, PR-G3 |
| **Test** | add `test/team-runner-writeprogress-cache.test.ts`, `test/team-runner-batch-filename-length.test.ts`; mutation |
| **Risk** | MEDIUM — perf + helper extraction. Do LAST. |

#### PR-G2 | EXT-9 | P2
| Field | Value |
|-------|-------|
| **Findings** | EXT-9 (`globalThis` `Symbol.for()` singleton pattern fragile) |
| **Files/symbols** | `src/extension/registration/team-tool.ts`, `src/extension/registration/lifecycle-handlers.ts` — replace globalThis singleton with proper module-scoped state or WeakMap |
| **Effort** | L, ~1 day |
| **Depends on** | **PR-F11** (EXT-11 touches registration/team-tool.ts) |
| **Can parallelize with** | PR-G1a/G1b/G1c, PR-G3 (disjoint files) |
| **Test** | Existing tests; add `test/singleton-lifecycle.test.ts` |

#### PR-G3 | UI-3 + UI-4 | P2/L
| Field | Value |
|-------|-------|
| **Findings** | UI-3 (5 incompatible Component interfaces), UI-4 (no overlay stack/router) |
| **Files/symbols** | `src/ui/` — unify Component interface across 5 files; implement overlay stack for z-order/focus/dismissal chaining |
| **Effort** | L, ~2 days |
| **Depends on** | Sprint F UI PRs should merge first (F1–F5 touch same files) |
| **Can parallelize with** | PR-G1a/G1b/G1c, PR-G2 (disjoint from team-runner.ts and registration/) |
| **Test** | New tests for overlay stack; existing UI tests must pass |

**Sprint G Validation Gate:**
- `npm run typecheck` → 0 errors
- `npm test` → ≥6489 pass, 0 new failures
- Manual: full `team action='run'` smoke test with coalesced microtasks enabled → verify writeProgress caching, status transitions, mergeUnitResult

---

## 3. Parallelization Map

### Worktree-Concurrent Groups (disjoint file sets)

**Wave 1 — Sprint A (4-way concurrent):**
| PR | Primary File | Safe with |
|----|-------------|-----------|
| PR-A1 | `discover-agents.ts` + `pi-args.ts` | A2, A3, A4 |
| PR-A2 | `knowledge-injection.ts` | A1, A3, A4 |
| PR-A3 | `redaction.ts` | A1, A2, A4 |
| PR-A4 | `lifecycle-actions.ts` | A1, A2, A3 |

**Wave 2 — Sprint B (10-way concurrent):**
| PR | Primary File | Safe with |
|----|-------------|-----------|
| PR-B1 | `background-runner.ts` | B2–B10 |
| PR-B2 | `crash-recovery.ts` | B1, B3–B10 |
| PR-B3 | `biome.json` + `package.json` lint script | B1–B2, B4–B10 |
| PR-B4 | `ci.yml` | B1–B3, B5–B10 |
| PR-B5 | `run-dashboard.ts` | B1–B4, B6–B10 |
| PR-B6 | `adapters/` | B1–B5, B7–B10 |
| PR-B7 | `team-tool-schema.ts` | B1–B6, B8–B10 |
| PR-B8 | `TEST_MATRIX.md` | B1–B7, B9–B10 |
| PR-B9 | `child-pi.ts` | B1–B8, B10 |
| PR-B10 | `parent-guard.ts` + `child-pi-spawn.ts` | B1–B9 (but see RT-19 dep on B1) |

**Wave 3 — Sprint C (7-way concurrent):**
| PR | Primary File | Safe with |
|----|-------------|-----------|
| PR-C1 | `worktree-manager.ts` | C2–C7 |
| PR-C2 | `team-runner.ts` | C1, C3–C7 |
| PR-C3 | `state-store.ts` + `event-reconstructor.ts` | C1–C2, C4–C7 |
| PR-C4 | `event-log.ts` | C1–C3, C5–C7 |
| PR-C5 | `child-pi-streams.ts` | C1–C4, C6–C7 |
| PR-C6 | `atomic-write.ts` | C1–C5, C7 |
| PR-C7 | `child-executor.ts` | C1–C6 |

**Wave 4 — Sprint D (4-way concurrent):**
| PR | Primary File | Safe with |
|----|-------------|-----------|
| PR-D1 | `run-coalesced-task-group.ts` | D2, D3, D4 |
| PR-D2 | `mailbox.ts` | D1, D3, D4 |
| PR-D3 | `registration/team-tool.ts` + `suggestions.ts` | D1, D2, D4 |
| PR-D4 | `team-tool/param-error.ts` + handlers | D1, D2, D3 |

**Wave 5 — Sprint E (5-way concurrent, after C1+C3 merge):**
All 5 PRs touch disjoint files. E2 waits for C3 (state-store.ts); E5 waits for C1 (worktree-manager.ts).

**Wave 6 — Sprint F (14-way concurrent, after B3+B7+D3+D4 merge):**
Most PRs are disjoint. F7 waits for B7; F9 waits for D4; F11 waits for D3; F14 waits for B3.

**Wave 7 — Sprint G (3-way concurrent, after C2 merges):**
G1a/b/c (sequential, same file), G2, G3 are disjoint. G1a depends on C2; G2 depends on F11.

### MUST-Be-Sequential Pairs (shared file or dependency)

| Pair | Reason | Order |
|------|--------|-------|
| PR-C2 → PR-G1a | Both touch `team-runner.ts` | C2 first |
| PR-C3 → PR-E2 | Both touch `state-store.ts` | C3 first |
| PR-C1 → PR-E5 | Both touch `worktree-manager.ts` | C1 first |
| PR-B3 → PR-F14 | Both touch `biome.json` | B3 first |
| PR-B7 → PR-F7 | Both touch `team-tool-schema.ts` | B7 first |
| PR-D3 → PR-F11 | Both touch `registration/team-tool.ts` | D3 first |
| PR-D3 → PR-G2 | Both touch `registration/team-tool.ts` | D3 first |
| PR-D4 → PR-F9 | Both touch handler files | D4 first |
| PR-B1 → PR-B10 | RT-19 references RT-2's fix | B1 first (soft dep) |
| PR-C2 → PR-D1 | RT-1 + RT-5 affect dispatch/merge flow | C2 first (soft dep) |

---

## 4. Special-Handling Callouts

### SEC-3 — ⚠️ DECISION POINT (NOT a blind fix)
- **Current state:** Intentional fail-open — PEM redaction skipped on >100 BEGIN markers or >2MB input. Documented in comment, tested in `redaction-redos-regression.test.ts` #4/#5.
- **Decision required:** (a) Keep as-is (DoS-resistance priority), (b) Fail-closed (replace oversized region with `***`), or (c) Linear `indexOf("-----BEGIN")` → `indexOf("-----END", i)` window-scan O(n) — no DoS risk AND no fail-open.
- **Recommendation:** Option (c) — but requires performance benchmarking vs current ~50ms bound.
- **Action:** **ESCALATE TO MAINTAINER** before implementing. Flag as `needs-human-signoff` in PR.

### RT-2 + RT-19 — Linked Root Cause
- **RT-2 (trivial fix):** `background-runner.ts:427` — change `process.exit(130)` to `abortController.abort(); process.exitCode = 130` (pattern already exists at :146-151 for the interrupt guard). This ensures `runCleanup` runs in the `finally` block.
- **RT-19 (doc correction):** Fix misleading comment in `parent-guard.ts:4` ("Workers call `startParentGuard` at startup" — they DON'T). Document that `PI_CREW_PARENT_PID` env var is set in `child-pi-spawn.ts:134` but has **zero consumers** (verified: pi binary `dist` has 0 matches for this env var).
- **RT-19 deeper fix (DEFERRED):** Wire `startParentGuard` into worker entry point. **HARD** — worker is external `pi` binary; pi-crew doesn't control its entry point. Would require Pi binary support or a wrapper script. Mark as **optional/deferred**.

### ST-4 — Dead Code Activation
- `reconstructTasksFromEvents` in `src/state/event-reconstructor.ts:198` is **dead code** — never called in production.
- **Before claiming done:** Verify it compiles, produces correct `TeamTaskState[]` from a real `events.jsonl`, and the quarantine+reconstruct path works end-to-end.
- **Test requirement:** Must add integration test that corrupts `tasks.json` and verifies reconstruction produces the correct task list (not `[]`).

### Dead-Code/Doc Cleanup Batch
- EXT-3 (`src/adapters/` — 7 files, only test imports): verify `handleExport` uses `run-export.ts` via grep before deleting.
- RT-10 (`child-pi.ts:479-509` — dead operation tracking): verify no code depends on `pendingOperations` rejection logic.
- UI-14 (`theme-adapter.ts:98` — `thinkingColorForLevel` never called): grep to confirm zero call sites before removing.
- RT-19: doc-only, zero behavioral change.

---

## 5. Validation Gate Per Sprint

| Sprint | Typecheck | Tests | Lint | Bundle | Smoke | Special |
|--------|-----------|-------|------|--------|-------|---------|
| **A** | 0 errors | ≥6489 pass | CI config | — | Hostile-repo test (SEC-1, SEC-2) | SEC-3 sign-off |
| **B** | 0 errors | ≥6489 pass | 0 errors + visible warnings | Build OK | — | — |
| **C** | 0 errors | ≥6489 pass | CI config | — | `team action='run'` research workflow | RT-1: verify no skipped in-flight tasks |
| **D** | 0 errors | ≥6489 pass | CI config | — | Typo test (EXT-1), error examples (EXT-2) | — |
| **E** | 0 errors | ≥6489 pass | CI config | — | — | — |
| **F** | 0 errors | ≥6489 pass | Improved (fewer `any`) | Pack dry-run | — | Tarball excludes dev scripts |
| **G** | 0 errors | ≥6489 pass | CI config | Build OK | Full coalesced-dispatch smoke test | Structural review |

**Baseline reference:** 6489 unit tests, 6486 pass, 3 skip, 0 fail, 839 suites, 500.5s. Typecheck must stay 0 errors.

---

## 6. Sequencing Summary

Execute sprints in order **A → B → C → D → E → F → G**:

1. **Sprint A** (Security) ships first — SEC-1 (RCE) and SEC-2 (prompt injection) are Critical and mirror already-fixed patterns (F-01). All 4 PRs run concurrently (disjoint files). SEC-3 needs human sign-off and may be deferred.

2. **Sprint B** (Quick wins) ships second — 10 low-risk PRs, all disjoint, all <4h each. Clears background-runner bugs (RT-2/3/4/18), dead code (EXT-3), lint hygiene (QA-4/5), and doc corrections (RT-19). Maximum parallelism (10-way).

3. **Sprint C** (Data-loss core) ships third — 7 PRs addressing the highest-impact correctness bugs: RT-1 (in-flight task clobbering), ST-1 (worktree data loss), ST-4 (corrupt tasks.json). All disjoint files, 7-way parallel. RT-1 (PR-C2) MUST complete before Sprint G team-runner.ts work.

4. **Sprint D** (Reliability + LLM ergonomics) ships fourth — RT-5 (coalesced dispatch parity), ST-3 (mailbox locks), EXT-1 (typo detection), EXT-2 (error examples). 4-way parallel. RT-5 has soft dependency on PR-C2 (dispatch/merge flow).

5. **Sprint E** (State hardening) ships fifth — 5 PRs for Tier 3 state/durability findings. Two dependencies on Sprint C (E2 after C3 for state-store.ts; E5 after C1 for worktree-manager.ts).

6. **Sprint F** (UI + quality cleanup) ships sixth — 17 PRs, mostly P3. Several dependencies on earlier sprints (F7 after B7, F9 after D4, F11 after D3, F14 after B3). Maximum 14-way parallelism once deps resolve.

7. **Sprint G** (Structural debt) ships last — **PR-G1a/G1b/G1c** (team-runner.ts split into 3 sequential sub-PRs: state-consistency → table refactor → perf/cleanup; G1a depends on PR-C2). PR-G2 (globalThis singleton) depends on PR-F11. PR-G3 (UI component unification) depends on Sprint F UI PRs.

**Rationale for ordering:** Security first (Critical RCE + injection), then reliability spine (background-runner + data-loss paths), then ergonomics (LLM-facing error quality), then hardening (state layer robustness), then cleanup (UI + quality), then structural debt (deferred refactors that don't affect correctness but reduce tech debt).

---

## 7. Team routing & concurrency policy

### Team routing (per PR risk)
| PR | Team | Lý do |
|----|------|-------|
| **PR-C2 (RT-1)**, **PR-D1 (RT-5)** | **`implementation`** (explorer→planner→**critic**→executor→**reviewer**→verifier) | HIGH-risk scheduler behavioral change; cần critique trước + review sau |
| PR-A1/A2 (SEC-1/2), PR-C1 (ST-1), PR-C3 (ST-4), PR-D2 (ST-3) | **`implementation`** + **security-reviewer** | security/data-loss; review kỹ |
| PR-G1a/b/c (team-runner refactor) | **`implementation`** | HIGH-risk structural; cần critic |
| Tất cả PR còn lại | `fast-fix` (explorer→executor→verifier) hoặc `default` | risk thấp / thay đổi cơ khí |

### Practical concurrency cap
- **Cap: 6 worktree concurrent** (mỗi worktree = 1 Pi process + RAM/CPU; giới hạn thực = hardware, không phải file conflict).
- Sprint B (10-way lý thuyết) và Sprint F (14-way) → chia **2 wave** mỗi sprint (wave 1: 6 PR P1/HIGH-risk trước; wave 2: còn lại).
- Sprint C/D có thể cross-sprint song song nhờ PR-C2 ↔ PR-D1 disjoint (§2).
- Cap có thể chỉnh qua config team nếu hardware cho phép.

---

## 8. Test binding (ràng buộc "no done without test")

**Rule:** Không PR nào được claim "done" cho đến khi:
1. TẤT CẢ test case trong `TEST-STRATEGY-2026-07-30.md` §3 cho finding(s) của PR → **green**.
2. **HIGH-risk** (RT-1, RT-5, ST-1, ST-4, ST-3, RT-2, SEC-1/2, PR-G1a/b/c) → **mutation check PASS** (revert fix → test phải fail). Dùng `mutationCheck()` helper (TEST-STRATEGY §4).
3. **Security** (SEC-1/2) → **hostile-repo PoC PASS**.
4. **Lock/seq** (ST-3/5/14) → **cross-process/concurrency test PASS**.
5. Typecheck 0 errors + `npm test` ≥6489 pass + 0 new failure.

### PR → TEST-STRATEGY test file map (compact)

**Sprint A**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-A1 | SEC-1, SEC-4 | `test/unit/security/project-agent-extensions-rce.test.ts`; `agent-sanitizer-dos.test.ts` |
| PR-A2 | SEC-2 | `test/unit/security/knowledge-injection-sanitization.test.ts` |
| PR-A3 | SEC-3 *(decision)* | `redaction-redos-regression.test.ts` (existing); `redaction-linear-pem.test.ts` (if option c) |
| PR-A4 | SEC-5 | `test/unit/destructive-gate-cleanup-self-enforce.test.ts` |

**Sprint B**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-B1 | RT-2,3,4,18 | `test/integration/background-runner-sigint-cleanup.test.ts`; `background-runner-startup-fail.test.ts`; `interrupt-guard-ack.test.ts` |
| PR-B2 | ST-6 | `test/unit/crash-recovery-transient-read.test.ts` |
| PR-B3 | QA-4,5 | lint gate (`npm run lint`) |
| PR-B4 | QA-1 | CI gate |
| PR-B5 | UI-8 | typecheck gate |
| PR-B6 | EXT-3 | typecheck + grep gate |
| PR-B7 | EXT-7 | extend schema tests |
| PR-B8 | QA-3 | `test-matrix-sync.test.ts` |
| PR-B9 | RT-10,11 | typecheck; `test/unit/child-pi-spawn-registration.test.ts` |
| PR-B10 | RT-19 | typecheck (doc-only) |

**Sprint C**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-C1 | ST-1 | `test/integration/worktree-snapshot-dirs-binary.test.ts` |
| PR-C2 | RT-1 | `test/unit/team-runner-failed-task-while-siblings-inflight.test.ts` + E2E |
| PR-C3 | ST-4 | `test/integration/state-store-corrupt-tasks-recovery.test.ts` |
| PR-C4 | ST-5,12 | `test/integration/event-log-cross-process-seq.test.ts`; extend event-log |
| PR-C5 | RT-9 | `test/unit/child-pi-streams-buffer-overflow.test.ts` |
| PR-C6 | ST-7 | `test/unit/atomic-write-temp-leak.test.ts` |
| PR-C7 | RT-6,8 | `test/unit/child-executor-spawn-budget-config.test.ts`; `child-executor-immutability.test.ts` |

**Sprint D**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-D1 | RT-5 | `test/unit/run-coalesced-{cancel-status,maxturns-config,timeout,retry-config}.test.ts` |
| PR-D2 | ST-3 | `test/integration/mailbox-sync-async-concurrent.test.ts` |
| PR-D3 | EXT-1 | `test/unit/team-tool-typo-detection.test.ts` |
| PR-D4 | EXT-2 | `test/unit/handler-error-examples.test.ts` |

**Sprint E**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-E1 | ST-8,11 | `test/integration/event-log-rotation-append-race.test.ts`; extend bench |
| PR-E2 | ST-9,10 | `test/unit/tasks-json-version-migration.test.ts`; `artifact-retention-enforcement.test.ts` |
| PR-E3 | ST-13 | `test/unit/conflict-detect-mixed-eol.test.ts` |
| PR-E4 | ST-14 | `test/integration/locks-reentrance-async-context.test.ts` |
| PR-E5 | ST-15 | `test/unit/worktree-prepare-twice-isolation.test.ts` |

**Sprint F** — 17 PR, chủ yếu extend existing UI/handler tests + lint/pack gates. Chi tiết per-finding trong `TEST-STRATEGY` §3 (Tier 3 table). Cụ thể cần viết mới: `test-matrix-sync`, `tarball-excludes-dev-scripts`, `team-tool-description`, `i18n-team-tool`, `ui-overlay-stack` (G3).

**Sprint G**
| PR | Findings | Test file |
|----|----------|-----------|
| PR-G1a | RT-13,15 | extend `team-runner-*`; mutation |
| PR-G1b | RT-16 | extend `team-runner-*`; `team-runner-should-merge-table.test.ts`; mutation |
| PR-G1c | RT-7,12,14,17 | `team-runner-writeprogress-cache.test.ts`; `team-runner-batch-filename-length.test.ts`; mutation |
| PR-G2 | EXT-9 | `test/unit/singleton-lifecycle.test.ts` |
| PR-G3 | UI-3,4 | `test/unit/ui-overlay-stack.test.ts` |

---

*End of remediation plan. 52 PRs, 72 findings, 7 sprints. Practical concurrency cap: 6 worktree (hardware-bound). Test binding: TEST-STRATEGY-2026-07-30.md — no PR "done" without its cases green + mutation (HIGH-risk) + PoC (security).*
