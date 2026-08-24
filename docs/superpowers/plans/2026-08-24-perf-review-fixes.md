# Perf Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all significant performance findings from the 2026-08-24 performance review of pi-crew (benchmark-backed: atomic write p50 13–15ms dominated by fsync ceremony; tasks.json read-modify-write ~30×/s; UI sync I/O storms; mailbox/event-log syscall ceremony; startup scan storms).

**Architecture:** 26 code tasks in 5 phases (quick wins → state persistence → UI → runtime/broker/extension → verification). Each task is independently testable and committable. Design rule throughout: **cut syscalls and redundant parses, not durability or documented invariants** — every fix preserves the crash-safety comments it touches (BUG-028 in-lock load, ST-7 terminal bypass, F4 flush-before-read, FLICKER FIX rebuild-in-place, R16-B1 advance-on-reserve).

**Tech Stack:** TypeScript (strip-types + esbuild bundle), node:test via `scripts/test-runner.mjs`, Biome (tabs, double quotes), no new dependencies.

## Global Constraints

- Repo: `/home/bom/source/my_pi/pi-crew`, branch `perf/review-2026-08-24` off `main`. Never commit changes under `dist/` (build artifacts; CI rebuilds via `build:bundle`).
- Single-file test command: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/<path>.test.ts`
- Typecheck before every commit: `npm run typecheck` (runs `tsc --noEmit` + strip-types import probe).
- Test convention: `import test from "node:test"; import assert from "node:assert/strict";` — imports of src use `../../src/...ts` relative paths with `.ts` extension. New tests go in `test/unit/` mirroring src layout.
- Preserve every `BUG-####`/`F#`/`ST-#`/`R#`/`H#`/`P#`-tagged comment block you touch — update the comment if behavior nuance changes, never delete the rationale.
- Commit style: `perf(<area>): <what>` conventional commits, one logical change per commit.
- When a step says "Read <file>:<lines>", do it first — line anchors are from 2026-08-24 and may have drifted by ±10 lines after earlier tasks.

## Findings NOT fixed in this plan (deliberate deferrals)

| Finding | Why deferred |
|---|---|
| In-memory authoritative tasks array (structural rewrite of persistSingleTaskUpdate) | Superseded by Tasks 11+12 (lazy stringify + cache-keep), which capture most of the win without a new crash-consistency surface. Revisit only if post-fix benchmarks still show the CAS loop dominating. |
| child-executor.ts transcript read 3×/copied per task completion | Cold path (once per task); the 5MB tail read is bounded. |
| branch-freshness 5 sequential git spawns | Once per run at finalize; offline-safe design is worth keeping. |
| discover-agents builtin permanent cache; stale-reconciler single-pass; run-maintenance cwd filter | Cold paths (startup/session-start, deferred via setTimeout already). |
| delivery-state eager `{...messages}` copies; sequenceCache eviction sort; setManifestCache TTL sweep; loadRunManifestById retry console.debug | Bounded (≤10k entries/64 entries/256 entries) and/or made moot by Tasks 12–14. |
| heartbeat-watcher full load per tick | Cost collapses as a side effect of Tasks 12 (manifest cache stays warm) + 23 (list() stat storm removed). |
| theme-adapter try/catch wrapper; widget Box/Text alloc churn; terminal-status sync /dev/tty write; DAG rebuild per tick; per-chunk timer churn in child-pi | Micro-optimizations below measurement noise; not worth review churn. |
| benchmark-runner sequential task execution | Functional-eval harness, not a hot path. |

---

## Phase 0 — Setup

### Task 1: Create working branch

**Files:** none.

- [ ] **Step 1: Branch**

```bash
cd /home/bom/source/my_pi/pi-crew && git checkout main && git pull --ff-only 2>/dev/null; git checkout -b perf/review-2026-08-24
```

Note: `dist/build-meta.json`, `dist/index.mjs`, `dist/index.mjs.map` may show as modified — leave them untouched and never `git add dist/`.

---

## Phase A — Quick wins (tiny diffs, verifiable immediately)

### Task 2: Scoped flush + in-lock CAS baseline in persistSingleTaskUpdate

**Files:**
- Modify: `src/runtime/task-runner/state-helpers.ts:44-129`
- Test: `test/unit/state-helpers.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `flushPendingAtomicWrites(filePath?: string)` scoped mode (already exists, `src/state/atomic-write.ts:979`).
- Produces: unchanged public signature `persistSingleTaskUpdate(manifest, fallbackTasks, updated, checkpointPhase?, skipCoalesce?)`.

- [ ] **Step 1: Read the anchor** — `src/runtime/task-runner/state-helpers.ts:36-135`.

- [ ] **Step 2: Write the failing test** (append to `test/unit/state-helpers.test.ts`):

```ts
test("persistSingleTaskUpdate does not drain unrelated coalesced writes (scoped flush)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scoped-flush-"));
	try {
		const manifest = makeTestManifest(dir); // reuse the file's existing manifest fixture helper; if none exists, copy the setup from the nearest existing test in this file
		const unrelated = path.join(dir, "agents.json");
		atomicWriteJsonCoalesced(unrelated, { hello: 1 }, 10_000); // long coalesce window
		persistSingleTaskUpdate(manifest, [], { ...baseTask, id: "t1", status: "running" });
		assert.equal(fs.existsSync(unrelated), false, "unrelated coalesced write must still be buffered, not flushed");
		flushPendingAtomicWrites(unrelated);
		assert.equal(JSON.parse(fs.readFileSync(unrelated, "utf-8")).hello, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 3: Run it** — `node --experimental-strip-types --test --test-concurrency=1 test/unit/state-helpers.test.ts` — expected FAIL (unrelated write got drained by the global flush).

- [ ] **Step 4: Apply the edit.** In `persistSingleTaskUpdate`:

Delete the pre-lock CAS capture (lines ~52-59):

```ts
	let baseMtime = 0;
	try {
		baseMtime = fs.statSync(manifest.tasksPath).mtimeMs;
	} catch {
		// File doesn't exist yet — baseMtime=0 means "anything is fine"
		baseMtime = 0;
	}
```

and `let baseMtime` moves inside the lock loop. Replace the loop body's flush+load block:

```ts
			flushPendingAtomicWrites();
			// ... BUG-028 comment block (KEEP AS IS) ...
			const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
```

with:

```ts
			// PERF (2026-08-24): scoped flush — only force OUR tasks.json pending
			// write to land. The old argument-less call drained every pending
			// coalesced write process-wide (other runs, agents.json 250ms window)
			// on every persist (~30x/s), defeating coalescing globally. The F4
			// invariant only needs tasks.json durable before this read.
			flushPendingAtomicWrites(manifest.tasksPath);
			// PERF (2026-08-24): capture the CAS baseline INSIDE the lock, after
			// the flush, immediately before the load. The old pre-lock stat almost
			// always disagreed with the in-lock stat under 10 parallel writers
			// (mtime moved between function entry and lock acquisition), forcing
			// 2+ full flush+load cycles per call. In-lock capture makes retry mean
			// exactly: "a cross-process writer committed between our load and our
			// pre-write stat" — the only race the CAS can actually catch.
			let baseMtime: number;
			try {
				baseMtime = fs.statSync(manifest.tasksPath).mtimeMs;
			} catch {
				baseMtime = 0;
			}
			// ... BUG-028 comment block (KEEP AS IS) ...
			const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
```

Then in the mismatch branch (~line 123) replace:

```ts
			if (currentMtime !== baseMtime) {
				// Another writer committed — their update is in latest, re-merge on top
				baseMtime = currentMtime;
				continue;
			}
```

with:

```ts
			if (currentMtime !== baseMtime) {
				// Another writer committed between our in-lock baseline and this
				// stat — retry; the next iteration recaptures the baseline fresh.
				continue;
			}
```

- [ ] **Step 5: Run the test file** — expected PASS (all tests, including pre-existing BUG-028 tests if present).

- [ ] **Step 6: Commit** — `git add src/runtime/task-runner/state-helpers.ts test/unit/state-helpers.test.ts && git commit -m "perf(state): scoped flush + in-lock CAS baseline in persistSingleTaskUpdate"`

### Task 3: worker-events-channel reads only the last byte

**Files:**
- Modify: `src/prompt/worker-events-channel.ts:60-80`
- Test: `test/unit/prompt/worker-events-channel-tail.test.ts` (new)

**Interfaces:** none changed (internal closure).

- [ ] **Step 1: Write the failing test** — new file:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

// The channel factory is exercised through createWorkerEventsChannel (see src).
// Import path follows the module's real export name — check the file's exports first.
import { createWorkerEventsChannel } from "../../src/prompt/worker-events-channel.ts";

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wec-"));
	const eventsPath = path.join(dir, "events.jsonl");
	return { dir, eventsPath };
}

test("appends separator when file does not end with newline", () => {
	const { dir, eventsPath } = setup();
	try {
		fs.writeFileSync(eventsPath, '{"a":1}', "utf-8"); // no trailing \n
		const ch = createWorkerEventsChannel({ eventsPath }); // adapt to real factory signature found in the file
		ch.emit({ type: "t" }); // adapt: trigger one event emit through the public path
		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[1]!).type, "t");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("no separator when file already ends with newline; none for empty or missing file", () => {
	const { dir, eventsPath } = setup();
	try {
		fs.writeFileSync(eventsPath, '{"a":1}\n', "utf-8");
		const ch = createWorkerEventsChannel({ eventsPath });
		ch.emit({ type: "t" });
		let lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);

		fs.writeFileSync(eventsPath, "", "utf-8");
		ch.emit({ type: "t2" });
		lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);

		fs.rmSync(eventsPath);
		ch.emit({ type: "t3" });
		lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
```

Adapt the two `adapt` markers to the module's real factory signature (read the file first; keep the three scenario assertions).

- [ ] **Step 2: Run** — expected: first scenario FAILs today only if a pre-existing partial line exists in fixture; if both pass already, keep them as regression guards and proceed (the perf fix is still needed — the current code reads the WHOLE file).

- [ ] **Step 3: Apply the edit.** Replace:

```ts
			let prefix = "";
			try {
				const buf = readFileSync(eventsPath);
				if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) prefix = "\n";
			} catch {
				/* absent file — nothing to separate */
			}
```

with:

```ts
			let prefix = "";
			try {
				// PERF (2026-08-24): 1-byte tail read (the comment above always
				// described this; the implementation used to readFileSync the
				// WHOLE file — O(file) reads up to 300x/min per worker for a
				// single byte of information).
				const fd = openSync(eventsPath, "r");
				try {
					const size = fstatSync(fd).size;
					if (size > 0) {
						const tail = Buffer.alloc(1);
						readSync(fd, tail, 0, 1, size - 1);
						if (tail[0] !== 0x0a) prefix = "\n";
					}
				} finally {
					closeSync(fd);
				}
			} catch {
				/* absent file — nothing to separate */
			}
```

Update the import to the function-style fs imports if the file uses `import { readFileSync } from "node:fs"` — add `openSync, fstatSync, readSync, closeSync` and drop `readFileSync` if now unused.

- [ ] **Step 4: Run tests** — PASS. Run the prompt-area suite too: `node --experimental-strip-types --test --test-concurrency=1 test/unit/prompt/worker-events-channel-tail.test.ts` plus any pre-existing worker-events test (`ls test/unit | grep worker-events`).

- [ ] **Step 5: Commit** — `git commit -am "perf(prompt): 1-byte tail read in worker events channel"`

### Task 4: sweepExpiredWaitingTasks checks cheap predicate before full load

**Files:**
- Modify: `src/runtime/dispatch-batch.ts:117-127` + all callers of `sweepExpiredWaitingTasks` (grep: likely `runSchedulerSweeps` at `:377-388`)
- Test: `test/unit/runtime/dispatch-sweep-hint.test.ts` (new)

**Interfaces:**
- Produces: `sweepExpiredWaitingTasks(cwd: string, runId: string, now?: number, hintTasks?: TeamTaskState[])` — new optional 4th param. Callers holding a fresh task view pass it.

- [ ] **Step 1: Grep callers** — `grep -rn "sweepExpiredWaitingTasks" src test`.

- [ ] **Step 2: Write failing test** — new file, skeleton:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sweepExpiredWaitingTasks } from "../../src/runtime/dispatch-batch.ts";
// + import the manifest fixture helpers used by neighboring dispatch tests (copy from an existing dispatch test file)

test("hint with no expired waiting task returns undefined without loading the manifest", () => {
	// Build a real run dir with manifest.json + tasks.json containing one RUNNING task.
	// Call sweepExpiredWaitingTasks(cwd, runId, Date.now(), [runningTask]).
	// Assert: returns undefined (no work). Then assert the manifest file's mtime
	// is unchanged AND — stronger — delete manifest.json from disk AFTER capturing
	// the hint array; the call must still return undefined (proving no disk load
	// happened; the old code loadRunManifestById'd first and would return
	// undefined too, so ALSO assert with a hint containing an expired waiting
	// task that a missing manifest short-circuits to undefined vs the no-hint
	// path returning undefined — behavior parity).
	const hint = [{ id: "t1", status: "running" /* …minimal TeamTaskState fields… */ }];
	fs.rmSync(manifestPath); // manifest gone
	assert.equal(sweepExpiredWaitingTasks(cwd, runId, Date.now(), hint as never), undefined);
});

test("hint with expired waiting task proceeds to the locked sweep", () => {
	// run dir with a task { status: "waiting", waiting: { deadline: Date.now() - 1 } }
	// sweep(..., [thatTask]) → returns a WaitingDeadlineSweepResult (not undefined)
});
```

Fill the fixtures from a neighboring dispatch test (`ls test/unit | grep -i dispatch`).

- [ ] **Step 3: Run** — FAIL (4-arg signature rejected / behavior differs).

- [ ] **Step 4: Apply the edit.** Replace lines 117-127 body start:

```ts
export async function sweepExpiredWaitingTasks(
	cwd: string,
	runId: string,
	now = Date.now(),
): Promise<WaitingDeadlineSweepResult | undefined> {
	const initial = loadRunManifestById(cwd, runId);
	if (!initial) return undefined;
	const hasExpired = initial.tasks.some((t) => t.status === "waiting" && t.waiting !== undefined && t.waiting.deadline <= now);
	if (!hasExpired) return undefined;
```

with:

```ts
export async function sweepExpiredWaitingTasks(
	cwd: string,
	runId: string,
	now = Date.now(),
	// PERF (2026-08-24): callers in the scheduler loop already hold a task view
	// loaded this tick. Check the cheap expiry predicate against it BEFORE
	// paying stat+parse of manifest.json + tasks.json — the sweep fires on every
	// unit settle/dispatch and almost always finds nothing expired.
	hintTasks?: TeamTaskState[],
): Promise<WaitingDeadlineSweepResult | undefined> {
	if (hintTasks) {
		const hintExpired = hintTasks.some((t) => t.status === "waiting" && t.waiting !== undefined && t.waiting.deadline <= now);
		if (!hintExpired) return undefined;
	}
	const initial = loadRunManifestById(cwd, runId);
	if (!initial) return undefined;
	const hasExpired = initial.tasks.some((t) => t.status === "waiting" && t.waiting !== undefined && t.waiting.deadline <= now);
	if (!hasExpired) return undefined;
```

Then update the caller(s) in `runSchedulerSweeps` to pass the task array it already holds for this tick (read `:370-395` to find the variable name; pass exactly that array).

- [ ] **Step 5: Run** dispatch tests — PASS.

- [ ] **Step 6: Commit** — `git commit -am "perf(runtime): expiry hint short-circuit in waiting-task sweep"`

### Task 5: updateCrewWidget stops building discarded widget lines

**Files:**
- Modify: `src/ui/widget/index.ts:444-470`

- [ ] **Step 1: Read `src/ui/widget/index.ts:425-480`** and confirm `lines` is used only for `.length` after construction (it is, per review; `setPanelRowsProvider` uses `runs`, not `lines`).

- [ ] **Step 2: Apply the edit.** Replace:

```ts
	const lines = buildWidgetLines(ctx.cwd, state.frame, maxLines, runs, state.notificationCount ?? 0, getRenderWidth(), {
		rowStyle,
		...panelDisplayState(),
	});
```

with nothing (delete the call), and replace both consumers:

```ts
	ctx.ui.setStatus(STATUS_KEY, lines.length ? statusSummary(runs) : undefined);
```

→

```ts
	// PERF (2026-08-24): the persistent CrewWidgetComponent renders itself from
	// state.frame; the built line set was only ever used for its .length.
	ctx.ui.setStatus(STATUS_KEY, runs.length > 0 ? statusSummary(runs) : undefined);
```

and

```ts
	if (!lines.length) {
```

→

```ts
	if (runs.length === 0) {
```

If `buildWidgetLines` becomes unused in this file, leave the export intact (the component may use it) — verify with grep before removing any import.

- [ ] **Step 3: Verify** — `npm run typecheck` and run widget tests: `ls test/unit | grep -i widget` then run those files. Visual smoke: none available headless; rely on tests + `render-flush` bench still passing.

- [ ] **Step 4: Commit** — `git commit -am "perf(ui): drop discarded buildWidgetLines call in updateCrewWidget"`

### Task 6: hooks registry hoists constant sanitizer state

**Files:**
- Modify: `src/hooks/registry.ts:65-113`

- [ ] **Step 1: Read `src/hooks/registry.ts:40-130`.** Confirm `sanitizeMergeData`, `sanitizeContext`, `sanitizeErrorMessage` close over nothing but `POLLUTED_KEYS` and their own params.

- [ ] **Step 2: Apply the edit.** Move the whole block (`const POLLUTED_KEYS = …`, `sanitizeMergeData`, `sanitizeContext`, and `sanitizeErrorMessage` if it is also per-call) from inside `executeHook` to module scope, directly above `executeHook`, marked:

```ts
// PERF (2026-08-24): constant sanitizer state hoisted to module scope — it was
// rebuilt (13 normalize+toLowerCase + Set + 3 closures) on EVERY hook execution.
const POLLUTED_KEYS = new Set(
	[…same 13 keys…].map((k) => k.toLowerCase().normalize("NFKC")),
);
function sanitizeMergeData(…unchanged body…) {}
function sanitizeContext(…unchanged body…) {}
```

Bodies stay byte-identical — only the nesting changes. If `sanitizeErrorMessage` mutates per-call state, leave it inner.

- [ ] **Step 3: Verify** — run hooks tests: `ls test/unit | grep -i hook` → run them. Then `npm run typecheck`.

- [ ] **Step 4: Commit** — `git commit -am "perf(hooks): hoist constant sanitizer state to module scope"`

### Task 7: render-diff computes diffWords once per changed pair

**Files:**
- Modify: `src/ui/render-diff.ts:39-85,130-141`
- Test: `test/unit/ui/render-diff-single-pass.test.ts` (new)

**Interfaces:**
- Produces: internal only — `computeSimilarity(old, new, wordDiff?)` and `renderIntraLineDiff(theme, old, new, wordDiff?)` gain optional precomputed parts (or become thin wrappers — see step).

- [ ] **Step 1: Write golden test** — new file:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { renderDiff } from "../../src/ui/render-diff.ts";

const DIFF_TEXT = `--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 context line
-old value with tail
+old value with tail modified
-the quick brown fox
+totally different content here`;

test("renderDiff intra-line highlighting is stable (golden)", () => {
	const out = renderDiff(DIFF_TEXT, {});
	assert.ok(out.includes("-2 "), "removed line rendered");
	assert.ok(out.includes("+2 "), "added line rendered");
	assert.ok(out.includes("context line"));
	// unrelated pair (low similarity) renders plainly:
	assert.ok(!out.includes("[7m"), "second pair below similarity threshold has no inverse video");
	// similar pair renders SOME inverse video span:
	// (first pair sim ≈ 0.8 ≥ 0.15 → theme.inverse used; default theme may not
	// emit [7m — if this assertion is theme-dependent, assert instead that
	// both old and new content substrings appear in the output.)
});
```

Run it BEFORE the change to capture actual behavior; adjust the two inverse-video assertions to whatever the default theme really emits (the point is: output before == output after).

- [ ] **Step 2: Apply the edit.** Change the pair-processing site (lines ~130-137) to compute once:

```ts
			if (removedLines.length === 1 && addedLines.length === 1) {
				const oldContent = replaceTabs(removedLines[0]!.content);
				const newContent = replaceTabs(addedLines[0]!.content);
				// PERF (2026-08-24): diffWords is the expensive call and was run
				// TWICE on identical inputs (similarity + render). One pass, shared.
				const wordDiff = Diff.diffWords(oldContent, newContent);
				const similarity = computeSimilarity(oldContent, newContent, wordDiff);
				if (similarity >= WORD_DIFF_MIN_SIM) {
					const { removedLine, addedLine } = renderIntraLineDiff(theme, oldContent, newContent, wordDiff);
```

and the two functions:

```ts
function computeSimilarity(oldContent: string, newContent: string, wordDiff?: Diff.Change[]): number {
	const parts = wordDiff ?? Diff.diffWords(oldContent, newContent);
	let commonChars = 0;
	for (const part of parts) {
		if (!part.removed && !part.added) {
			commonChars += part.value.length;
		}
	}
	/* …rest unchanged… */
}

function renderIntraLineDiff(
	theme: CrewTheme,
	oldContent: string,
	newContent: string,
	wordDiff?: Diff.Change[],
): { removedLine: string; addedLine: string } {
	const parts = wordDiff ?? Diff.diffWords(oldContent, newContent);
	/* …body iterates `parts` instead of `wordDiff`… */
}
```

(`oldContent`/`newContent` params stay for the fallback call; import type `Diff` namespace already present.)

- [ ] **Step 3: Run golden test** — PASS with identical output to pre-change capture.

- [ ] **Step 4: Commit** — `git commit -am "perf(ui): single diffWords pass per changed line pair"`

### Task 8: visibleWidth gets a short-string cache

**Files:**
- Modify: `src/utils/visual.ts:17-32`
- Test: extend the existing visual test file (`ls test/unit | grep -i visual`; if none, create `test/unit/utils/visual-width-cache.test.ts`)

- [ ] **Step 1: Write the test:**

```ts
test("short segments use a dedicated cache and do not evict long-string entries", () => {
	__test__clearVisibleWidthCache();
	visibleWidth("a");            // short cache
	visibleWidth("some long string used for the long entry cache");
	assert.equal(__test__visibleWidthCacheSize(), 1); // only the long entry
	assert.equal(visibleWidth("⏳"), 2); // matches pi-tui width model
	assert.equal(visibleWidth("a"), 1); // still correct on repeat
});
```

Add `__test__clearShortWidthCache()` alongside the existing test helpers if needed.

- [ ] **Step 2: Run** — FAIL (`__test__visibleWidthCacheSize` returns 2 today: both keys share the LRU).

- [ ] **Step 3: Apply the edit:**

```ts
const WIDTH_CACHE_LIMIT = 256;
const widthCache = new Map<string, number>();
// PERF (2026-08-24): truncateToWidth/wrapHard measure ONE codepoint at a time;
// those 1-2 char keys thrashed the 256-entry LRU, evicting every long-string
// entry that could actually hit. Short keys get their own cache (bounded
// alphabet — hit rate ~100%) so the LRU serves only whole lines/segments.
const SHORT_WIDTH_CACHE_LIMIT = 1024;
const shortWidthCache = new Map<string, number>();
```

and inside `visibleWidth`, after the >4096 guard:

```ts
	if (value.length <= 2) {
		const s = shortWidthCache.get(value);
		if (s !== undefined) return s;
		const w = tuiVisibleWidth(value);
		if (shortWidthCache.size >= SHORT_WIDTH_CACHE_LIMIT) {
			const first = shortWidthCache.keys().next().value;
			if (first !== undefined) shortWidthCache.delete(first);
		}
		shortWidthCache.set(value, w);
		return w;
	}
	// …existing LRU path unchanged for length > 2…
```

- [ ] **Step 4: Run** — PASS. Also run `test/unit/ui/` render tests that assert line widths.

- [ ] **Step 5: Commit** — `git commit -am "perf(ui): dedicated short-string width cache"`

### Task 9: listLiveAgents memoized sort, plain compare

**Files:**
- Modify: `src/runtime/live-session/live-agent-manager.ts:300-306` + every site that mutates the `liveAgents` map in this file

- [ ] **Step 1: Read the file** and list all `liveAgents.set/delete/clear` sites.

- [ ] **Step 2: Apply the edit:**

```ts
// PERF (2026-08-24): listLiveAgents is called 4-6x per render frame and used to
// copy + sort with ICU localeCompare every call. ISO-8601 strings are fixed-width
// and sort correctly with plain operators; the sorted array is memoized and
// invalidated at every map mutation.
let sortedLiveAgents: LiveAgentHandle[] | undefined;
function invalidateSortedLiveAgents(): void {
	sortedLiveAgents = undefined;
}
export function listLiveAgents(): LiveAgentHandle[] {
	if (!sortedLiveAgents) {
		sortedLiveAgents = [...liveAgents.values()].sort((a, b) => {
			const au = a.updatedAt ?? "";
			const bu = b.updatedAt ?? "";
			return au < bu ? 1 : au > bu ? -1 : 0;
		});
	}
	return sortedLiveAgents;
}
```

Add `invalidateSortedLiveAgents()` to every `liveAgents` mutation site found in Step 1 (register, unregister, update, evict). Callers get a shared array — grep call sites (`grep -rn "listLiveAgents\|listActiveLiveAgents" src`) and if any site sorts/mutates the result, change it to slice first.

- [ ] **Step 3: Verify** — run live-session tests: `ls test/unit | grep -i live` → run. `npm run typecheck`.

- [ ] **Step 4: Commit** — `git commit -am "perf(live-session): memoize listLiveAgents sort with plain string compare"`

### Task 10: config.ts stats cache mtimes once per load

**Files:**
- Modify: `src/config/config.ts:316-325,383-389`

- [ ] **Step 1: Apply the edit.** In `loadConfig`, change the tail:

```ts
	if (Object.keys(readCacheMtimes(cacheParts)).length > 0) {
		setConfigCache(cacheKey, result, readCacheMtimes(cacheParts));
	}
```

to:

```ts
	// PERF (2026-08-24): readCacheMtimes stats up to 4 files per call and ran
	// twice back-to-back here (guard + store). Compute once.
	const storeMtimes = readCacheMtimes(cacheParts);
	if (Object.keys(storeMtimes).length > 0) {
		setConfigCache(cacheKey, result, storeMtimes);
	}
```

(The hit path at :317 already computes its mtimes once — leave it.)

- [ ] **Step 2: Verify** — config tests: `ls test/unit | grep -i config` → run. `npm run typecheck`.

- [ ] **Step 3: Commit** — `git commit -am "perf(config): single readCacheMtimes pass on the store path"`

---

## Phase B — State persistence

### Task 11: atomic-write dir memoization + lazy stringify in the coalescer

**Files:**
- Modify: `src/state/atomic-write.ts:582-594` (sync mkdir), `:732-735` (async mkdir), `:869-942` (coalescer + flush)
- Test: extend `test/unit/atomic-write-coalesced.test.ts`
- Produces (for Tasks 13, 15): `export function ensureDirSync(dirPath: string): void` in atomic-write.ts.

- [ ] **Step 1: Add the dir memo.** Near the top of the module (after `pendingAtomicWrites` declaration):

```ts
// PERF (2026-08-24): every atomic write ran mkdirSync(recursive) on a parent
// that exists for the lifetime of a run. Memoize known-existing dirs; the memo
// is invalidated on ENOENT at temp-open so a deleted-then-recreated tree is
// handled (and recreated dirs are re-validated by isSymlinkSafeDirCached on
// the NEXT write, which re-runs whenever the path was not seen before).
const knownDirs = new Set<string>();
const KNOWN_DIRS_MAX = 512;
export function ensureDirSync(dirPath: string): void {
	if (knownDirs.has(dirPath)) return;
	fs.mkdirSync(dirPath, { recursive: true });
	if (knownDirs.size >= KNOWN_DIRS_MAX) {
		const oldest = knownDirs.keys().next().value;
		if (oldest !== undefined) knownDirs.delete(oldest);
	}
	knownDirs.add(dirPath);
}
function forgetDir(dirPath: string): void {
	knownDirs.delete(dirPath);
}
```

Replace `fs.mkdirSync(dirPath, { recursive: true });` at :584 with `ensureDirSync(dirPath);` — keeping the surrounding try/catch and the Windows EPERM canonicalize fallback (that fallback only matters when mkdir actually ran; when the memo hit, no throw is possible, so wrapping ensureDirSync in the same try/catch is still correct).

Do the same at :734 for the async path: `ensureDirSync(path.dirname(filePath));` (a sync mkdir on an existing dir is one cheap syscall; replacing `await fs.promises.mkdir` is fine — it does not throw when memoized).

In `atomicWriteFile`, where the temp file is opened (the `fs.openSync(tempPath, …)` call), wrap the open in:

```ts
	let fd: number;
	// …existing open in a try…
```

Add to the existing catch-or-retry structure: if opening the temp throws `ENOENT`, call `forgetDir(path.dirname(filePath))` and retry the `ensureDirSync` + open exactly once. Read the current open block first and apply minimally — if there is no catch around the open, add one that re-throws after the single retry fails.

- [ ] **Step 2: Lazy stringify.** Change the pending-entry shape and the flush:

In `atomicWriteJsonCoalesced` replace:

```ts
	const normalized = normalizeOptions(options);
	const content = `${normalized.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`;
```

with:

```ts
	const normalized = normalizeOptions(options);
	// PERF (2026-08-24): stringify moved to FLUSH time. persistSingleTaskUpdate
	// re-saves every ~500ms per task while the coalesce window is 50ms — callers
	// that keep writing overwrite the pending entry before it ever flushes, so
	// eager stringify burned a full-array serialize per save for nothing.
	// NOTE (semantic): the flushed content reflects the object's state at flush
	// time. All current callers hand us a freshly built array and drop it; if a
	// future caller mutates after queueing, that mutation persists.
```

and the `pendingAtomicWrites.set(filePath, { … })` entry stores `value` + `compact: normalized.compact` instead of `content` (update the `PendingAtomicWrite` type accordingly — keep `content` OUT of the type).

In `flushOnePendingAtomicWrite` build the content just before `atomicWriteFile`:

```ts
	const content = `${entry.compact ? JSON.stringify(entry.value) : JSON.stringify(entry.value, null, 2)}\n`;
	atomicWriteFile(filePath, content, { durability: entry.durability });
```

Grep for other readers of the pending map (`grep -n "pendingAtomicWrites" src/state/atomic-write.ts`) and update any other consumer of `entry.content`.

- [ ] **Step 3: Tests.** Extend `test/unit/atomic-write-coalesced.test.ts`:

```ts
test("coalesced write flushed content equals latest value (lazy stringify)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lazy-"));
	const filePath = path.join(dir, "tasks.json");
	try {
		const obj = { n: 0 };
		for (let i = 1; i <= 5; i++) {
			obj.n = i;
			atomicWriteJsonCoalesced(filePath, obj, 20);
			await new Promise((r) => setTimeout(r, 5));
		}
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).n, 5);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureDirSync memo survives and re-creates a deleted dir (ENOENT retry)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dirmemo-"));
	const filePath = path.join(dir, "a/b/c/file.json");
	try {
		atomicWriteJson(filePath, { x: 1 });
		assert.ok(fs.existsSync(filePath));
		fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
		atomicWriteJson(filePath, { x: 2 }); // must recover via ENOENT retry
		assert.equal(JSON.parse(fs.readFileSync(filePath, "utf-8")).x, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
```

- [ ] **Step 4: Run the file** — PASS, plus pre-existing coalescing tests still pass.

- [ ] **Step 5: Commit** — `git commit -am "perf(state): dir-exists memo + lazy stringify in atomic write coalescer"`

### Task 12: state-store keeps the manifest cache across coalesced task saves; artifacts validation memoized

**Files:**
- Modify: `src/state/stores/state-store.ts:210-243` (validateRunManifestPaths), `:629-640` (saveRunTasksCoalesced)
- Test: `test/unit/state/state-store-artifacts-memo.test.ts` (new) + extend the state-store test file for the cache-keep behavior (`ls test/unit | grep -i state-store`)

- [ ] **Step 1: Cache-keep in saveRunTasksCoalesced.** Replace:

```ts
	// FIX: Invalidate cache BEFORE atomic write to prevent stale cache serving.
	invalidateRunCache(manifest.stateRoot);
	try {
		fs.statSync(manifest.stateRoot);
	} catch {
		return;
	}
	atomicWriteJsonCoalesced(manifest.tasksPath, tasks, undefined, { compact: true }, skipCoalesce);
```

with:

```ts
	// PERF (2026-08-24): invalidating the WHOLE entry made every
	// loadRunManifestById after a coalesced save re-read + re-parse
	// manifest.json (24KB+) even though the manifest file did not change —
	// persistSingleTaskUpdate's next call (~500ms later) always paid it. Keep
	// the manifest half of the entry (mtime/size still verified on read) and
	// zero only the tasks stamps, which is the exact pre-existing signal for
	// "tasks on disk may be stale" (coalesced write not landed yet). Crash
	// safety is unchanged: a zeroed tasks stamp can only cause a miss, never a
	// stale hit. Generation semantics unchanged — setManifestCache stamps the
	// CURRENT generation, so a concurrent writer's bump still invalidates us.
	const cached = manifestCache.get(manifest.stateRoot);
	if (cached) {
		setManifestCache(manifest.stateRoot, { ...cached, tasks, tasksMtimeMs: 0, tasksSize: 0 });
	} else {
		invalidateRunCache(manifest.stateRoot);
	}
	try {
		fs.statSync(manifest.stateRoot);
	} catch {
		return;
	}
	atomicWriteJsonCoalesced(manifest.tasksPath, tasks, undefined, { compact: true }, skipCoalesce);
```

- [ ] **Step 2: Memoize artifacts validation.** Above `validateRunManifestPaths` add:

```ts
// PERF (2026-08-24): the artifacts containment verdict (existsSync + lstat +
// resolveRealContainedPath ≈ 10-25 syscalls) cannot change for a run dir that
// is not replaced — mirror the P1-12 runStateRootCache tradeoff: positive
// verdicts cached 10s, negatives never cached (a newly created artifacts dir
// must be found promptly). A stale positive is safe the same way P1-12 is:
// downstream manifest stat catches deleted runs, and any write through
// atomic-write re-runs isSymlinkSafeDirCached independently.
const artifactsVerdictCache = new Map<string, { expiresAt: number }>();
const ARTIFACTS_VERDICT_TTL_MS = 10_000;
const ARTIFACTS_VERDICT_CACHE_MAX = 256;
```

Inside `validateRunManifestPaths`, wrap the fs-touching block (`if (fs.existsSync(expectedArtifactsRoot)) { … } else if (…) { return true; } return true;` tail) with:

```ts
	const verdictKey = `${cwd}\0${runId}`;
	const cachedVerdict = artifactsVerdictCache.get(verdictKey);
	if (cachedVerdict && cachedVerdict.expiresAt > Date.now()) return true;
	// …existing existsSync/lstat/resolveRealContainedPath logic, and where it
	// would `return true` at the end, first record the positive verdict:
	//   if (artifactsVerdictCache.size >= ARTIFACTS_VERDICT_CACHE_MAX) { evict oldest }
	//   artifactsVerdictCache.set(verdictKey, { expiresAt: Date.now() + ARTIFACTS_VERDICT_TTL_MS });
	// then return true. All `return false` paths clear nothing (negatives are
	// not cached) and simply return.
```

- [ ] **Step 3: Tests.** New file exercising both behaviors via `__test__` exports; add to state-store.ts:

```ts
/** @internal — artifacts verdict cache introspection for unit tests. */
export function __test__artifactsVerdictCacheSize(): number {
	return artifactsVerdictCache.size;
}
/** @internal */
export function __test__clearArtifactsVerdictCache(): void {
	artifactsVerdictCache.clear();
}
```

Test: create a run via the public API (copy fixture setup from an existing state-store test), call `loadRunManifestById` twice → second call returns manifest, `__test__artifactsVerdictCacheSize() === 1`. For cache-keep: `saveRunTasksCoalesced(manifest, tasks)` then `loadRunManifestById` → returns the NEW tasks array and `__test__getManifestCacheEntry(stateRoot)` is defined (was deleted before this fix).

- [ ] **Step 4: Run state-store tests** — PASS (watch specifically for tests asserting old invalidate semantics; update their expectation ONLY if the test's stated intent is cache internals, not behavior).

- [ ] **Step 5: Commit** — `git commit -am "perf(state): keep manifest cache across coalesced saves; memoize artifacts verdict"`

### Task 13: lock pid files drop atomic-write ceremony; seq persist skips when already reserved

**Files:**
- Modify: `src/state/event-log/event-log.ts:331-337` (async lock pid), `:849-857` (persistSequenceMonotonic call site)
- Modify: `src/state/event-log/sequence-cache.ts:215-228` (sync seqlock pid) + export for seqCounters
- Test: extend existing event-log / sequence tests (`ls test/unit | grep -iE "event-log|sequence"`)

**Interfaces:**
- Produces: `export function reservedSequenceEnd(eventsPath: string): number` in sequence-cache.ts (returns `seqCounters.get(eventsPath) ?? 0`).

- [ ] **Step 1: sequence-cache export** — add:

```ts
/** PERF (2026-08-24): callers that just reserved a range can skip the lock+read
 * sidecar round-trip in persistSequenceMonotonic when their value is already
 * covered by the in-process reservation (R16-B1 advance-on-reserve persisted it
 * inside the .seqlock at reservation time). */
export function reservedSequenceEnd(eventsPath: string): number {
	return seqCounters.get(eventsPath) ?? 0;
}
```

- [ ] **Step 2: pid files without ceremony.** In `withEventLogLockAsync` (event-log.ts ~:333) replace:

```ts
				try {
					// P0-4: the lock pid file is disposable stale-lock state; best-effort.
					atomicWriteFile(pidFile, String(process.pid), { durability: "best-effort" });
				} catch {
					/* best-effort */
				}
```

with:

```ts
				try {
					// PERF (2026-08-24): "wx" (O_CREAT|O_EXCL) — fails rather than
					// following a planted symlink, so no O_NOFOLLOW/temp/rename
					// ceremony needed for this disposable, mtime-stale-detected
					// 4-byte file. We own the lock dir (we just mkdir'd it), so
					// EEXIST means a crashed holder's leftover under OUR fresh dir
					// or an attack — either way, skip: the dir itself is the mutex.
					const fh = await fs.promises.open(pidFile, "wx");
					try {
						await fh.write(String(process.pid));
					} finally {
						await fh.close();
					}
				} catch {
					/* best-effort */
				}
```

Apply the identical sync version in `withSeqLock` (sequence-cache.ts ~:225):

```ts
			try {
				const fd = fs.openSync(pidFile, "wx");
				try {
					fs.writeSync(fd, String(process.pid));
				} finally {
					fs.closeSync(fd);
				}
			} catch {
				/* best-effort — see withEventLogLockAsync note */
			}
```

Remove the now-unused `atomicWriteFile` import if nothing else in each file uses it (grep first).

- [ ] **Step 3: Skip redundant monotonic persist.** At the buffered-flush call site (event-log.ts ~:853, above `persistSequenceMonotonic(eventsPath, lastSeq);`) add:

```ts
				// PERF (2026-08-24): R16-B1 advance-on-reserve already persisted the
				// reserved end inside the .seqlock at reservation time. Re-acquiring
				// the seqlock (~12 syscalls) to conclude "no write needed" is pure
				// overhead in the single-writer common case.
				if (lastSeq > reservedSequenceEnd(eventsPath)) {
					persistSequenceMonotonic(eventsPath, lastSeq);
				}
```

(import `reservedSequenceEnd` alongside the existing sequence-cache imports).

- [ ] **Step 4: Run the event-log + sequence test files** — PASS. Add one test asserting sidecar correctness after a buffered flush:

```ts
test("buffered append leaves .seq sidecar at the flushed last seq", async () => {
	// existing fixtures in the nearest event-log test file: create eventsPath via
	// the module's public append API (buffered), await flush (or call the exported
	// flush), then read the .seq sidecar and assert it equals the last event's seq.
});
```

- [ ] **Step 5: Commit** — `git commit -am "perf(event-log): ceremony-free lock pid files; skip redundant monotonic seq persist"`

### Task 14: event-log append path — single pre-append stat; sequenceCache upkeep gated

**Files:**
- Modify: `src/state/event-log/event-log.ts:744-753,826,857` (batch inside-lock), `:905-1017` (sync inside-lock), `:647-671` (post-append sequenceCache upkeep)

- [ ] **Step 1: Read** `src/state/event-log/event-log.ts:700-1020` fully before editing — this is the most comment-dense file in the plan.

- [ ] **Step 2: Collapse pre-append stats.** In both `appendEventInsideLock` and `appendEventBatchInsideLock`, every `if (fs.existsSync(eventsPath)) { const stat = fs.statSync(eventsPath); …}` pair that runs BEFORE the append is replaced by one hoisted stat at the top of the lock body:

```ts
	let preStat: fs.Stats | undefined;
	try {
		preStat = fs.statSync(eventsPath);
	} catch {
		/* log absent — first append */
	}
```

and the former pairs become `if (preStat) { … preStat.size … }`. Do NOT touch the POST-append rotation check (`size > MAX_EVENTS_BYTES`) — it legitimately needs a fresh stat; if it currently reuses a pre-append stat it must switch to its own `fs.statSync` after the append (read carefully: rotation must see the size INCLUDING the just-appended line).

- [ ] **Step 3: Gate sequenceCache upkeep.** Grep `nextSequence(` and `sequenceCache` readers across src. If (per review) the only hot reader is `nextSequence` used solely by seeding/tests: add a module flag in event-log.ts:

```ts
// PERF (2026-08-24): the per-append sequenceCache upkeep (extra stat + Map set +
// occasional O(n log n) evict sort) fed no hot reader — nextSequence is used by
// the seeding/cold path only. Upkeep now runs lazily: nextSequence() rebuilds
// from the .seq sidecar scan when the cache is cold (its pre-existing fallback).
let sequenceCacheTracking = false;
```

Wrap the post-append upkeep blocks (`statResult`/`evictOldestSequenceCacheEntries`/`sequenceCache.set` at ~:647-671 and the sync twin ~:1000-1017) in `if (sequenceCacheTracking) { … }`, and set `sequenceCacheTracking = true` at the top of whatever export seeds the cache (find the seeding entry point; if none exists because the cache is only ever populated by these upkeep blocks, then instead DELETE the upkeep blocks and make `nextSequence` rely on its sidecar/scan fallback — grep decides which branch; take the delete branch only if zero non-test readers of populated cache state exist).

- [ ] **Step 4: Run** all event-log tests: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=180000 test/unit/state/event-log.test.ts` (path per `ls test/unit -R | grep event-log`), plus `npm run test:unit` once for this phase's regression sweep.

- [ ] **Step 5: Commit** — `git commit -am "perf(event-log): hoist pre-append stat; gate cold-path sequenceCache upkeep"`

### Task 15: withFileLockSync uses the cached symlink verdict pre-loop

**Files:**
- Modify: `src/state/coordination/locks.ts:418-446`
- Consumes: `isSymlinkSafeDirCached` (atomic-write.ts — verify export name with grep), `ensureDirSync` (Task 11).

- [ ] **Step 1: Apply the edit.** Replace:

```ts
	if (!isSymlinkSafePath(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
```

with:

```ts
	// PERF (2026-08-24): pre-loop check uses the 10s-TTL cached verdict (same
	// tradeoff atomic writes already make). The RETRY loop below keeps the
	// UNCACHED re-validation — TOCTOU rigor is preserved exactly where a race
	// is actually being retried.
	if (!isSymlinkSafeDirCached(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
	ensureDirSync(path.dirname(lockFile));
```

Leave the in-loop `if (!isSymlinkSafePath(…))` at :438 untouched.

- [ ] **Step 2: Verify** — locks tests: `ls test/unit | grep -i lock` → run; the security-oriented symlink tests must still pass (the pre-loop cached check still throws for symlinked parents on first sight).

- [ ] **Step 3: Commit** — `git commit -am "perf(state): cached symlink verdict on the lock pre-check"`

### Task 16: mailbox reads are stat-gated

**Files:**
- Modify: `src/state/coordination/mailbox.ts` (`safeReadMailboxFile`/`readMailboxFile` internals — read `:300-345` first)
- Test: `test/unit/state/mailbox-stat-gate.test.ts` (new)

**Interfaces:** none changed publicly.

- [ ] **Step 1: Write the failing test:**

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
// import readMailbox + appendMailboxMessage + a manifest fixture builder used by
// neighboring mailbox tests (copy their setup).

test("mailbox reads are stat-gated: unchanged file is not re-parsed, append invalidates", () => {
	// build run dir + manifest fixture
	// 1) append one message → readAllMailboxMessages returns [msg]
	// 2) read again → returns same message (cache hit — assert by content AND
	//    by instrumenting: temporarily wrap fs.readFileSync via node:test mock
	//    (`t.mock.method(fs, "readFileSync")`) and assert the mailbox file path
	//    was NOT read on the second call
	// 3) append second message → read returns both (mtime changed → re-read)
});
```

- [ ] **Step 2: Run** — FAIL (second read hits readFileSync).

- [ ] **Step 3: Apply the edit.** In mailbox.ts add:

```ts
// PERF (2026-08-24): parked workers poll all mailboxes every 500ms and used to
// read+parse every file each tick. Parse results are now memoized per file by
// (mtime, size); append/rotate change mtime so invalidation is automatic.
// Entries hold the parsed array; readers get a shallow copy (array of refs) —
// 100x cheaper than re-reading, and callers never mutate message objects.
const mailboxParseCache = new Map<string, { mtimeMs: number; size: number; messages: MailboxMessage[] }>();
const MAILBOX_PARSE_CACHE_MAX = 128;
function cachedMailboxRead(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		mailboxParseCache.delete(filePath);
		return [];
	}
	const hit = mailboxParseCache.get(filePath);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.messages.slice();
	const messages = parseMailboxFile(filePath, direction); // the existing per-file read+parse body, extracted verbatim
	if (mailboxParseCache.size >= MAILBOX_PARSE_CACHE_MAX) {
		const oldest = mailboxParseCache.keys().next().value;
		if (oldest !== undefined) mailboxParseCache.delete(oldest);
	}
	mailboxParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
	return messages.slice();
}
```

Refactor the existing read body of `safeReadMailboxFile`/`readMailboxFile` so the raw read+parse becomes `parseMailboxFile(filePath, direction)` and the public path goes through `cachedMailboxRead`. Rotation (`rotateMailboxFileIfNeeded`) renames then re-creates via `atomicWriteFile(filePath, "")` — mtime changes, cache self-invalidates; the archive walk may also route through `cachedMailboxRead` (archives are immutable once written — they will permanently hit).

- [ ] **Step 4: Run** — PASS + existing mailbox tests.

- [ ] **Step 5: Commit** — `git commit -am "perf(state): stat-gated mailbox parse cache"`

---

## Phase C — UI hot paths

### Task 17: fs.watch runs through the coalesced async refresh

**Files:**
- Modify: `src/ui/run-snapshot-cache.ts:1051-1100` (expose scheduleRefresh in the returned API)
- Modify: `src/extension/registration/lifecycle-handlers.ts:685` and `:934`
- Test: `test/unit/ui/run-snapshot-coalesced-refresh.test.ts` (new)

**Interfaces:**
- Produces: `RunSnapshotCache.scheduleRefresh(runId: string): void` — 80ms-debounced, async, in-flight-deduped refresh (the internal `scheduleRefresh` closure becomes public API; rename the closure to `scheduleCoalescedRefresh` and expose a public method of the same behavior).

- [ ] **Step 1: Write the failing test:**

```ts
test("scheduleRefresh coalesces bursts into one async rebuild", async () => {
	// Build a cache over a real run fixture (copy from the nearest run-snapshot
	// test). Spy the public get() stamps: fire scheduleRefresh(runId) 5x in a
	// tight loop; await ~200ms; assert the snapshot was rebuilt at most twice
	// (once from the coalesced timer) — instrument by patching Date.now around
	// entries' fetchedAt, or simpler: patch loadRunManifestById via t.mock and
	// count calls (≤2).
});
```

- [ ] **Step 2: Apply the edits.**

In run-snapshot-cache.ts: rename the internal closure `scheduleRefresh` → `scheduleCoalescedRefresh` (update its two uses in the event-bus subscriptions), and add to the returned object:

```ts
		/**
		 * PERF (2026-08-24): watcher-facing refresh. The fs.watch path used to
		 * call the SYNC refresh() directly on every file event — a full
		 * snapshot rebuild (manifest+tasks parse, agents.json, mailbox readdir,
		 * per-agent tail reads, 2x stringify+sha256) many times per second,
		 * blocking the UI event loop. This routes through the same 80ms
		 * coalesced → async (preloadStale) pipeline the run event bus uses.
		 * FLICKER FIX semantics preserved: buildAsync re-sets the entry in
		 * place; nothing is deleted.
		 */
		scheduleRefresh(runId: string): void {
			scheduleCoalescedRefresh(runId);
		},
```

In lifecycle-handlers.ts at BOTH `:685` and `:934`, replace `.refresh(runId);` with `.scheduleRefresh(runId);` (keep the surrounding try/catch and `renderScheduler?.schedule({ runId })` line — the render schedule makes the UI repaint while the async rebuild lands).

- [ ] **Step 3: Run** the new test + existing snapshot tests (`ls test/unit | grep -i snapshot`), then `test/unit/ui/transcript-viewer-debounce.test.ts` as the pattern sibling.

- [ ] **Step 4: Commit** — `git commit -am "perf(ui): coalesced async refresh on the fs.watch path"`

### Task 18: transcript viewer wraps only the visible tail

**Files:**
- Modify: `src/utils/visual.ts` (new `truncateToVisualLinesTail`)
- Modify: `src/ui/transcript-viewer.ts:239-250` (`renderViewerBase`) + `ViewerState`
- Test: `test/unit/utils/visual-tail-window.test.ts` (new)

**Interfaces:**
- Produces: `truncateToVisualLinesTail(text: string, maxVisualLines: number, width: number, paddingX?: number): VisualTruncateResult` — returns the SAME trailing visual lines as `truncateToVisualLines`, computing `skippedCount` as a lower bound (source lines skipped, unwrapped).

- [ ] **Step 1: Write the property test:**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { truncateToVisualLines, truncateToVisualLinesTail } from "../../src/utils/visual.ts";

const CASES = [
	"single line",
	"a\nb\nc",
	`${"x".repeat(200)}\n${"y".repeat(3)}\nshort`,          // wide line wraps
	Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n"), // long tail
	`${"⏳ ".repeat(80)}\nfinal`,                            // wide graphemes
];

for (const [i, text] of CASES.entries()) {
	test(`tail window matches full wrap tail (case ${i})`, () => {
		for (const limit of [1, 4, 16, 50]) {
			const full = truncateToVisualLines(text, limit, 60);
			const tail = truncateToVisualLinesTail(text, limit, 60);
			assert.deepEqual(tail.visualLines, full.visualLines);
			assert.ok(tail.skippedCount <= full.skippedCount, "skipped is a lower bound");
		}
	});
}
```

- [ ] **Step 2: Run** — FAIL (function missing).

- [ ] **Step 3: Implement in visual.ts:**

```ts
/**
 * PERF (2026-08-24): tail-windowed twin of truncateToVisualLines. Wraps lines
 * from the END backwards and stops as soon as `maxVisualLines` visual lines
 * exist — O(visible window) instead of O(whole transcript). `skippedCount`
 * counts skipped SOURCE lines (a lower bound on skipped visual lines; the
 * caller's total display therefore reads "≥ N lines" when scrolled to bottom).
 */
export function truncateToVisualLinesTail(text: string, maxVisualLines: number, width: number, paddingX = 0): VisualTruncateResult {
	if (!text) return { visualLines: [], skippedCount: 0 };
	const effectiveWidth = Math.max(1, width - paddingX * 2);
	const limit = Math.max(1, maxVisualLines);
	const sourceLines = text.split("\n");
	const wrapped: string[][] = [];
	let collected = 0;
	let index = sourceLines.length - 1;
	while (index >= 0 && collected < limit) {
		const w = wrapHard(pad(sourceLines[index]!, Math.max(0, effectiveWidth)).trimEnd(), effectiveWidth);
		wrapped.push(w);
		collected += w.length;
		index -= 1;
	}
	const visualLines = wrapped.reverse().flat().slice(-limit);
	return { visualLines, skippedCount: index + 1 };
}
```

- [ ] **Step 4: Use it in the viewer.** In `renderViewerBase` (transcript-viewer.ts) add to `ViewerState`: `fullVisual: string[] | null; sourceLen: number;`. Replace the body opening:

```ts
	const inner = Math.max(20, width - 4);
	const bodyText = lines.join("\n");
	const { visualLines, skippedCount } = truncateToVisualLines(bodyText, state.lastHeight, inner);
	const maxScroll = Math.max(0, visualLines.length - state.lastHeight);
	if (state.autoScroll) state.scroll = maxScroll;
	state.scroll = Math.min(state.scroll, maxScroll);
	const visible = visualLines.slice(state.scroll, state.scroll + state.lastHeight);
```

with:

```ts
	const inner = Math.max(20, width - 4);
	// PERF (2026-08-24): transcripts grow to thousands of lines; wrapping every
	// grapheme of the whole tail to display 16 rows was the largest CPU sink in
	// the UI. Bottom-pinned (autoScroll) renders use the tail window; scrolling
	// up materializes the full wrap once and reuses it until new lines arrive.
	const bodyText = lines.join("\n");
	let visualLines: string[];
	let skippedCount: number;
	let maxScroll: number;
	if (state.autoScroll && (state.fullVisual === null || state.sourceLen !== lines.length)) {
		const tail = truncateToVisualLinesTail(bodyText, state.lastHeight, inner);
		visualLines = tail.visualLines;
		skippedCount = tail.skippedCount;
		maxScroll = skippedCount; // bottom-pinned: everything above the window
		state.fullVisual = null;
		state.sourceLen = lines.length;
	} else {
		if (state.fullVisual === null || state.sourceLen !== lines.length) {
			const full = truncateToVisualLines(bodyText, Number.MAX_SAFE_INTEGER, inner);
			state.fullVisual = full.visualLines;
			state.sourceLen = lines.length;
		}
		visualLines = state.fullVisual!;
		skippedCount = 0;
		maxScroll = Math.max(0, visualLines.length - state.lastHeight);
	}
	if (state.autoScroll) state.scroll = maxScroll;
	state.scroll = Math.min(state.scroll, maxScroll);
	const visible = visualLines.slice(state.scroll, state.scroll + state.lastHeight);
```

Note the status line below uses `visualLines.length` — in the tail branch replace that expression with `skippedCount + visible.length` so the counter stays meaningful (add a `≥` prefix only if the existing tests permit; otherwise leave the number and a code comment). Read the status-line construction right below and adjust consistently. Also find where `ViewerState` instances are created and initialize `fullVisual: null, sourceLen: 0`.

- [ ] **Step 5: Run** the property test + `test/unit/ui/transcript-viewer-debounce.test.ts` + any transcript-viewer render tests. Fix the viewer's own golden tests if the status-line count semantics changed (update expected strings, noting the reason in the test).

- [ ] **Step 6: Commit** — `git commit -am "perf(ui): tail-windowed transcript wrap for bottom-pinned renders"`

### Task 19: transcript-cache reads incrementally

**Files:**
- Modify: `src/ui/transcript-cache.ts:80-130` (read the whole file first)
- Test: `test/unit/ui/transcript-cache-incremental.test.ts` (new)

- [ ] **Step 1: Read the file.** Locate the read path (`readTranscriptText`) and the cache entry shape (`{ mtimeMs, size, text }` or similar per the review).

- [ ] **Step 2: Write the failing test** — using `t.mock.method(fs, "readFileSync")` (or the async reader it uses) to count bytes read:

```ts
test("growing transcript reads only the appended bytes", async () => {
	// write 10KB transcript; read (full) → note call count/bytes
	// append 1KB; read again → assert only ~1KB read (open at offset — assert via
	// mock: exactly one read call whose length ≈ appended size, or position arg)
	// shrink the file (rotation) → read → full re-read happens (correctness)
});
```

- [ ] **Step 3: Apply the edit.** In the read function, when the cache entry exists and the new stat shows `size > entry.size && mtimeMs >= entry.mtimeMs` (append-only growth), read only `[entry.size, size)` and concatenate `entry.text + delta`; otherwise full read. Use `fs.openSync(path, "r")` + `fs.readSync(fd, buf, 0, len, position)` (or the async twin if the reader is async). Cap the accumulated cache text at the existing 256KB bound by trimming from the FRONT (keep the tail), same as today's tail cap.

- [ ] **Step 4: Run** — PASS; run `test/unit/ui/transcript-viewer-debounce.test.ts` and neighbors.

- [ ] **Step 5: Commit** — `git commit -am "perf(ui): incremental byte-offset transcript reads"`

### Task 20: dashboard resolves snapshots once per frame

**Files:**
- Modify: `src/ui/run-dashboard.ts:520-710` (read first)

- [ ] **Step 1: Read** `src/ui/run-dashboard.ts:510-710` and map every `snapshotFor(…)`/`agentsFor(…)`/`groupedRuns(…)` call in the render path (review counted 6-8 per frame across `:535, :582, :658, :671, :685, :697`).

- [ ] **Step 2: Apply the edit.** At the top of the render entry (`renderUnsafe` or equivalent):

```ts
	// PERF (2026-08-24): snapshot resolution stat'd 7-8 files per run 6-8 times
	// per frame. Resolve once per frame into a local map and thread it through.
	const frameSnapshots = new Map<string, RunUiSnapshot>();
	const snapshotOnce = (runId: string): RunUiSnapshot | undefined => {
		if (!frameSnapshots.has(runId)) frameSnapshots.set(runId, snapshotFor(runId));
		return frameSnapshots.get(runId);
	};
```

Replace the render-path call sites to use `snapshotOnce(...)`/the map (including `runLabel`'s `agentsFor` if it resolves via the snapshot). `groupedRuns` should be computed once into a local and reused by `:658/:671/:697` consumers. Do NOT change `refreshRuns` at `:535` semantics — only reuse its result.

- [ ] **Step 3: Verify** — dashboard tests: `ls test/unit | grep -i dashboard` → run; plus `test:critical` subset touching pi-tui parity (`node --experimental-strip-types --test --test-concurrency=1 test/unit/ui/pi-tui-dispatch-probe.test.ts`).

- [ ] **Step 4: Commit** — `git commit -am "perf(ui): resolve run snapshots once per dashboard frame"`

### Task 21: UI micro-cleanups (4 independent edits)

**Files:**
- Modify: `src/ui/widget/index.ts:334,380` (truncate-once)
- Modify: `src/ui/run-dashboard.ts:634` (border hoist)
- Modify: `src/ui/inline-panel/agent-pane.ts:369-374` (dispose reset) + `src/ui/inline-panel/agent-transcript.ts:320`
- Modify: `src/ui/run-snapshot-cache.ts:560-615` (single delivery/outbox read)

- [ ] **Step 1 (truncate-once).** In widget/index.ts `:380` (and the tasks variant `:334`), the cached-lines getter re-truncates every line on every render. Move truncation into the cache BUILD (store lines already truncated for the width at build time), keep a `lastTruncateWidth` in state, and only re-truncate the stored raw lines when the width changed:

```ts
	// PERF (2026-08-24): truncate at build time, re-truncate only on width
	// change — cache hits returned a fresh array + ANSI-aware width measurement
	// per line on every frame.
```

- [ ] **Step 2 (border hoist).** At run-dashboard.ts `:634` hoist a single `const border = new DynamicCrewBorder(this.theme)` per render pass and reuse `border.render(count)[0]` in the separator lambda (the class caches widths internally per instance — per-line instantiation defeated it).

- [ ] **Step 3 (dispose reset).** In `agent-pane.ts` `dispose()` add `resetAgentTranscriptCursor(taskId)` (import from `agent-transcript.ts`, matching its export name — grep first). This frees the per-task ring buffer (≤500 items with full message bodies) when a pane closes instead of retaining it for process lifetime.

- [ ] **Step 4 (single delivery read).** In run-snapshot-cache.ts `build()`, `mailboxFrom` (`:592`) and `groupJoinsFrom` (`:567`) each read+parse `delivery.json`, and both tail `outbox.jsonl`. Read both ONCE in `build()` and pass the parsed values in (adjust both function signatures — module-private, so no external ripple; grep for other callers first and update them).

- [ ] **Step 5: Run** the widget/dashboard/inline-panel test files + `npm run typecheck`.

- [ ] **Step 6: Commit** — `git commit -am "perf(ui): truncate-once widget cache, hoisted border, pane dispose cleanup, single delivery read"`

---

## Phase D — Runtime, broker, extension

### Task 22: broker msg.send fans out recipients concurrently

**Files:**
- Modify: `src/runtime/broker/crew-broker.ts:868-896`

- [ ] **Step 1: Apply the edit.** Replace the sequential loop:

```ts
		try {
			for (const recipient of recipients) {
				await appendMailboxMessageAsync(manifest, { … });
			}
			durable = true;
		} catch (err) {
			this.sendError(conn, id, "durable-failed", (err as Error).message);
			return;
		}
```

with chunked concurrency (chunks keep lock contention and fd usage bounded; per-recipient files are independent, the shared delivery.json RMW is serialized by its own file lock):

```ts
		try {
			// PERF (2026-08-24): to:"all" with 50 tasks used to run 50 sequential
			// awaited locked appends (~70 syscalls + 2 fsync each) while the
			// connection's frames queued behind it. Chunked fan-out — independent
			// mailbox files append concurrently; delivery.json stays serialized by
			// its own lock.
			const CHUNK = 8;
			for (let i = 0; i < recipients.length; i += CHUNK) {
				const results = await Promise.allSettled(
					recipients.slice(i, i + CHUNK).map((recipient) =>
						appendMailboxMessageAsync(manifest, {
							id: `${messageId}_${recipient}`,
							direction: "inbox",
							from: fromField,
							to: recipient,
							taskId: recipient,
							body: bodyJson,
							kind: parsed.kind ?? "message",
							priority: parsed.priority ?? "normal",
							deliveryMode: "next_turn",
							replyTo: parsed.replyTo,
						}),
					),
				);
				const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
				if (failure) throw failure.reason;
			}
			durable = true;
		} catch (err) {
			this.sendError(conn, id, "durable-failed", (err as Error).message);
			return;
		}
```

- [ ] **Step 2: Run the broker critical suite** — `npm run test:critical` (it includes crew-broker handshake/stale-socket/mailbox-observer tests).

- [ ] **Step 3: Add one correctness test** in the nearest broker mailbox test file: `msg.send to:["a","b","c"]` → all three task inboxes contain the message with distinct ids.

- [ ] **Step 4: Commit** — `git commit -am "perf(broker): chunked concurrent msg.send fan-out"`

### Task 23: manifest-cache stat storm removal

**Files:**
- Modify: `src/runtime/manifest-cache.ts:46,225-340` + watcher block `:342+`
- Test: extend `test/unit/manifest-cache-ttl.test.ts`

- [ ] **Step 1: Read** `src/runtime/manifest-cache.ts` fully (it is ~400 lines) — especially `collectRoots`, `parseManifestIfChanged`, `CachedManifest` shape, and the fs.watch handler.

- [ ] **Step 2: Apply three edits.**

(a) **Stat short-TTL inside parseManifestIfChanged:** add `statCheckedAtMs: number` to `CachedManifest`; at the top of the function, if `cached` exists and `Date.now() - cached.statCheckedAtMs < 250`, return `cached` WITHOUT statting. On any real stat path, set `statCheckedAtMs = Date.now()` on the stored entry. (fs.watch-driven invalidation of a specific run must bypass this — see (c).)

(b) **Directory-listing cache:** in `collectRoots`, cache the `readdirSync` result per root keyed by the root dir's own mtimeMs (one `statSync` of the root replaces the readdir when unchanged):

```ts
	// PERF (2026-08-24): list() runs on every 500ms TTL expiry and re-readdir'd
	// every run root; the root's own mtime only changes when run dirs are
	// added/removed — cache the listing against it.
	const dirListCache = new Map<string, { mtimeMs: number; entries: Dirent[] }>();
```

(c) **Watcher granularity:** in the fs.watch handler, when the event carries a filename that matches a run dir name, refresh only that run: `parseManifestIfChanged(root, filename, path.join(root, filename, "manifest.json"), manifestIndex.get(filename), /* forceStat */ true)` — bypassing the 250ms stat TTL — and mark `listCache`/`listActiveCache` expired so the next `list()` re-sorts. Only fall back to the current wholesale `scheduleListRefresh` when no filename is available. `parseManifestIfChanged` gains a `forceStat` parameter for this.

(d) **Plain sort:** `(a, b) => (b.createdAt ?? "") < (a.createdAt ?? "") ? -1 : (b.createdAt ?? "") > (a.createdAt ?? "") ? 1 : 0` at `:261` (and the listActive sort if present) — ISO-8601 fixed-width strings sort correctly without localeCompare.

- [ ] **Step 3: Extend the TTL test:** (1) two `list()` calls within 250ms with no watcher events → second call performs no manifest stats (assert via `t.mock.method(fs, "statSync")` counting only manifest.json paths); (2) watcher event with filename=runA updates runA and expires the list; (3) createdAt ordering unchanged.

- [ ] **Step 4: Run** `test/unit/manifest-cache-ttl.test.ts` + any run-listing tests (`grep -rln "listRuns\|manifestCache" test/unit | head` → run those files).

- [ ] **Step 5: Commit** — `git commit -am "perf(runtime): per-run watcher deltas + stat TTL in manifest cache"`

### Task 24: team-tool read-path costs

**Files:**
- Modify: `src/extension/team-tool/status.ts:152`
- Modify: `src/extension/team-tool/inspect.ts:23` (+ its param plumbing if a limit option exists)
- Modify: `src/extension/team-tool.ts:127,627-657`
- Modify: `src/extension/registration/team-tool.ts:232-236`

- [ ] **Step 1 (status event tail).** Read `readEventsCursor`'s signature (`grep -n "export function readEventsCursor" src/state/event-log/*.ts`) and at status.ts `:152` pass the tail-limit option it supports (`{ limit: 500 }` — or the closest equivalent; if only `sinceSeq` exists, read the manifest's last-known seq field if one exists and use it; if neither exists, leave `:152` unchanged and note it in the commit body). The downstream filters (`ackTimeoutRequestIds`, `attentionByTask`) intentionally operate on the recent window now — add a one-line comment saying so.

- [ ] **Step 2 (inspect events cap).** In inspect.ts `:23`, if the events reader supports a limit/tail, default it to the last 500 events unless the tool call explicitly asks for full history (check the action's params for an existing flag). Otherwise skip with a note.

- [ ] **Step 3 (locateRunCwd cache).** Wrap `locateRunCwd` (team-tool.ts `:630`):

```ts
// PERF (2026-08-24): a stale/typo'd runId from a looping LLM caller paid the
// full 1000-entry directory sweep on EVERY attempt. Resolution results (hits
// AND misses) are cached briefly; TTL bounds staleness for runs created in a
// sibling cwd after a cached miss.
const runCwdCache = new Map<string, { cwd: string | undefined; expiresAt: number }>();
const RUN_CWD_TTL_MS = 30_000;
const RUN_CWD_CACHE_MAX = 128;
export function locateRunCwd(runId: string, baseCwd: string): string | undefined {
	const key = `${baseCwd}\0${runId}`;
	const cached = runCwdCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.cwd;
	const cwd = locateRunCwdUncached(runId, baseCwd); // original body, renamed
	if (runCwdCache.size >= RUN_CWD_CACHE_MAX) {
		const oldest = runCwdCache.keys().next().value;
		if (oldest !== undefined) runCwdCache.delete(oldest);
	}
	runCwdCache.set(key, { cwd, expiresAt: Date.now() + RUN_CWD_TTL_MS });
	return cwd;
}
```

(Rename the original function to `locateRunCwdUncached`; keep its doc comment.)

- [ ] **Step 4 (listRuns slice-at-source).** Read `src/extension/run-index.ts:95-115` for `listRuns`' signature. If it accepts a cap/maxEntries, change team-tool.ts `:127` from `listRuns(ctx.cwd).slice(0, 10)` to pass the cap (e.g. `listRuns(ctx.cwd, { maxEntries: 50 })` — use the real param shape). If no cap exists, add one to `collectRuns` following the existing slice-at-source path the review found at run-index.ts:106.

- [ ] **Step 5 (widget refresh gating).** In registration/team-tool.ts `:232-236`, gate the unconditional `updateCrewWidget(...)` + `updatePiCrewPowerbar(...)` on mutating actions only:

```ts
	// PERF (2026-08-24): cheap read actions (status/summary/events/get/list)
	// re-rendered the widget + powerbar after every call; the event bus and
	// render tick already reflect run-state changes. Refresh only on actions
	// that mutate run state outside the watched files.
	const MUTATING_ACTIONS = new Set(["run", "cancel", "resume", "steer", "cleanup", "forget", "prune", "create", "update", "delete", "config"]);
	if (MUTATING_ACTIONS.has(action)) {
		updateCrewWidget(…); // same args as today
		updatePiCrewPowerbar(…);
	}
```

(Cross-check the action names against the dispatcher table in `src/schema/team-tool-schema.ts:381-432` and adjust the set.)

- [ ] **Step 6: Run** team-tool tests: `ls test/unit | grep -iE "team-tool|run-action"` → run those files; `npm run typecheck`.

- [ ] **Step 7: Commit** — `git commit -am "perf(ext): cached run cwd resolution, bounded event tails, gated widget refresh"`

### Task 25: worktree sync path memoizes git probes

**Files:**
- Modify: `src/worktree/worktree-manager.ts:145-230` (async caches — read as the template), `:715-883` (sync path)

- [ ] **Step 1: Read** `src/worktree/worktree-manager.ts:140-230` (the `_gitRootCache`/`_cleanLeaderCache` async implementations) and `:715-885` (the sync path using `execFileSync`).

- [ ] **Step 2: Mirror the caches for the sync path** (module scope, next to the async ones):

```ts
// PERF (2026-08-24): the sync path (prepareTaskWorkspace — per task!) ran
// findGitRoot (rev-parse spawn) + assertCleanLeader (status --porcelain spawn)
// on every call, and the reuse path ran assertCleanLeader twice. Mirror the
// async caches with a short TTL: same repoRoot → same answer within a run.
const syncGitRootCache = new Map<string, string>();
const syncCleanLeaderCache = new Map<string, { clean: boolean; expiresAt: number }>();
const SYNC_WT_CACHE_TTL_MS = 30_000;
```

Wire `findGitRoot`'s sync variant and `assertCleanLeader`'s sync variant through these caches (key by the input cwd / repoRoot respectively), mirroring the async cache invalidation behavior (if the async caches invalidate on anything — mirror that too).

- [ ] **Step 3: Throttle per-task prune.** Find `pruneStaleWorktrees` (the `git worktree prune` at ~`:825`) and gate it per repoRoot:

```ts
	// PERF (2026-08-24): worktree prune is a repo-level write; running it per
	// task in a 50-task run is 50 prunes. At most once per repoRoot per minute.
const lastPruneAt = new Map<string, number>();
const PRUNE_MIN_INTERVAL_MS = 60_000;
function pruneStaleWorktreesThrottled(repoRoot: string): void {
	const last = lastPruneAt.get(repoRoot) ?? 0;
	if (Date.now() - last < PRUNE_MIN_INTERVAL_MS) return;
	lastPruneAt.set(repoRoot, Date.now());
	pruneStaleWorktrees(repoRoot); // original body
}
```

Update the call site. Keep the failure-path cleanup semantics identical.

- [ ] **Step 4: Run** worktree tests: `ls test/unit | grep -i worktree` → run. These cover reuse/cleanup paths that must not regress.

- [ ] **Step 5: Commit** — `git commit -am "perf(worktree): memoized sync git probes + throttled per-repo prune"`

### Task 26: live-session batched writers + bounded stdout + gated control poll

**Files:**
- Modify: `src/runtime/output/sidechain-output.ts:15-22`
- Modify: `src/runtime/live-session/live-session-runtime.ts:918-960` (append path), `:187-195` (stdout +=), and `src/runtime/live-session/live-agent-control.ts:54-71` (500ms poll)
- Modify: `src/runtime/background-runner.ts:226` (250ms guard poll)
- Test: `test/unit/runtime/live-session-batched-writes.test.ts` (new)

- [ ] **Step 1: Batch the sidechain writer.** Read `src/runtime/child-pi/child-pi-transcript.ts:30-90` (the 50ms per-path batched writer) and reuse its pattern in sidechain-output.ts:

```ts
// PERF (2026-08-24): one mkdirSync + appendFileSync + full redaction clone PER
// STREAMING EVENT (message_update fires per chunk). Batch per path on a 50ms
// unref'd timer like child-pi-transcript; redaction still runs per event at
// queue time (cheap marker scan) and serialization at flush time.
const pendingSidechain = new Map<string, { lines: string[]; timer: NodeJS.Timeout }>();
const SIDECHAIN_FLUSH_MS = 50;
export function writeSidechainEntry(filePath: string, entry: Omit<SidechainEntry, "isSidechain" | "timestamp">): void {
	const line = `${JSON.stringify(redactSecrets({ isSidechain: true, timestamp: new Date().toISOString(), ...entry }))}\n`;
	const pending = pendingSidechain.get(filePath);
	if (pending) {
		pending.lines.push(line);
		return;
	}
	const timer = setTimeout(() => flushSidechain(filePath), SIDECHAIN_FLUSH_MS);
	timer.unref();
	pendingSidechain.set(filePath, { lines: [line], timer });
}
function flushSidechain(filePath: string): void {
	const pending = pendingSidechain.get(filePath);
	if (!pending) return;
	pendingSidechain.delete(filePath);
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, pending.lines.join(""), "utf-8");
	} catch (error) {
		logInternalError("sidechain-output.flush", error, filePath); // match the module's existing error logger, or add one
	}
}
/** @internal — flush on process exit / session close. */
export function flushPendingSidechainWrites(): void {
	for (const filePath of [...pendingSidechain.keys()]) flushSidechain(filePath);
}
```

Grep callers of `writeSidechainEntry` and of the transcript append in live-session-runtime.ts `:922-930` — route the transcript append through the same batching (either export the child-pi batched writer if it is generic over paths, or add the identical map in this module for `appendTranscript`). Register `flushPendingSidechainWrites` wherever live-session tears down (grep `dispose`/`close` in live-session-runtime.ts) and in the process-exit path if one exists there.

- [ ] **Step 2: Bound stdout.** Find `stdout += \`${text}\n\`` (live-session-runtime.ts ~`:187-195`). Replace with the existing `BoundedTail` accumulator from child-pi (grep its export) sized to the existing consumer's need (read what reads `stdout` — if it is only surfaced as a tail preview, 64KB cap is right):

```ts
	// PERF (2026-08-24): unbounded string concat re-copies the whole transcript
	// on every chunk; bounded tail keeps whatever the consumer actually reads.
```

- [ ] **Step 3: Gate the control poll.** In live-agent-control.ts `:54-71`, the 500ms `setInterval` reads the whole control JSONL even though `subscribeLiveControlRealtime` exists. Change to: 1000ms interval while a realtime subscription is active for that agent, 500ms otherwise (thread the "is realtime subscribed" flag from wherever `subscribeLiveControlRealtime` registers handlers — grep it).

- [ ] **Step 4: Guard poll interval.** background-runner.ts `:226`: change the 250ms interrupt-guard `setInterval` to 1000ms with a comment (it does existsSync + readFileSync + JSON.parse per tick for the whole background run; the guard is best-effort latency, not a correctness deadline — verify by reading what the guard does on trigger; if it aborts within a deadline, keep 500ms instead and note why).

- [ ] **Step 5: Test** — new file: queue 100 `writeSidechainEntry` calls, advance past 50ms, assert ONE appendFileSync-sized write landing all 100 lines in order (mock `fs.appendFileSync` via `t.mock.method`); assert flush-on-dispose drains pending lines. Run live-session suites: `ls test/unit | grep -i live` → run.

- [ ] **Step 6: Commit** — `git commit -am "perf(live-session): batched sidechain/transcript writers, bounded stdout, gated control poll"`

---

## Phase E — Verification & closeout

### Task 27: Full validation, benchmarks, docs

**Files:**
- Modify: `CHANGELOG.md` (entry per repo convention), memory file (outside repo).

- [ ] **Step 1: Full static + test sweep**

```bash
cd /home/bom/source/my_pi/pi-crew && npm run typecheck && npm run lint && npm run test:unit
```

Expected: all green. Any failure → fix before proceeding (this is the superpowers:verification-before-completion bar — no success claims without this output).

- [ ] **Step 2: Integration suite** — `npm run test:integration` (sequential, slow; budget ~20-40min).

- [ ] **Step 3: Benchmarks** — `npm run bench`, then compare against the pre-fix numbers captured 2026-08-24:
  - `atomic-write-json` warm p50: 13.01ms (target: materially lower via lazy stringify being invisible to this bench, dir memo −1 syscall; fsync remains — expect modest change)
  - `b3.state-store-jsonl` atomicWriteMs: 14.83ms @10 entries
  - `b4.event-log` sync append: 14.09ms/event; async: 1.56ms (target: async p50 visibly lower via Tasks 13/14)
  - `register-startup` import: unchanged (no startup tasks in this plan)
  Record actual numbers in the CHANGELOG entry.

- [ ] **Step 4: Refresh baseline** — `npm run bench:capture` (overwrites `test/bench/baseline.json` — this is the point: future regressions compare against the improved numbers).

- [ ] **Step 5: CHANGELOG** — one entry: `## [Unreleased] — perf: fix 2026-08-24 performance review findings (state persistence syscall ceremony, UI sync I/O storms, mailbox/event-log hot paths, broker fan-out, worktree git-spawn memoization)` with the before/after bench table from Step 3.

- [ ] **Step 6: Update memory** — append the post-fix bench numbers to `/home/bom/.claude/projects/-home-bom-source-my-pi/memory/pi-crew-perf-review.md` (this is outside the repo; not committed).

- [ ] **Step 7: Final commit** — `git add CHANGELOG.md test/bench/baseline.json && git commit -m "perf: 2026-08-24 review fixes — benchmarks + baseline refresh"` and report the branch summary (commits, bench deltas, remaining deferrals) to the user. Do NOT merge to main or push unless the user asks.

---

## Self-Review notes (checked during authoring)

- **Coverage:** every Critical/High finding from the review maps to a task: C1→T2/T11/T12, C2→T17, C3→T18/T19, H1→T16 (+T13 seq skip), H2→T13/T14/T15, H3→T23, H4→T22, H5→T26, H6→T24. Mediums: sweep→T4, worktree→T25, locateRunCwd/listRuns→T24, artifacts validation→T12b, lock spin→T15 (retry path kept rigorous), UI micro→T5/T7/T8/T9/T21. Lows intentionally deferred are enumerated in the table above.
- **Type consistency:** `ensureDirSync` (T11) consumed by T15; `reservedSequenceEnd` (T13) defined in T13 step 1; `scheduleRefresh` public method (T17) named identically at both lifecycle-handlers call sites; `truncateToVisualLinesTail` (T18) matches the property-test import.
- **Invariant preservation:** BUG-028 in-lock load kept (T2 comment retained); F4 flush-before-read kept but scoped (T2); ST-7 terminal bypass untouched (T11 touches only the buffered branch); R16-B1 advance-on-reserve untouched (T13 skips only the redundant post-hoc persist); FLICKER FIX rebuild-in-place preserved (T17 uses buildAsync's in-place set); pid-file symlink safety preserved via `wx` O_EXCL semantics (T13).
