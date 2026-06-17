# validateWorkflowForTeam cold-start race — STILL PRESENT after v0.8.1

**Date**: 2026-06-16
**Status**: OPEN — noted to fix later. v0.8.1 was a PARTIAL fix.
**Severity**: Medium (flaky, load-dependent — only under concurrent in-process subagent launch)

## Symptom (still firing)

Reproduced again on 2026-06-16 in the edge-ai-agent project (R4-UI7 task):
```
Agent: agent_mqherdfr_2 (executor)
Status: error
Error: Cannot read properties of undefined (reading 'validateWorkflowForTeam')
```
This is the SAME message class as the v0.8.1 crash, but on a different module.

## What v0.8.1 ACTUALLY fixed (be honest)

v0.8.1 added a module-scoped latch `loadLiveSessionModule()` around
`await import("@earendil-works/pi-coding-agent")` in `live-session-runtime.ts`.
That fixed the `Cannot read properties of undefined (reading 'existsSync')`
variant ONLY — because `existsSync` was accessed off the peer-dep namespace.

**It did NOT fix `validateWorkflowForTeam`** — that access is off a pi-crew
internal module namespace (`validate-workflow.ts` → imported by
`validate-resources.ts:4` and `team-tool/{plan,run}.ts`), which the v0.8.1
latch never touched. My v0.8.1 write-up conflated the two errors and claimed
both were covered. That was a diagnostic mistake. This issue documents the
gap honestly.

## Corrected root cause

Under the **tsx loader**, a named import
```ts
import { validateWorkflowForTeam } from "../workflows/validate-workflow.ts";
```
is transpiled to a CJS-interop namespace access at runtime:
```js
const validate_workflow_ts_1 = require("./workflows/validate-workflow.ts");
// ...
validate_workflow_ts_1.validateWorkflowForTeam(workflow, team);  // ← the throw site
```
So `Cannot read properties of undefined (reading 'validateWorkflowForTeam')`
means `validate_workflow_ts_1` (the namespace object) was `undefined` at the
moment of the call — i.e. the module record hadn't finished instantiating.

**This is NOT a property of the peer-dep import specifically. ANY named
import from ANY module can throw this under concurrent cold-start.** v0.8.1's
per-import latch patched ONE access site (the peer dep). It cannot scale to
every import in the codebase. The bug is fundamentally about the loader
serializing module-graph instantiation under concurrent evaluation, not about
any single import.

The defining repro remains: N in-process subagents launched concurrently →
some crash; sequential retries succeed. v0.8.1 reduced the blast radius
(the most common `existsSync` path) but did not eliminate the class.

## Why per-import latching is the wrong general fix

- There are hundreds of named imports across `src/`. Latching each is
  infeasible and unmaintainable.
- The race is on module RECORD INSTANTIATION, which happens inside the
  loader — a JS-level latch in the caller doesn't serialize loader-internal
  module-graph work.
- The latch in v0.8.1 worked for the peer dep because `createAgentSession` is
  the single hot entry point that N concurrent subagents hit; most other
  imports are reached only AFTER session creation (less concurrent pressure).

## Candidate fixes (for the later pass — ranked)

1. **Serialize cold-start at the spawn boundary (preferred).**
   Introduce a one-shot "warmup" gate in the subagent spawn path: before the
   Nth concurrent live-session subagent is allowed to enter its module-touching
   body, ensure the FIRST one has finished instantiating the shared module
   graph. Concretely, a module-scoped `Promise` that the first `createAgentSession`
   call resolves once its synchronous module graph is loaded, that subsequent
   callers `await` before proceeding. This generalizes the v0.8.1 latch to the
   whole graph with a single gate, not per-import.

2. **Pre-warm the module graph at extension registration.**
   `import("./workflows/validate-workflow.ts")` etc. eagerly (top-level, at
   `register()` time, before any subagent spawns). Eager evaluation during
   single-threaded registration avoids the concurrent cold-start window
   entirely. Trade-off: slightly slower startup, larger initial memory. Could
   be gated behind a flag if startup cost matters.

3. **Reduce concurrency at the spawn boundary.**
   `SubagentManager`'s `maxConcurrent` default is 4. Capping at 1–2 during
   the FIRST batch (warmup window) then raising it would avoid the race
   without architectural change. Cheap but a band-aid; doesn't fix the
   underlying loader behavior.

4. **Move off tsx for the runtime hot path.**
   Pre-compile pi-crew to plain ESM (no transpilation) so named imports are
   native ESM bindings (no namespace access, no race). Largest lift; cleanest
   result. Probably overkill for this bug alone.

## Verification plan (when implementing)

- Reproduce: launch 6+ `Agent({ run_in_background: true })` explorer/executor
  subagents in ONE turn (the original repro). Count crashes.
- Before fix: expect ~30–50% crash rate with the `validateWorkflowForTeam`
  (and occasionally other module) errors.
- After fix (option 1 or 2): expect 0 crashes across 10 consecutive 6-agent
  batches.

## Lesson

When a fix claims to address an error *class*, verify it against EVERY
observed variant, not just the first one that reproduced. I saw both
`existsSync` and `validateWorkflowForTeam` in the original 4-agent crash and
treated them as one bug because they looked the same. They share a *root
class* (cold-start module race under tsx) but diverge at the *access site*,
and my single latch only covered one site. Always confirm a class-level fix
with a reproduction of each variant.
