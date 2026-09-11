---
name: iterative-audit
description: >
  Iterative multi-round codebase audit with diminishing-returns detection. Run 5-20+ rounds, each focusing on one specific area. Built from 19 rounds of dogfooding pi-crew on itself.
  When NOT to use: one-shot review (use multi-perspective-review); investigation with single round (use read-only-explorer).

origin: pi-crew
triggers:
  - "audit this codebase"
  - "review everything"
  - "find all bugs"
  - "deep audit"
  - "harden this"
  - "iterate audit rounds"
  - "multi-round review"
---

# Iterative Audit

> Distilled from 19 rounds of auditing pi-crew on itself (v0.5.5 → v0.5.14):
> ~70 issues fixed, 286 tests added, 9 security improvements, 2 performance improvements.

The core insight: **a single round of audit finds the easy 30% of bugs**. The remaining 70% only surfaces through 5-20+ targeted rounds, each with a specific focus. After round 5+ you find HIGH severity bugs that round 1 missed. After round 10+ you find issues that no human reviewer would catch in a single pass.

## Operating Stance

- **One focus per round.** Each round targets one of the 7 patterns below. Don't try to fix everything in one pass.
- **Source verification is mandatory.** Never trust audit docs or previous round reports — always read the actual code. ~30% of issues from prior rounds are false positives or already fixed.
- **Document every finding with file:line.** "Sandbox env allow-list" is useless. "src/runtime/sandbox.ts:70 — process.env full leak" is actionable.
- **Verify the team actually applied changes.** After any team run, run `git diff` and inspect. ~20% of team runs silently fail to apply changes.
- **Don't publish without explicit user confirmation.** Audit work compounds; releasing in the middle of a round leaves the codebase in a half-hardened state.

## The 7 Patterns (rotate through these)

After 19 rounds, every issue found falls into one of these 7 categories. Use this to plan each round's focus.

### 1. L1 Cleanup (decoration, low value, easy)
**What**: Replace `console.error` / `console.warn` / `process.stderr.write` with `logInternalError()` from `utils/internal-error.ts`.

**Why**: `console.error` may not be visible in JSON-RPC mode or when stderr is redirected. `logInternalError` is the project-wide pattern; missing it means errors are silently dropped.

**How to find them**:
```bash
rg -n 'console\.(error|warn|log)' src/
rg -n 'process\.stderr\.write' src/
```

**Rule**: Skip `internal-error.ts:5` itself (it's the implementation). Skip `background-runner.ts:146` (overrides `console.error` for testing). Skip `parent-guard.ts:37` (exit-time log must fire synchronously).

**Time per round**: 30 min for 5-10 callsites. Diminishing returns after round 1.

### 2. Defensive Caps (memory safety, medium value, medium effort)
**What**: Find Maps, Sets, Arrays, and Queues that grow unboundedly. Add `MAX_*` constants and eviction logic.

**Why**: Long-running processes (background runners, extension reloads) accumulate state. Without caps, a busy period causes OOM.

**How to find them**:
```bash
rg -n 'new Map\(' src/  # look for ones that are .set() repeatedly
rg -n 'new Set\(' src/
rg -n 'this\.\w+\.push\(' src/  # look for unbounded arrays
```

**Common patterns**:
- `Semaphore.#queue` → add `MAX_QUEUE` cap (pi-crew: 10,000)
- `liveAgentManager.liveAgents` Map → add `MAX_LIVE_AGENTS` cap (pi-crew: 5,000)
- `OverflowRecoveryTracker.states` Map → add `MAX_TRACKED_STATES` cap (pi-crew: 5,000)
- `NotificationRouter.seen` Map → add `SEEN_MAP_MAX_SIZE` cap (pi-crew: 10,000)

**Eviction strategies** (in order of preference):
1. **LRU by access time** — track `lastAccessAt` per entry
2. **Oldest insertion** — Map's natural insertion order works (delete first key)
3. **Terminal-state priority** — protect live entries, evict completed/failed/cancelled first

**Test pattern**: Verify cap by inserting 1.5× the max, confirm old entries are gone.

### 3. Test Coverage Gaps (good value, low effort)
**What**: Find source files with zero direct unit tests.

**How to find them**:
```bash
# For each src file, check if any test file imports it
for f in src/runtime/*.ts src/extension/*.ts; do
  basename=$(basename "$f" .ts)
  count=$(ls test/unit/${basename}*.test.ts 2>/dev/null | wc -l)
  [ "$count" = "0" ] && echo "NO TEST: $f"
done
```

**Prioritize**:
- Security-critical: `sandbox.ts`, `child-pi.ts`, `pi-spawn.ts`, `crew-cleanup.ts`
- Resource-management: `live-agent-manager.ts`, `semaphore.ts`, `overflow-recovery.ts`
- Public APIs: anything with `export class` or `export function`

**Don't test**: internal helpers, generated code, pure re-exports.

**Test categories** (in order of importance):
1. **Path validation** (security) — `assertSafePathId`, path traversal rejection
2. **Resource cleanup** — `dispose()` clears everything, listeners don't stack
3. **Boundary conditions** — empty input, max-size, overflow
4. **Callback lifecycle** — sync/async error handling, `resultConsumed` flag

### 4. Security Hardening (high value, high effort)
**What**: Find places where untrusted input reaches dangerous sinks.

**Common sinks to audit**:
- `execSync(command)` → switch to `execFileSync(program, args[])`
- `eval()` / `Function()` / `vm.runInNewContext()` → avoid entirely
- `path.join(base, userInput)` → use `assertSafePathId(userInput)` first
- `process.env` access → use sanitized env with allow-list
- File writes to user-controlled paths → validate path is within allowed roots
- Child process spawn → use `cwd: knownDir`, sanitize env

**How to find them**:
```bash
rg -n 'execSync\(' src/
rg -n 'exec\(' src/
rg -n 'eval\(|Function\(' src/
rg -n 'spawn\(' src/
rg -n 'path\.join\(' src/ | rg 'record\.|task\.|runId|agent\.'
```

**Round 1**: Find all `execSync` and `exec`. Switch to `execFileSync(program, args)` (no shell).
**Round 2**: Audit env handling. Look for `process.env` access in hot paths. Add allow-list.
**Round 3**: Path traversal. For every `path.join(base, userInput)`, add `assertSafePathId()`.
**Round 4**: Subprocess safety. Verify all `spawn()` calls have: validated args, sanitized env, `cwd` set, signal handling, timeout.

### 5. Performance (medium value, medium effort)
**What**: Find O(N²) or worse algorithms, especially in hot paths.

**Common patterns**:
- Recomputing document frequency in search loops → precompute at construction
- `array.filter().map().filter()` in a loop → fuse into one pass
- `JSON.parse` of the same file repeatedly → cache
- `fs.statSync` per file in a directory scan → batch with `Dirent.isDirectory()`
- `setTimeout` busy-polling for state changes → use `fs.watch` or events

**How to find them**:
```bash
# Look for nested loops over the same data
rg -nB 1 -A 5 'for.*of.*for' src/
# Look for polls
rg -n 'setTimeout.*poll' src/
rg -n 'pollIntervalMs' src/
```

**Test pattern**: For precomputation fixes, write a perf test that creates 1000 docs, runs search, and asserts completion under 100ms.

### 6. Code Quality (low value, easy)
**What**: Remove dead code, fix type misuse, add missing JSDoc.

**Common patterns**:
- Fields declared but never used (e.g., `seenCleanupCounter`)
- Unused imports
- Type assertions (`as any`, `as unknown as T`) that hide real issues
- Functions that always return the same value
- Catch blocks that swallow errors silently

**How to find them**:
```bash
# Find fields/methods declared but never used
rg -n 'private \w+\s*=\s*' src/ | while read line; do
  field=$(echo "$line" | grep -oP 'private \K\w+')
  count=$(rg -c "\b$field\b" src/ 2>/dev/null | head -1)
  [ "$count" = "1" ] && echo "DEAD: $line"
done
```

### 7. Resource Cleanup (medium value, medium effort)
**What**: Find places where listeners, timers, file handles, or other resources can leak.

**Common patterns**:
- `process.on('SIGTERM', ...)` registered multiple times → use module-level flag
- `setInterval` / `setTimeout` not cleared on shutdown → `dispose()` method
- `AbortController` not aborted in cleanup
- File watchers (`fs.watch`) not closed
- Event listeners (`emitter.on`) not removed

**How to find them**:
```bash
rg -n 'process\.on\(' src/
rg -n 'setInterval\(' src/
rg -n 'setTimeout\(' src/ | rg -v 'setTimeout.*resolve'  # filter out poll sleeps
rg -n 'fs\.watch\(' src/
```

**Test pattern**: Call the registration function N times, verify listener count is 1.

## Round Workflow (use this for EVERY round)

### Step 1: Pick a focus
Choose ONE of the 7 patterns above. Don't try to do multiple patterns in one round.

### Step 2: Explore (read 3-5 files)
Read the actual source for the focus area. Don't trust prior audit docs.

### Step 3: Verify from source
For each candidate issue:
- Read the file at the cited line
- Check if the issue is real (not a false positive)
- Check if it's already fixed
- Note the exact file:line and code snippet

### Step 4: Create a plan doc
```markdown
# Round N Audit Fix Plan
## Findings
### Issue 1: <file>:<line> — <title> (severity)
<File path and line numbers>
<Code snippet showing the issue>
<Rationale>

## Plan (5 phases)
### Phase 1: <action>
### Phase 2: <action>
...
```

### Step 5: Implement
- Make the fix
- Add tests (if applicable)
- Run typecheck: `npx tsc --noEmit`
- Run tests: `npm test`

### Step 6: Commit + Release
- Commit with conventional message: `fix: round N - <summary>`
- Update CHANGELOG.md
- Bump version (patch)
- Push + npm publish
- Create GitHub release

### Step 7: Decide: continue or stop?
After 5-10 rounds, evaluate:

**Continue if**:
- Last 2 rounds found HIGH or MEDIUM severity issues
- Test coverage is < 80% of modules
- User explicitly wants more

**Stop if**:
- Last 2 rounds found only LOW severity or L1 cleanup
- All patterns exhausted (you've done each at least once)
- Diminishing returns: more time spent planning than implementing

## When to Use Teams vs. Do It Yourself

**Use teams** (via `team action='run', team='review'`) for:
- Initial broad audit (round 1)
- Security reviews (specialized `security-reviewer` agent)
- When you need 3+ perspectives (multi-explorer)

**Do it yourself** for:
- Round 2+ (you have context from prior rounds)
- Focused single-pattern work (L1 cleanup, test coverage)
- Small fixes (< 5 file edits)

**Teams often fail because**:
- 5-min heartbeat timeout for long-running runs (add `startTeamRunHeartbeat` if needed)
- Agent cancellations
- Hallucinated file:line references (always verify from source)

## Common False Positives (audit findings to reject)

After 19 rounds, ~30% of audit findings are false positives. Common patterns:

1. **"Double-merge in config"** — looks like a bug, but project config + user config merge is intentional
2. **"as unknown as T in error handling"** — necessary for TypeScript's strict mode
3. **"Auto-repair timer race"** — there's a guard like `cleanedUp || !currentCtx` you missed
4. **"Already-validated input"** — validation is in the caller, not the callee
5. **"Redundant null check"** — TypeScript narrowing doesn't always work for closures

**Always verify against source** before acting. If you're not sure, write a test that exercises the alleged bug path. If the test passes, it's a false positive.

## Success Metrics

After each round, record:
- Issues found (real vs. false positive)
- Tests added
- Typecheck clean?
- Total test count delta

**Healthy round**: 3-8 real issues found, +20 to +50 tests added, all pass.

**Exhausted round**: 0-1 real issues found, 0 tests added, mostly L1 cleanup.

When you hit 2+ exhausted rounds in a row, **stop**.

## Real Examples from 19 Rounds

| Round | Focus | Issues Found | Severity Range |
|-------|-------|--------------|----------------|
| 1-3 | Broad security audit | 11 | CRITICAL, HIGH |
| 4-6 | Race conditions, locks | 5 | HIGH |
| 7-9 | L1 cleanup, dead code | 12 | LOW |
| 10-12 | Defensive caps | 3 | MEDIUM |
| 13-15 | Security: execSync, sandbox | 9 | CRITICAL, HIGH |
| 16-18 | Test coverage, L1 | 30+ | LOW |
| 19 | Path validation, tests | 5 | MEDIUM |

**Pattern**: First 3 rounds find the most impactful issues. Rounds 4-15 find the rest. Rounds 16+ are diminishing returns (mostly test coverage and L1 cleanup).

## Anti-Patterns to Avoid

- **Mega-rounds** (10+ files, 5+ categories) — too broad, low quality findings
- **Trusting audit docs** — always verify from source
- **Skipping typecheck** — type errors compound and become hard to debug later
- **Releasing mid-round** — leaves the codebase in a half-hardened state
- **No test for the fix** — every fix needs a test that would have caught the bug
- **Committing too late** — commit after each phase, not at the end of the round

## Enforcement — Iterative Audit Gate

**Before reporting round findings, verify:**

- [ ] Round focus is ONE of the 7 patterns (not multiple)
- [ ] Each finding has a verified `file:line` reference (read the actual source)
- [ ] False positives filtered out (consult "Common False Positives" section)
- [ ] Severity assigned using the standard scale (CRITICAL / HIGH / MEDIUM / LOW)
- [ ] Plan doc created with phases and file:line evidence
- [ ] Typecheck clean: `npx tsc --noEmit` returns 0 errors
- [ ] All tests pass: `npm test` shows 0 failures
- [ ] Tests added for the fix (if applicable)
- [ ] Round results recorded: issues found, tests added, delta
- [ ] Decision logged: continue to next round or stop (with reason)

**If ANY answer is NO → Stop. Complete audit requirements before reporting round results.**

## Related Skills

- `scrutinize` — Quick outsider-perspective review of a single change
- `multi-perspective-review` — 8-pass deep review for a single change
- `verification-before-done` — Evidence before claim (use per round)
- `systematic-debugging` — When a finding reveals a real bug that needs deeper investigation
