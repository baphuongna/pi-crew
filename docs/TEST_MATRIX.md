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
| Core team run | `docs/product/team-run.md` | yes | yes | yes 3/3 | implemented | 6489 tests pass (839 suites) |
| Child process runner | `docs/product/child-process.md` | yes | yes | yes 3/3 | implemented | child-pi-pool.test.ts, child-pi-timeout.test.ts, mock-child-run.test.ts |
| Async runner | `docs/product/async-runner.md` | yes | yes | yes 3/3 | implemented | async-runner.test.ts, async-restart-recovery.test.ts |
| Live session | `docs/product/live-session.md` | yes | no | yes 3/3 | implemented | live-session-context.test.ts, live-session-runtime.test.ts |
| State durability | `docs/product/state.md` | yes | yes | yes 3/3 | implemented | state-store.test.ts, state-contracts.test.ts, phase3-runtime.test.ts |
| Worktree isolation | `docs/product/worktree.md` | yes | yes | yes 3/3 | implemented | worktree-manager.test.ts, worktree-run.test.ts |
| Team tool API | `docs/product/team-tool.md` | yes | yes | yes 3/3 | implemented | team-tool-dispatch.test.ts, extension-api-surface.test.ts, operator-experience.test.ts |
| Group join | `docs/product/group-join.md` | yes | yes | yes 3/3 | implemented | phase6-runtime-hardening.test.ts |
| Model fallback | `docs/product/model-fallback.md` | yes | no | yes 3/3 | implemented | model-fallback.test.ts |
| Conflict detection | `docs/product/conflict-detect.md` | yes | no | yes 3/3 | implemented | conflict-detect.test.ts, delta-conflict.test.ts |
| Crash recovery | `docs/product/crash-recovery.md` | yes | yes | yes 3/3 | implemented | recovery-recipes.test.ts, async-restart-recovery.test.ts |
| Effectiveness guard | `docs/product/effectiveness.md` | yes | no | yes 3/3 | implemented | effectiveness-guard.test.ts |
| Windows EBUSY | `docs/product/platform.md` | yes | yes | yes 3/3 | implemented | phase6-runtime-hardening.test.ts |
| Depth guard | `docs/product/runtime-safety.md` | yes | no | yes 3/3 | implemented | subagent-depth.test.ts, completion-guard.test.ts |
| Worker loadout full-session (D5) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | pi-args-loadout.test.ts, pi-args.test.ts, pi-args-cov.test.ts |
| Delegate mọi role (D8 — default-on + kill switch) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | yes | pending | implemented | delegate-tool-roles.test.ts, delegate-broker.test.ts, nesting-config.test.ts, delegate-roundtrip-e2e.test.ts |
| Worker message tool (D9) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | yes | pending | implemented | message-tool.test.ts, crew-broker-msg-worker.test.ts, crew-broker-msg.test.ts |
| Worker inbox pickup (§15.2) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | inbox-pickup.test.ts |
| Wake — worker.message event (§15.2) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | crew-broker-msg-worker.test.ts |
| Surface detect matrix + tier-1 cap (§3) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | resolve-surface.test.ts (depth/async/mode/cap/tmux/herdr/both/none) |
| Surface providers tmux/herdr (§4) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | tmux-provider.test.ts, herdr-provider.test.ts (create/send/read/close, onExit, graceful escalation) |
| Launch script + TTL + orphan sweep (§5.2) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | launch-script.test.ts (0600, shellEscape, taskId guard, depth guard lớp 2, early self-delete, relative baseDir → absolute) |
| Worker terminal events — emitTerminal (§12.2) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | worker-events-channel.test.ts |
| Surface spawn branch trong child-pi (§13.1) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | surface-spawn.test.ts, prepare-surface-spawn.test.ts, child-pi-surface.test.ts |
| Worker recorder + auto-exit + parent-guard (§5.2/§5.3) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | surface-runtime.test.ts (stopReason `stop` + alias, pid-reuse, seq-seed, worker.error cap) |
| EventLogTailSource (§5.3) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | event-log-tail-source.test.ts |
| Broker revoke + stale-token + fresh re-issue (§12.4) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | wait-request-broker.test.ts, crew-broker-tokens.test.ts |
| Degrade + classify timeout + lockout + headless resume (§7) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | degrade.test.ts, post-execution-surface-lost.test.ts, team-runner-surface-registry-lifecycle.test.ts (3/4 resume components — session resume defer A2) |
| Zombie surface fields + doctor orphan-pane cleanup (§5.1) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | zombie-scanner.test.ts, doctor-orphan-cleanup.test.ts |
| Surface config keys (§8) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | yes | no | pending | implemented | surface-config.test.ts |
| E2E surface tmux — spawn/degrade/doctor (§9 system) | `docs/superpowers/specs/2026-08-26-mux-surface-design.md` | no | local only | skip by design | implemented | surface-tmux.e2e.test.ts — `npm run test:system` trong tmux (3/3 local); `npm test` KHÔNG chạy `test/system` (opt-in local, CI skip qua guard `CI \|\| !TMUX`) |
| Inline agent panel | `docs/design/2026-08-20-inline-agent-panel.md` | yes | no | pending | in_progress | inline-panel-selection.test.ts, widget-budgeted-row.test.ts, agent-transcript.test.ts, inline-panel-openpane.test.ts, widget-focused.test.ts, task-list.test.ts |

## Evidence Rules

- **Unit proof**: Pure logic, state transitions, config parsing
- **Integration proof**: Multi-module interaction (team runner → state → child process)
- **CI proof**: Cross-platform (ubuntu, windows, macos) green on GitHub Actions
- A story can be implemented without every proof column if the story explains why
- Agents must run `npm test` and `npm run typecheck` before claiming done

## Validation Commands

```bash
npm test                    # Run all unit + integration tests (6489 tests across 670 unit files + 29 integration files)
npm run typecheck           # TypeScript check + strip-types import
npm run check               # Biome lint + format
npm run test:unit           # Unit tests only (fast, parallel)
npm run test:integration    # Integration tests only (sequential)
npm run test:system         # System E2E (opt-in local — cần chạy TRONG tmux; KHÔNG thuộc npm test/CI)
gh run list --limit 1       # Check latest CI status
```
