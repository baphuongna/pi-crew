# pi-crew — Project Review

> Review date: 2026-05-18
> Version: `pi-crew@0.2.19`
> Scope: the entire source (`index.ts`, `src/**`), config, tests, docs, scripts.
> Method: read source directly, cross-referenced against `AGENTS.md`/`docs/architecture.md`, ran `npm run typecheck` + `npm run test:unit`.

## Overview

`pi-crew` is a multi-agent orchestration Pi extension (teams + workflows + worktrees + async background runs), with a **durable-first model**: every run/task/event is persisted to disk (JSONL + atomic JSON writes) so that foreground, async background, dashboard, and crash recovery all read the same source of truth.

The codebase is mature, uses **TypeScript strict mode** (`noImplicitAny`, `strict: true`), has a broad test suite (1596 tests pass, 2 skipped, 0 failures), clear layered architecture (extension / runtime / state / worktree / utils), and many defensive notes ("3.1 backpressure", "2.10 cache", "P1 catch unhandled errors") indicating it has been iterated over many review rounds.

### Quick health-check results

| Category | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit` + strip-types import) | PASS |
| `npm run test:unit` (1598 tests / 128 suites) | 1596 pass · 2 skip · 0 fail (~90s) |
| `npm pack --dry-run` (via `npm run ci`) | Not checked in this session |
| Linter (ESLint) | No `lint` script; relies on `tsc strict` |
| Number of `.ts` files in `src/` | ~190 modules |

---

## 1. Notable strengths

1. **Consistent path-safety**: `utils/safe-paths.ts` (`assertSafePathId`, `resolveContainedPath`, `resolveRealContainedPath`) is used uniformly in `state-store.ts`, `artifact-store.ts`, `mailbox.ts`. It has two layers: a string-based containment check and a real-path check (defends against symlink escape after mkdir).
2. **Multi-layered defensive atomic writes** (`state/atomic-write.ts`):
   - `O_EXCL | O_CREAT | O_NOFOLLOW` when opening the temp file.
   - `fstatSync` post-open to verify a regular file (defends against TOCTOU on Windows where `O_NOFOLLOW = 0`).
   - Rename retry with exponential backoff + jitter (defends against lockstep starvation).
   - Coalesced variant `atomicWriteJsonCoalesced` for high-frequency state writes; flush on `exit`/`SIGTERM`/`SIGINT`.
3. **Redaction (`utils/redaction.ts`)** handles many patterns: PEM private keys, Authorization headers, Bearer tokens, inline secret patterns, key-name matching (`apiKey`, `password`, `secret`, ...). Applied in `appendEvent`, `appendMailboxMessage`, `writeArtifact`, `appendTranscript`.
4. **Env sanitization (`utils/env-filter.ts`)**: default secret-pattern deny-list, allow-list mode for `worktree.setupHook` to pass only `PATH`, `HOME`, `PI_*`.
5. **Process kill tree** (`runtime/child-pi.ts`):
   - Windows: `taskkill /T /F` + verify-after-2s + retry if PID is still alive.
   - POSIX: `process.kill(-pid, "SIGTERM")` (process group) with an absolute-pid fallback; SIGKILL escalation after `HARD_KILL_MS`; fast-cancel SIGKILL after 200ms on user cancel.
   - Lifecycle events have a structured shape `{ type, pid, exitCode?, error?, ts }`.
6. **Backpressure**: pause child stdout when more than 256KB is undrained.
7. **Lazy imports marked with `// LAZY:`** with a specific reason (reduces ~1.4s import cost at registration), plus a `check:lazy-imports` script to enforce it.
8. **Run / task contract guards**: `shouldMergeTaskUpdate` (prevents a stale snapshot from regressing terminal state), monotonic finishedAt, `canTransitionRunStatus`, plan-approval-gating for mutating tasks.
9. **Crash & cancellation paths**: `executeTeamRun` catch-all ensures the manifest/tasks transition to terminal on unhandled error (avoids "running forever"); `background-runner` has an `unhandledRejection` guard that writes `async.failed` before exit; `parent-guard` so the background runner dies when its parent dies.
10. **Very broad test coverage** for both happy paths and edge cases (yield, atomic-write retry, mergeTaskUpdates, mailbox validation, cancellation, model fallback...).
11. **Config**:
    - Schema validation via TypeBox with fuzzy suggestions for misspelled keys.
    - **Sanitize project-level config** (`sanitizeProjectConfig`): strips sensitive keys (`executeWorkers`, `runtime.mode`, `worktree.setupHook`, `otlp.headers`, `agents.overrides`, …) from the project config, accepting them only from user config. This is an essential safeguard for an injected repo.

---

## 2. Bugs / Issues found

> Classification: **HIGH** (can cause data loss / incorrectness), **MED** (correctness corner case / DX), **LOW** (improvement).

### HIGH

**H1. `event-log.ts` — silent loss when exceeding `MAX_EVENTS_BYTES` (50MB)**
```ts
// src/state/event-log.ts ~ appendEventInsideLock
if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
    logInternalError(...);
    return { ...fullEvent, metadata: { ...(fullEvent.metadata ?? {seq:0,...}), appended: false } };
}
```
- Problem: the event is dropped immediately (including terminal events like `run.failed`, `task.completed`) and `appendCounter` is also not incremented → `compactEventLog` (which only runs every 100 appends) is not triggered when it is needed most. Consequence: once the threshold is crossed, the log is "locked" silently until the next 100 appends trigger a rotation.
- Suggestion: when the threshold is hit, call `compactEventLog(eventsPath)` immediately, or rotate first then append; also prioritize letting terminal events (TERMINAL_EVENT_TYPES) through, since those events are part of the durable contract.

**H2. `mailbox.ts` — `appendMailboxMessage` has no cross-process lock**
```ts
fs.appendFileSync(mailboxFile(manifest, complete.direction, complete.taskId), `${JSON.stringify(...)}\n`, "utf-8");
```
- Problem: `appendFileSync` is not atomic across processes on Windows. Two background runners + foreground steering at the same time can interleave JSON lines → `parseMailboxMessage` skips them, messages are lost silently (reported later via `validateMailbox`).
- Suggestion: use the existing `withEventLogLockSync` pattern for the mailbox, or use `atomicWriteFile` to rewrite (slower but atomic). At minimum, add atomic `O_APPEND` on POSIX (only guaranteed up to PIPE_BUF) and a lock on Windows.

**H3. `atomic-write.ts` — fallback `writeFileSync` has no symlink guard**
```ts
try { renameWithRetry(tempPath, filePath); }
catch (renameError) {
    try { fs.writeFileSync(filePath, content, "utf-8"); } // BYPASSES symlink guard
    catch { throw renameError; }
}
```
- Problem: if rename fails with EPERM on Windows, the fallback goes directly to `writeFileSync(filePath)` — if `filePath` becomes a symlink between the `isSymlinkSafePath` check (top of function) and the fallback, the write follows the link. The time window is small but could be exploited by an adversary on a multi-user host.
- Suggestion: before the fallback, re-check `fs.lstatSync(filePath).isSymbolicLink()`. Or open an fd with `O_NOFOLLOW` and `O_TRUNC` then write.

**H4. `team-runner.ts` — function named `__test__mergeTaskUpdates` is used in production**
```ts
// Re-exported and documented as test-only:
export function __test__mergeTaskUpdates(...) { ... }
// but called in executeTeamRunCore:
tasks = __test__mergeTaskUpdates(tasks, results);
```
- Problem: the `__test__` convention implies only tests should import it; this is actually the runner's core merge logic. Another developer might "clean up" this helper or change its behavior thinking it only affects tests → silent regression.
- Suggestion: rename to `mergeTaskUpdatesPreservingTerminal()` (or similar), keep `__test__mergeTaskUpdates` as an export-only alias for tests, add a comment.

### MED

**M1. `task-runner.ts` — `transcriptPath` reused across model fallback attempts**
- Each attempt appends to the same transcript file. `parsePiJsonOutput(fs.readFileSync(transcriptPath, "utf-8"))` parses everything → final text/usage may be mixed across attempts. `resultArtifact.content` takes `parsedOutput?.finalText`, which could be the final text of attempt 1 (which failed) if attempt 2 has no valid message_end.
- Suggestion: either use `transcripts/${task.id}.attempt-${i}.jsonl` per attempt, or clear the file at the start of each attempt if the policy is "last attempt wins".

**M2. `task-runner.ts` — reads the entire transcript into memory for `transcriptArtifact`**
```ts
content: fs.readFileSync(transcriptPath, "utf-8"),
```
- For long-running tasks the transcript can be tens of MB. Combined with compactChildPiEvent already reducing size, it is still unbounded. `MAX_CAPTURE_BYTES` only applies to in-memory `stdout/stderr`, not to the on-disk transcript.
- Suggestion: cap the transcript file size (rotate when exceeding a threshold) or have the artifact use a reference (path) instead of copying content.

**M3. `cleanup.ts` — `fs.statSync(worktreePath).isDirectory()` has no race guard**
```ts
for (const entry of fs.readdirSync(worktreeRoot)) {
    const worktreePath = path.join(worktreeRoot, entry);
    if (!fs.statSync(worktreePath).isDirectory()) continue;
```
- If the entry is deleted between `readdirSync` and `statSync`, it throws uncaught.
- Suggestion: wrap in `try { fs.statSync... } catch { continue; }` or use `fs.readdirSync(worktreeRoot, { withFileTypes: true })` then `entry.isDirectory()`.

**M4. `worktree-manager.ts` — `runSetupHook` parses JSON only from the last line**
```ts
const lastLine = lines[lines.length - 1] ?? trimmed;
const parsed = JSON.parse(lastLine);
```
- If the hook outputs multi-line JSON (pretty-printed), only the last line is parsed → `syntheticPaths` are silently lost. There is a log warning, but it is silent from the caller's side.
- Suggestion: try parsing `trimmed` first, fall back to the last line. Or define a clear protocol (one-line JSON, terminator marker).

**M5. `worktree-manager.ts` — `linkNodeModulesIfPresent` does not warn when `symlinkSync` fails**
```ts
try { fs.symlinkSync(...); return true; } catch { return false; }
```
- On Windows without the right to create symlinks (requires SeCreateSymbolicLinkPrivilege), it fails silently, the agent runs without `node_modules` — module resolution may fail but the caller does not know.
- Suggestion: log the reason for failure (especially for non-admin Windows) via `logInternalError`, or return `{ linked, reason }`.

**M6. `child-pi.ts` — `forcedFinalDrain` forces `exitCode: 0`**
```ts
const finalExitCode = forcedFinalDrain && !timeoutError ? 0 : exitCode;
```
- This logic (already explained in a comment) converts some exit ≠ 0 into 0 after the child sends the final assistant event. Edge case: child crashes during cleanup after the final event → still reports success. This could mask a memory leak or crash in the child Pi.
- Suggestion: add telemetry/metrics counting how often `forcedFinalDrain → 0` happens to detect regressions. Currently there is only a lifecycle event "final_drain" but no conversion metric.

**M7. `background-runner.ts` — `process.exit(130)` in the interrupt guard does not await flush**
```ts
if (last?.type === "interrupt" && last?.acknowledged !== true) {
    appendEvent(...);
    process.exit(130);
}
```
- `process.exit` runs the `'exit'` handler but does not await async ops (e.g., a pending `appendEventBuffered` Promise). `flushEventLogBuffer` registered on `'exit'` is sync so it's OK, but `terminateLiveAgentsForRun` is not. It could leak a live agent.
- Suggestion: `await terminateLiveAgentsForRun(...)` before exiting, or use `process.exitCode = 130` + return so cleanup runs normally.

**M8. `state-store.ts` — manifest cache TTL invariant**
- The cache key is `stateRoot`, TTL 5 minutes. Path validation guards against manifest paths changing. But if the file mtime + size do not change (extremely rare but possible with coalesced atomic writes when the size & content are the same), the cache serves stale content.
- Suggestion: add a `contentHash` (cheap to stat → a fingerprint like the first 32 bytes) to the cache key, or invalidate the cache in the `atomicWriteJsonCoalesced` flush callback.

**M9. `event-log.ts` — `sequenceCache` not invalidated when the file is truncated externally**
- If an external tool truncates `events.jsonl` (manual rotation), the cached `seq` stays high, making `nextSequence` produce wrong seqs (there is a fallback: `cached.size === stat.size`). OK for the same-size race, but if truncation happens between `statSync` and `appendFileSync`, two appends will have the same seq.
- Suggestion: persistSequence already uses atomic write, you can trust it in the race. Add an integration test for external truncation.

**M10. `runtime-resolver` / config — `executeWorkers=false` default fallback path**
- `handleResume` has complex logic to re-evaluate `runtime.mode` when resuming scaffold runs. The 3-way logic (`resumeManifest.runtimeResolution?.safety === "explicit_dry_run"` + env var checks) easily leads to an edge case where the user expects actual workers but resume is still scaffold. Hard to test.
- Suggestion: refactor into a clear state machine `resolveResumeRuntime({ original, override, env })` with unit tests covering the full truth table.

### LOW

- **L1. `package.json` missing a `lint` script**; the global `AGENTS.md` has a convention `eslint --max-warnings=0`. Currently it only relies on `tsc strict`. Consider adding ESLint or Biome.
- **L2. Many `JSON.stringify(value, null, 2)` for metadata artifacts**. Pretty-printing 50+ artifact/task files costs I/O. Consider minified JSON for metadata; pretty only for summary/progress that users read.
- **L3. `task-runner.ts` creates ~13 artifacts per task** (prompt, result, inputs, coordination, skill, packet, verification, startup, permission, capability, prompt-pipeline, log, transcript, diff, diff-stat, output-validation). Each is an `atomicWriteFile` syscall. In a large run (50+ tasks), consolidating into fewer sub-artifacts would significantly reduce I/O.
- **L4. `registerYieldTool()` runs at module top level** (`task-runner.ts` line 35). Side effect on import — if the module is imported twice (e.g., jiti vs strip-types), `subprocessToolRegistry` could be duplicated. Check whether `subprocess-tool-registry.ts` is idempotent.
- **L5. `atomic-write.ts` `atomicWriteJsonCoalesced`** — the API has a significant caveat (read-after-write within the buffer window reads stale content). Large risk surface if a future dev forgets to call `flushPendingAtomicWrites()`. Consider adding a dedicated read API `readJsonFileWithCoalesceFlush()`.
- **L6. Cancellation paths have no counting metric**. There are observability events but no gauge for the number of tasks cancelled per run.
- **L7. `management.ts` `handleUpdate` rename+write** sequence has no rollback if writeFileSync fails after rename (a backup exists, but the user must manually restore). Could wrap in try/catch + auto-restore from backup.
- **L8. `child-pi.ts` mock paths read env `PI_TEAMS_MOCK_CHILD_PI`** — there should be a guard preventing accidental production activation (check `process.env.NODE_ENV === "test"` or a clear test flag).
- **L9. `worktree-manager.ts` `findGitRoot` throws** if cwd is not a git repo. `prepareTaskWorkspace` calls it before checking workspaceMode; actually workspaceMode is checked at the top of the function, OK. But the git error message ("not a git repository") propagates to the user — not user-friendly.
- **L10. The naming `crewRoot` vs `.crew/` vs `.pi/teams/`** is documented but easy to confuse. `projectCrewRoot` has three branches (existing `.crew` → `.crew`; existing `.pi` → `.pi/teams`; else → `.crew`). Tests cover it but a new dev reading the code can easily misunderstand.
- **L11. Some `let task: TeamTaskState = ...` is reassigned multiple times in `task-runner.ts`**. Hard to reason about. Consider refactoring into a reducer pattern.
- **L12. `update-references-for-rename` only updates team→agent and team.defaultWorkflow**, does not cover workflow→step.role or agent references in test fixtures. The comment acknowledges this. Still worth fixing so renames are safe.

---

## 3. Security review

| Item | Status | Notes |
|---|---|---|
| Path traversal | OK | `assertSafePathId`, `resolveContainedPath`, `resolveRealContainedPath` cover it fairly thoroughly. |
| Symlink escape | OK (corner case H3) | `O_NOFOLLOW`, `lstatSync`, post-open `fstatSync`. One fallback path skips the check (H3). |
| Secret leak | OK | Redaction applied at the event log, transcript, mailbox, artifact inputs. Env sanitization before spawning the child. |
| Code injection via setup hook | Mitigated | `runSetupHook` validates the file exists, uses `shell: false`, allow-lists env, 30s timeout. But it still executes user-provided code. Must trust the user. |
| Untrusted project config | OK | `sanitizeProjectConfig` strips sensitive keys before merging. |
| Process tree leak (zombie child Pi) | OK | `terminateActiveChildPiProcesses` + `parent-guard` + Windows `taskkill /T /F`. |
| DoS via concurrency | OK | Default hard-cap; `allowUnboundedConcurrency=true` requires explicit opt-in + emits an event. |
| Event log injection | Mitigated | JSON.stringify per line; readEvents skips parse errors. There is a risk of corrupted JSON lines due to an `appendFileSync` race (H2 in mailbox, but the event log has a lock). |
| Dependency surface | Small | Only runtime deps: typebox, cli-highlight, diff, jiti. |

In summary: the security posture is **good**. The biggest issue is H2 (mailbox has no lock) — stale state can occur if multiple processes race.

---

## 4. Performance review

- **Atomic write coalescer** (50ms window) has reduced I/O for high-frequency state writes.
- **Manifest cache** with mtime+size key avoids re-parsing when unchanged.
- **Lazy import boundaries** reduce import cost ~1.4s.
- **`projectRootCache` TTL 30s** reduces 14 `existsSync` × ancestor levels per render tick.

Areas with optimization potential:
1. Each completed task produces ~13 artifacts (L3). 50 tasks = 650 atomic writes for metadata. Consider batching.
2. `progress.md` and `summary.md` are rewritten multiple times per batch (writeProgress in a loop). Coalescing is fine but `atomicWriteJsonCoalesced` could be used.
3. `parsePiJsonOutput(fs.readFileSync(transcriptPath))` runs each attempt, parsing the full transcript. Stream parsing is cheaper for large transcripts.
4. `aggregateUsage(tasks)` runs O(n) over tasks on each summary write.

---

## 5. DX / Maintainability

| Aspect | Note |
|---|---|
| TS strict | OK, `noImplicitAny` enforced. |
| Naming `__test__*` | Some mixing of pure test utils and production helpers (H4). |
| File size | `team-runner.ts` (694 lines), `task-runner.ts` (440+ lines), `register.ts` (1k+ lines), `live-session-runtime.ts` (~750 lines) are all > 500 lines. AGENTS.md says "prefer small modules". |
| Comment quality | Good — there are "WHY" markers, version tags (`// 2.10`, `// H4`, `// 3.1`). |
| Test layout | `test/unit/*.test.ts` + `test/integration/*.test.ts`. Reasonable concurrency. |
| Hard-coded magic numbers | Mostly centralized in `config/defaults.ts`. |
| Error reporting | `logInternalError` is consistent — best-effort, does not throw. |
| Docs sync | `docs/architecture.md` matches the code (except some next-upgrade-roadmap items not yet implemented). |

---

## 6. Test-matrix gaps (candidates for new tests)

- Cross-process race on mailbox append (H2).
- Event log overflow recovery (H1) — ensure terminal events are still persisted when exceeding 50MB.
- `forcedFinalDrain` does not mask a real child crash (M6).
- Resume with mixed `runtime.mode` overrides (M10).
- Atomic-write coalesced + read-after-write within the window — ensure documented behavior matches reality.
- `linkNodeModulesIfPresent` Windows non-admin fallback (M5).
- `runSetupHook` multi-line JSON output (M4).

---

## 7. Suggested priorities (sorted)

1. **Fix H1** (event-log overflow): rotate immediately when the threshold is crossed + prioritize terminal events.
2. **Fix H2** (mailbox lock): apply the `withEventLogLockSync` pattern to mailbox append.
3. **Fix H3** (atomic-write symlink TOCTOU): re-check lstat before the `writeFileSync` fallback.
4. **Fix H4** (rename `__test__mergeTaskUpdates` → `mergeTaskUpdates`, keep alias).
5. **M1/M2** transcript per-attempt + cap size.
6. **M3** race-safe `statSync` in cleanup.
7. **M6** add a metric `crew.child.final_drain_force_zero_total`.
8. **L1** add ESLint or Biome for consistency (global AGENTS.md requires it).
9. **L3** batch artifact writes for metadata.
10. **L12** expand `updateReferencesForRename` for workflow→step + agent references.

---

## 8. Verification

```
npx tsc --noEmit                                  → PASS
node --experimental-strip-types -e "..."         → PASS (strip-types import ok)
node --test test/unit/*.test.ts                  → 1596 pass / 2 skip / 0 fail / 90s
```

There is no lint command in the project (only `tsc strict`); no `.eslintrc*` file was found.

---

## 9. Conclusion

`pi-crew` is a **mature, highly disciplined** codebase, with many defensive layers against TOCTOU, races, and mid-write crashes. Test coverage is broad, the architecture is clear. The issues found are mainly edge-case correctness and hardening; there is no serious "broken core flow" vulnerability.

**Recommendation**: prioritize fixing H1–H4 and expanding tests for cross-process races (mailbox + event-log overflow). Next, consider adding a linter, batching metadata artifact writes, and refactoring some large orchestrator files (`register.ts`, `team-runner.ts`, `live-session-runtime.ts`) into sub-modules.
