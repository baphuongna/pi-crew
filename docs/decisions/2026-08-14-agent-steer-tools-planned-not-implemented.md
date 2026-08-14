# Agent-level steer tools: planned, not implemented

**Date:** 2026-08-14
**Status:** Accepted — decision (b) for Phase 1.3 of the maintainability refactor
**Relates to:** `src/extension/registration/subagent-tools.ts` (`steer_subagent`, `crew_agent_steer`), `src/runtime/child-pi/child-pi-steering.ts`, `src/extension/team-tool.ts` (`handleSteer`), `docs/actions-reference.md` (`steer` action)

## Context

`steer_subagent` / `crew_agent_steer` returned stub strings
(`t("steer.noted")` + `t("steer.unavailable")`). Real tool-level steering means
writing a steering JSONL entry to a LIVE running child's steering file
(`artifacts/steering/<taskId>.jsonl`, the same file `pollSteering()` in
`prompt-runtime.ts` polls via `PI_CREW_STEERING_FILE`) with agent_id
validation.

## Evidence (verified 2026-08-14)

1. The steering file is keyed by the **team task id** — built at
   `src/runtime/task-runner/child-executor.ts:549` as
   `steeringFile: resolveRealContainedPath(\`${manifest.artifactsRoot}/steering\`, \`${task.id}.jsonl\`)`,
   and handed to the child via `PI_CREW_STEERING_FILE`
   (`child-pi-spawn.ts:271`).
2. The tool layer's lookup (`subagentManager.getRecord(id)` /
   `readPersistedSubagentRecord(cwd, id)`) returns `SubagentRecord`, which has
   `id` (`agent_...`), optional `runId`, and **no `taskId` field** — so the tool
   cannot resolve which steering file a live run is polling. `CrewAgentRecord`
   has `taskId`, but the steer tools do not consume it.
3. The run-level steering path IS wired: `team action=steer`
   (`handleSteer`, `team-tool.ts:529`) takes `runId`+`taskId`+`message`, guards
   terminal tasks, appends to `pendingSteers`, and writes the steering file
   immediately (documented at `docs/actions-reference.md` §`steer`).

## Decision

**Option (b): mark the tools as "planned, not implemented".** No direct seam
exists (<~40 LOC, no new state) — bridging the gap would require adding a
`taskId` linkage to `SubagentRecord` (new state) and run-manifest resolution in
the tool layer. That is a feature build, out of scope for a stub-resolution
step. The stubs now say so explicitly and point users at
`team action=steer` / `team cancel`.

## Consequences

- Tool responses keep returning `steer.noted` + `steer.unavailable`; comments
  and tool descriptions now state the planned status.
- Real-time steering of a running child remains available at run level via
  `team action=steer` (pendingSteers queue + steering-file write).
- If a future task wants option (a), the prerequisite is a `taskId` (or
  steering-file path) field on `SubagentRecord`, populated at spawn time.
