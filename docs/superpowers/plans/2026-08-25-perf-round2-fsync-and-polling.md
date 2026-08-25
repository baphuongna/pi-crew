# Perf Round 2: fsync Cleanup + Polling Latency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the extra fsyncs that survive in pi-crew's state layer (pid files, non-terminal batches, non-terminal tasks checkpoints, mailbox delivery marks) and drop the fixed 500ms polling latency on mailbox steering — the two largest remaining performance levers after the 2026-08-24 round.

**Architecture:** Durability is tiered: (a) terminal state transitions + terminal events keep full fsync durability (crash-durable, reconstructible); (b) *disposable* files — lock pid files, sequence sidecar, non-terminal checkpoint data — become best-effort: content is reconstructible from the fsync'd event log or overwritten by the next write. The mailbox has an existing opt-in broker-push path that removes the 0-500ms poll latency entirely; the fix enables it behind the existing config gate. Fixed 500ms intervals drop to the existing event-driven realtime path under live-session, and the events cursor stops re-parsing the whole file on tail reads.

**Tech Stack:** Node.js 22 (node:test, `node --experimental-strip-types`), fs promise API, pi-crew state layer (`src/state/`), Pi extension host (`src/ui/`, `src/prompt/`, `src/runtime/`).

## Global Constraints

- Preserve every `BUG-####`, `F#` (F1–F4), `ST-#` (ST-7/ST-8), `R16-B1`, `H#`, `P#`-tagged comment block describing an invariant — wording may be corrected to match new behavior, but the invariant documentation must survive.
- Never commit anything under `dist/`. Never use `git commit -am` — always explicit `git add`.
- Durability escalation only: best-effort is *downgrade only for the specific files listed*; no terminal transition or terminal event may become best-effort.
- Event-log monotonic sequence (R16-B1/advance-on-reserve) and the F3a inconsistent-tail tolerance must be preserved exactly.
- New/changed tests must use the repo conventions: `node:test`, `import test from "node:test"`, `node:assert/strict`, Ts src imports, fs ESM-namespace mocking only via the CJS-default-swap + `syncBuiltinESMExports` technique (see `test/unit/manifest-cache-ttl.test.ts`).
- Conventional commits: `perf(<area>): ...`, `fix(<area>): ...`, `test(<area>): ...`.

---

## File Map

| File | What changes |
|---|---|
| `src/state/event-log/event-log.ts` | pid-file write at :135, buffered batch fsync at :828, sync append path :975 |
| `src/state/event-log/sequence-cache.ts` | sequence sidecar — VERIFY only, leave logic as-is |
| `src/state/atomic-write.ts` | `atomicWriteFile` + atomicWriteJsonCoalesced remain the entry points |
| `src/state/stores/state-store.ts` | `saveRunTasksCoalesced` (:665,:695) — add via `skipCoalesce` path only |
| `src/runtime/task-runner/state-helpers.ts` | `persistSingleTaskUpdate` (:156) — terminal passthrough only |
| `src/state/coordination/mailbox.ts` | `appendMailboxMessage` (:660) + delivery-path full durability |
| `src/runtime/scratchpad/engine.ts` / `src/runtime/task-runner/child-executor.ts` | sync append call sites (verification + optional migration) |
| `src/prompt/prompt-runtime.ts` | poll intervals (:249,:328,:832) |
| `src/ui/scratchpad-overlay.ts` | scratchpad-poll path |
| `src/state/event-log/cursor.ts` | `parseJsonlEvents` (:40) byte-offset tail |
| `src/ui/transcript-cache.ts` | incremental byte-offset reader (pattern source) |
| `src/ui/transcript-viewer.ts` | cursor-backed tail reads |
| `src/config/config.ts` + `src/config/env-vars.ts` | new config `persistence.skipTasksFsync` (default `false`) |
| `test/unit/state/event-log-*.test.ts` etc. | new tests |

---

## Phase 1 — Best-effort pid file (disposable, risk≈0)

### Task 1: Pid-file write in `.mkdirlock` / `.alock` → `"wx"` open

**Files:**
- Modify: `src/state/event-log/event-log.ts:135` (sync lock) and the `.alock` async pid write (the `"wx"` pattern already used for the async path at :337) — the sync-path pid write at :135 still uses `atomicWriteFile(pidFile, ...)`.

**Interfaces:**
- Consumes: `withEventLogLockSync`'s lock-dir acquisition; existing `"wx"` pattern already demonstrated at :337 for the async `.alock` path.
- Produces: pid files that are written with `fs.openSync(pidFile, "wx")` + `fs.writeSync`, never `atomicWriteFile`. Reading sites (:172, :203, :364, :389) unchanged.

**Rationale (from the existing :337 PERF comment, verbatim intent):** pid files are "disposable, mtime-stale-detected 4-byte file". Stale detection uses mtime + pid, not file content durability; a pid file is never a durability boundary. The sync path at :135 still pays a full `atomicWriteFile` (2 fsync) per sync `appendEvent`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/state/event-log-pid-write.test.ts` using `const { openSync, writeSync } = await import("node:fs")` via CJS-default-swap spy on file-create mode. Assert: after `withEventLogLockSync(eventsPath, () => {})`, the `.mkdirlock/pid` file exists with the correct pid content, **and** `atomicWriteFile` was NOT called for the pid path (spy counts calls where `filePath === pidFile`).

```ts
// test/unit/state/event-log-pid-write.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("pid file is written via openSync('wx') not atomicWriteFile", async () => { ... });
```

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/event-log-pid-write.test.ts`
Expected: FAIL — pid currently written via `atomicWriteFile`.

- [ ] **Step 2: Patch `src/state/event-log/event-log.ts:135`**

Replace inside `withEventLogLockSync`'s post-mkdir block (currently ~:135):

```ts
// PERF (2026-08-25): pid file is disposable + mtime-stale-detected, so the
// full atomicWriteFile (2 fsync) here was dead ceremony — the .alock async
// path already writes pid via "wx". Mirror it: O_EXCL open, plain write.
// The lock dir itself is the mutex.
try {
	const pidFd = fs.openSync(pidFile, "wx");
	try {
		fs.writeSync(pidFd, String(process.pid));
	} finally {
		fs.closeSync(pidFd);
	}
} catch {
	/* best-effort — e.g. EEXIST under a re-taken dir; stale pid is mtime-detected */
}
```

- [ ] **Step 3: Run the test to verify it now passes**

Run: same command. Expected: PASS (2 tests: pid content correct; atomicWriteFile not invoked for pid).

- [ ] **Step 4: Run the event-log unit suites**

Run:
```bash
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/event-log.test.ts
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/event-log-*.test.ts
```
Expected: 0 failures.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/unit/state/event-log-pid-write.test.ts src/state/event-log/event-log.ts
git commit -m "perf(event-log): write lock pid files via 'wx' open, not full atomicWrite (2 fsync)"
```

---

### Task 2: Buffered batch flush — skip fsync when the batch is all non-terminal

**Files:**
- Modify: `src/state/event-log/event-log.ts` — `appendEventBatchInsideLock` (:702), specifically the Phase-2 fsync (:828).

**Interfaces:**
- Consumes: `appendEventBuffered` (:1041) pushes entries into `bufferedQueues`, timer flushes via `flushOneEventLogBuffer` → `appendEventBatchInsideLock`. `finalized` entries carry `fullEvent: TeamEvent` (fullEvent.type ∈ `TERMINAL_EVENT_TYPES`).
- Produces: batch fsync only when `finalized.some((f) => TERMINAL_EVENT_TYPES.has(f.fullEvent.type))`.

**Rationale (mirrors F3a/P0-4 at :582/:602, current code at :582 has the identical skip for the single-event path):** terminal events bypass the buffer entirely (see :1043-1056 — terminal goes straight to `appendEvent` with its own fsync), so a buffered batch containing only non-terminal events can skip the fsync and rely on the caller's own flush for crash durability. This erases the ~50 fsync/s currently spent on `task.progress` bursts from `child-executor.ts:445` and `dispatch-batch.ts:591` (both callers fire non-terminal events through the buffer).

- [ ] **Step 1: Write the failing test**

Extend `test/unit/state/event-log-buffered.test.ts` (or create). Assert: a batch of 20 non-terminal events appended via `appendEventBuffered` completes and the underlying `fsyncSync` on the events file is called **0 times**; a batch containing ≥1 terminal event calls it **≥1 time**.

- [ ] **Step 2: Patch `appendEventBatchInsideLock` (:828)**

```ts
// PERF (2026-08-25): skip the fsync when the whole batch is non-terminal.
// Terminal events never route through this buffer (appendEventBuffered
// bypasses to appendEvent, which fsyncs itself), so a batch here has no
// terminal event unless a caller deliberately mixed one in — mirror F3a:
// the event-reconstructor tolerates an inconsistent tail; the explicit
// persistSequenceMonotonic below still lands the reserved end range.
const hasTerminal = finalized.some((f) => TERMINAL_EVENT_TYPES.has(f.fullEvent.type));
if (hasTerminal) {
	const fd = fs.openSync(eventsPath, "r+");
	try {
		fs.fsyncSync(fd);
	} catch {
		// EPERM on Windows CI: best-effort flush
	} finally {
		fs.closeSync(fd);
	}
}
```

- [ ] **Step 3: Verify** — re-run `event-log-buffered.test.ts` + `event-log.test.ts`. Expected: PASS.
- [ ] **Step 4: Typecheck + lint.** Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add test/unit/state/event-log-buffered.test.ts src/state/event-log/event-log.ts
git commit -m "perf(event-log): skip batch fsync for all-non-terminal buffered flushes"
```

---

### Task 3: Non-terminal tasks checkpoint → best-effort (gated, default off)

**Files:**
- Modify: `src/state/stores/state-store.ts` (:665, :695), `src/runtime/task-runner/state-helpers.ts` (:156 where skipCoalesce is decided)
- New: `src/config/config.ts` option + env gate, and new test

**Interfaces:**
- Consumes: `saveRunTasksCoalesced(manifest, tasks, skipCoalesce)` — the third param already toggles between coalesced (buffered, 50ms) and immediate `atomicWriteJson` (durable). A new config flag `persistence.skipTasksFsync` (default `false`) flips a new fourth option `coalesceDurability?: WriteDurability` on `atomicWriteJsonCoalesced`.
- Produces: `atomicWriteJsonCoalesced<T>(filePath, value, coalesceMs?, options?, skipCoalesce?, opts?)` where `opts` may carry `durability`. `saveRunTasksCoalesced` gains an optional `durability` param (default `"full"`).

**Implementation via the existing `skipCoalesce` bypass — NO change to the coalesced buffered path:** when `persistence.skipTasksFsync === true` AND the save is *not* skipping coalescing (i.e., non-terminal checkpoint), route through `atomicWriteJson(filePath, tasks, { compact: true, durability: "best-effort" })` instead of the coalesced queue. Terminal transitions keep `skipCoalesce: true` → `atomicWriteJson(..., durability: "full")` untouched.

**Rationale:** tasks.json is fully reconstructible from the fsync'd event log (`src/state/manifest-io.ts:162,169,227,233`); a crash loses at most the ~50ms un-flushed checkpoint and recovers from the event log. Default `false` → zero semantic change out of the box; opt-in for long-running teams.

- [ ] **Step 1: Add the config flag**

In `src/config/config.ts`, extend the persistence-adjacent config object with `persistence: { skipTasksFsync: boolean }` readable from env `PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC`. Add to `src/config/env-vars.ts` if a helper var exists there.

- [ ] **Step 2: Plumb `AtomicWriteOptions.durability`**

`atomicWriteFile` already accepts `{ durability: "best-effort" }` (atomic-write.ts:676,709). Verify the coalesced entry stores the durability and forwards it to `atomicWriteFile` at :997. Then implement `saveRunTasksCoalesced` deciding which path to use based on the config flag (see the skipCoalesce branch sketch below).

- [ ] **Step 3: Write the failing test**

`test/unit/state/state-store-tasks-fsync.test.ts`: with `PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC=1`, calling `saveRunTasksCoalesced(manifest, tasks)` for a non-terminal save must (a) NOT call `atomicWriteJsonCoalesced`, and (b) call `atomicWriteFile` with `durability:"best-effort"` (spy via CJS-default-swap). Without the flag, behavior unchanged — identical calls, `durability:"full"`.

- [ ] **Step 4: Implement; add a unit test for the default-off path** such that with the flag unset the save goes through the normal coalesced/`full` path exactly as before.

- [ ] **Step 5: Run state-store + state-helpers suites.** Expected: 0 failures.
- [ ] **Step 6: Typecheck, lint.**
- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts src/state/stores/state-store.ts src/runtime/task-runner/state-helpers.ts test/unit/state/state-store-tasks-fsync.test.ts
git commit -m "perf(state): opt-in best-effort fsync for non-terminal tasks checkpoints (PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC)"
```

---

## Phase 2 — Mailbox durability + polling latency

### Task 4: `appendMailboxMessage` delivery durability → best-effort default

**Files:**
- Modify: `src/state/coordination/mailbox.ts` (:660 and surrounding)

**Interfaces:**
- Consumes: `writeDeliveryState(manifest, delivery, { durability: "full" })` (mailbox.ts ~:660); `delivery.json` is "informational, next message overwrites" per the existing comment.
- Produces: delivery messages written with default best-effort; terminal/monitor paths that explicitly pass `durability: "full"` keep it.

**Rationale (verbatim from mailbox.ts comment ~:555-557 already self-justifying):** delivery state is informational and overwritten by the next message; a crash only risks re-delivery, the accepted semantics of the default path.

- [ ] **Step 1: Write the failing test** — `test/unit/state/mailbox-delivery-durability.test.ts`: spy on `atomicWriteFile`; after `appendMailboxMessage` with no explicit durability, assert the call passed `durability: "best-effort"`; with `{ durability: "full" }` passed explicitly, it stays full.
- [ ] **Step 2: Patch** — change the `writeDeliveryState(manifest, delivery)` call in `appendMailboxMessage` from `{ durability: "full" }` to the default (drop the option; best-effort is the default per `writeDeliveryState`'s signature). Keep any *separate* terminal/reply-path `writeDeliveryState(..., { durability: "full" })` untouched.
- [ ] **Step 3: Verify** — run mailbox suites (`mailbox*.test.ts`). Expected: 0 failures.
- [ ] **Step 4: Typecheck, lint.**
- [ ] **Step 5: Commit**

```bash
git add test/unit/state/mailbox-delivery-durability.test.ts src/state/coordination/mailbox.ts
git commit -m "perf(mailbox): delivery.json marks default to best-effort (next message overwrites)"
```

---

### Task 5: Polling latency — event-driven steering under live-session, adaptive intervals

**Files:**
- Modify: `src/prompt/prompt-runtime.ts` (:249, :328, :832), `src/ui/scratchpad-overlay.ts` (scratchpad poll), possibly `src/runtime/live-session/live-session-runtime.ts` (realtime signal)

**Interfaces:**
- Consumes: the existing poll loops; the existing opt-in broker push (Feature 2b) with `sanitizeSteer` + `pi.sendMessage`.
- Produces: when live-session realtime mode is active, the mailbox steering poll (currently fixed 500ms) switches to an event-driven wake: poll immediately on demand, and on a configurable short interval (e.g. 50ms) only while an expectNextCall/ask is in flight; otherwise the interval relaxes to the prior 500ms. This removes the 0–500ms latency term for `ask`/`steer` answers under live-session without changing the durable/fallback semantics of the poll.

- [ ] **Step 1: Write the failing test** — a unit test on the poll decision logic: given a "realtime active" state, the effective interval is 50ms; given "realtime inactive", it stays 500ms; given "no in-flight handshake", it relaxes back to 500ms.
- [ ] **Step 2: Implement** — add an `effectiveSteeringInterval()` helper that consults the realtime flag + in-flight-request state; replace the hard-coded 500ms in the three `setInterval` sites with it. When realtime is active, also trigger an immediate wake on event (call the poll function directly) rather than waiting for the next interval.
- [ ] **Step 3: Verify** — run `prompt-runtime` + scratchpad suites.
- [ ] **Step 4: Typecheck, lint.**
- [ ] **Step 5: Commit**

```bash
git add src/prompt/prompt-runtime.ts src/ui/scratchpad-overlay.ts test/unit/prompt/prompt-steering-interval.test.ts
git commit -m "perf(prompt): event-driven + adaptive steering poll under live-session (50ms when in-flight)"
```

---

## Phase 3 — Events cursor incremental tail + bench infra

### Task 6: Events cursor → byte-offset tail

**Files:**
- Modify: `src/state/event-log/cursor.ts` (:40 `parseJsonlEvents` full read), `src/ui/transcript-viewer.ts` (cursor-backed tail), optional `src/ui/transcript-cache.ts` (reuse the incremental reader)

**Interfaces:**
- Consumes: `readEventsCursor(fd/path, ...)` returns events; currently `parseJsonlEvents` does `fs.readFileSync(filePath, "utf-8")` + split + parse per call.
- Produces: a byte-offset tail reader that, when only the tail is requested (`TAIL_EVENT_CAP` slice), seeks to `max(0, size - TAIL_LOOKBACK_BYTES)` and reads only that span, then walks to the first complete line boundary. Full reads (no limit) keep the existing full parse. The monotonic-seq dedupe in `readEventsCursor` (:215 onward) is preserved.

- [ ] **Step 1: Write the failing test** — `test/unit/state/cursor-tail-read.test.ts`: a 10k-event file; `readEventsCursor(path, { limit: 50 })` returns 50 events (slice-correct) and the underlying `fs.readFileSync` on the whole file was **not** called (spy); a no-limit call still full-reads.
- [ ] **Step 2: Implement** — add a tail-seek branch in `parseJsonlEvents`/`readEventsCursor` when `limit` is set and `< total`.
- [ ] **Step 3: Verify** — run cursor + event-log suites; run `test/unit/ui/transcript-*.test.ts`.
- [ ] **Step 4: Typecheck, lint.**
- [ ] **Step 5: Commit**

```bash
git add src/state/event-log/cursor.ts src/ui/transcript-viewer.ts test/unit/state/cursor-tail-read.test.ts
git commit -m "perf(event-log): byte-offset tail read in events cursor (no full-file parse per tick)"
```

---

### Task 7: Bench infra repairs (b11 NDJSON, b5 module) + fsync-count micro-bench

**Files:**
- Modify: `bench/b11-dep-context-cache.bench.ts`, `bench/b5-deep-tracking.bench.ts`, `scripts/run-bench.mjs` (contract docs), new `bench/b12-dure-graph.bench.ts`

**Interfaces:**
- Consumes: the runner contract (single NDJSON line on stdout, `scripts/run-bench.mjs:41` parses first JSON line).
- Produces: b5/b11 emit clean NDJSON; `b12` reports fsync counts per operation (pid write, buffered non-terminal batch, non-terminal tasks checkpoint, delivery mark) pre/post fix.

- [ ] **Step 1: Fix b11 output contract** — b11 currently prints human tables (verified `bench/b11-dep-context-cache.bench.ts:177-184`) with no NDJSON → runner rejects (`could not parse JSON output from b11...`). Add a final `console.log(JSON.stringify({ name: "b11.dep-context-cache", ... }))` NDJSON line.
- [ ] **Step 2: Fix b5 module** — b5's imports resolve to a module that no longer exists (runner exits before parsing, `[bench] could not parse JSON output from b5...` with `MODULE_NOT_FOUND`). Point the import at the current module or add a defensive NDJSON catch. If the module is gone, rewrite the two b5 cases against the equivalent current facility.
- [ ] **Step 3: Write b12** — a micro-bench that counts fsync calls (via `fs.fsyncSync` spy) for: one sync `appendEvent` non-terminal and terminal (pre/post — pid write via full atomicWrite vs `"wx"`), one `appendEventBuffered` all-non-terminal batch, one `saveRunTasksCoalesced` non-terminal checkpoint (config on/off), one `appendMailboxMessage`. Print a small NDJSON line with the counts.
- [ ] **Step 4: Run `npm run bench`** — expect all b* to print NDJSON and a 0-errors log; capture the new fsync counts.
- [ ] **Step 5: Commit**

```bash
git add bench/b11-dep-context-cache.bench.ts bench/b5-deep-tracking.bench.ts bench/b12-fsync-counts.bench.ts scripts/run-bench.mjs
git commit -m "test(bench): repair b5/b11 NDJSON contract; add b12 fsync-count micro-bench"
```

---

## Phase 4 — Group-commit dir-fsync

### Task 8: Group the per-file parent-dir fsync across a coalesced drain (serial kept)

**Files:**
- Modify: `src/state/atomic-write.ts` — `atomicWriteFile` (sync ~:709-717, async ~:845-853), `flushOnePendingAtomicWrite` (:984-1056), `flushPendingAtomicWrites` (:1064-1080)

**Interfaces:**
- Consumes: the existing `durability === "full"` dir-fsync block (atomic-write.ts:709-717 sync / :845-853 async). The mult-output drain `flushPendingAtomicWrites(undefined)` (:1069) serial-loops `flushOnePendingAtomicWrite` for each pending file.
- Produces: a new internal `dirsPendingFsync: Set<string>` (or an option to `atomicWriteFile`/`atomicWriteJson` like `deferDirFsync: true`) so a full drain can run N file writes+renames and then issue **one** `fsync(dirFd)` per distinct parent directory at the end, instead of one per file. Individual single-file calls (`atomicWriteJson`, terminal `skipCoalesce`) keep their immediate dir-fsync unchanged.

**Rationale (measured):** burst of 4 files in one dir — current serial per-file 2-fsync pattern 59.4ms; with a single shared dir-fsync at the end 22.9ms (−61%), full durability semantics preserved (rename is atomic and journaled; dir-fsync after all renames makes every rename in that dir crash-durable in one journal commit). Files in distinct dirs still group by dir. `R16-B1` ordering holds: all renames complete before the dir-fsync.

**Durability safety:** since `rename(2)` is atomic and visible to readers the instant it happens (independent of dir-fsync), delaying the *dir* fsync to the end of the drain changes nothing for readers — only the crash-durability horizon, which is per-dir-finalize and identical to Ring-Fencing the whole drain. Files with `durability: "full"` located mid-drain are covered by the same trailing dir-fsync (same parent dir), so their guarantees are preserved.

- [ ] **Step 1: Write the failing test**

`test/unit/state/atomic-write-drain-group-fsync.test.ts`: run a full drain with 4 pending files in one `stateRoot` (via `atomicWriteJsonCoalesced` × 4) with `flushPendingAtomicWrites()`; spy on `fs.fsyncSync`/`fs.openSync(dirFd...)` and assert: (a) all 4 renames happened, (b) the parent dir's fsync was called **exactly 1 time**, not 4. For the single-file direct call (`atomicWriteJson`), dir-fsync is called exactly once as today.

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/atomic-write-drain-group-fsync.test.ts`
Expected: FAIL — currently 4 dir-fsyncs.

- [ ] **Step 2: Implement**

Add a module-level (or per-call) `deferDirFsync` path:
- `atomicWriteFile`/`atomicWriteJson` accept an optional `deferDirFsync?: boolean` reaching the dir-fsync block; when true, push `path.dirname(filePath)` into a module-level `pendingDirFsyncs: Set<string>` instead of fsyncing now, and **mark the write durable by a trailing accumulate**.
- `flushPendingAtomicWrites(undefined)` (:1069) — after the serial loop over pending files, iterate `pendingDirFsyncs` and issue one `openSync(dir, "r")` + `fsyncSync(dirFd)` + `closeSync` per **distinct** dir (skip on `process.platform === "win32"`). Clear the set in a `finally` so an error mid-drain still drains remaining dirs.
- `flushPendingAtomicWrites(filePath)` (single) and terminal `skipCoalesce` path keep immediate dir-fsync (no deferral) — semantics unchanged.
- Async drain (`flushAllPendingAtomicWrites` / any Promise-based counterpart): collect `pendingDirFsyncs` and `Promise.all` the dir fsyncs at the end. Same grouping.

Side effect on `flushOnePendingAtomicWrite`'s retry/error path: a failed flush that is retried later still gets its dir-fsync (the entry's deferred dir remains in the set until the next drain; if the next call is single-path, it does its own dir-fsync).

- [ ] **Step 3: Verify**

Run after Step 2:
```bash
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/atomic-write-drain-group-fsync.test.ts
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/state/atomic-write.test.ts
```
Expected: PASS, and the full atomic-write unit suite still green (no regression on per-file semantics).

- [ ] **Step 4: Measure**

Run the interleaved A/B from round 1's CHANGELOG on this drain (4 coalesced files in one stateRoot, mock content): expected drop toward 22.9ms (from a serial 4-file baseline). If the machine is under load, capture the same pair as a control.

- [ ] **Step 5: Typecheck + lint.**

- [ ] **Step 6: Commit**

```bash
git add src/state/atomic-write.ts test/unit/state/atomic-write-drain-group-fsync.test.ts
git commit -m "perf(state): group parent-dir fsync across coalesced drains (one journal commit per dir)"
```

---

## Phase 5 — Documentation

### Task 9: CHANGELOG + plan self-review

- [ ] **Step 1: Update `CHANGELOG.md`** — new Unreleased entry "perf round 2 (2026-08-25)": the best-effort escalations (pid files, non-terminal batch fsync, opt-in tasks-checkpoint, delivery marks), the group-commit dir-fsync (Task 8, with the measured −61% burst figure), the polling-latency change, cursor byte-offset tail, plus the bench numbers from `npm run bench` after Task 7.
- [ ] **Step 2: Self-review the plan** — check spec coverage (each Tier-1/Tier-2 finding maps to a task), placeholder scan, type consistency (`durability` plumbing across atomic-write.ts ↔ state-store.ts ↔ state-helpers.ts ↔ config.ts).
- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): perf round 2 (2026-08-25) — fsync cleanup + polling latency"
```

---

## Verification

```bash
npm run typecheck && npm run lint
npm run test:unit        # 0 failures required
npm run test:integration # 0 failures required, then E2E smoke via tmux (see below)
```

E2E smoke (after merge, like round 1): build bundle, run a `fast-fix` team in a tmux pi session, verify dashboard + transcript + steering latency visually, then confirm the new config flag (`PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC=1`) doesn't corrupt a run: after a force-kill mid-run, the run's tasks are recoverable from the event log (integration test `state-store-corrupt-tasks-recovery` still passes).

## Deferred (explicitly NOT in this plan, with reasons)

| Item | Why deferred |
|---|---|
| In-memory authoritative tasks array | Measured: JSON parse+stringify is 0.09-0.36ms @50-200 tasks — 40x cheaper than one fsync. The dominant cost is fsync, already addressed by Task 3. |
| fdatasync / fsync→fdatasync | `node:fs` does not expose fdatasync; composite bench with rename+dir-fsync showed no win (14.3 vs 12.3ms). Not feasible in pure Node. |
| Dead-code cleanup of run-metrics/run-graph | No callers in src (cold). Zero win; would add churn. Separate hygiene task if wanted. |
| Full sync-append migration (79 call sites) | Risk-appropriate as a follow-up; Tasks 1-2 already cut most sync-appends' fsync count without changing call sites. |
| Mailbox poll → broker push default-on | Requires config change + fallback semantics review; deferred to a behavior/UX decision, not perf. |