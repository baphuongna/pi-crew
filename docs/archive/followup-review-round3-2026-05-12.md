# Follow-up Review — pi-crew (2026-05-12, round 3)

Author: Droid (Factory) | Related: `docs/code-review-2026-05-11.md`, `docs/followup-plan-2026-05-12.md`, `docs/followup-review-2026-05-12.md`. HEAD: `5bee878`.

This is the review round after commit `5bee878` resolved C1–C6. Goal: scrutinize the modules not yet examined closely (event-log, atomic-write, child-pi, redaction, sleep, hooks, cleanup) to find remaining risks.

## Result summary

- `npm run typecheck` → Passed
- `npm run check:lazy-imports` → Passed
- `npm run test:unit` → **1418 tests / 1415 pass / 0 fail / 3 skip** (212s)

The codebase is in a stable state. The findings below are **low risk** or **defense-in-depth**, not urgent bugs.

---

## Part A — New findings

### D1 — `event-log.appendEvent` has no lock, JSONL may interleave on Windows

**Severity:** Medium | **Effort:** ~30 minutes | **File:** `src/state/event-log.ts:148`

**Current state:**
```ts
fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
```

**Problem:**
- `fs.appendFileSync` on POSIX is only atomic for writes smaller than `PIPE_BUF` (~4 KiB). A full event JSON (with data, metadata, transcripts) can exceed that → interleaved lines between 2 processes (parent + background-runner).
- On Windows, append is NOT atomic at any size; 2 processes appending to the same eventsPath can produce interleaved JSON lines → `JSON.parse(line)` in `readEvents`/`scanSequence` throws and skips the line.
- Consequence: lost events, sequence numbers jumping, "appended: false" is returned in a different path (size-limit) but the normal path gives no hint.

**Trigger:** running `background-runner` in parallel with the parent writing events to the same `eventsPath` (e.g. cancel + retry in succession).

**Proposed fix:**
1. Wrap `appendEvent` in `withRunLockSync(manifest, () => { ... })` — ensures exclusive access.
2. Or use `fs.openSync(..., O_APPEND | O_WRONLY)` + retry with an advisory lock (`flock` POSIX, `LockFileEx` Windows — via the npm package `proper-lockfile`).
3. Lightest option: switch to `appendEventAsync` via a queue/serialize.

**Tests to add:** stress test in `test/integration/`: 2 processes each appending 100 events concurrently → assert total parseable line count = 200.

---

### D2 — `event-log.sequenceCache` Map leaks by number of runs

**Severity:** Low | **Effort:** ~10 minutes | **File:** `src/state/event-log.ts:60`

**Current state:**
```ts
const sequenceCache = new Map<string, { size: number; mtimeMs: number; seq: number }>();
```

**Problem:**
- Module-level map, never evicts. Each `eventsPath` (1 per run) takes 1 entry. A long-running parent process (e.g. live-session-runtime) running for many days → the cache could reach thousands of entries.
- Memory isn't large (~100 bytes/entry) but is unbounded.

**Proposed fix:** use a simple LRU (Map with a max size, evict oldest when exceeding the threshold), or clear after the run ends:
```ts
export function evictSequenceCache(eventsPath: string): void {
	sequenceCache.delete(eventsPath);
}
// Call from updateRunStatus(..., "completed"/"failed"/"cancelled").
```

---

### D3 — `atomicWriteFileAsync` has a "matches" fallback → sync path doesn't (parity)

**Severity:** Low | **Effort:** ~15 minutes | **File:** `src/state/atomic-write.ts:122-138`

**Current state:**
```ts
// async path:
try { await renameWithRetryAsync(...); }
catch (renameError) {
	const existing = await fs.promises.readFile(filePath, "utf-8");
	const matches = existing === content;
	if (matches) { /* cleanup temp, return success */ }
	throw renameError;
}

// sync path: just throws, no "matches" fallback.
```

**Problem:**
- The async path "forgives" the race condition (the file was already written with the correct content by another process). The sync path throws hard.
- Different semantics → hard to debug when someone uses sync with a race.
- This case is rare (identical content), but the asymmetry is a code smell.

**Proposed fix:** add the same fallback to sync, or remove the fallback from async (pick one consistent convention):
```ts
} catch (renameError) {
	try {
		const existing = fs.readFileSync(filePath, "utf-8");
		if (existing === content) {
			try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
			return;
		}
	} catch { /* fall through */ }
	throw renameError;
}
```

---

### D4 — `withRunLock` (async) waits until the deadline for an active lock, `withRunLockSync` throws immediately

**Severity:** Low | **Effort:** ~10 minutes | **File:** `src/state/locks.ts:91-110`

**Current state:**
- Sync: `if (!isLockStale(...)) throw ...` → fail fast for an active lock.
- Async: only checks staleness in `readLockStateAsync`, doesn't throw for active → loops waiting until the deadline (`staleMs * 2`, usually 60s).

**Problem:**
- The test `withRunLockSync throws immediately on active (non-stale) lock` proves sync throws immediately.
- Async will hang ~60s then throw → slow cancel/retry experience.
- BUG-004 (round 1) aimed to unify sync ↔ async, but this semantic asymmetry remains.

**Proposed fix:** unify by one of:
- Sync: add a short wait + retry like async (wait up to 1-2s then throw).
- Async: throw immediately when the lock isn't stale (like sync) — usually better since the caller can retry with higher context.

```ts
async function acquireLockWithRetryAsync(filePath: string, staleMs: number): Promise<void> {
	let attempt = 0;
	const deadline = Date.now() + staleMs * 2;
	while (true) {
		try { writeLockFile(filePath); return; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (Date.now() > deadline) throw new Error(`Run '${path.basename(filePath)}' is locked.`);
			if (!isLockStale(filePath, staleMs)) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			try { fs.rmSync(filePath, { force: true }); } catch { /* race */ }
			await sleep(Math.min(250, 25 * 2 ** attempt));
			attempt++;
		}
	}
}
```

**Tests to add:** mirror the sync test — `withRunLock async throws immediately on active (non-stale) lock`.

---

### D5 — `sleep.ts` uses `require()` in an ES module

**Severity:** Low (style) | **Effort:** ~5 minutes | **File:** `src/utils/sleep.ts:18`

**Current state:**
```ts
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
```

**Problem:**
- The project is ESM (`"type": "module"`). `require` only works via strip-types backward-compat — not clean.
- AGENTS.md: "Avoid dynamic inline imports, EXCEPT at documented lazy-load boundaries to defer heavy runtime cost (mark with `// LAZY: <reason>`)". This `require` has no marker.
- `child_process` isn't heavy — top-level import is fine.

**Proposed fix:**
```ts
import { execFileSync } from "node:child_process";
// ...
execFileSync("sleep", [(ms / 1000).toFixed(3)], { timeout: ms + 1000, stdio: "pipe" });
```

---

### D6 — `iteration-hooks.runIterationHook` doesn't filter env like post-checks

**Severity:** Low | **Effort:** ~5 minutes | **File:** `src/runtime/iteration-hooks.ts:140`

**Current state:**
```ts
env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", USER: process.env.USER, LANG: process.env.LANG, PI_CREW_HOOK: "1" },
```

**Problem:**
- Already restricted manually, OK for Linux. But on Windows it lacks `USERPROFILE`, `TEMP`, `TMP`, `ComSpec`, `SystemRoot` → `.cmd/.ps1` scripts may fail.
- post-checks.ts has the same pattern (line 82) — inconsistent with worktree-manager.runSetupHook which moved to `sanitizeEnvSecrets(..., { allowList: [...] })`.

**Proposed fix:** apply `sanitizeEnvSecrets` with an allowList, unifying all 3 sites (post-checks, iteration-hooks, setup-hook):
```ts
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
const HOOK_ENV_ALLOW = ["PATH", "HOME", "USER", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "ComSpec", "SystemRoot", "PI_*"];
// ...
env: { ...sanitizeEnvSecrets(process.env, { allowList: HOOK_ENV_ALLOW }), PI_CREW_HOOK: "1" },
```

**Benefits:**
- 1 source of truth for the hook env whitelist.
- Supports Windows .cmd/.ps1 (USERPROFILE/TEMP needed).
- Avoids code duplication.

---

### D7 — `cleanup.ts` git helper doesn't force locale (consistency with worktree-manager)

**Severity:** Info | **Effort:** ~2 minutes | **File:** `src/worktree/cleanup.ts:15`

**Current state:**
```ts
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
```

**Problem:**
- `worktree-manager.ts` already forces `LANG: "C", LC_ALL: "C"` (C5 round 2). `cleanup.ts` doesn't yet.
- Doesn't cause a current bug because cleanup doesn't parse error strings; but if error parsing is added later, this gets missed again.
- `branch-freshness.ts` has the same issue.

**Proposed fix:** extract a `git()` helper into a shared `src/utils/git-helper.ts`, used by all 3 files:
```ts
// src/utils/git-exec.ts
import { execFileSync } from "node:child_process";
export function gitExec(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, LANG: "C", LC_ALL: "C" },
	}).trim();
}
```

---

### D8 — `redaction.PEM_PRIVATE_KEY_PATTERN` has no length limit → low ReDoS potential

**Severity:** Info | **Effort:** ~5 minutes | **File:** `src/utils/redaction.ts:7`

**Current state:**
```ts
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
```

**Problem:**
- The lazy `[\s\S]*?` is ReDoS-safe, but if the input has a BEGIN without an END → backtracks to the end of the string. With a long JSONL transcript (10+ MB), the regex scans the whole thing.
- Not a true ReDoS (linear), but can be slow.

**Proposed fix:** add a hard 64KB limit for a PEM block (real PEM ~3KB):
```ts
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,65536}?-----END [A-Z ]*PRIVATE KEY-----/g;
```

Trade-off: PEM > 64KB won't be fully redacted. Rare in practice.

---

### D9 — `subagent-manager.persistedSubagentPath` doesn't validate `id` → potential path traversal

**Severity:** Low | **Effort:** ~5 minutes | **File:** `src/runtime/subagent-manager.ts:58`

**Current state:**
```ts
function persistedSubagentPath(cwd: string, id: string): string {
	return path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir, `${id}.json`);
}
```

**Problem:**
- `id` is currently generated internally (`agent_${Date.now().toString(36)}_${counter.toString(36)}`) → safe.
- But `readPersistedSubagentRecord(cwd, id)` is called with `id` from an external source (e.g. `get_subagent_result` tool param). If tool param validation is missing, `id = "../../../etc/passwd"` could read a file outside the state dir.

**Proposed fix:** validate `id` matches `^[a-z0-9_]+$`:
```ts
function isValidSubagentId(id: string): boolean {
	return /^[a-z0-9_]+$/i.test(id) && id.length <= 128;
}
function persistedSubagentPath(cwd: string, id: string): string {
	if (!isValidSubagentId(id)) throw new Error(`Invalid subagent id: ${id}`);
	return path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir, `${id}.json`);
}
```

Check the `get_subagent_result` tool schema to see if it sanitizes id already; if so, D9 is just defense-in-depth.

---

## Implementation priority

| # | Item | Severity | Effort | Recommendation |
|---|---|---|---|---|
| 1 | D1 (event-log concurrent append) | Medium | 30 minutes | Current sprint — prevent event loss/corruption |
| 2 | D6 (consistent hook env allowList) | Low | 5 minutes | Current sprint — sync with the setup-hook fix |
| 3 | D4 (async lock fail-fast for active) | Low | 10 minutes | Current sprint — cancel/retry UX |
| 4 | D9 (subagent id validate) | Low | 5 minutes | Current sprint — defense-in-depth |
| 5 | D2 (sequenceCache eviction) | Low | 10 minutes | Next sprint |
| 6 | D3 (atomic-write sync/async parity) | Low | 15 minutes | Next sprint |
| 7 | D5 (sleep.ts ESM require) | Low | 5 minutes | Next sprint |
| 8 | D7 (git helper consolidate) | Info | 2 minutes | Anytime |
| 9 | D8 (PEM regex limit) | Info | 5 minutes | Anytime |

**Total effort priority 1 (must-fix):** ~50 minutes.
**Total effort priority 2 (nice-to-have):** ~37 minutes.

---

## Proposed commit batches

- **Batch 1 (correctness/security):** D1 + D9 + D4 → 1 PR "event-log lock + subagent id guard + async lock parity" (~45 minutes).
- **Batch 2 (hardening):** D6 + D7 + D2 → 1 PR "hook env allowList consolidation + git helper extract + cache eviction" (~20 minutes).
- **Batch 3 (polish):** D3 + D5 + D8 → 1 PR "atomic-write parity + ESM cleanup + redaction limit" (~25 minutes).

---

## Positive notes after round 3

- All C1–C6 (round 2) fixed correctly per spec.
- 1418 tests pass (vs 1411 the previous round → +7 new tests), 0 fail.
- `npm run check:lazy-imports` now runs on Windows (after removing `sed`).
- `sanitizeEnvSecrets` has both a deny-list (default) and an allow-list mode → good flexibility.
- `resolveShellForScript` correctly handles `.bat/.cmd` to guard against CVE-2024-27980.
- `parent-guard` polling works well cross-platform (POSIX + Windows).
- Multi-layer redaction pipeline (key-name + inline-substring + auth-header + bearer + PEM).
- Atomic-write has O_EXCL + O_NOFOLLOW + post-open `isFile()` verification.
- Subagent records persisted under the redaction filter.
- Background runner has `parent-guard` + tempdir cleanup + final-drain timer.

---

## Areas with NO serious issues (reviewed)

- `src/schema/team-tool-schema.ts` — TypeBox schema has the "retry" literal, strict additionalProperties.
- `src/state/artifact-store.ts` — 2-layer path traversal blocking (`resolveInside` + `resolveRealContainedPath`), post-redaction hash.
- `src/state/atomic-write.ts` — symlink-safe, O_EXCL, fd-based stat verification.
- `src/worktree/worktree-manager.ts` — branchExists local+remote, prune stale, env filter, locale-safe error parse.
- `src/runtime/async-runner.ts` — jiti + strip-types fallback, multi-candidate path.
- `src/runtime/child-pi.ts` — env sanitize, redacted transcript, post-exit stdio guard, hard kill timer.
- `src/runtime/parent-guard.ts` — kill(pid,0) cross-platform, unref'd interval.

---

## Verification

```
npm run typecheck            → Passed
npm run check:lazy-imports   → All dynamic imports have `// LAZY:` marker.
npm run test:unit            → 1418 tests, 1415 pass, 0 fail, 3 skip (212s)
HEAD                         → 5bee878 (fix: address followup-review C1-C6)
```
