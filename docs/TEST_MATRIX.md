# Test Matrix

Maps pi-crew behavior to proof. Every row must have real validation evidence.

## Status Values

| Status | Meaning |
|--------|---------|
| planned | Accepted behavior, not implemented |
| in_progress | Actively being built |
| implemented | Implemented and proof exists |
| changed | Contract changed after implementation |
| retired | No longer part of product |

## Matrix

| Story | Contract | Unit | Integration | CI | Status | Evidence |
|-------|----------|------|-------------|-----|--------|----------|
| Core team run | `docs/product/team-run.md` | yes | yes | yes 3/3 | implemented | 1621 tests pass |
| Child process runner | `docs/product/child-process.md` | yes | no | yes 3/3 | implemented | child-pi.ts tests |
| Async runner | `docs/product/async-runner.md` | yes | no | yes 3/3 | implemented | async-runner tests |
| Live session | `docs/product/live-session.md` | yes | no | yes 3/3 | implemented | live-session tests |
| State durability | `docs/product/state.md` | yes | no | yes 3/3 | implemented | state-store tests |
| Worktree isolation | `docs/product/worktree.md` | yes | no | yes 3/3 | implemented | worktree tests |
| Team tool API | `docs/product/team-tool.md` | yes | no | yes 3/3 | implemented | api tests |
| Group join | `docs/product/group-join.md` | yes | no | yes 3/3 | implemented | group-join tests |
| Model fallback | `docs/product/model-fallback.md` | yes | no | yes 3/3 | implemented | model-fallback tests |
| Conflict detection | `docs/product/conflict-detect.md` | yes | no | yes 3/3 | implemented | conflict-detect tests |
| Crash recovery | `docs/product/crash-recovery.md` | yes | no | yes 3/3 | implemented | crash-recovery tests |
| Effectiveness guard | `docs/product/effectiveness.md` | yes | no | yes 3/3 | implemented | effectiveness tests |
| Windows EBUSY | `docs/product/platform.md` | yes | no | yes 3/3 | implemented | rmSyncRetry tests |
| Depth guard | `docs/product/runtime-safety.md` | yes | no | yes 3/3 | implemented | depth-guard tests |

## Evidence Rules

- **Unit proof**: Pure logic, state transitions, config parsing
- **Integration proof**: Multi-module interaction (team runner → state → child process)
- **CI proof**: Cross-platform (ubuntu, windows, macos) green on GitHub Actions
- A story can be implemented without every proof column if the story explains why
- Agents must run `npm test` and `npm run typecheck` before claiming done

## Validation Commands

```bash
npm test                    # Run all unit tests (1600+)
npm run typecheck           # TypeScript check + strip-types import
npm run check               # Biome lint + format
gh run list --limit 1       # Check latest CI status
```
