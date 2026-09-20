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
| F01 — Snapshot/cleanup worktree contract (RR-010) | `docs/stories/RR-010/overview.md` | yes | yes | pending | implemented | worktree-snapshot-preserve-dirty.test.ts + worktree-snapshot-completeness.test.ts 28/28 (RED→GREEN); full unit 8012 tests + integration 130/0/4 local |
| F02 — Run lock async-context ownership (RR-011) | `docs/stories/RR-011/overview.md` | yes | no | pending | implemented | run-lock-async-async-mutual-exclusion.test.ts (NEW) — RED maxActive=2 → GREEN 18/18 + 32/32 non-regression; CI-flake canary included |
| F03+F16 — Delegation lifecycle (RR-012) | `docs/stories/RR-012/overview.md` | yes | yes | pending | implemented | delegate-execution-cwd / delegate-shadow-lifecycle / shadow-task-dag-readiness (NEW) 23/23 + delegate region 50/50 + scheduling 81/81; scheduler risk PROVEN reachable → guard added |
| F04 — surfaceLost qua ranh giới branch (RR-013) | `docs/stories/RR-013/overview.md` | yes | no | pending | implemented | task-runner-surface-lost-boundary.test.ts (NEW, đi qua runTeamTask thật) — RED completed-giả → GREEN 67/67 incl. finalizer + characterization suites |
| F15 — Semaphore abort (RR-014) | `docs/stories/RR-014/overview.md` | yes | no | pending | implemented | semaphore-abort.test.ts (NEW) — RED waiter stuck → GREEN 36/36; 200-round abort↔handoff race test; capacity-leak tests |
| F05+F18+F19+F20 — Test/CI harness integrity (RR-015) | `docs/stories/RR-015.md` | yes | no | yes (ci.yml + weekly-smoke) | implemented | test-runner-exit.test.ts (NEW 13 tests), test-changed-mode.test.ts (NEW 8), argv-flags.smoke.ts rewritten (mutation-verified), benchmark.test.ts 18→29; wrapper SIGKILL exit 0→1 confirmed live in full-suite run |
| F08+F09+F10 — State/config correctness (RR-016) | `docs/stories/RR-016.md` | yes | no | pending | implemented | config-depth-limit.test.ts (NEW), mailbox-replay.test.ts (+246 dòng), cancellation-trace-wipe.test.ts (+59) — 52/52 sau khi restore từ stash (race với agent timeout đã xử lý) |
| F06+F07 — Persistence/retrieval cost (RR-017) | `docs/stories/RR-017.md` | yes | no | pending | implemented | crew-agent-record-cost.test.ts (NEW, structural counts) — trong bộ 52/52 ở trên; incremental-reader tái dùng cho event cursor |
| F11+F12+F13 — Session resource ownership (RR-018) | `docs/stories/RR-018.md` | yes | no | pending | implemented | observability-ownership-generation.test.ts (NEW, await init — non-vacuous), session-switch-rpc-cache.test.ts (NEW, real registerPiTeams: RPC 4→switch→4), turn-hook-once.test.ts (NEW); registration dir 20 files 0 fail |
| F14+F17 — Idle render + verification quality (RR-019) | `docs/stories/RR-019.md` | yes | no | pending | implemented | preload-idle-render.test.ts (NEW, real scheduler: 8-render allowance honored); verifier.md precedence rule + provenance .meta + pipefail (probe exit 1) + 0 wildcard cleanups; distill.workflow.md cùng treatment |
| Event-type registry completeness + CI enforcement | `docs/archive/2026-09-17-pi-crew-review-verification.md` §6.3 | yes | no | yes (--enforce trong ci.yml) | implemented | gate detection fix (ternary emit sites) + 79 loại đã emit được đăng ký; `check:event-types --enforce` PASS; 89→168 registered |
| Baseline-green: env-vars + test-runner fail-closed | AGENTS.md `npm run ci` | yes | no | yes | implemented | `npm run check:env-vars` PASS (PI_CREW_DEBUG_STALE đăng ký + 2 read routed); full-suite ETIMEDOUT được fail-closed đúng thiết kế → budget 900s→1500s + env override |
| Review-round MAJOR 1: sweep fail-closed khi history không đọc được (run team_20260917150642) | review 2026-09-17 (verifier TRUE POSITIVE) | yes | no | no | implemented | mailbox-sweep-fail-closed.test.ts (NEW, 2 case, RED→GREEN + mutation-check reordering): case 1 — 1001 acks sống sót qua symlinked-tasks-root; case 2 — abort không tiêu throttle window + sweep hồi phục khi FS đọc lại được (mutation: đảo recordAckSweep về trước collect → test đỏ đúng phase 2); collectReplayableInboxIds trả undefined, sweep abort |
| Review-round MAJOR 2: steal live-holder observable | review 2026-09-17 (verifier TRUE POSITIVE) | yes | no | no | implemented | run-lock-steal-live-holder-warn.test.ts (NEW, RED→GREEN: console.error capture được `[pi-crew:locks.steal-live-holder]`); tradeoff doc thêm vào ADR 2026-09-17-run-lock-async-ownership |
| BR-12/BR-01 layout parity: resolver hai-root + `/tmp` scanner hai-layout (RR-020 A0-1/A0-3 + cold-verify R1/R4/R6/F-A) | `docs/stories/RR-020.md` | yes | no | pending | implemented | project-markers-parity.test.ts (NEW, 7 case: parent/.git + subproject/.pi ⇒ một root; worktree `.git` file; monorepo; e2e; markerless-dưới-$HOME boundary stop; marker-dưới-$HOME vẫn win) + run-state-layout-parity.test.ts (NEW, 13 case: cả hai layout; symlink guard cho layout dir, `state` GIỮA, `state/runs`; cleanupLegacyOrphanTempDirs giữ `.pi/teams`) |
| BR-12/BR-01 no-op materialization: session-start không tạo crew root (RR-020 A0-2 + cold-verify R2/R3) | `docs/stories/RR-020.md` | yes | no | pending | implemented | no-op-writers-no-crew-root.test.ts (NEW, 8 case: audit/metric-sink/notification-sink gate theo crew-root-tồn-tại; metric fixture dạng PRODUCTION (registry có metric, không rỗng); HEAD parity: empty tick vẫn ghi, prune 0-candidate vẫn audit; positive control) |
| BR-06 cache key thiếu goal (RR-020 C-1) | `docs/stories/RR-020.md` | yes | no | pending | implemented | prompt-builder-cache-goal.test.ts (NEW: hai run cùng cwd + cùng step template + goal khác ⇒ run B KHÔNG tái dùng suggested-files/knowledge của A) |
| BR-08 cursor continuation (RR-020 C-2) | `docs/stories/RR-020.md` | yes | no | pending | implemented | event-log-cursor-limit-continuation.test.ts (NEW: `limit` + `fromByteOffset` ⇒ không trả `nextByteOffset` gây bỏ sót đuôi; doc contract ghi rõ giới hạn của `nextSeq`: event không seq / duplicate seq cần byte anchor) |
| BR-09 shadow discriminator cấu trúc (RR-020 C-3) | `docs/stories/RR-020.md` | yes | no | pending | implemented | shadow-task-dag-readiness.test.ts (BR-09 case: workflow task agent="delegate" CÓ stepId vẫn dispatch; shadow không stepId loại khỏi DAG) + delegate-shadow-lifecycle.test.ts |
| A0-4 hardcode `.crew` read-site (RR-020 + round-3 test) | `docs/stories/RR-020.md` | yes | no | pending | implemented | keybinding-map-override.test.ts (thêm case `.pi/teams` override + mtime cache; mutation-check revert ⇒ đỏ; 8/8) |
| BR-10 pin fallow (RR-020 D-lite) | `docs/stories/RR-020.md` | n/a | n/a | pending | implemented | `.github/workflows/ci.yml` `FALLOW_VERSION=3.27.0` (thay `@latest`); job vẫn `continue-on-error` |

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
