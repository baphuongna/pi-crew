# Feature Intake

Mọi implementation prompt phải đi qua intake gate trước khi code changes.

## Intake Flow

```text
User prompt / issue
        │
        ▼
Classify input type
        │
        ▼
Identify affected modules
(src/runtime, src/state, src/extension, src/ui, src/utils)
        │
        ▼
Run risk checklist
        │
        ▼
Choose lane: tiny, normal, or high-risk
        │
        ▼
Create/update story packet (normal+)
or patch directly (tiny)
```

## Input Types

| Type | Use when | Artifact |
|------|----------|----------|
| Bug fix | Fix crash, wrong behavior, test failure | Direct patch or story |
| Feature | New capability (new tool action, new runtime mode) | Story packet |
| Refactor | Internal restructure without behavior change | Direct patch |
| Performance | Improve speed/memory/concurrency | Story packet |
| Security | Fix vulnerability, harden boundary | High-risk story |
| Docs | README, comments, harness files | Direct patch |
| Dependency | Update/add/remove dependencies | Story packet |
| Harness improvement | Improve this operating model | Direct docs update |

## Lanes

### Tiny
Low-risk: docs, names, narrow edits, comment fixes.

Requirements:
- Patch directly
- Run `npm run typecheck`
- Update harness only if friction found

### Normal
Story-sized behavior with bounded blast radius.

Requirements:
- Create/update story in `docs/stories/`
- Link affected product docs
- Add/update test matrix entries
- Run `npm test` + `npm run typecheck`
- Update `docs/TEST_MATRIX.md`

### High-Risk
Affects security, data integrity, state mutation, concurrency, or multiple modules.

Requirements:
- Create high-risk story folder in `docs/stories/`
- Fill overview, design, exec plan, validation
- Ask human confirmation before implementation
- Record decision in `docs/decisions/`

## Risk Checklist

| Risk flag | Applies when work touches |
|-----------|---------------------------|
| State mutation | manifest.json, tasks.json, events.jsonl writes |
| Concurrency | shared mutable state, race conditions, locks |
| Child process | spawning Pi workers, worktree isolation |
| Error handling | catch blocks, error propagation, crash recovery |
| External tools | `gh` CLI, `git` commands, shell execution |
| API contract | team tool API shape, tool parameters |
| Platform | Windows vs Unix path handling, EBUSY/EPERM |
| Backward compat | state format changes, config migration |
| Dependencies | new npm packages, native modules |
| Security | command injection, path traversal, trust boundaries |

## Classification

```text
0-1 flags:
  tiny or normal, based on code impact

2-3 flags:
  normal with stronger validation

4+ flags:
  high-risk

Hard gates (always high-risk):
  - State mutation + concurrency
  - Child process spawning
  - External tool execution (command injection surface)
  - Removing or weakening error handling
  - Changing state file format without migration
```

## Affected Modules

| Module | Path | Blast radius |
|--------|------|-------------|
| Extension | `src/extension/` | Tool API, registration, hooks |
| Runtime | `src/runtime/` | Team runner, task runner, child process, async |
| State | `src/state/` | Durable state, events, locks, artifacts |
| UI | `src/ui/` | TUI dashboard, overlay, widgets |
| Utils | `src/utils/` | Shared utilities, conflict detection, git |
| Worktree | `src/worktree/` | Git worktree management |
| Config | `src/config/` | Runtime config, resource discovery |
| Tests | `test/` | Unit tests, integration |

## Output Example

```text
Lane: normal
Reason: touches state mutation and concurrency in team-runner.ts
Modules: src/runtime/team-runner.ts, src/state/state-store.ts
Story: docs/stories/US-015-durable-state-locking.md
Validation: npm test, npm run typecheck, CI 3/3
```
