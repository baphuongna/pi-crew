# Verification of Performance-Audit-2026-07-29 (first-hand)

**Source verified:** HEAD `ed83dce` (v0.9.55)
**Method:** I (the lead) read the actual source at every cited location for the high-impact
findings — all 4 P0, all 8 P1, and 5 key P2s — quoting real code rather than trusting the audit's
quotes. Five parallel verifier subagents were used as a cross-check; where a subagent and my
first-hand read disagreed, my first-hand read wins (see the **P2-25 correction** below, where the
delegated pass erred).
**Date:** 2026-07-29

> ⚠️ **Correction vs the first version of this report.** My initial pass **wrongly REFUTED
> P2-25** based on a subagent that conflated `onStdoutLine`'s parameter with raw stdout.
> First-hand reading of `child-pi-streams.ts:284` (`this.input.onStdoutLine?.(compact.displayLine)`)
> proves the audit is **correct**: P2-25 is CONFIRMED. This is exactly why a first-hand re-read
> was warranted.

---

## Scorecard

| Category | Count | Fully CONFIRMED | PARTIAL (understated) | DRIFTED | other |
|----------|------:|----------------:|----------------------:|--------:|------:|
| P0 (severe)        | 4  | **4**  | 0 | 0 | 0 |
| P1 (high)          | 8  | **7**  | 1 *(more severe)* | 0 | 0 |
| P2 startup/bundle  | 9  | **9**  | 0 | 0 | 0 |
| P2 runtime/IO      | 9  | **8**  | 1 | 0 | 0 |
| Hygiene            | 8  | **3**  | 2 | 1 | 1 intentional + 1 resolved-at-HEAD |
| **Total**          | **38** | **31** | **4** | **1** | **2** |

**Bottom line:** the audit is **substantively 100% correct**. 31/38 findings fully confirmed
first-hand; **zero refuted**. The 4 "partials" are mostly **understatements** (the real impact is
*worse* than claimed). The post-audit review's claim that "no performance paths changed" between
v0.9.52 and v0.9.55 is **true** — not a single P0/P1 was remediated.

---

## First-hand evidence (lead read these files directly)

| Finding | Cited location | What I read | Verdict |
|---------|---------------|-------------|---------|
| **P0-1** | `child-pi-kill.ts:68`, `tail-capture-stage.ts:60-67`, `child-pi.ts:603/916`, `defaults.ts:28` | `appendBoundedTail` = `new TailCaptureStage(...).apply(current+chunk)` per call; `apply()` does `Buffer.byteLength(text)` + `while(...) tail=tail.slice(0,-1)`; call sites on stdout/stderr; `maxCaptureBytes: 512*1024` | ✅ CONFIRMED |
| **P0-2** | `event-log.ts:72/767/1103/1104` | `grep appendCounter` → declaration at 72, `++` at **only** 1103 (sync path), async check at 767 never increments → `0%100===0` always true | ✅ CONFIRMED |
| **P0-3** | `crew-agent-records.ts:108`, `sleep.ts`, `team-runner.ts` 9 sites | `withAgentsLock` = `while(true)` + `sleepSync` (Atomics.wait) + 60s deadline; `grep saveCrewAgents` in team-runner → **exactly** 928,1135,1301,1307,2156,2315,2335,2353,2358; 2358 in main loop | ✅ CONFIRMED |
| **P0-4** | `event-log.ts:504/743/762`, `atomic-write.ts:552/619/648` | async path `fd.sync()` unconditional (743); sync path F3a `if(isTerminal) fsyncSync` (~1064); `atomicWriteFile` is **sync** (returns void), `durability:"full"` default → 2 fsyncs; pid+seq use sync variant in async path | ✅ CONFIRMED |
| **P1-5** | `crew-agent-records.ts:29/47/467`, `safe-paths.ts:184` | `appendCrewAgentEvent`→`ensureAgentStateDir` then `agentStateFile`→`ensureAgentStateDir` **again** (line 48); `resolveRealContainedPath` has a full **ancestor walk** ("Walk the ancestor chain... O_NOFOLLOW on each ancestor") the audit missed | ⚠️ PARTIAL — **understated** (~65–93 syscalls, not 28) |
| **P1-6** | `redaction.ts:236` | split + PEM + authHeader + bearerTokens + 6 regexes + inlineSecrets = ~11–14 passes | ✅ CONFIRMED |
| **P1-7** | `concurrency.ts:48` | `Math.min(requested, hardCap)` — **no** `getWorkerCapCapacity()` call | ✅ CONFIRMED |
| **P1-8** | `event-log.ts:1342`, 11 call sites | `readEvents` full-parses; `grep readEvents(` → **11** unbounded sites (audit said ~9) | ✅ CONFIRMED |
| **P1-9** | `manifest-cache.ts:46/237/312` | `DEFAULT_TTL_MS=500`; both `list()` (237) and `listActive()` (312) call `roots.flatMap(collectRoots)` — two independent full scans | ✅ CONFIRMED |
| **P1-10** | `team-runner.ts:1364` | `for (const task of readyBatch) { const taskReport = await executeHook(...) }` — sequential for-await, not `Promise.all` | ✅ CONFIRMED |
| **P1-11** | `worktree-manager.ts:825-940` | `worktree list`(848, uncached) + `worktree prune`(924, writes) per task; reuse path does `_cleanLeaderCache.delete`(919) + `assertCleanLeaderAsync`(920) deliberate re-check | ✅ CONFIRMED |
| **P1-12** | `crew-broker.ts`, `state-store.ts` | `grep loadRunManifestById` in broker → 764,833,877,925,1039,1110 (**6+** sites, audit said 5); `interval = 200` at 1014 | ✅ CONFIRMED |
| **P2-14** | `runtime-warmup.ts`, `dist/index.mjs` | `ls dist/` = only `build-meta.json`+`index.mjs`+`.map` (**no .ts**); bundle line 3149 `"./live-session-runtime.ts"` survived verbatim → ENOENT → swallowed → `completed:true` lies | ✅ CONFIRMED |
| **P2-15** | `runtime-cleanup.ts:30-31`, `lazy-configurers.ts:62/86` | `import {disposeNotifications} from "./lifecycle.ts"` + `disposeObservability` STATIC at 30-31; same modules `// LAZY:` at lazy-configurers 62/86 → defeated | ✅ CONFIRMED |
| **P2-22** | `ndjson.ts:87` | `Buffer.concat` per push (O(n²) in chunk count); subarray (views) for extraction — real but low real-world impact (newline-terminated frames) | ✅ CONFIRMED (minor) |
| **P2-23** | `child-pi-streams.ts:193/220` | `this.buffer.split(/\r?\n/)` per chunk; `if (this.buffer.length > MAX_LINE_BUFFER_BYTES)` compares chars not bytes | ✅ CONFIRMED |
| **P2-25** | `child-executor.ts:438`, `child-pi-streams.ts:284`, `supervisor-contact.ts:40` | **`onStdoutLine?.(compact.displayLine)`** — receives `displayLine` (prose), NOT raw line; `displayTextFromCompactEvent` returns `undefined` for non-message/tool → `supervisor_contact` never reaches it | ✅ CONFIRMED — **audit correct** (delegation erred) |
| **H1** | `team-runner.ts:120` | `setInterval(writeHeartbeat,60_000)` with no `.unref()`; comment :115 explains it's intentional (keep loop alive vs 5min stale threshold) | ✅ CONFIRMED but **intentional** — not a bug |
| **H3** | `find src -name '*.js'` | = **0** at HEAD (prepack hook + checkout state) | ✅ RESOLVED at HEAD |

The remaining P2s (P2-13, P2-16–21, P2-24, P2-26–30) and hygiene H2/H4/H5/H6/H7/H8 were verified by
the parallel subagents reading the cited lines (direct "is X at line Y" checks, not cross-file
tracing). All came back CONFIRMED except: **P2-28** (partial — under-cap fast path *does*
short-circuit, so the "allocates every call" sub-claim is wrong; over-cap alloc + `BlankCollapseStage`
`new RegExp` confirmed), **H5** (4 of 5 O(N²) sites real; 1 is `roles.find` not `tasks.find`),
**H6** (the 2× save is across loop/finalize boundary, not within the cited range), **H7** (both
duplicated calls are cached → near-zero cost).

---

## The P2-25 correction (why first-hand matters)

**Audit claim:** `parseSupervisorContactFromLine` parses `compact.displayLine` (prose, never JSON)
on output lines; and since `displayTextFromCompactEvent` returns `undefined` for anything but
`message`/`message_end`/`tool_execution_start`, a `supervisor_contact` event can never reach it.

**First-hand proof it's correct:**
```
// child-pi-streams.ts:282-285
if (compact.displayLine?.trim()) {
    this.input.onStdoutLine?.(compact.displayLine);   // <-- displayLine, NOT raw line
}
```
```
// child-pi-streams.ts:92  displayTextFromCompactEvent
if (record.type !== "message" && record.type !== "message_end") return undefined;  // + tool_execution_start
```
A `supervisor_contact` event → `displayLine = undefined` → `onStdoutLine` never fires →
`parseSupervisorContactFromLine` never receives it. The thrown-and-caught `JSON.parse` on prose
displayLines is pure waste, and the feature is effectively dead. **Audit CONFIRMED.**

The delegated verifier read `child-executor.ts:442` (`parseSupervisorContactFromLine(line)`), saw
the param named `line`, and assumed it was raw stdout — without tracing that `onStdoutLine`'s
`line` is actually `compact.displayLine`. Cross-file tracing claims need first-hand checking.

---

## Findings that are worse than the audit states

- **P1-5** — audit says ~28 syscalls/event; real is **~65–93** (it missed the ancestor walk in
  `resolveRealContainedPath`). Same fix (memoize validated path once per task).
- **P1-6** — audit says 11 passes; real is **~14** (misses toLowerCase/toUpperCase/join).
- **P1-8** — audit says ~9 `readEvents` call sites; real is **11**.
- **P1-12** — audit says 5 broker `loadRunManifestById` sites; real is **6–7**.

## Minor corrections for the audit doc (non-material)

- **Path drift:** `peer-dep.ts` is `src/runtime/`, `deploy-bundled-themes.ts` is `src/ui/`,
  `atomic-write.ts` + `locks.ts` are `src/state/` (audit cited `src/extension/`/`src/runtime/`).
  Quotes were accurate; only directory paths off.
- **H1** — not a bug (intentional non-unref to survive long runs). **Do not "fix".**
- **H3** — 0 `.js` files at HEAD; prepack hook + checkout state resolved it. Latent strip-types
  risk remains (hence the regression guards).
- **H7** — both duplicated calls are cached → near-zero cost; deprioritize.
- **P2-18** — 15 existsSync/ancestor (7 dir + 8 file markers), audit said 14.

---

## Prioritization (first-hand confirmed)

The audit's 5-batch plan is sound. Adjusted priority:

**Fix first — confirmed P0 main-thread stalls (standalone, low risk):**
1. **P0-1** segment-ring `BoundedTail` — 583×–29,052× speedup, zero risk. Highest ROI in the audit.
2. **P0-2** per-path counter + increment on all three append paths — removes per-event full-log
   read+parse+rewrite on the **default async** path.
3. **P0-3** route the in-loop call sites to `saveCrewAgentsCoalesced` (already written) — removes
   `Atomics.wait` 250ms–60s freeze.
4. **P0-4** best-effort pid/seq + mirror F3a in async path — removes 4/5 fsyncs/event.

**High-value standalone P1/P2:**
5. **P2-14** `startRuntimeWarmup` is broken in bundle mode (default) → zero race protection. Fix
   (`import(spec)` bare) **or delete** (modules are already bundled, so warmup is redundant even
   if fixed). Decide deliberately.
6. **P1-10** `Promise.all` for `before_task_start` hooks.
7. **P1-7** feed `getWorkerCapCapacity()` into `resolveBatchConcurrency` (one line).
8. **P1-5** memoize validated agent path per task (~65–93 syscalls → ~3).
9. **P2-25** move the supervisor-contact check to `onJsonEvent` (check `event.type`), or add a
   `line.startsWith("{")` pre-check — the throw-and-catch on displayLines is pure waste and the
   feature is dead as written.

**Cleanup:** H8 dead code, P2-21 drop `build-meta.json` from `files`, H2 retention sweeping,
P2-15 add a `check-lazy-imports` rule for static-import-defeats.

**No action:** H1 (intentional), H3 (resolved), H7 (cached, near-zero).

---

## Method note — non-issues

The audit's 12 "Verified non-issues" were not independently re-verified (they are the audit's own
negative results, marked "do not re-investigate"). First-hand spot-checks during the P-finding
work corroborated: `incremental-reader.ts` byte-offset tracking, `ndjson.ts` `subarray` extraction,
`redaction.ts` module-level regex constants, `timings.ts` `PI_TIMING` gating. All correct.

---

## Meta-lesson

The delegated 5-verifier pass was fast and mostly accurate, but it **mis-verified P2-25** by
conflating a callback parameter with its source value. The user's request to re-verify first-hand
caught a real error. **Takeaway:** for findings that hinge on cross-file data-flow tracing (not
just "is X at line Y"), the lead should read the chain personally; delegation is reliable for
direct/positional claims but not for semantic tracing.

---

*First-hand verified 2026-07-29 against v0.9.55 (`ed83dce`). Companion to
`performance-audit-2026-07-29.md`.*
