# BUG: Compaction-guard cross-session run-context leak + sendUserMessage race

**Status:** Confirmed, root-caused, fix designed (not yet applied)
**Date:** 2026-06-16
**Severity:** Medium (correctness — wrong session resumes another session's work)
**Reported:** User observed it live ("có lỗi khi dùng /compact ở 1 session khác, lại nhận được thông tin session hiện tại")
**File:** `src/extension/registration/compaction-guard.ts`

## Symptom

Run `/compact` (or trigger auto-compaction) in **Session B** (a different Pi
session open in the same project directory). Session B's post-compaction context
is injected with **Session A's** in-flight run details — runId, goal, team,
workflow — even though Session A owns those runs and Session B has nothing to do
with them. Session B then wrongly tries to resume Session A's run.

Observed leak text (Session A's data showing up in Session B):

```
[pi-crew] Context was compacted while crew tasks were still in-flight. Continue the work - do not wait for me.
- runId=team_20260616085426_ba2f835cc1e2732a (status=running, team=direct-explorer, workflow=direct-agent):
  Map CHÍNH XÁC hiện trạng kiến trúc agent/config/prompt/tool của pi-crew...
```

Plus a second, related error surfacing to the user:

```
Error: Failed to send queued message: Agent is already processing a prompt.
Use steer() or followUp() to queue messages, or wait for completion.
```

## Root Cause

### BUG 1 — `collectInFlightRuns()` has NO session-ownership filter (the leak)

`compaction-guard.ts`:

```typescript
export function collectInFlightRuns(cwd: string): TeamRunManifest[] {
	return listRecentRuns(cwd, MAX_ARTIFACT_INDEX_RUNS).filter((run) =>
		IN_FLIGHT_RUN_STATUSES.has(run.status),   // ← filters STATUS only
	);
}
```

`listRecentRuns(cwd)` scans the **shared project** `.crew/state/runs/` directory
(per-project, NOT per-session). Multiple Pi sessions in the same project share
that directory. So this returns ALL in-flight runs across ALL sessions.

`TeamRunManifest` already carries the owning session:
- `src/state/types.ts:162` → `sessionId?: string`
- `src/state/types.ts:179` → `ownerSessionId?: string`

But `collectInFlightRuns` never reads them. The `session_compact` handler then
calls `triggerContinuation(pi, ctx, inFlight)` with those foreign runs:

```typescript
pi.on("session_compact", (_event, ctx) => {
	const inFlight = collectInFlightRuns(ctx.cwd);   // ← Session A's runs leak in
	if (inFlight.length === 0) return;
	// ... appends resume-directive, notifies, then:
	triggerContinuation(pi, ctx, inFlight);           // ← injects foreign run text
});
```

The current session id IS available on `ctx` — `register.ts:1243-1252` already
extracts it via `Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value`.
So the filter is a 1-line addition; we just never wired it in.

### BUG 2 — `triggerContinuation()` `sendUserMessage` race (the error)

`triggerContinuation` calls `pi.sendUserMessage(prompt)` in the compaction
`onComplete` / `session_compact` path. During compaction the agent may still be
mid-processing, so Pi rejects the queued message:

> "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."

`triggerContinuation` has `try { ... Promise.resolve(result).catch(...) }`, but
the rejection still surfaces to the user (the error line above). It should
either: (a) swallow/notify-only on this specific race (it's benign — the run
continues independently), or (b) fall back to `pi.followUp()` / `ctx.ui` as Pi
suggests. Compounding: once BUG 1 is fixed, foreign runs won't trigger this path
nearly as often for unrelated sessions, but the race still exists for
genuinely-owned runs during a busy compaction.

## Impact

- **Cross-session information leak**: Session B sees Session A's private run
  goal/task text and runId. (Severity depends on how sensitive run goals are —
  in this case it leaked the F1-port-assessment investigation task.)
- **Wrong-session resume**: Session B is instructed to resume Session A's run
  and may call `team status`/`wait` on it, interfering with Session A's work or
  producing confusing output.
- **Noisy error**: the `sendUserMessage` race error is shown to the user even
  though it is benign (the in-flight run continues independently).

## Fix Plan (designed, ~1 file)

### Fix A — session-scoped in-flight runs (the leak)

1. Add an optional session filter to `collectInFlightRuns`:
   ```typescript
   export function collectInFlightRuns(cwd: string, currentSessionId?: string): TeamRunManifest[] {
     return listRecentRuns(cwd, MAX_ARTIFACT_INDEX_RUNS).filter((run) => {
       if (!IN_FLIGHT_RUN_STATUSES.has(run.status)) return false;
       if (currentSessionId) {
         // Only runs owned by THIS session. Keep legacy (no ownerSessionId) runs
         // since older manifests predate the field — but ONLY when we can't tell.
         return !run.ownerSessionId || run.ownerSessionId === currentSessionId;
       }
       return true; // no session filter → current behavior (back-compat for callers)
     });
   }
   ```
   ⚠️ Design note: whether to include legacy `!run.ownerSessionId` runs is a
   judgment call. Safe default for the compaction-guard is **strict** (only
   owned), since the resume directive is session-local. Consider:
   `return run.ownerSessionId === currentSessionId;` (strict, drop legacy) vs
   the lenient version above. Recommend **strict** — if a run has no owner it
   shouldn't be auto-resumed by a random session; crash-recovery handles truly
   orphaned runs separately.

2. Wire `ctx.sessionId` through both call sites in the guard:
   - `session_compact` handler
   - `startCompact` (`onComplete`) and the proactive path

   Use the same safe extractor as `register.ts:1243`:
   ```typescript
   const currentSessionId =
     typeof ctx === "object" && ctx !== null
       ? Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value
       : undefined;
   ```

3. Keep the **artifact index** (`collectCrewArtifactIndex`) UNFILTERED — that's
   intentional durable memory (run artifacts are project-wide), not a resume
   directive. Only the *resume/continuation* path must be session-scoped.

### Fix B — swallow the sendUserMessage race

In `triggerContinuation`, treat "already processing" as benign:
- Detect the race message / error kind and downgrade to silent (or a debug-level
  notify), since the in-flight worker continues independently regardless.
- Optionally fall back to `ctx.ui.notify(...)` with the resume hint so the user
  can manually `team status` if auto-continuation couldn't be queued.

## Verification

- Unit test: `collectInFlightRuns(cwd, sessionA)` returns only runs with
  `ownerSessionId === sessionA`, excluding sessionB-owned runs.
- Unit test: a run with no `ownerSessionId` (legacy) is excluded under strict mode.
- Regression: artifact index still returns cross-session artifacts.

## Related code (reading map)

- `src/extension/registration/compaction-guard.ts` — the bug + fix location
- `src/extension/run-index.ts:90` — `listRecentRuns` (shared project scan)
- `src/state/types.ts:162,179` — `sessionId` / `ownerSessionId` fields
- `src/extension/register.ts:1243-1252` — `ctx.sessionId` extraction pattern to reuse
- `src/runtime/crash-recovery.ts:121` — precedent: `ownerId === currentSessionId` filter
