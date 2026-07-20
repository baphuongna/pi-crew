# pi-crew Deep Review — 2026-07-20

**Target:** pi-crew v0.9.44 (~104,868 LOC TS · 472 src files · 658 test files)
**Method:** 4 parallel read-only audits (runtime/concurrency, state durability+perf, security, code-health), then **manual line-by-line verification of every finding by the reviewer** (each finding below was confirmed by directly reading the cited `file:line`, not trusted from the audit alone).
**Baseline:** cross-referenced against `UPGRADE-ROADMAP.md` and `reports/deep-review-2026-07-17.md` (v0.9.42, "107 findings addressed") to report only issues **still present** in the current checkout.

> **Verification status:** 15/15 findings personally re-read in source. **0 false positives.** 3 findings were **downgraded** after reading the surrounding code, and 1 (FIND-10) had its originally-proposed fix **corrected** because the naive fix would reintroduce a crash-safety bug. Static review only — `npm run typecheck` / `npm test` were **not** run.

---

## TL;DR — Health verdict

The core infrastructure remains **battle-hardened**. Confirmed already-defended (read and cleared, do not re-file): command/arg injection (all `execFile`/`spawn` with argv arrays, never `shell:true`), verification-gate allowlist (`validateGateCommand`), env secret sanitization (allowlists + per-task provider-key scoping), path traversal (`assertSafePathId` + `O_NOFOLLOW` + TOCTOU re-check), atomic writes (temp + `O_EXCL|O_NOFOLLOW` + link/unlink + data+dir fsync), worktree cleanup preserving dirty trees unless `force`, depth guard (cap 10), management deletes requiring `confirm:true`, child-process kill/leak paths, timer `unref`/clear discipline.

Residual issues cluster in **two areas**:

1. **Performance** — a few hot paths still do O(N)/O(N²) synchronous work: the `delivery.json` read-modify-write per mailbox message (worst), plus several full-scan/full-parse state reads that block the event loop.
2. **Maintainability / low-risk hygiene** — duplicated `renderLines`, three orphaned modules kept alive only by coverage tests, a localized `any` cluster, self-referential import-bundle hash, and unredacted background stderr.

**No P0 found.** Two P1 perf items are worth prioritizing (FIND-01, FIND-02).

---

## Severity legend

`P1` high / do soon · `P2` medium / worthwhile · `P3` low / opportunistic. Effort in dev-days; risk = regression risk of the fix.

---

## Performance

### FIND-01 · P1 · `delivery.json` full read-modify-write per mailbox message → O(N²)
**File:** `src/state/mailbox.ts:481-487` (also `:565` acknowledge, `:645` replay, `:694` validate)
**Verified:** `completeMailboxMessage` (and the 3 other delivery mutators) run, under `withFileLockSync(deliveryFile(...))`, a full `readDeliveryState()` (`readFileSync` + `JSON.parse` of the whole `delivery.json`, capped at `MAX_DELIVERY_MESSAGES = 10000`) followed by `writeDeliveryState()` which re-serializes and rewrites the **entire** object via `atomicWriteFile`. No in-memory cache exists.
**Problem:** For a chatty multi-agent run, every message send/complete/ack re-reads and re-writes the whole delivery map → cost ≈ O(messages × delivery-size), i.e. O(N²) up to the 10k cap. Each mutation also takes a cross-process file lock.
**Fix:** Keep an in-process `delivery.json` cache keyed by `stateRoot` + mtime (invalidate on our own writes); or move delivery status to an append-only log compacted periodically like the event log.
**Effort:** 1–2d · **Risk:** medium (delivery correctness is load-bearing for handoffs).

### FIND-02 · P1 · Mailbox append blocks the event loop via `sleepSync` lock
**File:** `src/state/mailbox.ts:467` → `withEventLogLockSync` → `src/state/event-log.ts:165` (`sleepSync(50)` retry loop)
**Verified:** The mailbox append path uses the **sync** lock. `event-log.ts:79-82` and `:400-405` carry the project's own `@deprecated` + `SECURITY WARNING` on this path: *"uses `sleepSync` which blocks the event loop and prevents AbortSignal handlers from firing."* No async mailbox-append variant exists (`withEventLogLockAsync` exists at `event-log.ts:434` but mailbox does not use it).
**Problem:** Steering / follow-up messages are sent **while a live agent is executing**. Blocking the loop delays AbortSignal / SIGTERM handling — the exact hazard the code's own warning describes.
**Fix:** Add an async mailbox-append path built on `withEventLogLockAsync` (promise-chain lock, no `sleepSync`); route live-session steering sends through it.
**Effort:** 1d · **Risk:** low–medium.

### FIND-03 · P2 · `manifest-cache.listActive()` full FS scan, no result cache (RT-F10)
**File:** `src/runtime/manifest-cache.ts:281-306`
**Verified:** Unlike `list()` (500ms `listCache` TTL), `listActive()` re-runs `collectRoots()` (`readdirSync` per run root) + `parseManifestIfChanged` for every entry on **every** call, with no memoized result. This is the crash-recovery / zombie-detection path. Code comment confirms the "full scan (NOT via list())" is deliberate so running runs past the top-N cutoff aren't dropped.
**Nuance (downgraded from P2-high):** `parseManifestIfChanged` memoizes on stat+size, so per-run cost is `readdir` + one `stat` per manifest — **not** a full `JSON.parse` each call. Still O(total runs) syscalls per invocation.
**Fix:** Give `listActive` the same short-TTL cache as `list` (invalidated by the existing `fs.watch` → `scheduleListRefresh`), keyed separately so the "all running" semantics are preserved.
**Effort:** 0.5d · **Risk:** low.

### FIND-04 · P2 · `getRunMetricsSummary` reads up to 500 files synchronously
**File:** `src/state/run-metrics.ts:110-135`
**Verified:** Loops over `readdirSync` dirents calling `loadRunMetrics` → `readJsonFile` (`readFileSync` + `JSON.parse`) up to `MAX_METRIC_FILES_TO_SCAN` **before** sorting and slicing to `limit` (default 25). Files are read in directory order, not mtime order, so it reads far more than the caller needs and blocks the loop for the whole scan.
**Fix:** Sort dirents by mtime (or by run-id timestamp embedded in name) first, then read only `limit` newest files; or make the whole function async.
**Effort:** 0.5d · **Risk:** low.

### FIND-05 · P2 · `readEventsCursor` default path loads & parses the entire event log
**File:** `src/state/event-log.ts:1168` (`readEvents`), `:1227-1244` (`readEventsCursor`)
**Verified:** Called **without** `fromByteOffset`, `readEventsCursor` calls `readEvents` (full `readFileSync` + `split("\n")` + `JSON.parse` per line) and only `slice(-5000)` **after** the full parse. Callers on this path include `status.ts`, `inspect.ts`, `run-export.ts`, `attention-events.ts`, `diagnostic-export.ts`.
**Nuance (downgraded):** Mitigations already exist — an incremental `fromByteOffset` reader (`readJsonlSince`) is available and preferred, the result is tail-capped at 5000, and a `logInternalError("event-log.cursor-full-read", ...)` warns when the full read triggers on a large log. So memory is bounded; CPU is still O(total events) per call on the default path.
**Fix:** Migrate the hot default callers (status/inspect UI) to pass `fromByteOffset` (stream tail bytes) instead of the full read.
**Effort:** 1d · **Risk:** low.

### FIND-06 · P2 · Heartbeat `setInterval` races the final result write in coalesced dispatch
**File:** `src/runtime/run-coalesced-task-group.ts:89-107`
**Verified:** The heartbeat refresher is `setInterval(async () => { updatedTasks = updatedTasks.map(...); await saveRunTasksAsync(manifest, updatedTasks); }, 15_000)`. Two concrete defects:
1. `setInterval` does not await the previous async callback — if a `saveRunTasksAsync` exceeds 15s, two callbacks interleave on the shared closure variable `updatedTasks`.
2. `clearInterval` in `finally` stops *future* ticks, but an already in-flight heartbeat save (mid-`await`) captured a snapshot **without** the final results. If it flushes after the main flow's results save, it clobbers the completed/failed statuses + `resultArtifact` on disk (lost update).
**Fix:** Add an "in-flight" guard (skip a tick if the previous save is unresolved) **and** `await` any pending heartbeat save before writing the final result map; or touch heartbeats on an immutable per-tick copy so a late flush can't overwrite terminal state.
**Effort:** 0.5d · **Risk:** low.

### FIND-10 · P3 · `appendEventAsync` re-opens the file to fsync + issues 3–4 `stat`s per event
**File:** `src/state/event-log.ts:585-604` (append + fsync), `:540/:566/:630` (stats)
**Verified:** After `appendFile`, the code does a **second** `fs.promises.open(eventsPath, "r+")` → `fd.sync()` → `fd.close()` for **every** event, plus up to 3–4 `fs.promises.stat` calls (initial overflow pre-check, post-compact, size-check, cache-update).
**Correction to the original audit suggestion:** The audit proposed "skip fsync for non-terminal events" — **that is wrong here.** The code comment at `:598-600` documents the fsync as intentional: it closes the crash window between `appendFile` and `persistSequence` that would otherwise allow **sequence-number reuse** on restart. Skipping it reintroduces a durability bug.
**Correct fix:** Do not remove the fsync. Instead (a) avoid the double-open — obtain a single fd (open → append → `fd.sync()` → close) so we don't open the path twice per event, and (b) collapse the redundant `stat` calls into one where possible.
**Effort:** 1d · **Risk:** medium (touches the seq-integrity hot path; needs the existing seq-uniqueness tests to stay green).

---

## Maintainability

### FIND-07 · P2 · `renderLines()` copy-pasted verbatim across 3 UI files
**File:** `src/ui/widget/widget-renderer.ts:176` (exported) vs identical private copies at `src/ui/run-dashboard.ts:162` and `src/ui/live-run-sidebar.ts:22`
**Verified:** All three implementations are the same `new Box(0,0)` + `addChild(new Text(line))` + `box.render(width)`.
**Fix:** Delete the two private copies; import the already-exported `renderLines` from `widget-renderer.ts` (or hoist it to a small shared `ui/box-render.ts`).
**Effort:** 0.25d · **Risk:** very low.

### FIND-08 · P2 · Three runtime modules imported only by coverage tests, never by `src/`
**Files:**
- `src/runtime/auto-resume.ts` (`AutoResumeController`, `SETTLE_WINDOW_MS`)
- `src/runtime/notebook-helpers.ts` (`getCell`, `isNotebookPath`, `parseNotebook`, `serializeNotebook`, `updateCell`)
- `src/runtime/orphan-sentinel.ts` (self-labeled `DEPRECATED, replaced by parent-guard.ts ... no-op placeholder`)

**Verified:** `grep 'from "…(auto-resume|notebook-helpers|orphan-sentinel)"'` across `src/` returns **no matches**; the only references are prose comments (e.g. `loop-gates.ts`, `compaction-guard.ts`) and their respective `test/unit/*.test.ts` cov tests. The live auto-resume path uses `loop-gates.ts`.
**Problem:** Dead code artificially retained by tests that only assert it loads (coverage padding).
**Fix:** Delete all three modules + their cov tests. If `auto-resume` logic is still intended, fold it into `loop-gates.ts` and wire it in.
**Effort:** 0.5d · **Risk:** low (confirm no dynamic/bundle reference first).

### FIND-09 · P2 · `resilient-edit.ts` `any` cluster on the Edit-tool boundary
**File:** `src/runtime/resilient-edit.ts:6,30-34,66,97,114`
**Verified:** The `ToolLike.execute` signature and `retryWithReplace` use `params: any, signal: any, onUpdate: any`, a `[key: string]: any` index, and `const piAny = pi as any` (line 66), each with an explicit `eslint-disable @typescript-eslint/no-explicit-any`.
**Nuance (downgraded):** The `any` is confined to the boundary that mirrors Pi's untyped tool API; the local `EditParams` / `EditResult` shapes are properly typed. It is an intentional shim, not a codebase-wide type hole.
**Fix (opportunistic):** Define a minimal `EditToolLike` interface + a typed accessor for `pi.extensions` to remove the `as any` and the index signature.
**Effort:** 0.5d · **Risk:** low.

### FIND-13 · P3 · Two tracked TODOs
**File:** `src/runtime/task-packet.ts:88` ("Once TaskPacket type gains a hashId field, include this in the packet"), `src/agents/discover-agents.ts:123` ("In production, integrate with project's logging infrastructure").
**Verified:** These are the only two TODO/FIXME markers in `src/`. Both benign; convert to tracked issues or resolve.
**Effort:** trivial · **Risk:** none.

---

## Security (all low severity — no P0/P1)

### FIND-11 · P2 · Import-bundle SHA-256 integrity is self-referential (no authenticity)
**File:** `src/extension/run-import.ts:58-77`
**Verified:** The hash is recomputed over the bundle's own contents (with the `sha256` field stripped) and compared to `manifest.sha256` carried **inside the same bundle**; when `sha256` is absent the check is skipped entirely.
**Problem:** A tampered/malicious `run-export.json` simply carries a matching (or absent) hash. This detects accidental corruption only, not tampering, while giving a false sense of trust.
**Mitigating context:** Import writes only into a path-contained `imports/<runId>/` (`isContained` + `assertSafePathId`) and does **not** execute the bundle, so blast radius is bounded.
**Fix:** Treat imported bundles as untrusted regardless of hash (validate + sandbox), or sign bundles with a key not embedded in the payload.
**Effort:** 0.5–1d · **Risk:** low.

### FIND-12 · P3 · Unknown/custom agent roles default to write + subagent-spawn
**File:** `src/runtime/role-permission.ts:14-37`
**Verified:** Only the hardcoded `READ_ONLY_ROLES` set is restricted; `permissionForRole` returns `workspace_write` for **any** unrecognized role, so `checkSubagentSpawnPermission` allows recursive spawning for any custom-named agent (bounded only by the depth guard).
**Fix:** Default-deny write/spawn for roles not explicitly recognized, or require an explicit opt-in in the agent config.
**Effort:** 0.5d · **Risk:** medium (could break existing custom agents relying on the permissive default — needs a migration note).

### FIND-14 · P3 · Background-runner stderr written to `background.log` unredacted
**File:** `src/runtime/async-runner.ts:311-321` (`flushStderr`)
**Verified:** Captured child stderr is appended raw via `fs.appendFileSync(logPath, `[child stderr] ${body}...`)` with no `redactSecrets` / `redactSecretString`, unlike `child-pi.ts` which redacts every stderr excerpt.
**Mitigating context:** The runner's env is allowlist-sanitized, so provider keys should not appear; risk is limited to secrets that surface in a thrown error / native crash text.
**Fix:** Route `body` through `redactSecretString` before the append.
**Effort:** 0.25d · **Risk:** very low.

---

## Consolidated priority table

| ID | Sev | Area | Title | Effort | Risk |
|----|:---:|------|-------|:------:|:----:|
| FIND-01 | P1 | perf | `delivery.json` O(N²) read-modify-write | 1–2d | med |
| FIND-02 | P1 | perf | Mailbox append blocks loop (`sleepSync`) | 1d | low-med |
| FIND-03 | P2 | perf | `listActive()` uncached full scan | 0.5d | low |
| FIND-04 | P2 | perf | Metrics summary reads ≤500 files sync | 0.5d | low |
| FIND-05 | P2 | perf | `readEventsCursor` full parse (default) | 1d | low |
| FIND-06 | P2 | correctness | Coalesced heartbeat races final write | 0.5d | low |
| FIND-07 | P2 | maint | `renderLines` duplicated ×3 | 0.25d | v.low |
| FIND-08 | P2 | maint | 3 orphan modules (test-only) | 0.5d | low |
| FIND-09 | P2 | types | `resilient-edit.ts` `any` cluster | 0.5d | low |
| FIND-10 | P3 | perf | `appendEventAsync` double-open fsync + stats | 1d | med |
| FIND-11 | P2 | security | Import-bundle SHA-256 self-referential | 0.5–1d | low |
| FIND-12 | P3 | security | Custom roles default to write/spawn | 0.5d | med |
| FIND-13 | P3 | maint | 2 tracked TODOs | trivial | none |
| FIND-14 | P3 | security | Background stderr unredacted | 0.25d | v.low |

**Totals:** 2 × P1, 8 × P2, 4 × P3 · ~8.5–9.5 dev-days.

---

## Recommended sequencing

1. **FIND-01 + FIND-02** (mailbox perf) — highest runtime impact; the code already flags the `sleepSync` path as deprecated.
2. **FIND-07 + FIND-08 + FIND-14** — cheap, low-risk hygiene (dedupe, delete dead code, redact).
3. **FIND-03 / FIND-04 / FIND-05** — O(N) scan reductions on state reads.
4. **FIND-06** — heartbeat race guard.
5. **FIND-11 / FIND-12 / FIND-09 / FIND-10 / FIND-13** — opportunistic.

## Corrections vs. the parallel audit (transparency)

- **FIND-10:** the audit's "skip fsync for non-terminal events" is **rejected** — the fsync is intentional seq-integrity protection. Re-scoped to "remove the double-open + collapse stats."
- **FIND-03 / FIND-05:** downgraded — both have partial mitigations already (stat memoization; incremental reader + tail-cap + warning log).
- **FIND-09:** downgraded — `any` is a deliberate, localized Pi-tool boundary shim, not a systemic hole.

## Method notes / limitations

- Every finding was confirmed by directly reading the cited source lines. `.js` companions in `src/` were checked and dismissed (gitignored strip-types emit, not committed).
- **Not run:** `npm run typecheck`, `npm test`, `npm run ci`. All fixes above must be validated against the existing suite (esp. seq-uniqueness, mailbox, and coalesced-dispatch tests) before landing.
