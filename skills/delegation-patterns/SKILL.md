---
name: delegation-patterns
description: "Subagent/team delegation workflow. Use when splitting work across pi-crew teams, direct agents, async background workers, chains, or parallel tasks. Triggers: delegate this, split this task, parallelize, dispatch workers, assign to team, spawn agents."
---

# delegation-patterns

Use this skill when deciding how to delegate work.

## Source patterns distilled

- pi-subagents: foreground/background/parallel/chain execution, fork/fresh context, worktree isolation, result watcher
- pi-crew: `src/extension/team-tool/run.ts`, `src/runtime/team-runner.ts`, `src/runtime/task-graph-scheduler.ts`, builtin `teams/*.team.md`, `workflows/*.workflow.md`
- Existing pi-crew skill: `task-packet`

## Rules

- Delegate when tasks span multiple files/subsystems, need planning/review/verification, or can be independently researched.
- Do not parallelize edits to the same file, symbol, migration path, manifest/lockfile, or generated schema unless explicitly sequenced.
- Use read-only explorer/reviewer roles for source audit; implementation workers should receive narrow task packets.
- For async/background work, provide concrete objective, scope, constraints, outputs, and verification. Do not spin in wait loops; retrieve results when notified or when needed.
- For chain-style work, pass dependency outputs forward explicitly and require downstream workers to read upstream artifacts first.
- Use worktree isolation for risky parallel code-changing tasks when repository cleanliness and merge plan allow it.
- Require workers to report blockers and smallest recoverable next action rather than making broad assumptions.

## Task packet checklist

- objective
- scope/paths
- allowed edits vs read-only areas
- constraints and project rules
- dependencies/input artifacts
- expected output artifacts
- acceptance criteria
- verification commands
- escalation conditions

## Anti-patterns

- Sending broad “fix everything” prompts to multiple editors in one workspace.
- Waiting for async workers by sleeping/polling when result notifications exist.
- Letting review workers modify files.
- Claiming completion without durable artifacts or verification evidence.

## Verification

For orchestration changes:

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/team-recommendation.test.ts test/unit/task-output-context-security.test.ts test/integration/phase3-runtime.test.ts
npm test
```
