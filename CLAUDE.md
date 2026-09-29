# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **pi-crew** repository — a Pi extension for multi-agent team orchestration. It coordinates autonomous AI agent teams with durable state, parallel execution, worktree isolation, and safe defaults.

## Architecture

### Three-Layer Design

```
Pi extension layer
  register tools, slash commands, widget/dashboard, notifier, lifecycle cleanup

Runtime layer
  team runner, task graph scheduler, child Pi process runner, async runner,
  model fallback, policy engine, worktree manager

State layer
  <crewRoot>/state/runs/{runId}/manifest.json
  <crewRoot>/state/runs/{runId}/tasks.json
  <crewRoot>/state/runs/{runId}/events.jsonl
  <crewRoot>/artifacts/{runId}/...
```

`crewRoot` resolves to `.crew/` (default) or `.pi/teams/` (legacy repos).

### Key Source Paths

| Path | Purpose |
|------|---------|
| `src/extension/team-tool.ts` | Main tool — 56 schema actions across 5 domain dispatchers (run/status/control/manage/automate); see `src/schema/team-tool-schema.ts:401-453` |
| `src/runtime/team-runner.ts` | Workflow scheduler, task graph, concurrency control |
| `src/runtime/task-runner.ts` | Task execution, workspace/worktree context, model selection |
| `src/runtime/child-pi/` | Child Pi process runtime — spawns real `pi` workers (spawn/streams/kill/steering/timers/transcript modules) |
| `src/runtime/async-runner.ts` | Detached background run spawner + double-gated in-process test seam (`PI_CREW_TEST_ASYNC_INLINE=1` + `PI_CREW_ALLOW_MOCK=1`) |
| `src/state/` | Durable state/event/artifact store |
| `src/worktree/` | Worktree creation and cleanup |
| `src/config/` | Runtime config, resource discovery |
| `agents/`, `teams/`, `workflows/` | Builtin resources |

### Tool Actions (56 total)

The `team` tool exposes 56 schema actions across 5 domains. The canonical
per-action listing (syntax, examples, when to use) is
[`docs/actions-reference.md`](docs/actions-reference.md); the machine-checked
source of truth is `allActionLiterals` in `src/schema/team-tool-schema.ts`
(gated by `test/unit/schema/team-tool-docs-sync.test.ts`).

| Domain | Count | Actions |
|--------|-------|---------|
| run | 10 | run, parallel, plan, plans, orchestrate, resume, retry, wait, steer, goal |
| status | 16 | status, list, get, events, artifacts, summary, graph, search, health, worktrees, checkpoint, cache, explain, onboard, recommend, help |
| control | 7 | cancel, invalidate, respond, cleanup, prune, forget, doctor |
| manage | 17 | create, update, delete, init, config, validate, autonomy, settings, workflow-create, workflow-get, workflow-list, workflow-save, workflow-delete, import, imports, export, compare |
| automate | 6 | schedule, scheduled, anchor, auto-summarize, auto_boomerang, api |

### Runtime Modes

| Mode | Description |
|------|-------------|
| `child-process` (default) | Spawn real `pi` child processes for task execution |
| `scaffold` | Dry-run mode — preview prompts without executing |
| `live-session` (experimental) | In-process session-based execution |

Workers run as **full `pi` sessions by default** — extensions, skills, and tools
are inherited like the main session; restrictions are per-agent opt-in via
frontmatter (`tools:` / `disallowedTools:` / `inheritSkills: false`). Nested
spawning is also default-on: every role gets the `delegate` tool
(`nesting.maxDepth: 4`, kill switch `nesting.enabled: false` in **user** config —
project config cannot flip it, see `src/config/defaults.ts`).

### State Layout

```
<crewRoot>/                          # .crew/ (default) or .pi/teams/ (legacy)
├── state/runs/{runId}/
│   ├── manifest.json                # Run metadata + config
│   ├── tasks.json                   # Task graph + status
│   ├── events.jsonl                 # Append-only events
│   └── agents/{taskId}/status.json  # Per-agent state
├── artifacts/{runId}/
│   ├── goal.md                      # Original goal
│   ├── prompts/{taskId}.md         # Rendered task prompts
│   ├── results/{taskId}.txt        # Task results
│   ├── logs/{taskId}.log           # Execution logs
│   └── summary.md                   # Run summary
├── worktrees/{runId}/{taskId}/     # Isolated git worktrees
└── imports/{runId}/run-export.json
```

### Built-in Teams

- `default` — adaptive: planner breaks the goal into concrete tasks, executes them in parallel phases, verifies
- `fast-fix` — explore → execute → verify (bug fixes)
- `implementation` — adaptive planner fanout for multi-file work
- `review` — explore → code-review → security-review → verify
- `research` — explore → analyze → write

### Resource Discovery (precedence)

```
builtin (package) < user (~/.pi/agent/) < project (.crew/ or .pi/teams/)
```

Custom agents/teams/workflows are YAML files with routing metadata (triggers, useWhen, avoidWhen, cost, category).

### Config Precedence

Config (`pi-crew.json`) merge order DIFFERS from resource discovery:

`builtin (package defaults) < project (.pi/pi-crew.json) < user (~/.pi/pi-crew.json)`

User config always wins. Sensitive fields in project config are sanitized
via `sanitizeProjectConfig()`. See `src/config/config.ts:1170-1181`.

## Common Commands

```bash
# TypeScript validation
npm run typecheck

# Lazy import check
npm run check:lazy-imports

# Run all tests
npm test

# Run unit tests only (fast, parallel)
npm run test:unit

# Run integration tests only (sequential, slow)
npm run test:integration

# Watch mode for unit tests
npm run test:watch

# Full CI pipeline
npm run ci

# Run a single test file
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/your-test.test.ts

# Heavy async tests: run in-process instead of spawning a detached
# background-runner (kills AV spawn-stalls + orphan tmpdirs — see
# docs/decisions/2026-09-26-inline-async-test-seam.md):
#   PI_CREW_TEST_ASYNC_INLINE=1 PI_CREW_ALLOW_MOCK=1 PI_TEAMS_MOCK_CHILD_PI=json-success

# Smoke test local pi install
npm run smoke:pi
```

## Development Notes

### Source of Truth Order

Read in this order when changing behavior:
1. `AGENTS.md` — operating rules and paths
2. `docs/HARNESS.md` — human-agent collaboration model
3. `docs/FEATURE_INTAKE.md` — before turning any request into work
4. `docs/architecture.md` — implementation shape
5. `docs/TEST_MATRIX.md` — proof status

### Task Loop

1. Classify the request with `docs/FEATURE_INTAKE.md`
2. Identify affected modules and risk level
3. Choose lane: tiny, normal, or high-risk
4. Implement the change
5. Run validation: `npm test` + `npm run typecheck`
6. Update docs, stories, test matrix, decisions as needed
7. Report what changed and what was not attempted