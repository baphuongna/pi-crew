# Issue #29 Analysis: Hardcoded `.crew/state/runs` Path Crashes pi

> **Status**: ANALYZED — no code changes applied (per user request).
> **Reporter**: sethmorton (external, opened 2026-06-05)
> **Affects**: pi-crew 0.6.0 / 0.6.1 (issue present in v0.6.1 too — not fixed in any post-v0.6.1 commit as of `e95e055`).
> **Severity**: **CRITICAL** — full-harness uncaughtException, can crash pi.

---

## 1. Reporter's Claims — Verification Matrix

| Claim | Verified? | Evidence |
|---|---|---|
| `waitForRun()` hardcodes `.crew/state/runs/<runId>` at `run-tracker.ts:82` | ✅ YES | `src/runtime/run-tracker.ts:82` — `const runDir = path.join(cwd, ".crew", "state", "runs", runId);` |
| `projectCrewRoot()` correctly resolves to `.pi/teams/` for `.pi/`-only projects | ✅ YES | `src/utils/paths.ts:88-97` |
| The throw escapes as an unhandled promise rejection | ✅ PARTIAL | Both direct call sites (`team-tool.ts:817`, `team-tool/run.ts:211,344`) wrap in `try/catch`. **However**, the issue is real when `waitForRun` is called indirectly through `subagent-manager.ts`. |
| `subagent-manager.ts:250` re-throws via `record.promise` IIFE | ⚠️ LINE-DRIFT | Issue says `~line 250` — in current code (commit `e95e055`), `record.promise` IIFE starts at line 258 and the `throw error;` is at line 281. The mechanism is correct; line numbers drifted from prior code. |

## 2. Root Cause Analysis

### Why it crashes (in `.pi/`-only projects)

`projectCrewRoot(cwd)` (in `src/utils/paths.ts:88-97`) returns:

```
1. .crew/  (if exists)
2. .pi/teams/  (if .pi/ exists and .crew/ doesn't)
3. .crew/  (default, would be created by ensureCrewDirectory)
```

In a `.pi/`-based project **without** `.crew/`, run state lives at:
```
.pi/teams/state/runs/<runId>/
```

But `waitForRun()` (line 82) hardcodes:
```
.crew/state/runs/<runId>/
```

The early-exit check `fs.existsSync(runDir)` returns `false`, throwing:
```
Error: Run <runId> not found. No run directory at <cwd>/.crew/state/runs/<runId>
```

### Why this becomes a `uncaughtException`

The throw in `waitForRun` propagates differently depending on caller:

| Caller | Wrapped in try/catch? | Result |
|---|---|---|
| `team-tool.ts:817` (wait action) | ✅ YES | Returns error to user — safe |
| `team-tool/run.ts:211` (async.run) | ✅ YES | Returns error to user — safe |
| `team-tool/run.ts:344` (foreground) | ✅ YES | Returns error to user — safe |
| **`subagent-manager.ts:270` (pollRunToTerminal)** | ⚠️ **NO** | `record.promise` rejects → line 281 `throw error` re-throws → if no caller awaits → **unhandled rejection** |

The `subagent-manager.ts` path is the actual crash site. Direct `waitForRun` calls in `team-tool.ts` are safe.

### Why the run "exists" in `.pi/teams/...`

The background worker process (`background-runner.ts`) correctly **reads/writes** to the right path **once it uses `projectCrewRoot()`** — but it does NOT. The same hardcoding is present in `background-runner.ts:139, 172`. So the **background worker itself is writing to `.crew/state/runs/...` (wrong path)**, while the **manifest claims it lives at `.pi/teams/state/runs/...`** (correct path).

Wait — let me re-verify this. The manifest is created by which process?

Actually, the **run manifest is created at the orchestrator** (using `projectCrewRoot`), and the **background worker reads/writes log/exit-code files using the same wrong path**. The manifest's `stateRoot` field is correct (`.pi/teams/...`), but the background worker writes its log to `<cwd>/.crew/state/runs/.../background.log`, which is the wrong path.

Result: the manifest correctly points to `.pi/teams/...` but the background worker logs/exit-codes go to `.crew/.../background.log`. The manifest loader (`loadRunManifestById` → `scopeBaseRoot` → `projectCrewRoot`) reads from the correct path. So if the manifest is created and persists, polling SHOULD work. The early-exit `fs.existsSync` check fires only on the very first poll iteration before any manifest has been written.

## 3. Affected Sites — Complete Inventory

Hardcoded `.crew/state/runs/...` paths that ignore `projectCrewRoot()`:

| File | Line | Code | Used for |
|---|---|---|---|
| `src/runtime/run-tracker.ts` | 82 | `path.join(cwd, ".crew", "state", "runs", runId)` | **CRASH SITE**: `waitForRun()` early-exit |
| `src/runtime/background-runner.ts` | 139 | `path.join(_cwd, ".crew/state/runs", _runId, "background.log")` | Background worker log redirect |
| `src/runtime/background-runner.ts` | 172 | `path.join(cwd, ".crew", "state", "runs", runId, "exit-code.txt")` | Exit code persistence |
| `src/runtime/skill-effectiveness.ts` | 115 | `join(process.cwd(), ".crew/state/runs/${runId}/skill-metrics.jsonl")` | Skill metrics storage |
| `src/runtime/skill-effectiveness.ts` | 125 | `join(process.cwd(), ".crew/state/runs/${runId}/skill-activations.jsonl")` | Skill activation storage |
| `src/runtime/checkpoint.ts` | 166 | `path.join(process.cwd(), ".crew/state/runs", runId)` | `saveCheckpoint` |
| `src/runtime/checkpoint.ts` | 177 | `path.join(process.cwd(), ".crew/state/runs", runId)` | `loadCheckpoint` |
| `src/runtime/checkpoint.ts` | 188 | `path.join(process.cwd(), ".crew/state/runs", runId)` | `clearCheckpoint` |
| `src/runtime/checkpoint.ts` | 199 | `path.join(process.cwd(), ".crew/state/runs", runId)` | `hasCheckpoint` |
| `src/runtime/checkpoint.ts` | 209 | `path.join(process.cwd(), ".crew/state/runs", runId)` | `listCheckpoints` |
| `src/state/decision-ledger.ts` | 29 | `stateRoot ?? \`.crew/state/runs/${runId}\`` | `getLedgerPath` fallback (always hit when called without `stateRoot`) |

**11 sites across 5 files** confirmed affected.

### Already correct (for reference)

| File | Line | Why correct |
|---|---|---|
| `src/state/crew-init.ts` | 209 | `safeJoin(crewRoot, "state", "runs")` — uses `crewRoot` parameter |
| `src/extension/team-tool.ts` | 1210 | `path.join(projectCrewRoot(ctx.cwd), "state", "runs", params.runId)` ✓ |
| `src/extension/team-onboard.ts` | 28 | `path.join(crewRoot, "state", "runs")` — uses parameter |
| `src/runtime/stale-reconciler.ts` | 389 | Inside `tmpDir` workspace scan — these are pi-crew's own zombie workspaces, not user `.pi/` projects, so this is acceptable (but inconsistent) |

## 4. Why the Bug Survives (it should have been caught)

- ✅ `loadRunManifestById` and `loadRunManifestByIdAsync` in `state-store.ts` correctly use `projectCrewRoot()` via `scopeBaseRoot` → `useProjectState`.
- ❌ `waitForRun()` and the 10 other sites above bypass the resolver and hardcode the path.
- The hardcoded path is **inconsistent** with the resolver — clearly a copy-paste/regression.
- The issue is **only triggered in `.pi/`-only projects** (no `.crew/`). Standard `.crew/` projects (the original pi-crew use case) never hit it.

## 5. Recommended Fix (NOT APPLIED per user request)

### Phase 1 — Use the resolver everywhere

Replace each hardcoded path with:

```ts
import { projectCrewRoot } from "../utils/paths.ts";
// ...
const stateRoot = path.join(projectCrewRoot(cwd), "state", "runs", runId);
```

For sites that take `process.cwd()`, switch to taking a `cwd` parameter (callers pass the real cwd). This is a small refactor for `skill-effectiveness.ts` and `checkpoint.ts` since their current API uses `process.cwd()`.

### Phase 2 — Defense in depth (the reporter's second suggestion)

The reporter's point about `subagent-manager.ts` is also valid: **a single run failure should never crash the harness**. The current pattern at line 281 `throw error; // H4: Propagate rejection` deliberately rejects the promise, but if no one awaits it, it becomes unhandled.

Two options:

**A) Add a safety net in `subagent-manager.ts` (recommended)**:

```ts
private start(record: SubagentRecord, ...) {
  // ...
  record.promise = (async () => { ... })();
  // Defense in depth: a subagent failure should never crash pi.
  // Attach a no-op catch so that even if no caller awaits, the rejection
  // doesn't propagate to unhandledRejection → uncaughtException.
  record.promise.catch((error) => {
    logInternalError("subagent-manager.start.unhandled", error, `id=${record.id}`);
  });
}
```

This protects the harness against **any** future rejection path, not just the one fixed in Phase 1.

**B) Remove the `throw error;` at line 281** — the record is already marked `error` status, the caller can read it. This is a deeper change to the API contract.

Option (A) is the smaller, safer change.

## 6. Test Coverage

Tests exist for `checkpoint` (`checkpoint.test.ts`, `checkpoint-cov.test.ts`) and `skill-effectiveness` (`skill-effectiveness.test.ts`) but they likely use a `.crew/`-based temp project, so they wouldn't catch this bug. A regression test should:

1. Create a temp project with `.pi/` (no `.crew/`)
2. Call each affected function (`waitForRun`, `saveCheckpoint`, `getSkillMetricsPath`, etc.)
3. Assert the result path is `.pi/teams/...` (not `.crew/...`)

For the `subagent-manager.ts` defense-in-depth: spawn a subagent whose `runner` rejects, assert pi does not exit and the record is marked `error`.

## 7. Impact Assessment

- **Blast radius**: All pi-crew users with `.pi/`-only projects.
- **Trigger frequency**: Low — requires the background worker to fail/die AND `waitForRun` to be called indirectly via `subagent-manager.ts`. The `team-tool` direct paths are safe.
- **Severity**: CRITICAL — full-harness crash with misleading "Run not found" error pointing at a path that, by design, should never exist.

## 8. Recommended PR Description (draft)

> **Title**: fix(issue #29): use projectCrewRoot() for run-state paths in all 11 affected sites
>
> **Body**:
>
> The `.pi/`-based project layout (`.pi/teams/`) is not handled by the 11 hardcoded `.crew/state/runs/...` sites listed in the analysis. The most severe site is `waitForRun()` in `src/runtime/run-tracker.ts:82`, which throws on a non-existent path and (via `subagent-manager.ts:281`) can escape as an unhandled rejection that crashes pi.
>
> Fix:
> 1. Replace all 11 hardcoded paths with `path.join(projectCrewRoot(cwd), "state", "runs", runId)`.
> 2. For sites that use `process.cwd()` (`skill-effectiveness.ts`, `checkpoint.ts`), switch to taking a `cwd` parameter.
> 3. Add `record.promise.catch(...)` in `subagent-manager.ts:start()` as defense in depth — a subagent failure should never crash the harness.
> 4. Add regression tests using a `.pi/`-only temp project.
>
> Closes #29.

---

## Status

- ✅ Issue reproduced in code (all 11 sites verified)
- ✅ Root cause identified
- ✅ Fix plan drafted
- ❌ **Code changes NOT applied** (per user request: "nothing has been changed yet")
- ❌ Tests NOT added
- ❌ v0.6.2 NOT released

Ready to apply when requested by the user.
