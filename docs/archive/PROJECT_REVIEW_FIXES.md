# Review of the fixes applied

> Date: 2026-05-18
> Version: `pi-crew@0.2.20`
> Base: PROJECT_REVIEW.md (same directory) — the original report.
> Working tree: 33 files changed (`git diff --stat`), including installing `@biomejs/biome`, adding `biome.json`, fixing source + tests.

## TL;DR

The fixes go in the right direction and **all tests still pass** (1596/1598, 0 fail). However, there are **3 new correctness bugs introduced by the fixes** and **2 conventions to clean up**:

| ID | File | Severity | Status |
|---|---|---|---|
| **NEW-1** | `src/state/event-log-rotation.ts` (rotateEventLog) | HIGH | `require()` in ESM → throws silently |
| **NEW-2** | `src/runtime/task-runner.ts` (M1 transcript per attempt) | HIGH | logic is wrong, still uses a single shared file |
| **NEW-3** | `src/runtime/task-runner.ts` (M2 transcript cap) | MED | tail read does not cut on line boundaries → corrupt JSONL; writes artifact with the old relativePath |
| LINT-1 | `src/runtime/task-runner.ts:350` | LOW | `yieldResult` unused (yield logic removed?) |
| LINT-2 | `src/runtime/team-runner.ts:270` | LOW | `runPromise` unused (registers a Promise then drops the reference) |

Status of each original issue:

| Issue | Status | Notes |
|---|---|---|
| **H1** event-log overflow | OK | correct pattern: prioritize terminal events, compact + rotate before append |
| **H2** mailbox lock | OK | uses `withEventLogLockSync` |
| **H3** atomic-write fallback symlink | OK | re-checks `lstatSync.isSymbolicLink()` before fallback |
| **H4** rename `__test__mergeTaskUpdates` | OK | renamed + kept deprecated alias |
| **M1** transcript per attempt | **BROKEN (NEW-2)** | logic is incorrect |
| **M2** transcript cap | **PARTIAL (NEW-3)** | has a cap but cuts at the wrong place |
| **M3** cleanup race-safe stat | OK | uses `withFileTypes` + try/catch |
| **M4** runSetupHook full-JSON | OK | tries full trimmed first, falls back to last-line |
| **M5** symlink fail logging | OK | logs the reason, hints at Windows non-admin |
| **M6** final-drain telemetry | OK | logs internal error when overriding exit |
| **L1** ESLint/Biome | OK | added `@biomejs/biome` + `biome.json` |
| **L12** rename references | OK | expanded for workflow step.role + test fixtures |

---

## 1. New bugs introduced by the fixes (NEW-*)

### NEW-1 (HIGH) — `rotateEventLog` uses `require()` in an ESM module

**File**: `src/state/event-log-rotation.ts` (lines 124–129)

```ts
} catch (error) {
    // Import here to avoid circular dependency at module load time
    try {
        const { logInternalError } = require("./internal-error.ts"); // ❌
        logInternalError("event-log.rotate", error, `eventsPath=${eventsPath}`);
    } catch {
        // fallback — log not available
    }
    return false;
}
```

**Problem**:
1. The project declares `"type": "module"` (ESM). In an ESM scope, **`require` does not exist** → throws `ReferenceError: require is not defined`.
2. The path `"./internal-error.ts"` is wrong — the file is actually at `../utils/internal-error.ts`.
3. The outer try-catch swallows the error → when `rename` fails, the function returns `false` but **no log is written**. The H1 fix relies on rotateEventLog to reduce size; if rotate fails silently, we are back to the silent-drop scenario.

**Correct fix**: import at the top of the file like `compactEventLog` already does:
```ts
import { logInternalError } from "../utils/internal-error.ts";
// ...
} catch (error) {
    logInternalError("event-log.rotate", error, `eventsPath=${eventsPath}`);
    return false;
}
```
There is no circular dependency because `internal-error.ts` does not import from `state/`.

---

### NEW-2 (HIGH) — Transcript-per-attempt does not work

**File**: `src/runtime/task-runner.ts` (lines 155–158)

```ts
modelAttempts = [];
// M1 fix: transcript path per attempt to avoid mixing across fallback attempts.
const attempt = modelAttempts.length; // 0-based index   ← always 0
transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${attempt}.jsonl`;
```

**Problem**:
- `modelAttempts = []` was just initialized empty → `modelAttempts.length` **is always 0**.
- `transcriptPath` is set **outside** the `for (let i = 0; i < attemptModels.length; i++)` loop.
- All N attempts write to `transcripts/${task.id}.attempt-0.jsonl` → still mixing exactly like before.
- Furthermore: `parsePiJsonOutput(fs.readFileSync(transcriptPath))` reads accumulated content → final text/usage is still mixed across attempts.

**Correct fix**: use the loop variable `i`, set transcriptPath inside the for loop:
```ts
for (let i = 0; i < attemptModels.length; i++) {
    transcriptPath = `${manifest.artifactsRoot}/transcripts/${task.id}.attempt-${i}.jsonl`;
    // ...
}
```

---

### NEW-3 (MED) — Transcript cap tail read does not respect line boundaries

**File**: `src/runtime/task-runner.ts` (lines 294–315)

```ts
const MAX_TRANSCRIPT_ARTIFACT_BYTES = 5 * 1024 * 1024;
let transcriptContent = '';
if (fs.existsSync(transcriptPath)) {
    const stat = fs.statSync(transcriptPath);
    if (stat.size > MAX_TRANSCRIPT_ARTIFACT_BYTES) {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
            const buf = Buffer.alloc(MAX_TRANSCRIPT_ARTIFACT_BYTES);
            const bytesRead = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_ARTIFACT_BYTES, stat.size - MAX_TRANSCRIPT_ARTIFACT_BYTES);
            transcriptContent = buf.slice(0, bytesRead).toString('utf-8');
        } finally { fs.closeSync(fd); }
    } else {
        transcriptContent = fs.readFileSync(transcriptPath, 'utf-8');
    }
    transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
        kind: "log",
        relativePath: `transcripts/${task.id}.jsonl`,   // ← artifact name differs from source!
        content: transcriptContent,
        producer: task.id,
    });
}
```

**Problem**:
1. **JSONL corruption**: the tail read cuts at a fixed byte offset, not on a `\n` → the first line of the transcript artifact is very likely a **partial JSON line** that cannot be parsed. Any tool replaying the transcript will skip the first line (losing an important event).
   - Fix: after reading, find the first newline and drop the bytes before it. Or prepend a header marker `[truncated head]`.
2. **`relativePath` does not match the source file**: if NEW-2 is fixed correctly (`attempt-i.jsonl`), then the artifact should reference that name. Currently the artifact always writes `transcripts/${task.id}.jsonl` → loses the attempt information.
3. **UTF-8 boundary**: `buf.slice(0, bytesRead).toString('utf-8')` can cut in the middle of a multi-byte character → the first character becomes `\uFFFD`. Minor but worth noting.
4. **Cap is only 5MB** for the artifact, but the source `transcriptPath` is not capped → can still grow very large (M2 only solves the artifact memory, not the disk).

---

## 2. Remaining lint warnings

Installed `@biomejs/biome` (L1 OK). When running `npx biome lint` on the changed files, 2 warnings remain:

### LINT-1 — `task-runner.ts:350` `yieldResult` unused

```ts
let yieldResult: YieldResult | undefined;
// ... assigns yieldResult = extractYieldResult(yieldEvent);
// but never read again
```

`yieldResult` is assigned but never used anywhere below. The yield logic is "dangling". Either remove the variable, or use it to override task.result/finalText. Needs confirmation from the owner.

### LINT-2 — `team-runner.ts:270` `runPromise` unused

```ts
const runPromise = registerRunPromise(manifest.runId);
```

`registerRunPromise` has a side effect (registers into the tracker), but the variable name is unnecessary. You could change it to `void registerRunPromise(manifest.runId);` so biome ignores it, or rename to `_runPromise`.

> Do not wire `lint:check` into CI until these 2 warnings are fixed, otherwise it will add noise to every PR.

---

## 3. Original issues fixed well (details)

### H1 — Event-log overflow (PASS)

`appendEventInsideLock` was fixed correctly:
- Terminal events are always appended regardless of size.
- Non-terminal events that hit the overflow → `compactEventLog` immediately, and if still too large → `rotateEventLog`.
- The `skippedDueToSize` flag is only set when both compact + rotate fail to reduce size (very rare).

**Minor notes**:
- `appendCounter++` still runs even when `skippedDueToSize === true`. Not a bug but makes the `% 100` rotation trigger one cycle early — does not affect correctness.
- The seq number is still consumed when skipped → when a consumer sees a "gap" in seq they may worry. You can set `metadata.appended: false` (already present) so consumers skip safely. OK.
- Depends on `rotateEventLog` (NEW-1 broken). When NEW-1 fails, the fallback path is `appendFileSync` which still appends to a file > 50MB → the file keeps growing.

### H2 — Mailbox lock (PASS)

Wraps `appendFileSync` in `withEventLogLockSync`. Reasonable.

**Notes**:
- The lock by `eventsPath` is actually by `mailboxFile(...)`, i.e., `inbox.jsonl` and `outbox.jsonl` have independent locks. OK for cross-process.
- `withEventLogLockSync` was not exported before; it was changed to `export function` — acceptable but the name is slightly misleading when used for the mailbox. Consider extracting a generic `withJsonlAppendLock`.
- The lock only protects append. Other paths like `updateMailboxMessageReply` (which already uses `atomicWriteFile` rewrite) or `validateMailbox` are not affected.

### H3 — Atomic-write fallback symlink TOCTOU (PASS)

```ts
try {
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
        throw renameError;
    }
} catch {
    // File might not exist yet — safe to proceed with fallback.
}
```

OK. Note: the outer catch swallows **all** errors from `lstatSync`, not just ENOENT. If `lstatSync` fails with EACCES (permission denied), the fallback proceeds even though it may not be safe. Could narrow to `(err as NodeJS.ErrnoException).code === "ENOENT"`.

### H4 — Rename `__test__mergeTaskUpdates` (PASS)

```ts
export function mergeTaskUpdatesPreservingTerminal(...) { ... }
/** @deprecated Use mergeTaskUpdatesPreservingTerminal. ... */
export const __test__mergeTaskUpdates = mergeTaskUpdatesPreservingTerminal;
```

Nice. Good backward compatibility. The caller inside `executeTeamRunCore` also needs updating — quick check:

```
> rg "__test__mergeTaskUpdates" -n src
src/runtime/team-runner.ts:117:export const __test__mergeTaskUpdates = mergeTaskUpdatesPreservingTerminal;
src/runtime/team-runner.ts:545: tasks = __test__mergeTaskUpdates(tasks, results);  ← still uses the alias
```

Production code still calls the alias `__test__mergeTaskUpdates`. Suggestion: change the caller to `mergeTaskUpdatesPreservingTerminal` so only the test file uses the alias.

### M3 — Cleanup race-safe stat (PASS)

Uses `withFileTypes`, wraps `statSync` in try/catch. OK.

### M4 — runSetupHook multi-line JSON (PASS)

Tries `JSON.parse(trimmed)` first, then falls back to the last line. OK.

**Minor note**: two nested try/catch inside the outer try → the outer catch (parse error logging) almost never triggers because the inner catch already swallows. Could be cleaned up. Does not affect correctness.

### M5 — symlink fail logging (PASS)

Logs the reason + a Windows non-admin hint. Note the indentation is slightly off (5 tabs instead of 1) — biome auto-format will fix it.

### M6 — final-drain telemetry (PASS)

```ts
if (forcedFinalDrain && !timeoutError && exitCode !== 0) {
    logInternalError("child-pi.final-drain-zero-exit", new Error(`Child exit code overridden to 0 after forced final drain (original=${exitCode})`), `pid=${child.pid}, finalDrainMs=${finalDrainMs}`);
}
```

OK. Uses `logInternalError` (not a metric counter). In the future, emit a metric `crew.child.final_drain_force_zero_total` via MetricRegistry so the dashboard can count it — `logInternalError` is only a backup observability.

**Note**: the indentation block is off (5 tabs for the if-block inside a 4-tab parent block). Biome will flag it.

### L1 — Biome added (PASS)

`@biomejs/biome ^2.4.15` + good `biome.json` config:
- `recommended: true`, indent tab × 4, double quotes, semicolons always.
- Disables some unsuitable rules (`noNonNullAssertion`, `noUselessSwitchCase`, …).
- `useIgnoreFile: true` reads `.gitignore`.

**Still missing**:
- `npm run lint` script in `package.json`.
- CI does not run biome in `npm run ci`.

Suggested additions:
```json
"scripts": {
    "lint": "biome lint .",
    "format": "biome format --write .",
    "ci": "npm run typecheck && npm run lint && npm run check:lazy-imports && npm test && npm pack --dry-run"
}
```

### L12 — Rename references (PASS, with risk)

`updateReferencesForRename` was expanded:
1. Workflow step.role → renamed along with the agent rename. **Logic warning**: `step.role` is actually the role name within the team, not the agent name. These are two different concepts: agent `coder` can be used for role `developer`. Updating step.role when renaming an agent is **semantically wrong** and can break a valid workflow.
   - Suggestion: only rename `team.roles[*].agent` (already done in the earlier loop), do not touch `step.role`.
2. Update test fixtures via regex.
   ```ts
   const agentPattern = new RegExp('(["\'\\`]agent[="\':\\s]*)' + escapeRegex(oldName) + '(["\'\\`]|\\s)', 'g');
   ```
   - This regex is complex + has a template-literal mess, very prone to false positives/negatives. For example:
     - It will match `"agent": "coder"` (OK)
     - It will NOT match `agent: coder` (oldName without quotes)
     - It will false-match if there is a variable named `agent_other = "coder"`
   - The `escapeRegex` regex: `/[.*+?^${}()|[\\]\\]/g` — correct (verified the character class).
   - **Suggestion**: test fixture rewrites should not use regex; if needed, parse YAML/markdown frontmatter / TS AST.
3. `walkTsFiles` recursively processes all `.ts`/`.md` in the test dir. OK but I/O-heavy for a rename op.

---

## 4. Incidental side fixes (not in the original scope)

Some changed files do not belong to the 4 batches above — appear to be general cleanup:

- `src/extension/team-tool.ts` — changed `import { … }` to `import type { … }` for 2 lazy-load spots. Reasonable (avoids runtime import side effects).
- `src/extension/team-tool.ts` — `let nextTasks` → `const nextTasks`. Correct (not reassigned).
- `src/runtime/team-runner.ts` — `let workflow` → `const workflow`. Correct.
- `src/runtime/code-summary.ts`, `manifest-cache.ts`, `prose-compressor.ts`, `result-extractor.ts`, `retry-executor.ts`, `skill-instructions.ts`, `observability/event-to-metric.ts`, `utils/gh-protocol.ts`, `utils/names.ts`, `utils/sse-parser.ts`, `config/markers.ts`, `config/resilient-parser.ts`, `adapters/export-util.ts`, `worktree/cleanup.ts` (M3 + others) — mostly biome auto-fixes (formatting / unused imports). Diff stat is small (~1-2 lines/file).

Need to verify biome did not break logic (especially since the `noUnusedImports` rule was turned off but the `1 deletion` changes in `result-extractor.ts`, `skill-instructions.ts`, `sse-parser.ts` are suspicious).

```bash
git diff src/runtime/result-extractor.ts src/runtime/skill-instructions.ts src/utils/sse-parser.ts
```

---

## 5. Verification

```bash
npm run typecheck   → PASS
npm run test:unit   → 1596 pass / 2 skip / 0 fail / 87s
npx biome lint <changed files>  → 2 warnings (LINT-1, LINT-2)
```

Tests still pass because:
- NEW-1 does not trigger in unit tests (rotateEventLog only runs when the file > 50MB).
- NEW-2 has no specific test for transcript-per-attempt collision.
- NEW-3 has no test for a transcript cap > 5MB.

---

## 6. Recommended actions (by priority)

1. **Fix NEW-1 now**: change `require` → top-level `import { logInternalError } from "../utils/internal-error.ts"`. (1 minute)
2. **Fix NEW-2**: move the `transcriptPath = ...attempt-${i}...` line inside the `for` loop. (2 minutes)
3. **Fix NEW-3**: cut the tail on the `\n` boundary; update the artifact `relativePath` to match the source filename; prepend a `[truncated]\n` marker so consumers know.
4. **Add unit tests** for:
   - `rotateEventLog` (rename + create empty)
   - `appendEvent` with a file > 50MB → terminal event still persisted
   - `appendMailboxMessage` concurrent (spawn 2 workers, check no interleaving)
   - Transcript per-attempt (mock 2 attempts, verify 2 separate files)
   - Atomic-write fallback symlink TOCTOU (mock rename fail + symlink swap)
5. **Clean up LINT-1, LINT-2** before wiring biome into CI.
6. **Suggested: add a `lint` script** to `package.json` + run biome in `ci`.
7. **Re-review L12**: remove the `step.role` update logic (semantically wrong) or gate it behind an `--unsafe-rename` flag.
8. **Re-verify biome auto-fix side fixes** in `result-extractor.ts`, `skill-instructions.ts`, `sse-parser.ts` (3 files with suspicious `-1 deletion`).

---

## 7. Conclusion

The direction is correct, most of the original issues have been resolved. However, 3 fixes have **logic bugs** (NEW-1, NEW-2, NEW-3) that mean the "anti-overflow" and "per-attempt transcript" features do not work as intended. Because the old tests do not cover these code paths, the regressions pass the current suite.

After fixing the 3 bugs above + adding tests, we will have a significantly more robust codebase compared to the baseline review.
