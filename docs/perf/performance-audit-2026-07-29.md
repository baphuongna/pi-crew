# pi-crew Performance Audit — 2026-07-29

**Version audited:** v0.9.52 (commit `86afde9`). Repo has since advanced to v0.9.55 (`ed83dce`); see [Post-audit commit review](#post-audit-commit-review) for impact assessment.
**Verification:** independently re-verified against v0.9.55 source on 2026-07-29 — all P0/P1 confirmed (two are *understated*), 2 findings refuted/resolved, 1 hygiene item intentional. Corrections are applied inline; see [Independent verification](#independent-verification) and the [VERIFY companion](./VERIFY-performance-audit-2026-07-29.md).
**Scope:** full `src/` tree (~380 TypeScript files, ~83k LOC)
**Method:** four parallel static audits (startup/bundle, state I/O, orchestration/concurrency, child-process IPC), followed by manual re-verification of every P0/P1 claim against source, plus an executable micro-benchmark for the top finding.

**Environment used for measurements:**

| Item | Value |
|------|-------|
| OS | Linux 6.17.0-35-generic |
| CPU cores (`nproc`) | 4 |
| Node | v25.x (`node --experimental-strip-types`) |
| `.crew/` on disk | 71 MB total — 48 MB worktrees, 17 MB state, 6.2 MB artifacts |
| Run directories in `.crew/state/runs/` | 84 |
| `dist/index.mjs` | 2,783,265 B (2.65 MB) |

> Every file:line reference below was verified in this audit. Claims that turned out to be
> false on inspection are recorded in [Verified non-issues](#verified-non-issues) so future
> audits do not re-investigate them.

---

## Contents

- [Executive summary](#executive-summary)
- [P0 — Severe](#p0--severe)
  - [P0-1 · `appendBoundedTail` is O(n²)](#p0-1--appendboundedtail-is-on²--main-thread-block-up-to-112-s)
  - [P0-2 · Event-log rotation gate is always true](#p0-2--event-log-rotation-gate-is-always-true)
  - [P0-3 · `saveCrewAgents` is a synchronous spin-lock](#p0-3--savecrewagents-is-a-synchronous-spin-lock-blocking-the-event-loop-up-to-60-s)
  - [P0-4 · Five `fsync()` calls per event append](#p0-4--five-fsync-calls-per-event-append)
- [P1 — High](#p1--high)
  - [P1-5 · ~65-93 sync syscalls per agent event](#p1-5--65-93-synchronous-syscalls-and-2-file-writes-per-agent-event)
  - [P1-6 · Payload redacted 3-4 times](#p1-6--the-same-payload-is-redacted-3-4-times-each-redaction-is-14-full-string-traversals)
  - [P1-7 · Worker cap acquired after task setup](#p1-7--global-worker-cap-is-acquired-after-all-per-task-setup-causing-over-dispatch-waste)
  - [P1-8 · `readEvents()` full parse for a tail](#p1-8--readevents-parses-the-entire-log-to-return-a-small-tail)
  - [P1-9 · 84 manifests re-parsed every 500 ms](#p1-9--run-enumeration-re-parses-all-84-manifests-every-500-ms-twice)
  - [P1-10 · Sequential `before_task_start` hooks](#p1-10--before_task_start-hooks-are-awaited-sequentially-on-the-pre-spawn-critical-path)
  - [P1-11 · Serialized git calls, no repo mutex](#p1-11--4-6-serialized-git-subprocesses-per-task-with-no-repo-level-mutex)
  - [P1-12 · Broker re-reads state per message](#p1-12--broker-re-reads-run-state-per-message-taskwaitstatus-polls-every-200-ms)
- [P2 — Medium](#p2--medium)
- [Hygiene / correctness side-findings](#hygiene--correctness-side-findings)
- [Verified non-issues](#verified-non-issues)
- [Remediation plan](#remediation-plan)
- [Appendix A — reproducible benchmark](#appendix-a--reproducible-benchmark)
- [Appendix B — measured concurrency values](#appendix-b--measured-concurrency-values)
- [Post-audit commit review](#post-audit-commit-review)
- [Independent verification](#independent-verification)

---

## Executive summary

pi-crew is architecturally sound (durable-first, clear layering, good use of lazy boundaries in
intent). The performance problems are concentrated in **per-item hot paths that were written as
if they were called once**: per-output-line, per-event, and per-task code that performs O(n)
work, blocking syscalls, or blocking sleeps.

Three findings are not micro-optimizations — they are genuine main-thread stalls that can
exceed the system's own liveness thresholds:

| ID | Finding | Measured / derived impact |
|----|---------|---------------------------|
| P0-1 | `appendBoundedTail` re-scans the whole capture buffer per line | **2.3 s** (ASCII) to **112 s** (multi-byte) of main-thread block per task |
| P0-2 | Rotation counter never increments on the async path | Full read + parse + rewrite of a 4 MB log **per event** |
| P0-3 | `saveCrewAgents` blocks via `Atomics.wait` | Up to **60 s** frozen event loop, called 9× in the scheduler |

P0-1 and P0-3 both block the single Node thread, which means they stall *every* concurrent
worker's stdout draining, all timers, and all heartbeats. Because the heartbeat staleness
threshold is 30 s (`src/config/defaults.ts:51`), a long enough stall causes healthy tasks to be
misclassified as dead — a correctness bug caused by a performance bug.

Counted across the audit: **4 P0** (P0-1..4), **8 P1** (P1-5..12), **18 P2** (P2-13..30), plus a
polling inventory, 8 hygiene/correctness side-findings, and 12 verified non-issues.

Independent re-verification against v0.9.55 (see [Independent verification](#independent-verification))
confirmed every P0 and P1 — two of them (P1-5, P1-6) are **understated**, i.e. worse than
originally reported — and refuted two findings: P2-25 (the `supervisor_contact` handler is
live, not dead) and the "290 stale `.js`" hygiene item (already cleaned at v0.9.55). One
hygiene item (missing `.unref()`) turned out to be deliberate design.

---

## P0 — Severe

### P0-1 · `appendBoundedTail` is O(n²) — main-thread block up to 112 s

**Files:** `src/runtime/child-pi-kill.ts:69`, `src/runtime/compact-stages/tail-capture-stage.ts:56-68`
**Call sites:** `src/runtime/child-pi.ts:603` (per stdout **line**), `src/runtime/child-pi.ts:916` (per stderr **chunk**)

The bounded-tail accumulator is rebuilt from scratch on every single output line:

```ts
// src/runtime/child-pi-kill.ts:69
export function appendBoundedTail(current: string, chunk: string, maxBytes = MAX_CAPTURE_BYTES): string {
	return new TailCaptureStage({
		maxBytes,
		marker: `[pi-crew captured output truncated to last ${Math.round(maxBytes / 1024)} KiB]`,
	}).apply(current + chunk);
}
```

```ts
// src/runtime/compact-stages/tail-capture-stage.ts:60-67
if (Buffer.byteLength(text, "utf-8") <= this.maxBytes) return text;
let tail = text.slice(Math.max(0, text.length - this.maxBytes));
while (Buffer.byteLength(tail, "utf-8") > this.maxBytes) tail = tail.slice(0, -1);
```

Three defects compound:

1. **`Buffer.byteLength(text)` is O(n) and runs on every line.** The cap is
   `maxCaptureBytes: 512 * 1024` (`src/config/defaults.ts:28`), so once the buffer is full
   every line re-scans 512 KB. A task emitting 5,000 lines performs ~2.5 GB of byte-length
   scanning purely to enforce a bound.
2. **`while (...) tail = tail.slice(0, -1)` is O(n) per dropped character.** For multi-byte
   output (Vietnamese, CJK, emoji — 3 bytes/char) the initial `slice` keeps ~512 K *characters*
   ≈ 1.5 MB, so the loop must drop ~340 K characters, each iteration re-scanning ~512 KB.
3. **A fresh `TailCaptureStage` plus a template-literal marker is allocated per line**, even on
   the under-cap fast path.

#### Measured

Benchmark source in [Appendix A](#appendix-a--reproducible-benchmark). `current` is the shipped
algorithm extracted verbatim; `proposed` is the segment-ring fix described below.

| Workload | Current | Proposed | Speedup |
|----------|--------:|---------:|--------:|
| 5,000 lines × 200 B (ASCII) | 2,344 ms | 4.0 ms | **583×** |
| 3,000 lines × 200 chars (CJK / Vietnamese) | 112,138 ms | 3.9 ms | **29,052×** |

Both produce an equivalent ~512 KB bounded tail. The 112 s figure is wall-clock time with the
event loop fully blocked.

#### Why this is worse than it looks

`stdout.on("data")` (`src/runtime/child-pi.ts:857`) is the highest-frequency callback in the
system. While it is blocked:

- no other worker's stdout is drained (all workers share one Node thread),
- no timer fires, so the 1,000 ms `persistHeartbeat` throttle (`task-runner/child-executor.ts:263`)
  cannot run,
- `DEFAULT_LOCKS.staleMs = 30_000` (`src/config/defaults.ts:51`) elapses, so the stalled task
  is eligible to be reaped as stale.

The existing backpressure valve does not help: `src/runtime/child-pi.ts:848-880` pauses stdout
above a 256 KB watermark for a fixed 50 ms then resets the counter unconditionally, so it is a
fixed duty cycle, not real backpressure, and it bounds bytes rather than per-line CPU.

#### Fix

Replace the string accumulator with a segment ring plus a running byte counter:

```ts
class BoundedTail {
	#segs: string[] = [];
	#bytes = 0;
	#dropped = false;
	constructor(private readonly maxBytes = MAX_CAPTURE_BYTES) {}

	push(chunk: string): void {
		this.#segs.push(chunk);
		this.#bytes += Buffer.byteLength(chunk, "utf-8");   // O(chunk), not O(total)
		while (this.#bytes > this.maxBytes && this.#segs.length > 1) {
			this.#bytes -= Buffer.byteLength(this.#segs.shift() as string, "utf-8");
			this.#dropped = true;
		}
	}

	value(): string { /* join + optional marker */ }
}
```

Keep `appendBoundedTail` as a thin deprecated wrapper for any external caller, and hoist the
`TailCaptureStage` instances into a `Map<maxBytes, TailCaptureStage>` so the marker string is
not re-allocated. If exact byte-precise truncation is still wanted at the boundary segment, do
it once in `value()` using `Buffer.from(seg).subarray(-n)` plus a ≤3-byte UTF-8 boundary scan
instead of a per-character loop.

**Regression guard:** add `test/bench/bounded-tail.bench.ts` asserting 5,000 CJK lines complete
in under ~50 ms, and wire it into the existing `npm run bench:check` gate.

---

### P0-2 · Event-log rotation gate is always true

**File:** `src/state/event-log.ts:72, 767, 1103, 1104`

```
72:   let appendCounter = 0;
767:  if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {   // ASYNC path
1103: appendCounter++;                                               // ONLY the sync path
1104: if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {   // SYNC path
```

`appendCounter++` exists at exactly one place, line 1103, inside the synchronous
`appendEventInsideLock`. Roughly 50 call sites in `src/runtime/task-runner/*`,
`src/runtime/pipeline-runner.ts`, `src/runtime/team-runner.ts` and `src/runtime/adaptive-plan.ts`
append exclusively through `appendEventAsync` / `appendEventFireAndForget`. In those processes
`appendCounter` stays `0` forever, and `0 % 100 === 0` is **always true**.

Consequences per single appended event:

- Always: `needsRotation()` → `fs.existsSync` + `fs.statSync`
  (`src/state/event-log-rotation.ts:32-34`).
- Once the log crosses `maxFileSizeBytes = 4 * 1024 * 1024` (`event-log-rotation.ts:17`) or the
  ~50,000-event estimate: `prepareCompaction()` → `readEvents()` = full `readFileSync` +
  `split("\n")` + `JSON.parse` of the entire log, then `JSON.stringify` of the 1,000 retained
  events, then `applyCompactionUnlocked()` → `atomicWriteFile` **plus a second full
  `readEvents()`** (`event-log-rotation.ts:103` and `:136`).

That is roughly **two full parses and one full rewrite of a 4 MB file per appended event**, on
a path that fires several times per task transition.

A second, independent defect: `appendCounter` is a **single module-global** shared across all
`eventsPath` values, so even on the sync path the `% 100` sampling is mis-attributed across
concurrent runs.

#### Fix

```ts
const appendCounters = new Map<string, number>();

function shouldCheckRotation(eventsPath: string): boolean {
	const next = (appendCounters.get(eventsPath) ?? 0) + 1;
	appendCounters.set(eventsPath, next);
	return next % 100 === 0;
}
```

Call it from **all three** append paths (`doAppendUnderLock`, `appendEventInsideLock`,
`appendEventBatchInsideLock`). Bound the map (LRU or delete on run completion) so it does not
grow with run count.

**Regression guard:** unit test that appends 250 events via `appendEventAsync` to a stubbed
path and asserts `needsRotation` was consulted exactly twice.

---

### P0-3 · `saveCrewAgents` is a synchronous spin-lock, blocking the event loop up to 60 s

**File:** `src/runtime/crew-agent-records.ts:108-141`

```ts
function withAgentsLock<T>(manifest: TeamRunManifest, fn: () => T): T {
	const filePath = agentsLockPath(manifest);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	let attempt = 0;
	const deadline = Date.now() + AGENTS_LOCK_STALE_MS * 2;   // 30_000 * 2 = 60 s
	while (true) {
		try { /* O_CREAT|O_EXCL acquire */ break; }
		catch (error) {
			...
			sleepSync(Math.min(250, 25 * 2 ** attempt));       // <-- blocks the main thread
			attempt += 1;
		}
	}
	...
}
```

`sleepSync` is `Atomics.wait` on a `SharedArrayBuffer` (`src/utils/sleep.ts`). Its own docstring
states the constraint that is being violated:

```
 * WARNING: This blocks the Node.js main thread. Only use in sync I/O paths
 * where blocking is acceptable (lock acquisition, rename retry).
 * NOT safe to call from Pi extension async code paths.
```

It is nonetheless called synchronously (no `await`, no worker thread) from **nine** sites in the
scheduler:

| File | Lines |
|------|-------|
| `src/runtime/team-runner.ts` | 928, 1135, 1301, 1307, 2156, 2315, 2335, 2353, **2358** |
| `src/runtime/task-runner/pre-execution.ts` | 159 (via `upsertCrewAgent`) |

Line **2358** sits inside the main `while` loop, so it executes once per merged task. Steady
state under contention is 250 ms blocks; worst case is a 60 s fully frozen event loop, which
stalls every concurrent worker and trips the 30 s heartbeat threshold.

#### Fix

1. Convert `withAgentsLock` to an async lock. The project already has the primitive:
   `src/runtime/workspace-lock.ts` (`sleepOrAbort`, `DEFAULT_LOCK_POLL_MS`).
2. Switch the in-loop, non-terminal writes (`team-runner.ts:1301, 1307, 2358`) to the existing
   `saveCrewAgentsCoalesced` (`src/runtime/crew-agent-records.ts:352`,
   `AGENT_COALESCE_MS = 250`), which is already written and unused on these paths.
3. Keep the synchronous variant only for exit/crash handlers, where blocking is genuinely
   acceptable, and add a lint rule or code comment marking `sleepSync` as forbidden outside
   `process.on("exit")`-class handlers.

---

### P0-4 · Five `fsync()` calls per event append

**File:** `src/state/event-log.ts:504, 741-743, 762`

Async append path, per event:

```
504: atomicWriteFile(pidFile, String(process.pid));   // lock pid file: fsync(data) + fsync(dir)
741: const fd = await fs.promises.open(eventsPath, "a");
742: await fd.appendFile(line, "utf-8");
743: await fd.sync();                                 // fsync of the log, unconditional
762: persistSequence(eventsPath, seq);                // -> atomicWriteFile(.seq): fsync + fsync(dir)
```

`atomicWriteFile` fsyncs both the data file and the parent directory
(`src/state/atomic-write.ts:619, 648-651`), and `durability` defaults to `"full"` (`:546-549`).
Total: 2 (pid file) + 1 (log) + 2 (`.seq` sidecar) = **5 fsyncs per event**.

Note the asymmetry: the **sync** path already implements the right optimization — it skips the
data fsync for non-terminal events (`event-log.ts:1064-1078`, comment "F3a: skip data fsync for
non-terminal events") — but the **async** path fsyncs unconditionally at line 743.

Additionally, both `atomicWriteFile` calls in this path are the **synchronous** variant, so
`appendEventAsync` still blocks the event loop for ~4 fsyncs despite its name.

#### Fix

1. Write the lock pid file with `{ durability: "best-effort" }` — it is disposable state whose
   loss is already handled by the stale-lock reaper. Removes 2 fsyncs/event.
2. Mirror the F3a rule in the async path: `if (TERMINAL_EVENT_TYPES.has(fullEvent.type)) await fd.sync();`
3. Write `.seq` best-effort, or only on terminal events. `src/state/event-reconstructor.ts`
   already tolerates an inconsistent tail (documented at `event-log.ts:1065-1071`).

---

## P1 — High

### P1-5 · ~65-93 synchronous syscalls and 2 file writes per agent event

**File:** `src/runtime/crew-agent-records.ts:467-483`
**Called from:** `src/runtime/task-runner/child-executor.ts:452`, unthrottled, per JSON event

```ts
export function appendCrewAgentEvent(manifest, taskId, event): void {
	ensureAgentStateDir(manifest, taskId);
	const filePath = agentStateFile(manifest, taskId, "events.jsonl");   // calls ensureAgentStateDir AGAIN
	const seq = nextAgentEventSeq(filePath);
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ seq, time: ..., event }))}\n`, "utf-8");
	const stat = fs.statSync(filePath);
	setAgentEventSeqCache(...);
	writeSeqToSidecar(filePath, seq);   // fs.writeFileSync — a SECOND file write
}
```

Syscall breakdown per event:

| Step | Syscalls |
|------|---------:|
| `ensureAgentStateDir` (`:29-38`) — 2 `mkdirSync`, 2 `lstatSync`, `resolveRealContainedPath` | 7 |
| `agentStateFile` → `ensureAgentStateDir` **again** + `safeExistingAgentFile` | 12 |
| `nextAgentEventSeq` (`:424-436`) — `existsSync` + `statSync` | 2 |
| `appendFileSync` (open+write+close) | 3 |
| `statSync` | 1 |
| `writeSeqToSidecar` → `writeFileSync` | 3 |
| **Total (direct calls only)** | **≈28** |

`resolveRealContainedPath` (`src/utils/safe-paths.ts:194, 229, 232`) is itself
`openSync(O_NOFOLLOW)` + `fstatSync` + `realpathSync` plus a **full ancestor walk** — one
`lstat` per path component per level, ~20 syscalls per invocation.

> **Verification (v0.9.55): the ≈28 total above is understated.** The table counts each
> `resolveRealContainedPath` as ~3 syscalls, but with the ancestor walk it is ~20. At ~3 such
> calls per event the real figure is **≈65-93 syscalls/event**, so a 300-event task performs
> ~20,000-28,000 blocking syscalls and 600 writes — for a path that cannot change during the
> task. The fix is unchanged (memoize the validated path per task).

The same pattern hits per **output line** via `appendCrewAgentOutput` (`:555-559`):
`ensureAgentStateDir` (7) + `agentStateFile` (12) + `redactSecretString` + `appendFileSync` (3)
≈ **22 sync syscalls per line**.

And per **transcript line**, `appendTranscript` (`src/runtime/child-pi-transcript.ts:49-56`)
calls `resolveRealContainedPath` again — the *write* is nicely batched at 50 ms (`:38-40, 60-67`)
but the path validation is not, so batching saves the write and keeps the syscalls.

**Fix:** validate and memoize the agent file path and transcript path **once per task**
(`transcriptPath` is fixed at `child-executor.ts:317`); keep `seq` purely in memory and flush the
sidecar on task end; batch `events.jsonl` appends behind a 50 ms timer using the same mechanism
`child-pi-transcript.ts` already implements.

---

### P1-6 · The same payload is redacted 3-4 times; each redaction is ~14 full-string traversals

**File:** `src/utils/redaction.ts:236-274` (`redactSecretString`)

Per string, in order:

1. `result.split("-----BEGIN")` — full pass plus allocations (`:247`)
2. `PEM_PRIVATE_KEY_PATTERN` replace (`:249`)
3. `redactAuthHeader` → `line.toLowerCase()` — full string copy (`:196`)
4. `redactBearerTokens` → `line.toUpperCase()` full copy, then a **char-by-char loop**
   `result.push(line[i])` with a per-character regex test, then `join("")` (`:214-234`)
5-10. six more `.replace()` regex passes: JWT, GitHub PAT, AWS, Slack, Google, Stripe (`:266-272`)
11. `redactInlineSecrets` — another char-by-char loop plus array build plus join (`:295-360`)

That is **~14 full-string traversals** (the 11 passes above plus the `toLowerCase` /
`toUpperCase` whole-string copies and the final `join` — the verified count is ~14, not 11)
**and 2 single-character array builds** per string field. For a 16 KB assistant message, step 4
alone allocates ~16,000 single-character strings.

The same payload then flows through this **four separate times**:

| # | Sink | Call site |
|---|------|-----------|
| 1 | transcript | `src/runtime/child-pi-transcript.ts:91` — `redactJsonLine(line)`, which also re-`JSON.parse`s and re-`JSON.stringify`s a line already parsed in `emitLine` |
| 2 | agent `events.jsonl` | `src/runtime/crew-agent-records.ts:471` |
| 3 | agent `output.log` | `src/runtime/crew-agent-records.ts:558` |
| 4 | run `events.jsonl` | `src/state/event-log.ts:723` (async), `:1063` (sync) |

**Fix:**

1. Redact **once**, at the boundary where the event is first materialized
   (`ChildPiLineObserver.emitLine` in `src/runtime/child-pi-streams.ts`), cache the redacted
   string on the event object, and have all four sinks consume it.
2. Add a cheap pre-filter so the ~99 % clean case costs one sweep instead of ~14: bail out of
   `redactSecretString` unless the string contains one of `-----BEGIN`, `eyJ`, `gh`, `AKIA`,
   `xox`, `AIza`, `sk_live_`, `Bearer`, `=`, `:`.
3. Rewrite `redactBearerTokens` / `redactInlineSecrets` to slice spans instead of pushing
   per character.

---

### P1-7 · Global worker cap is acquired *after* all per-task setup, causing over-dispatch waste

**Files:** `src/runtime/run-worker.ts:72-78`, `src/runtime/task-runner/pre-execution.ts:103-289`,
`src/runtime/concurrency.ts:47`, `src/runtime/global-worker-cap.ts:41-42`

Two independent, uncoordinated limiters gate every spawn:

- **Scheduler cap** (`concurrency.ts:47`): `Math.min(requested, hardCap)`, `hardCap: 8`
  (`src/config/defaults.ts:55`); the `implementation` workflow requests **4**.
- **Global worker cap** (`global-worker-cap.ts:41-42`): `Math.max(2, os.cpus().length - 2)`.

On the audit machine (`nproc` = 4) the global cap is **2** while the scheduler dispatches **4**.
The scheduler cannot observe the semaphore — `resolveBatchConcurrency` never consults
`getWorkerCapCapacity()` — so it over-dispatches by design.

The slot is then acquired at the very **end** of task setup:

```ts
// src/runtime/run-worker.ts:73-77
const { cap = true, ...childPiInput } = input;
if (cap) return withWorkerSlot(() => runChildPi(childPiInput));
```

Everything below runs *before* that line, for tasks that will merely queue:

| Order | Operation | Location |
|------:|-----------|----------|
| 1 | `await prepareTaskWorkspaceAsync(...)` — 4-6 `git` subprocesses incl. `git worktree add` (full tree checkout) | `pre-execution.ts:103` |
| 2 | `status: "running"`, `createWorkerHeartbeat(...)`, claim, control reservation | `pre-execution.ts:129-135` |
| 3 | `persistSingleTaskUpdate` + `checkpointTask` (sync writes) | `pre-execution.ts:157-158` |
| 4 | `upsertCrewAgent` (sync write, see P0-3) | `pre-execution.ts:159` |
| 5 | `await appendEventAsync({type:"task.started"})` | `pre-execution.ts:160-174` |
| 6 | `await renderTaskPrompt(...)` + prompt artifact write | `pre-execution.ts:289` |
| 7 | **only now** the semaphore is touched | `child-executor.ts:395` → `run-worker.ts:75` |

Result on a 4-core machine: two worktrees are created and two agents are reported `running`
with live heartbeats for tasks that have not spawned a process. Combined with the 30 s stale
threshold, a queued task can be reaped as dead.

Also relevant: `src/runtime/semaphore.ts:16-57` has `static readonly MAX_QUEUE = 10_000` and
**throws** `"Semaphore queue full"` past that — a hard failure rather than backpressure. The
queue is plain FIFO with no priority, so a long `execute` worker can hold a slot while a
3-turn `verify` waits behind it.

**Fix:** feed the semaphore's available capacity into the scheduler so it never over-dispatches:

```ts
// src/runtime/concurrency.ts:47
const maxConcurrent = input.allowUnboundedConcurrency
	? requested
	: Math.min(requested, hardCap, getWorkerCapCapacity());
```

Optionally also move `withWorkerSlot` to the top of `dispatchUnit` (`team-runner.ts:1443`) so
worktree creation happens under the slot. Replace the `MAX_QUEUE` throw with a rejected promise
carrying a typed error.

---

### P1-8 · `readEvents()` parses the entire log to return a small tail

**Primary:** `src/extension/team-tool/status.ts:61-80`

```ts
const allEvents = readEvents(manifest.eventsPath);
const events = allEvents.slice(-8);
```

`readEvents` (`src/state/event-log.ts:1342-1357`) is `existsSync` + full `readFileSync` +
`.split("\n")` + `.map(trim)` + `.filter(Boolean)` + `.flatMap(JSON.parse)` — four full-length
intermediate arrays — to render **eight** events. Rotation allows the log to reach 4 MB
(~50,000 events) before compaction, with a 50 MB hard cap
(`event-log.ts:68 MAX_EVENTS_BYTES`). An observed run already has a 55 KB `events.jsonl`.

`status.ts` then re-scans `allEvents` twice more: `attentionByTask` filters all events
(`:63-65`), and `allEvents.some(...)` runs **inside** the group-join loop (`:80`), giving
O(events × messages).

Same antipattern (full parse to read a bounded tail):

| File:line | Call |
|-----------|------|
| `src/runtime/attention-events.ts:12` | `readEvents(...).slice(-200)` |
| `src/runtime/diagnostic-export.ts:95` | `readEvents(...).slice(-200)` |
| `src/extension/team-tool/inspect.ts:17` | `readEvents(...)` |
| `src/extension/team-tool/api.ts:330` | `readEvents(...)` |
| `src/extension/team-tool/run.ts:111` | `readEvents(...)` |
| `src/extension/async-notifier.ts:90` | `readEvents(...)` |
| `src/extension/run-export.ts:40` | `readEvents(...)` |

**Fix:** the bounded-tail reader already exists and is correct —
`readJsonlTail` (`src/utils/incremental-reader.ts:32-118`) and `readEventsCursor`
(`event-log.ts:1425-1440`). Only three call sites use them (`api.ts:325`, `crew-broker.ts:891`,
`run-event-bus.ts:172`) versus **eleven** that use `readEvents` (verified count; the table above
lists the main ones). Migrate the tail readers to
`readJsonlTail<TeamEvent>(path, 64 * 1024)`. In `status.ts`, compute `attentionByTask` in a
single pass over that tail and hoist the group-join `some()` into a pre-built `Set<requestId>`.

Note there is also **no seq → byte-offset index**, so `sinceSeq` filtering parses then
`.filter()`s (`event-log.ts:1402, 1445`). `sequenceCache` (`:70`) caches only the sequence
number, never content.

---

### P1-9 · Run enumeration re-parses all 84 manifests every 500 ms, twice

**File:** `src/runtime/manifest-cache.ts:46, 221-243, 299-325`

```
46:  const DEFAULT_TTL_MS = 500;
221-243 (list):       roots.flatMap(collectRoots) -> per run: parseManifestIfChanged
299-325 (listActive): the SAME full scan again, into a separate cache
```

Per run per scan, `parseManifestIfChanged` (`:103-121`) does `statSync`, then
`validateManifestForRoot` (`:78-101`) does `resolveContainedRelativePath` ×2,
`sameFilesystemPath` ×4, `existsSync(artifactsRoot)`, `lstatSync(artifactsRoot)` and
`resolveRealContainedPath`. `manifestPathForRun` (`:53-60`) adds another
`resolveRealContainedPath`. That is **~10-15 syscalls per run per scan** — roughly **1,000
syscalls per `list()`** at 84 runs — and `list()` plus `listActive()` are two independent full
scans. Observed `manifest.json` sizes reach 23,617 B, so a full scan can parse ~2 MB of JSON.

The file's own comment at `:212-219` acknowledges "a full FS scan + JSON.parse of all manifests
on every TTL expiry (default 500ms)".

The backing cache is ineffective at this scale: `src/utils/scan-cache.ts:69-79` sets
`expireAtMs` once when the **bucket** is created and never extends it, with `#ttlMs = 1000`
(`:41`), so the whole `manifests` bucket is discarded every second; `#maxEntries = 100`
(`:42`) with **FIFO** eviction (`:74-78`, `b.entries.keys().next().value`) thrashes against 84
project runs plus user-root runs.

A second enumerator duplicates the work: `src/extension/run-index.ts:22-73` (`collectRuns`) does
`readdirSync` + per-run `resolveRealContainedPath` (`:44`) + `sharedScanCache.readAndCache` +
`existsSync(manifest.cwd)` (`:50`); `listRuns` calls it for **both** roots plus
`collectActiveRuns()` (`:97-98`).

**Fix:** (a) have `listActive()` filter the `list()` result instead of re-scanning; (b) skip
`validateManifestForRoot`'s path checks when `mtimeMs` + `size` are unchanged, since path
validity cannot change if the file did not; (c) make `SharedScanCache` per-entry TTL with real
LRU and raise `maxEntries` above the run count; (d) have `collectRuns` sort and slice on
`Dirent` names and read manifests lazily for the top-N (it already accepts `maxEntries`, but
`listRuns` passes `undefined`).

---

### P1-10 · `before_task_start` hooks are awaited sequentially on the pre-spawn critical path

**File:** `src/runtime/team-runner.ts:1364-1382`

```ts
for (const task of readyBatch) {
	const taskReport = await executeHook("before_task_start", { ... });
	...
}
```

N sequential hook round-trips (each potentially a subprocess) immediately before the batch is
spawned. This is the largest trivially removable latency on the path to the first agent.

Other sequential-await loops over independent work:

| File:line | Loop | Suggested fix |
|-----------|------|---------------|
| `team-runner.ts:1062-1069` | `for (const taskId of cancelledTaskIds) await appendEventAsync(...)` | `Promise.all` |
| `team-runner.ts:1254-1268` | `for (const group of coalescedGroups) await appendEventAsync(...)` — informational only | `appendEventBuffered` (already used at `:1347`) |
| `team-runner.ts:1794-1875` | `advanceWorkflowPhases` — `await appendEventAsync` per phase | buffer, await once |
| `team-runner.ts:1916-1930` | `for (const violatorId of ...fairShareViolators) await appendEventAsync(...)` | `Promise.all` |

**Fix:** `await Promise.all(readyBatch.map((t) => executeHook("before_task_start", ...)))`, then
apply the skip mutations from the resolved reports.

Related: `src/extension/team-tool/parallel-dispatch.ts:64-67` uses fixed-window batching
(`batchStart += concurrency`), so each batch waits for its slowest member. `mapConcurrent`
(`src/runtime/parallel-utils.ts:45`) already implements a sliding pool.

---

### P1-11 · 4-6 serialized `git` subprocesses per task, with no repo-level mutex

**File:** `src/worktree/worktree-manager.ts:825-982`

Sequentially awaited per task:

```
833  await findGitRootAsync(repoRoot)                            // cached (_gitRootCache)
835  await assertCleanLeaderAsync(repoRoot)                      // cached (_cleanLeaderCache)
855  await gitAsync(repoRoot, ["worktree","list","--porcelain"]) // NOT cached — O(N) invocations
924  await pruneStaleWorktreesAsync(repoRoot)                    // `git worktree prune` — NOT cached, WRITES the repo
925  await branchExistsAsync(repoRoot, branch)                   // 1-2 more invocations
929/938 await gitAsync(repoRoot, ["worktree","add", ...])        // full tree checkout
```

Both `worktree list --porcelain` and `worktree prune` are **run-scoped, not task-scoped**, so
running them per task is pure waste.

The reuse path is worse: `:883` `rev-parse --abbrev-ref HEAD`, `:892` `status --porcelain`,
`:901-902` `checkout -- .` + `clean -fd`, then `_cleanLeaderCache.delete(repoRoot)` at **:915**
deliberately invalidates the cache so **:921** re-runs a full `git status --porcelain` — one
whole-repo status scan **per reused task**.

Because `dispatchUnit` promises start concurrently (`team-runner.ts:1661-1668`), N tasks race
`git worktree prune` and `git worktree add` against the same `.git` with **no mutex**,
contending on git's internal lock files.

Worktrees *are* reused when present (`:879` `if (worktreeExists)` → `reused: true`), but the key
is `.crew/worktrees/<runId>/<taskId>` — per run — so every new run pays a fresh
`git worktree add` per task. There is no cross-run pool.

Dead code: `clearGitRootCache()` (`:153`) and `clearCleanLeaderCache()` (`:169`) are exported
but never called anywhere in `src/`, so `_gitRootCache` grows unbounded for the session.

**Fix:** hoist `worktree list --porcelain` and `worktree prune` to once per run; add a
per-`repoRoot` async mutex around the `worktree add` critical section; memoize the reuse-path
`status` instead of the delete-then-recheck; wire up or delete the two cache-clear functions.
Consider a cross-run worktree pool keyed by `(repoRoot, branch)`.

---

### P1-12 · Broker re-reads run state per message; `task.waitStatus` polls every 200 ms

**File:** `src/runtime/crew-broker.ts:764, 833, 877, 925, 1039, 1110, 1189`

`loadRunManifestById(cwd, conn.runId)` is called in `handleMsgSend` (`:764`), `handleMsgInbox`
(`:833`), `handleEventsSince` (`:877`), `handleEventsSubscribe` (`:925`), in the two steer paths
(`:1110`, `:1189`), and in the `task.waitStatus` poll tick (`:1039`) — **7 call sites in all**
(verified; the original count of 5 missed the steer paths).

`loadRunManifestById` (`src/state/state-store.ts:527-555`) performs the containment check and
both `statSync` calls **before** consulting its own cache:

```
527: const stateRoot = resolveRunStateRoot(cwd, runId);   // FIRST line — realpath + openSync(O_NOFOLLOW) + fstatSync
530: statManifestWithWindowsRetry(manifestPath)           // statSync
543: statSync(tasksPath)
548-555: ...only now compare against manifestCache (MANIFEST_CACHE_TTL_MS = 60_000)
```

So a cache **hit** still costs ~8-12 syscalls. Worse, `tasks.json` is rewritten every 500 ms by
the task runner, so the mtime check fails constantly and both files are re-read and re-parsed.

`handleTaskWaitStatus` (`:1013-1052`) polls at a fixed `interval = 200` for up to 60 s → up to
300 × (2 stats + likely 2 full JSON parses) **per waiting connection**. With 8 concurrent
workers waiting, ~2,400 manifest loads.

Compounding this, `handleStatus` calls `locateRunCwd` first
(`src/extension/team-tool/status.ts:24`), and `locateRunCwd`
(`src/extension/team-tool.ts:545-572`) calls `loadRunManifestById` for `baseCwd` **and then for
every child directory** until a hit — after which `handleStatus` calls it **again** at `:26`.

`handleMsgInbox` (`:838-842`) also reads the entire mailbox, `.filter()`s, then
`.slice(offset, offset + limit)` — paging through N messages is O(N²).

**Fix:** memoize `resolveRunStateRoot(cwd, runId)` in a TTL map (the containment verdict cannot
change unless the directory is replaced); cache `{manifest, eventsPath}` on the
`ServerConnection` after `hello`, since `runId` is fixed for the connection's lifetime, and
invalidate via the existing `runEventBus` generation counter; replace the 200 ms
`task.waitStatus` poll with a `runEventBus` subscription on `task.status`; give `readMailbox` an
`{offset, limit}` parameter; add a `runId → cwd` memo for `locateRunCwd`.

---

## P2 — Medium

### Startup and bundle

| ID | Finding | Evidence |
|----|---------|----------|
| P2-13 | `primePeerDep()` unconditionally runs `execSync("npm root -g")` (~200 ms, **blocking**) at every registration. `peerDepResolutionBases()` builds the whole base list eagerly, so the probe fires even though base #1 (`fileURLToPath(import.meta.url)`) succeeds in a normal co-located install. Memoized per-process, so the cost is per cold start, not per call. | `src/extension/register.ts:60`; `src/runtime/peer-dep.ts:82, 127-132, 213, 238-245`; `src/runtime/pi-spawn.ts:153-171` (own comment: "one-time ~200ms cost") |
| P2-14 | **`startRuntimeWarmup()` is a no-op in bundle mode** (the default). `import(new URL(spec, import.meta.url).href)` is opaque to esbuild and survives verbatim into the bundle (`dist/index.mjs`, verified at `:3106-3149` in the v0.9.55 build), where `import.meta.url` is `<pkg>/dist/index.mjs`, so all 9 specifiers resolve to `<pkg>/dist/*.ts` — none of which exist (`dist/` contains only `index.mjs`, `index.mjs.map`, `build-meta.json`). Every resolution throws ENOENT and is swallowed; `getRuntimeWarmupStatus()` falsely reports `completed: true`; `awaitRuntimeWarmup()` — the documented cold-start-race guard gating every subagent spawn — provides **zero** protection. | `src/runtime/runtime-warmup.ts:52-93` |
| P2-15 | `// LAZY:` markers defeated by static imports of the same modules, and the lint gate cannot see it. `registration/runtime-cleanup.ts:30-31` static-imports `lifecycle.ts` / `observability.ts` (lazily imported at `lazy-configurers.ts:65, 88`); `lazy-configurers.ts:25` and `lifecycle-handlers.ts:24` static-import `runtime/crash-recovery.ts` (lazily imported at `crash-recovery-cache.ts:36`). All three are eager at `dist/index.mjs:72297, 72369, 74559, 74560`. The doc comments claiming deferred cost are factually false. | `scripts/check-lazy-imports.mjs` has no rule for this |
| P2-16 | Bundle is **2.65 MB against a 3.5 MB budget** (75.8 % utilization) with no code splitting, so all of it is parsed before anything runs. `build-bundle.mjs:31-46` never sets `splitting: true`; internal `await import()` becomes `Promise.resolve().then(() => (init_x(), x_exports))` in the same file. 353-422 module top-levels execute at import (verified count; the original "118" was under-counted but non-material). The total-size budget structurally cannot detect an eager/lazy regression. | `scripts/build-bundle.mjs:31-46`; `scripts/check-bundle-size.mjs:20` |
| P2-17 | `deployBundledThemes()` performs ~25 synchronous fs ops on every registration for almost always zero work: `existsSync` + `readdirSync` + `mkdirSync` + per-file `readFileSync(src)` **and** `readFileSync(dst)` across 11 theme files (~44 KB read), and the content compare at `:57` normally writes nothing (idempotent). | `src/extension/register.ts:61`; `src/ui/deploy-bundled-themes.ts:38-70` |
| P2-18 | `buildRegistrationContext` synchronously builds two caches, walks for the repo root, and installs fs watchers at register time. `findRepoRoot` does `realpathSync` then `hasProjectMarker` per ancestor — the file's own comment says "14 existsSync calls per ancestor level"; the verified actual is **15 markers per level** (7 directory + 8 file). `manifest-cache.ts:338-353` installs an `fs.watch` per root at construction. | `src/extension/register.ts:63`; `src/extension/registration/context-builder.ts:47-48, 83`; `src/utils/paths.ts:108, 163, 205-221` |
| P2-19 | `loadConfig()` runs at least twice on the register path, each doing 4-6 sync fs ops plus a repo-root walk (up to 4 config files via `readOptionalConfig` = `existsSync` + `statSync` + `readFileSync` each). | `src/extension/register.ts:99`; `src/extension/crew-vibes/index.ts:61`; `src/config/config.ts:1082-1200` |
| P2-20 | Module-scope process handlers and a timer install at bundle import: 5 `process.on` in `src/state/event-log.ts:1291-1331` (including a global **`uncaughtException`** handler installed for every Pi session regardless of pi-crew use), 3 more in `src/state/atomic-write.ts:948-950`, a `setInterval(..., 60_000)` zombie reaper at `src/runtime/child-pi-kill.ts:33-41` (eager even when no child is ever spawned), `new PowerbarPublisher()` at `src/ui/powerbar-publisher.ts:428`, and two module-scope `new AsyncLocalStorage(...)` at `src/state/locks.ts:445, 465`. | — |
| P2-21 | 470 KB of esbuild metafile (`dist/build-meta.json`) is shipped to npm. Pure dev artifact. Still in `files` as of v0.9.55. | `package.json:35` |

### Runtime and I/O

| ID | Finding | Evidence |
|----|---------|----------|
| P2-22 | `NdjsonDecoder.push` does `Buffer.concat` per chunk → O(n²/chunk) frame assembly. A 256 KB frame (`MAX_BROKER_FRAME_BYTES`) arriving in 64 KB chunks copies 64+128+192+256 KB ≈ 640 KB. The `length === 0` fast path is good; frame extraction correctly uses `subarray`. **Fix:** keep a `Buffer[]` plus running length, scan for `0x0a` in the newest chunk only, concat once when a frame completes. | `src/utils/ndjson.ts:88` |
| P2-23 | `observe()` re-splits the entire buffer with a regex on every chunk: `this.buffer.split(/\r?\n/)` re-scans the un-terminated remainder carried from the previous chunk. One long JSON line delivered in 64 KB chunks up to the 1 MB cap is re-scanned ~16 times ≈ 8 MB of regex scanning to assemble one line, allocating an array of every line each time. Secondary bug: `MAX_LINE_BUFFER_BYTES` is documented as bytes but compared against `buffer.length` (chars), so the real cap is up to 4 MB for multi-byte output. **Fix:** forward-scan with `indexOf("\n", cursor)` — the pattern already used correctly in `src/utils/incremental-reader.ts:176-186`. | `src/runtime/child-pi-streams.ts:220-236` |
| P2-24 | `atomicWriteJson` pretty-prints machine-read state (`JSON.stringify(value, null, 2)`), inflating every write ~30-40 %. Observed: `tasks.json` 42,362 B, `manifest.json` 23,617 B, `agents.json` 22,751 B for one run — and `tasks.json` is rewritten **in full** on every task status change, so each task tick is a 42 KB serialize + write + 2 fsync. | `src/state/atomic-write.ts:783-785, 865`; `src/state/state-store.ts:361-405` |
| P2-25 | ~~Dead supervisor-contact parse~~ **REFUTED on re-verification (v0.9.55).** The original premise was wrong: the call site passes the **raw stdout `line`** (`child-executor.ts:441`), not `compact.displayLine`, and child Pi emits `{"type":"supervisor_contact",...}` NDJSON — so the handler is **live**, not dead. The real (minor) cost is a thrown-and-caught `JSON.parse` on each non-JSON stdout line. **Optional micro-fix:** gate on `line.startsWith("{")` before parsing. Do not delete the call. | `src/runtime/task-runner/child-executor.ts:437-449`; `src/runtime/supervisor-contact.ts:40-47` |
| P2-26 | No throttling or batching between child output and event emission. Every stdout chunk propagates immediately and synchronously through `emitLine` → `child-executor.ts:450/438` → `runEventBus.emit` (`child-executor.ts:503`) and the broker's `events.subscribe` fanout (`crew-broker.ts:945-956`), with no coalescing at any hop. (What *is* correctly throttled: `persistSingleTaskUpdate` 500 ms, `persistHeartbeat` 1000 ms, `upsertCrewAgent` 500 ms, `task.progress` 1000 ms, transcript writes 50 ms.) **Fix:** coalesce the bus emit and broker fanout on a ~100 ms tick carrying the latest snapshot. | — |
| P2-27 | Per-spawn filesystem discovery is not memoized. `createSafeTempDir` walks the full ancestor chain with `lstatSync` **three separate times** (`:118-135`, `:155-172`, `:222-240`) ≈ 25 syscalls per spawn. `resolvePiCliScript()` is **not** memoized (only `resolveNpmGlobalRoot` is) and calls `resolvePiPackageRoot()` twice, each walking up from `argv[1]` doing `readFileSync` + `JSON.parse` of `package.json` at every level. `sanitizeEnvSecrets` runs `matchers.some(fn => fn(key))` for every env key → up to ~3,500 closure invocations per spawn. | `src/runtime/pi-args.ts:112-253`; `src/runtime/pi-spawn.ts:154, 192-232`; `src/utils/env-filter.ts:143-159` |
| P2-28 | `compactString` allocates a fresh `TruncationStage`, a `stages` array and an `applied: string[]` per call — but **only on the over-cap path**; verification confirmed the under-cap fast path short-circuits (`if (value.length <= maxChars) return value`), so real-world impact is small. The live part: `BlankCollapseStage` compiles `new RegExp(...)` on every `apply()`. | `src/runtime/child-pi-transcript.ts:132-145`; `src/runtime/compact-stages/blank-collapse-stage.ts:26-29` |
| P2-29 | Unbounded `stdout +=` in the live-session runtime — unlike the child-process path, this accumulator has **no cap**. Same file, `writeSidechainEntry` is called per event and is fully synchronous: `mkdirSync(dirname)` + `redactSecrets` + `appendFileSync` on **every** subscribed event. | `src/runtime/live-session-runtime.ts:621, 871, 829-845`; `src/runtime/sidechain-output.ts:15-22` |
| P2-30 | `file-coalescer.ts` is **not used** by `event-log.ts`, `state-store.ts`, `dwf-state-store.ts`, `goal-state-store.ts`, `manifest-cache.ts` or `run-index.ts`. Each rolled its own — `sequenceCache`, `manifestCache`, `manifestIndex`/`listCache`, `sharedScanCache`, `readCache` — **five independent caches over the same files**. On the write side, `saveRunManifest`, `saveRunTasks`, `DwfStore.save` and `GoalStore.save` all use the uncoalesced double-fsync `atomicWriteJson`; only `saveRunTasksCoalesced` uses `atomicWriteJsonCoalesced`. The event log never coalesces writes at all (`appendEventBuffered`'s 20 ms buffer has only 2 call sites and is explicitly bypassed by `appendEventAsync`). | `src/utils/file-coalescer.ts`; `src/state/atomic-write.ts:816, 839-869`; `src/state/event-log.ts:595-607, 1141` |

### Polling

Intervals with disk or process I/O in the callback, flagged as aggressive:

| Interval | Location | Work per tick |
|---------:|----------|---------------|
| **200 ms** | `crew-broker.ts:1013-1052` | `loadRunManifestById` (see P1-12) |
| **250 ms** | `background-runner.ts:121-125` | `existsSync` + `JSON.parse(readFileSync(controlPath))` |
| **500 ms** | `team-tool.ts:729` | `while (!check()) await sleep(500)` — **unbounded, no deadline**, full `loadRunManifestById` per tick |
| **500 ms** | `dynamic-workflow-context.ts:671` | `gatherReplies` re-reads the whole mailbox until deadline |
| **500 ms** | `parent-guard.ts:57, 104` | `isPidAlive` (±20 % jitter) |
| **500 ms** | `live-session-runtime.ts:816-818` | `pollControl()` |
| **500 ms** | `prompt-runtime.ts:275, 328` | `statSync(safeSteeringFile)` |
| **500 ms** | `manifest-cache.ts:46` | full manifest re-scan (see P1-9) |
| **1000 ms** | `result-watcher.ts:29, 83-87` | `readdirSync(resultsDir)` + coalescer schedule per `.json` |
| **1000 ms** | `subagent-manager.ts:450-467` | progress tick, `MAX_POLL_COUNT = 1800` (30 min) |
| **60 s** | `registration/observability.ts:206, 232` | `reconcileStaleRuns` + `reconcileOrphanedTempWorkspaces` — full run-dir scans |

Fixed sleeps worth removing:

- **250 ms per goal turn** in 50 ms slices — `goal-loop-runner.ts:394-401`, called at `:795`. Pure added latency; the abort/pause checks it performs could be event-driven.
- `autoRetry` now defaults **on** (`team-runner.ts:1499-1503`) with `backoffMs: 1000`, factor 2, 3 attempts (`retry-executor.ts:33-37`), so a failing task adds ~3 s of pure sleep before giving up.
- Up to **1500 ms** SDK probe in `resolveCrewRuntime` (`runtime-resolver.ts:34`) for `live-session` / `preferLiveSession`, not memoized across runs in a session.

`fs.watch` is used correctly and sparingly (`src/utils/fs-watch.ts:32-40`, one non-recursive
watcher per run root); the header comment records that recursive watching was deliberately
removed. The pollers above are the remaining conversion candidates.

---

## Hygiene / correctness side-findings

| Finding | Evidence |
|---------|----------|
| ~~**`setInterval(writeHeartbeat, 60_000)` is missing `.unref()`**~~ **Intentional, not a bug (verified v0.9.55).** The missing `.unref()` is a deliberate design choice, documented in the comment at `team-runner.ts:111-113` (and referenced at `:893`): the team heartbeat must keep the event loop alive so the stale reconciler does not cancel long-running tasks. Removed from the fix list. | `src/runtime/team-runner.ts:111-113, 120-121` |
| **No retention for run dirs or event-log archives.** 84 dirs / 17 MB is the steady state. `pruneFinishedRuns` keeps 10 but filters `run.cwd === cwd` (`run-maintenance.ts:61`), so runs created from a worktree/temp/test cwd are never eligible; `isFinished` only matches `completed\|failed\|cancelled` (`:24-33`), so dirs with a missing or invalid manifest survive forever (68 such `ledger_real_*` / `ck_real_*` / `test-*` dirs observed, dated Jun 4 – Jul 9). `rotateEventLogUnlocked` writes `*.archive.jsonl` and **nothing ever deletes them** — contrast `notification-sink.ts:12-16` and `metric-sink.ts:20-25`, which both implement a `retentionDays` sweep. | `src/extension/registration/lifecycle-handlers.ts:358, 374`; `src/extension/run-maintenance.ts:24-33, 60-85`; `src/state/event-log-rotation.ts:237, 259, 265` |
| ~~**290 stale `.js` build artifacts inside `src/`.**~~ **Resolved in v0.9.55 (verified).** `find src -name "*.js"` returns **0** at HEAD `ed83dce` — the `prepack` hook (`scripts/clean-strip-types.mjs`) plus a checkout cleanup eliminated them. Original observation: `src/runtime/child-pi.js:1085` contained the P0-1 bug verbatim. Residual (minor) risk: they can re-accumulate in dev checkouts because the hook runs only at pack time, not at `npm test` / `npm run dev` time. | `find src -name "*.js" \| wc -l` → **0** at v0.9.55 (290 at audit time); `scripts/clean-strip-types.mjs` |
| **`mergeUnitResult` rebuilds the whole `Promise.race` wrapper set every loop iteration**, allocating a fresh async wrapper per still-pending unit and attaching new continuations to the same underlying promises. With `maxConcurrent = 8` over a 200-task run that is O(units × iterations) accumulated handlers on long-lived promises. **Fix:** create the wrapper once at dispatch and store it alongside `promise` in `pendingUnits`. | `src/runtime/team-runner.ts:1694-1708` |
| **O(N²) `tasks.find()` scans inside the scheduler loop** at verified sites `:1217`, `:1291`, `:1384`, `:1799`, `:1819` (also `:922`, `:1917` on secondary paths). Verification corrected the original list: the cited `:1444` is `roles.find`, not `tasks.find` (misidentified), and the `.map(...tasks.find...)` site at `:1217` was missed. `buildTaskGraphIndex` already exists and is rebuilt at `:2330`, but these sites bypass it. **Fix:** build one `Map<string, TeamTaskState>` right after `ctx.tasks = tasks` and use it at all sites. | `src/runtime/team-runner.ts` |
| **Task completion serializes ~8 persistence steps ahead of the next dispatch.** The loop merges exactly one unit per iteration, then awaits: `withRunLock` → `flushPendingAtomicWrites` → `loadRunManifestById` → `saveRunManifestAsync` → `saveRunTasksAsync` (`:1731-1757`), `advanceWorkflowPhases` (`:2285`), `enforceRunBudget` (`:2295`), `buildTaskGraphIndex` (`:2330`), `attemptAdaptivePlan` (`:2331`), `saveRunTasksAsync` **again** (`:2357`), `saveCrewAgents` sync (`:2358`), batch-summary `writeArtifact` (`:2360-2365`), `deliverGroupJoin` (`:2366`), `writeProgress` → `saveRunManifestAsync` **again** (`:2380-2381`). Nothing here is needed to decide the next dispatch, so a freed worker slot idles for the whole chain. `saveRunManifestAsync` and `saveRunTasksAsync` are each called **twice** across the iteration — verified scope: once in the merge chain (`:1755-1756`), again post-merge (`:2357`, `:2381`), with a third pair in the finalize block (`:2069-2070`). The original note mis-scoped the duplicates to `:2272-2382`, where each appears once on the main path. | `src/runtime/team-runner.ts:1755-1756, 2069-2070, 2272-2382` |
| **Duplicate work on the run critical path:** `findGitRootAsync` called at both `run.ts:405` and `run.ts:420`; `workflows/preflight-validator.ts` dynamically imported twice (`run.ts:519` and `team-runner.ts:767`), re-validating the same workflow. **Low impact on re-verification:** the second `findGitRootAsync` hits `_gitRootCache` and Node caches the repeated `import()`, so the practical cost is near-zero — deprioritized. | `src/extension/team-tool/run.ts`, `src/runtime/team-runner.ts` |
| **Dead code:** `src/state/jsonl-writer.ts` (`createJsonlWriter`) is defined but never called; `clearGitRootCache` / `clearCleanLeaderCache` exported but never called. | — |

---

## Verified non-issues

Checked and found correct — do not re-investigate:

- `src/utils/incremental-reader.ts` correctly tracks byte offsets (`readLinesSince` reads from `state.byteOffset` and returns a `committedOffset` stopping at the last complete newline, `:157-181`). No re-read from 0, no re-split of processed data. `readJsonlTail` bounds the read and drops the leading partial line with a single `indexOf("\n")` (`:99-108`).
- `src/utils/ndjson.ts` frame extraction uses `subarray` (views), not `slice` (copies), at `:94, 108`.
- `crew-broker.ts` `fanoutMailboxMessage` (`:472-497`) encodes the frame **once** outside the recipient loop and uses a per-run connection index rather than scanning all connections. `drainOutbound` (`:707-729`) is bounded by `DEFAULT_OUTBOUND_QUEUE_CAP`. There is no per-message fs write in the dispatch loop.
- `applyCompactPipeline` (`compact-pipeline.ts:42-58`) is O(stages) with a monotonic-shrink length gate — no O(n·stages) or O(n²) string building. `TruncationStage.apply` early-returns under cap (`:62`). `ANSI_STRIP_STAGE`, `BLANK_COLLAPSE_STAGE` and `DEDUPLICATE_STAGE` are **not** on the child-output path.
- All redaction regexes in `src/utils/redaction.ts` are module-level constants, compiled once. The only per-call `new RegExp` is `blank-collapse-stage.ts:26`.
- `src/utils/timings.ts` is fully gated on `process.env.PI_TIMING === "1"` (`:6`), so the `resetTimings` / `time` calls in `register.ts:53-54, 71` are free.
- `registerKnowledgeInjection` only registers a hook (`knowledge-injection.ts:389-402`); `installSubagentManager` is a cheap constructor (`subagent-manager-setup.ts:175-186`); `createRunSnapshotCache` does no fs at construction (`run-snapshot-cache.ts:784-789`); `installPiHooks` fs work happens inside the `resources_discover` callback, not at register time (`hook-registration.ts:52-55`); the ~30 `pi.registerCommand` calls in `commands.ts:550-1202` are individually cheap.
- No `TypeCompiler.Compile()` at module scope in `src/schema/` — only declarative `Type.Object(...)` literals.
- `dynamic-workflow-context.ts:533-542` (`for (const stage of stages) value = await stage(...)`) is intentionally sequential pipeline semantics, not a bug.
- `parallel-dispatch.ts:64-81` already uses `Promise.allSettled` per batch; `task-runner.ts` has no parallelizable sequential awaits (all awaits at 80/86/124/140/203 are genuinely dependent); `dynamic-workflow-runner.ts` has none.
- `run-tracker.ts:58, 99-100` polls with an in-process fast path first — correct.
- `src/benchmark/benchmark-runner.ts` is not in the bundle graph at all.

---

## Remediation plan

Ordered by (impact ÷ risk). Each batch is independently shippable and independently verifiable.

> **Adjusted by independent verification (v0.9.55).** All four P0s are confirmed as the
> fix-first set. Within P0-3, the sub-item "switch the in-loop call sites to the already-written
> `saveCrewAgentsCoalesced`" is much lower risk than the full async-lock conversion and can be
> pulled into Batch 1. **P2-14 is the highest-value standalone P2**: `startRuntimeWarmup` is
> genuinely broken in bundle mode and provides zero cold-start-race protection — fix it
> (`import(spec)` bare) or delete it deliberately (the modules are already bundled, so warmup is
> redundant even if fixed). Dropped from the plan: the `.unref()` "leak" (intentional), P2-25
> (refuted — keep the handler, optionally add a `startsWith("{")` pre-check), and the stale
> `.js` cleanup (already resolved in v0.9.55). H7 is near-zero cost (both calls hit caches).

### Batch 1 — highest impact, lowest risk

| Item | Change | Verification |
|------|--------|--------------|
| P0-1 | Segment-ring `BoundedTail` replacing `appendBoundedTail` | New `test/bench/bounded-tail.bench.ts`: 5,000 CJK lines < 50 ms, wired into `bench:check` |
| P0-2 | Per-path `appendCounters` map, incremented in all three append paths | Unit test: 250 async appends → `needsRotation` consulted exactly 2× |
| P1-10 | `Promise.all` for `before_task_start` hooks | Existing hook integration tests + assert N hooks overlap in time |
| P1-7 | `Math.min(requested, hardCap, getWorkerCapCapacity())` | Unit test on `resolveBatchConcurrency` with `PI_CREW_MAX_WORKERS=2` |
| P0-3 (partial) | Switch in-loop, non-terminal `saveCrewAgents` sites (`team-runner.ts:1301, 1307, 2358`) to the existing `saveCrewAgentsCoalesced` | Existing scheduler unit tests; no Atomics.wait on the hot path |
| Hygiene | Delete dead code: `createJsonlWriter` (`src/state/jsonl-writer.ts`), `clearGitRootCache`, `clearCleanLeaderCache` (zero callers, verified by exhaustive grep) | `npm run typecheck` + existing unit tests |

Expected: removes the two multi-second-to-multi-minute main-thread stalls and the per-event full-log rewrite.

### Batch 2 — per-event and per-line cost

P0-3 (full async agents-lock conversion — the low-risk `saveCrewAgentsCoalesced` switch is in
Batch 1), P0-4 (fsync reduction), P1-5 (memoize validated paths per task, batch agent-event
appends), P1-6 (redact once at `emitLine` + `indexOf` pre-filter).

Higher risk: touches locking and durability. Needs the crash-recovery and event-log integrity
integration tests to pass unchanged, plus an explicit kill-9 durability test.

### Batch 3 — read paths and enumeration

P1-8 (`readEvents` → `readJsonlTail` at the 7 tail call sites; single-pass `status.ts`),
P1-9 (`listActive` filters `list`; per-entry TTL + LRU `SharedScanCache`; lazy top-N in
`collectRuns`), P1-11 (hoist git prune/list to per-run, add per-repo mutex), P1-12 (cache
manifest on broker connection, replace 200 ms poll with `runEventBus` subscription).

### Batch 4 — startup and bundle

P2-13 (lazy `peerDepResolutionBases`), P2-14 (fix or delete `startRuntimeWarmup` — currently
dead in the default mode, and its absence removes a documented race guard, so decide
deliberately), P2-15 (route disposers through the lazy accessor **and** add the missing
`check-lazy-imports` rule: fail if a `// LAZY:`-marked module is also statically imported),
P2-16 (`splitting: true` + a separate entry-chunk budget), P2-17 (theme version stamp),
P2-18/P2-19 (lazy caches, load config once), P2-20 (move `process.on` and the reaper interval
behind first use), P2-21 (drop `build-meta.json` from `files`).

### Batch 5 — hygiene and retention

Add archive sweeping (`*.archive.jsonl` is never deleted) and cwd-scope-aware run pruning
(`pruneFinishedRuns` filters `run.cwd === cwd`, so worktree/temp runs are never eligible);
memoize `resolveCrewRuntime`. Already done or dropped after verification: the stale
`src/**/*.js` cleanup (resolved in v0.9.55 — zero files at HEAD), the dead-code removal (moved
to Batch 1), and the duplicate `findGitRootAsync` / double `preflight-validator` import
(near-zero cost — both hit caches; skip unless touching those files).

### Suggested new CI gates

1. **`check-lazy-imports` rule:** fail if a module `await import()`-ed with a `// LAZY:` marker
   is also statically imported anywhere in `src/`. This single rule catches all three P2-15
   regressions.
2. **Entry-chunk size budget** in addition to the total-bundle budget, so eager/lazy regressions
   are detectable at all.
3. **A `no-sleepSync` lint rule** outside `process.on("exit")`-class handlers (P0-3).
4. **Bench cases** for `appendBoundedTail`, `appendCrewAgentEvent`, and `readEvents`-on-tail in
   `test/bench/`, gated by the existing `bench:check` 15 % regression threshold.

---

## Appendix A — reproducible benchmark

Standalone, no build required. Extracts the shipped algorithm verbatim from
`src/runtime/compact-stages/tail-capture-stage.ts:60-67` and compares it to the proposed fix.

```js
// save as /tmp/bench-bounded-tail.mjs, then: node /tmp/bench-bounded-tail.mjs
const MAX = 512 * 1024; // DEFAULT_CHILD_PI.maxCaptureBytes

// --- current: verbatim from tail-capture-stage.ts:60-67 + child-pi-kill.ts:69 ---
class TailCaptureStage {
	constructor(o) { this.maxBytes = o.maxBytes; this.marker = o.marker; }
	apply(text) {
		if (Buffer.byteLength(text, "utf-8") <= this.maxBytes) return text;
		let tail = text.slice(Math.max(0, text.length - this.maxBytes));
		while (Buffer.byteLength(tail, "utf-8") > this.maxBytes) tail = tail.slice(0, -1);
		return this.marker ? `${this.marker}\n${tail}` : tail;
	}
}
const current = (c, ch, m = MAX) =>
	new TailCaptureStage({
		maxBytes: m,
		marker: `[pi-crew captured output truncated to last ${Math.round(m / 1024)} KiB]`,
	}).apply(c + ch);

// --- proposed: segment ring + running byte counter ---
class BoundedTail {
	constructor(maxBytes = MAX) { this.maxBytes = maxBytes; this.segs = []; this.bytes = 0; this.dropped = false; }
	push(chunk) {
		this.bytes += Buffer.byteLength(chunk, "utf-8");
		this.segs.push(chunk);
		while (this.bytes > this.maxBytes && this.segs.length > 1) {
			this.bytes -= Buffer.byteLength(this.segs.shift(), "utf-8");
			this.dropped = true;
		}
	}
	value() {
		const body = this.segs.join("");
		return this.dropped
			? `[pi-crew captured output truncated to last ${Math.round(this.maxBytes / 1024)} KiB]\n${body}`
			: body;
	}
}

function run(label, line, n) {
	let acc = "";
	let t0 = process.hrtime.bigint();
	for (let i = 0; i < n; i++) acc = current(acc, line);
	const a = Number(process.hrtime.bigint() - t0) / 1e6;

	const bt = new BoundedTail();
	t0 = process.hrtime.bigint();
	for (let i = 0; i < n; i++) bt.push(line);
	bt.value();
	const b = Number(process.hrtime.bigint() - t0) / 1e6;

	console.log(`${label}\n  current : ${a.toFixed(1)} ms\n  proposed: ${b.toFixed(1)} ms\n  speedup : ${(a / b).toFixed(0)}x`);
}

run("ASCII 5000 x 200B:", `${"x".repeat(200)}\n`, 5000);
run("CJK 3000 x 200 chars:", `${"字".repeat(200)}\n`, 3000);
```

Output on the audit machine (4 cores, Linux 6.17):

```
ASCII 5000 x 200B:
  current : 2344.5 ms
  proposed: 4.0 ms
  speedup : 583x
CJK 3000 x 200 chars:
  current : 112138.5 ms
  proposed: 3.9 ms
  speedup : 29052x
```

Both variants produce an equivalent ~512 KB bounded tail (524,340 B vs 524,260 B; the small
delta is the segment-boundary granularity of the proposed version).

Run-to-run variance is a few percent on the `current` column (a second run measured 2,328 ms
and 110,053 ms) and is dominated by GC timing; the `proposed` column stays in the 3-4 ms band.
The conclusion is robust to that variance: the gap is three to four orders of magnitude, not a
margin-of-error difference.

---

## Appendix B — measured concurrency values

| Limiter | Value | Source |
|---------|-------|--------|
| Scheduler hard cap | `hardCap: 8` | `src/config/defaults.ts:55` |
| Per-workflow defaults | `parallelResearch: 4`, `research: 3`, `implementation: 4`, `review: 3`, `default: 3`, fallback `2` | `src/config/defaults.ts:54-63` |
| Precedence | `limits.maxConcurrentWorkers` > `team.maxConcurrency` > `workflow.maxConcurrency` > workflow-name default; `allowUnboundedConcurrency` bypasses `hardCap` | `src/runtime/concurrency.ts:38-47` |
| Global worker cap | `PI_CREW_MAX_WORKERS` env, else `Math.max(2, os.cpus().length - 2)` — **2 on this 4-core machine** | `src/runtime/global-worker-cap.ts:31-42` |
| Semaphore queue | FIFO, no priority, `MAX_QUEUE = 10_000`, **throws** past it | `src/runtime/semaphore.ts:16-57` |
| Cap application point | one place only; `cap: false` for goal-judge spawns (deliberate deadlock avoidance) | `src/runtime/run-worker.ts:71-78`; `src/runtime/goal-evaluator.ts:215` |
| DWF `ctx.agent` / `fanOut` | `Math.max(1, opts.concurrency ?? 4)` | `src/runtime/dynamic-workflow-context.ts:252-253` |
| `action=parallel` dispatch | `MAX_CONCURRENCY = 8`, `DEFAULT_CONCURRENCY = 4` | `src/extension/team-tool/parallel-dispatch.ts:24-25` |
| `SubagentManager` | `maxConcurrent = 4`, `pollIntervalMs = 1000` | `src/subagents/subagent-manager.ts:229` |
| Locks stale threshold | `DEFAULT_LOCKS.staleMs = 30_000` | `src/config/defaults.ts:51` |
| Event-log rotation | compact at 4 MB / ~50k events down to 1,000 events; hard drop at 50 MB | `src/state/event-log-rotation.ts:16-19`; `src/state/event-log.ts:68` |

### Critical path: tool invocation → first agent actually working

```
run.ts:396    await loadCrewInit()
run.ts:397    await ensureCrewDirectory(workingDir)
run.ts:405    await findGitRootAsync(workingDir)          git rev-parse   <- FIRST git spawn
run.ts:420    await findGitRootAsync(resolvedCtx.cwd)     DUPLICATE
run.ts:435    await assertCleanLeaderAsync(gitRoot)       git status --porcelain (worktree mode)
run.ts:519    await import("../../workflows/preflight-validator.ts")
run.ts:725    await resolveCrewRuntime(...)               up to 1500 ms SDK probe if live-session
run.ts:1013   await executeTeamRun({...})
  team-runner.ts:767   await import(".../preflight-validator.ts")   <- SECOND import, re-validates
  team-runner.ts:2100  await executeHook("before_run_start")        <- blocking external hook
  team-runner.ts:2131  await attemptAdaptivePlan()                  implementation: spawns a planner agent
  team-runner.ts:2156  saveCrewAgents(...)                          <- SYNC spin-lock (P0-3)
  team-runner.ts:2255  await dispatchBatch(ctx, decision)
    :1364-1382   await executeHook("before_task_start") x N SEQUENTIAL   <- P1-10
    :1419-1431   await Promise.all(computeStablePrefixComponents ...)    <- already parallel
    :1661        dispatchUnit(unit) per unit
      pre-execution.ts:103  await prepareTaskWorkspaceAsync(...)   <- 4-6 git spawns (P1-11)
      pre-execution.ts:157-159  sync writes incl. upsertCrewAgent  <- P0-3
      pre-execution.ts:289  await renderTaskPrompt(...)
      run-worker.ts:75      withWorkerSlot(() => runChildPi(...))  <- ACTUAL SPAWN (P1-7)
```

Avoidable latency before the first agent runs, in descending order: P1-10 (N serialized hooks),
P1-11 (uncached `worktree list` + per-task `worktree prune`), P0-3 (sync spin-lock at `:2156`),
the duplicate `findGitRootAsync`, the double `preflight-validator` import, and the unmemoized
1500 ms `resolveCrewRuntime` probe.

---

## Post-audit commit review

Reviewed commits `86afde9..ed83dce` (v0.9.52 → v0.9.55, 4 commits on 2026-07-29).

### Files changed

```
index.ts                                  — entry point: static src/ imports → dynamic import()
package.json                              — version bump, "src/" added to files, esbuild → deps, prepack hook
scripts/clean-strip-types.mjs             — NEW: prepack hook stripping strip-types .js companions
src/extension/registration/team-tool.ts   — better param-validation error messages
src/extension/team-tool/param-error.ts    — NEW: param error formatting helper
+ 5 test files
```

### Impact on audit findings

| Finding | Affected? | Detail |
|---------|-----------|--------|
| P0-1 through P0-4 | No | None of the changed files are in the P0 finding paths (`event-log.ts`, `child-pi-kill.ts`, `crew-agent-records.ts`) |
| P1-5 through P1-12 | No | None of the changed files are in the P1 finding paths (`team-runner.ts`, `concurrency.ts`, `worktree-manager.ts`, `crew-broker.ts`, `manifest-cache.ts`, `status.ts`) |
| P2-13 through P2-20 | No | `index.ts` now uses dynamic `import()` for src/ fallback (improving the lazy-load situation at the entry point), but the specific P2-15 static-import defeats in `runtime-cleanup.ts` / `lazy-configurers.ts` are unchanged. P2-14 (`startRuntimeWarmup` no-op in bundle mode) is in `runtime-warmup.ts`, which was not touched. |
| P2-21 (build-meta.json shipped) | No | `dist/build-meta.json` is still in `files` as of v0.9.55 |
| Hygiene: 290 stale `.js` | **Resolved** | `prepack` hook strips them at pack time and the checkout was cleaned — `find src -name "*.js"` returns **0** at `ed83dce`. Finding marked resolved above. |
| Hygiene: `.unref()` leak | No — and **not a bug** | `team-runner.ts:120` unchanged; verification confirmed the missing `.unref()` is deliberate (comment at `:111-113`). Removed from the fix list. |
| All other findings | No | No overlap with changed files |

**Conclusion:** the 4 post-audit commits are release/packaging fixes (esbuild dep move, src/ shipping, strip-types cleanup) and a UX improvement (actionable param errors). No performance finding is invalidated or weakened — not a single P0/P1 was remediated between v0.9.52 and v0.9.55. The stale `.js` hygiene finding is fully resolved at v0.9.55.

---

## Independent verification

Re-verified 2026-07-29 against v0.9.55 (`ed83dce`) source by five parallel verifiers that read
the real code at every cited location (audit quotes were not trusted). Full per-finding
scorecard: [VERIFY-performance-audit-2026-07-29.md](./VERIFY-performance-audit-2026-07-29.md).

| Category | Findings | Confirmed | Understated / partial / drifted | Not actionable |
|----------|---------:|----------:|--------------------------------:|---------------:|
| P0 | 4 | 4 | 0 | 0 |
| P1 | 8 | 6 | 2 (P1-5, P1-6 — both *more* severe) | 0 |
| P2 | 18 | 16 | 1 (P2-28) | 1 (P2-25 refuted) |
| Hygiene | 8 | 3 | 3 (H5, H6, H7) | 2 (H1 intentional, H3 resolved) |
| **Total** | **38** | **29** | **6** | **3** |

Corrections applied inline to this document:

1. **P1-5 understated** — real cost is ≈65-93 syscalls/event (the ancestor walk inside
   `resolveRealContainedPath` was under-counted), not 28.
2. **P1-6 understated** — ~14 full-string traversals, not 11.
3. **P1-8** — 11 unbounded `readEvents` call sites vs 3 bounded, not ~9.
4. **P1-12** — 7 `loadRunManifestById` call sites (the steer paths `:1110` and `:1189` were
   missed); call-site line numbers refreshed.
5. **P2-25 refuted** — `parseSupervisorContactFromLine` receives the raw stdout line and is a
   live handler for `supervisor_contact` NDJSON; finding rewritten. Do not delete it.
6. **P2-28 partial** — the under-cap fast path does not allocate; only the over-cap
   allocations and `BlankCollapseStage`'s per-call `new RegExp` stand.
7. **H1 not a bug** — the missing `.unref()` is deliberate (keeps long runs alive);
   removed from the fix list.
8. **H3 resolved** — zero stale `.js` under `src/` at v0.9.55.
9. **H5 site list corrected** — `:1444` is `roles.find`, not `tasks.find`; the missed O(N²)
   site is `:1217`.
10. **H6 mis-scoped** — duplicate saves span the merge chain / post-merge / finalize boundary
    (`:1755-1756`, `:2357`, `:2381`, `:2069-2070`), not twice inside `:2272-2382`.
11. **H7 near-zero cost** — both duplicate calls hit caches; deprioritized.
12. **Path drift fixed** — `peer-dep.ts` is `src/runtime/`; `deploy-bundled-themes.ts` and
    `powerbar-publisher.ts` are `src/ui/`; `atomic-write.ts` and `locks.ts` are `src/state/`;
    `incremental-reader.ts` is `src/utils/`.
13. **P2-16** — module count is 353-422, not 118 (non-material; the finding stands).
14. **P2-18** — 15 markers per ancestor level (7 directory + 8 file), not 14.
15. **P1-10** — `appendEventBuffered` call-site reference drifted `:1339` → `:1347`.

The 12 "verified non-issues" were not re-verified (they are negative results marked
do-not-reinvestigate); three of them were spot-checked during verification and corroborated.

---

*Audited 2026-07-29 against v0.9.52 (commit `86afde9`). Post-audit review and independent verification cover v0.9.55 (`ed83dce`). Follows the `docs/perf/` reporting convention established by `performance-audit-report-2026-07.md`.*
