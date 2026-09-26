# 2026-09-26 — Temp-workspace hygiene: rotating sweep batches, sentinel reclaim TTL, post-suite test sweep

**Status**: Accepted

## Context

Live triage (2026-09-26, full-battery aftermath): health reported
`running=144`, ~3.4k `pi-crew-*` tmpdirs in `/tmp`, reconciler frozen. Root
causes stacked in layers:

- **Sentinel freeze**: a session killed between sentinel-create and dir-delete
  left 42 `.cleanup-in-progress` sentinels; the sweep skipped them forever
  (EEXIST-style permanent skip).
- **Alphabetical batch starvation**: the sweep scanned only the first
  `ORPHAN_TEMP_SCAN_BATCH_SIZE=50` dirs per tick, alphabetically. The frozen
  sentinel cluster (`agent-*` names, alphabet-first) permanently starved the
  ~3.4k dirs behind it.
- **Source leak**: ~320 test files `mkdtemp("pi-crew-*")`; heavy suites spawn
  real runs whose detached runners outlive test cleanup (fixed at the source by
  `2026-09-26-inline-async-test-seam`; residual leaks covered below).

## Decision

1. **Stateless rotation** (`stale-reconciler.ts`): batch index =
   `floor(now / 60s) % ceil(candidates/batch)` — every batch is visited within
   N ticks, no persisted state, deterministic under injected clocks. A stuck
   cluster delays cleanup of dirs behind it by at most one rotation period.
2. **Sentinel reclaim TTL**: a `.cleanup-in-progress` sentinel older than 10
   minutes is reclaimable (its owner died mid-cleanup). Live cleanup holds a
   sentinel for seconds; losing the reclaim race still skips (concurrent-safe).
3. **Post-suite test sweep** (`scripts/sweep-test-tmp.mjs`, wired into
   `scripts/test-runner.mjs` exit paths): after every suite, remove
   pre-existing `pi-crew-*` dirs with `mtime < suiteStart − 30min`. One choke
   point covers all 320 test files instead of per-file teardown rewrites.
   Real dirs only (lstat — symlinks skipped), best-effort, exit-code neutral,
   opt-out `PI_CREW_TEST_NO_TMP_SWEEP=1`. Implementation lives in
   `test-runner.mjs` so copied runners stay self-contained
   (`test-changed-mode` copies it bare).

## Consequences

- Bounded, self-healing `/tmp`: fresh debris is swept by the next suite run;
  stuck clusters rotate through; dead-session sentinels expire.
- Health counts drop to truth after one rotation period (observed:
  running 144→0, zombie 201→0, ~3.4k→19 dirs).
- Rotation is a *liveness* fix, not a *latency* fix — a full sweep of N dirs
  still takes N/batch ticks by design (bounded work per tick).
- Regression contract: `stale-reconciler-rotation.test.ts` (mutation-checked —
  pinned `batchIdx=0` reproduces the starvation),
  `stale-reconciler-sentinel-reclaim.test.ts`, `sweep-test-tmp.test.ts`.
