---
name: runtime-state-reader
description: >
  Safe read-only navigation of pi-crew run state.
  When NOT to use: write actions or mutations (use state-mutation-locking); configuration changes (use resource-discovery-config).

origin: pi-crew
triggers:
  - "inspect manifest"
  - "read tasks"
  - "trace events"
  - "examine state"
  - "diagnostics"
---
# runtime-state-reader

Use this skill when debugging or auditing a pi-crew run.

## Source patterns distilled

- `src/state/types.ts`, `src/state/contracts.ts`, `src/state/state-store.ts`
- `src/state/event-log.ts`, `src/state/artifact-store.ts`, `src/runtime/crew-agent-records.ts`
- `src/extension/run-index.ts`, `src/extension/team-tool/status.ts`, `src/extension/team-tool/inspect.ts`

## Rules

- Prefer exported state APIs over direct file parsing: `loadRunManifestById(cwd, runId)`, run index/list helpers, event readers, and agent readers.
- Treat state as append-mostly/durable. For review and debugging, do not mutate manifests/tasks/events.
- Validate run IDs and path-derived IDs; never concatenate untrusted path segments outside state helpers.
- Read events as JSONL; expect partial/corrupt trailing lines in crash scenarios and handle gracefully.
- Check status contracts before inferring behavior: terminal vs active run/task statuses matter.
- Agent aggregate records (`agents.json`) and per-agent status files can disagree briefly; prefer the latest loaded run state plus event log for final conclusions.
- Include exact paths inspected and distinguish direct evidence from inference.

## Common inspection order

1. Load manifest/tasks.
2. Check run/task statuses and timestamps.
3. Read recent events.
4. Read agent records and per-agent output/status if needed.
5. Inspect artifacts/diagnostics only through contained paths.
6. Report root cause and smallest safe remediation.

## Enforcement — Runtime State Reader Gate

**Before inspecting or reporting on run state, verify:**

- [ ] Using exported state APIs (not direct file parsing where helpers exist)
- [ ] State treated as append-mostly (no mutations during review/debugging)
- [ ] runId validated before use (no untrusted path concatenation)
- [ ] Corrupt JSONL handled gracefully (skip malformed lines)
- [ ] Terminal vs active statuses distinguished (critical for conclusions)
- [ ] Exact paths inspected reported with direct evidence vs inference labeled

If ANY answer is NO → Stop. Verify state access method before proceeding.

## Verification

For code changes to state readers:

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/run-index.test.ts test/unit/crew-contracts.test.ts test/unit/atomic-write.test.ts
npm test
```
