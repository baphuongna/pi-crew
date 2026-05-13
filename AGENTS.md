# pi-crew Development Notes

This package is a Pi extension for team orchestration.

## Source of Truth

Read in this order:

1. This file (`AGENTS.md`) for operating rules and paths.
2. `docs/HARNESS.md` for the human-agent collaboration model.
3. `docs/FEATURE_INTAKE.md` before turning any request into work.
4. `docs/product/` for current product contracts.
5. `docs/ARCHITECTURE.md` for implementation shape.
6. `docs/stories/` for story packets and backlog.
7. `docs/TEST_MATRIX.md` for proof status.
8. `docs/decisions/` for why important choices were made.

## Task Loop

For every task:

1. Classify the request with `docs/FEATURE_INTAKE.md`.
2. Identify affected modules and risk level.
3. Choose lane: tiny, normal, or high-risk.
4. Implement the change.
5. Run validation: `npm test` + `npm run typecheck`.
6. Update docs, stories, test matrix, decisions as needed.
7. Report what changed and what was not attempted.

## Rules

- Keep `index.ts` minimal; register functionality from `src/extension/register.ts`.
- Prefer small modules over large orchestrator files.
- Do not copy source from SUL-licensed projects. `oh-my-openagent` is concept-only inspiration.
- MIT sources such as `pi-subagents` and `oh-my-claudecode` may be adapted with attribution in `NOTICE.md`.
- Avoid `any`; use `unknown` plus validation for tool/config inputs.
- Avoid dynamic inline imports, EXCEPT at documented lazy-load boundaries to defer heavy runtime cost (mark with `// LAZY: <reason>`).
- Do not hardcode global keybindings without user configurability.
- Default execution uses child Pi workers. Keep it safe through runtime limits, depth guards, and explicit disable controls (`executeWorkers=false`, `runtime.mode=scaffold`, `PI_CREW_EXECUTE_WORKERS=0`, or `PI_TEAMS_EXECUTE_WORKERS=0`).
- Worktree cleanup must preserve dirty worktrees unless `force` is explicitly set.
- Management deletes must require `confirm: true`; referenced resources should be blocked unless `force: true`.
- After code changes, run `npm test` from `pi-crew/` unless explicitly told not to.

## Important commands

```bash
npm test
```

## Important paths

- `src/extension/team-tool.ts` — main tool actions
- `src/runtime/team-runner.ts` — workflow scheduler
- `src/runtime/task-runner.ts` — task execution and artifacts
- `src/state/` — durable state/event/artifact store
- `src/worktree/` — worktree creation and cleanup
- `agents/`, `teams/`, `workflows/` — builtin resources
