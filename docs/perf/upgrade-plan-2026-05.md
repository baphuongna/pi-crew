# pi-crew Performance Upgrade Plan — 2026-05

Date: 2026-05-14
Owner: pi-crew maintainers
Base branch: `perf/baseline-bench`
Status: in-progress (Sprint 0 starting)

## Purpose

Improve performance and UI smoothness while maintaining stability, following the `AGENTS.md` task loop and the 5 current ADRs (durable state, child-process for async, depth guard, execFileSync, no parameter properties). This plan consolidates 30 analyzed upgrade items, split into 5 sprints plus 1 wrap-up phase.

The tracks:

1. **Smoother UI** — cut sync I/O out of the render path.
2. **Runtime/state** — reduce syscalls, lazy imports, warm pool, refactor large files.
3. **Stability** — backpressure, heartbeat, early cancel, mailbox archive, Windows kill-tree.
4. **Low-cost telemetry** — stream sink, OTLP gzip, sampled progress, histogram buckets.
5. **Build/test feedback loop** — bench gate, test concurrency, watch mode, bundling.

## Process applied to every PR

- Branch: `perf/<sprint>-<id>-<slug>` cut from `perf/baseline-bench`.
- Lane (per `AGENTS.md`): tiny / normal / high-risk.
- Required validation before merge:
  - `npm run typecheck`
  - `npm run check:lazy-imports`
  - `npm test`
  - `npm run bench:check` — no regression > 15%
- Documentation:
  - Update `CHANGELOG.md` (grouped by sprint).
  - Update `docs/TEST_MATRIX.md` when adding tests.
  - Write an ADR for any contract change (`docs/decisions/`).
- Do not combine > 2 items into a single PR. No "drive-by" refactors.
- Each high-risk item must have a kill switch in config (`runtime.experimental.<feature>=false`).

## Sprint 0 — Baseline & gate (2 days)

Goal: measure before optimizing.

| ID | Task | Files | Lane |
|---|---|---|---|
| S0-1 | Profile script | `scripts/profile-startup.mjs` | tiny |
| S0-2 | Bench harness, 3 files | `test/bench/{register-startup,render-flush,snapshot-cache}.bench.ts`, `test/bench/baseline.json` | normal |
| S0-3 | `npm run bench` + `bench:check` | `package.json`, `scripts/bench-check.mjs` | tiny |
| S0-4 | Base branch `perf/baseline-bench` | — | — |
| S0-5 | Capture baseline | `docs/perf/baseline-2026-05.md` | tiny |

Exit criteria: `npm run bench` is stable, baseline recorded.

## Sprint 1 — Low-risk UI smoothness (5 days)

| ID | Item | Lane | Acceptance |
|---|---|---|---|
| 1.1 | renderTick no-sync | tiny | Render skeleton when preload is not ready; test that a thrown fs.statSync does not crash. |
| 1.2 | Async snapshot stamps | normal | Sync version only in the CLI handler; bench p95 -30%. |
| 1.4 | Stamp version counter | tiny | Use `events.jsonl.seq` instead of `combineStamps(size)`. |
| 1.5 | Stamp agents O(1) | tiny | 1 stat/run instead of N. |
| 1.8 | Powerbar dedup hash | tiny | 100 emits with the same payload → 1 event. |
| 1.9 | subagent.completed coalescer | tiny | 10 events within 30 ms → 1 invalidate. |
| 1.10 | Mascot pause idle | tiny | Config `ui.mascotPauseIdleMs`. |

Exit: `render-flush.bench.ts` -30%, `snapshot-cache.bench.ts` -20%.

## Sprint 2 — Cut sync I/O from the hot path (5 days)

| ID | Item | Lane | Acceptance |
|---|---|---|---|
| 2.7 | Lazy import phase 2 | tiny | `register` end-to-end -200 ms. |
| 2.10 | projectCrewRoot cache | tiny | 1000 calls → 1 stat. |
| 4.1 | Metric-sink stream | tiny | 10k metrics → 0 sync IO on hot path. |
| 4.4 | Progress sample 1/10 + first/last | tiny | 100 progress events → 12 in jsonl. |
| 2.1 | Atomic-write coalescer | normal | A crash in the window does not corrupt; recovery test. |
| 2.2 | Events.jsonl buffer 20 ms | normal | flushSync on cleanupRuntime + session_before_switch. |
| 2.3 | Rotation threshold 4 MB | tiny | Append 4 MB → rotate. |
| 1.3 | FS watcher native | normal | Render < 100 ms from FS event; poll fallback on ENOSYS. |

Exit: 0 sync IO in `RenderScheduler.flush`, register start ≤ 400 ms.

## Sprint 3 — Refactor & UI selectors (5 days)

| ID | Item | Lane | Acceptance |
|---|---|---|---|
| 2.8 | Split out adaptive-plan | normal | `team-runner.ts` < 45 KB; lazy import when workflow ≠ implementation. |
| 2.9 | Split out config.ts | normal | `config.ts` < 20 KB; hot path does not import drift/suggestions. |
| 1.6 | Dashboard pane independent | normal | 1 task changes → only the agents-pane re-renders. |
| 1.7 | Memoized snapshot slice | normal | 2 identical get calls on the same cache → same reference. |
| 5.1 | Test concurrency 4 | tiny | each test does its own mkdtemp for a private PI_TEAMS_HOME. |

Exit: dashboard FPS +50% while a run is active.

## Sprint 4 — Stability & telemetry (4 days)

| ID | Item | Lane | Acceptance |
|---|---|---|---|
| 3.1 | Backpressure stdout | normal | Stress 50 MB output → memory does not exceed cap. |
| 3.2 | Heartbeat backoff | tiny | Stale → poll every 1 s; healthy → every 5 s. |
| 3.5 | Cancel propagate < 200 ms | normal | Stream-parse JSONL + signal check. |
| 3.6 | Deadletter cooldown | tiny | Config `reliability.deadletterCooldownMs`. |
| 3.7 | Idempotent resume by attemptId | tiny | Resume 3 times → artifact is not duplicated. |
| 3.8 | Kill-tree on Windows | normal | SIGKILL fail → `taskkill /F /T`. |
| 3.4 | Atomic-write jitter | tiny | Jitter ±20%, max 8 attempts. |
| 3.3 | Mailbox auto-archive | normal | 11 MB → rotate into blob-store. |
| 4.2 | OTLP gzip + delta | tiny | Content-Encoding: gzip; counter delta. |
| 4.3 | Histogram buckets pre-tuned | tiny | `crew.task.duration_ms` buckets `[50,200,500,1k,5k,30k,120k]`. |

Exit: cancel < 200 ms, no OOM under stress, no deadletter repetition.

## Sprint 5 — High-risk backlog + ADR (1 week)

| ID | Item | Lane | ADR |
|---|---|---|---|
| 5.5 | Bundle ESM (esbuild) | high-risk | `0006-publish-bundled-esm.md` |
| 2.4 | Active-run-registry binary | high-risk | `0007-active-run-binary-index.md` |
| 2.6 | Child-pi warm pool | high-risk | `0008-child-pi-warm-pool.md` |
| 2.5 | Lazy materialize agent records | normal | — |
| 5.2 | Watch mode test | tiny | — |

Each item: ADR + kill switch + dual-ship migration if needed.

## Wrap-up

- `docs/perf/sprint-<n>-report.md` at the end of each sprint.
- `docs/perf/final-report-2026-05.md` comparing baseline vs final.
- Update `docs/archive/next-upgrade-roadmap.md` to mark completed items.

## Risk register

| Risk | Sprint | Mitigation |
|---|---|---|
| Coalescer loses events on crash | 2 | flushSync in exit hook; crash-recovery integration test. |
| FS watcher fails on network filesystems | 2 | Detect ENOSYS/EPERM → poll fallback. |
| Bundling breaks Pi extension load | 5 | Prototype + smoke first; dual-ship for 1 release. |
| Warm pool leaks state | 5 | Pool process starts fresh, has a nonce; reuse failure → discard. |
| Binary index migration | 5 | Read both binary + JSONL for 2 releases. |
| Concurrency=4 unit tests flaky | 3 | Audit tests using a shared HOME; each test does its own mkdtemp. |

## Measurement goals

| Metric | Baseline (Sprint 0) | Target | Expected sprint for improvement |
|---|---|---|---|
| `register.ts` end-to-end | TBD | < 400 ms | 2 |
| Widget first frame after session_start | TBD | < 150 ms | 1 |
| `runTeamTask` cold | TBD | -2 to -4 s (warm pool) | 5 |
| Dashboard FPS while a run is active | TBD | +50% | 3 |
| events.jsonl tail 32 KB parse | TBD | < 5 ms | 2 |
| CPU idle when run completed | TBD | < 1% | 1 |
| Cancel round-trip | TBD | < 200 ms | 4 |
