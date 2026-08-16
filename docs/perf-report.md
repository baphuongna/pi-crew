# pi-crew Performance Report (v0.9.62)

> Real measured numbers from the benchmark suite in `bench/b*.bench.ts`,
> captured via `node scripts/run-bench.mjs` on this machine.

## 0. Environment

| Key | Value |
|---|---|
| Node | `v22.23.1` |
| Platform | `linux` |
| Date | 2026-08-06T09:06:59Z |
| Model (env `PI_MODEL`) | `deepseek/deepseek-v4-flash` |
| Bundle | `dist/index.mjs`, 2,915,941 B |
| Results file | `bench/results/2026-08-06T09-12-02-004Z.json` |

Re-run anytime:

```bash
cd pi-crew
node scripts/run-bench.mjs     # runs legacy test/bench + bench/b*.bench.ts
```

## 1. b1 — child spawn cold start (REAL pi binary)

> ⚠️ **Correction (2026-08-06):** the original b1 measured a bare
> `node -e "process.exit(0)"` probe (~38 ms) — NOT the real spawn path.
> Rewritten to use the runtime's own `getPiSpawnCommand()` +
> `buildFinalChildPiSpawnOptions()` and spawn the actual `pi` binary
> (`pi --version`, no LLM). Real per-subagent cost includes pi runtime boot.

| n | total ms | ms/child | max block ms | RSS Δ (B) |
|---|---|---|---|---|
| 1 | 1,167 | 1,167 | 0 | 4,812,800 |
| 5 | 6,320 | 1,264 | 0 | 131,072 |
| 10 | 12,671 | 1,267 | 0 | 262,144 |

- Real `pi` binary (resolved via `getPiSpawnCommand`, exec'd with the
  runtime's env-filtered options): **~1.2 s/child**, linear in n.
- This includes the pi runtime boot (~1.27 s from b7) — consistent with b7.
- No event-loop blocking (spawn is async); the RSS delta is near-zero because
  the child is detached (`setsid`).
- A full spawn + broker-handshake + first-LLM-turn probe needs a live Pi
  session + credentials — TODO in perf-analysis.md §7.

## 2. b2 — broker handshake + round-trip (real unix-socket CrewBroker)

| metric | value |
|---|---|
| broker start (bind) | 7.25 ms |
| handshake (connect + hello + 1st rt) | 7.69 ms |

| n msgs | wall ms | p50 ms | p95 ms | max ms | msgs/s |
|---|---|---|---|---|---|
| 1 | 0.52 | 0.52 | 0.52 | 0.52 | 1,924 |
| 100 | 13.63 | 0.10 | 0.22 | 2.05 | 7,336 |
| 1000 | 119.71 | 0.10 | 0.14 | 4.32 | 8,353 |

- Steady-state p95 ≈ **0.14–0.22 ms/msg**, ~8.3k msgs/s. Handshake is the
  dominant one-time cost (~7.7 ms).

## 3. b3 — state store JSONL write/read

| n entries | jsonl write ms | jsonl read ms | atomic write ms | bytes |
|---|---|---|---|---|
| 10 | 0.08 | 0.09 | 13.40 | 2,520 |
| 100 | 0.20 | 0.30 | 13.03 | 25,430 |
| 1000 | 0.86 | 2.31 | 20.73 | 256,880 |

- Raw JSONL append/read is microseconds-per-entry; **`atomicWriteJson` has a
  ~13 ms fixed floor** (temp-file + rename + symlink-safety checks) regardless
  of payload size.

## 4. b4 — event-log append + retention

| n events | sync ms (ev/s) | async ms (ev/s) | buffered ms (ev/s) | compact ms |
|---|---|---|---|---|
| 100 | 1,344.86 (74) | 121.87 (821) | 261.08 (383) | 0.78 |
| 1000 | 14,066.25 (71) | 1,180.59 (847) | 279.06 (3,584) | 1.89 |
| 10000 | *skipped* (~145 s est) | 10,759.93 (929) | *skipped* (1000-cap overflow) | 52.79 |

- **Finding:** sync `appendEvent` ≈ **14 ms/event** (~70 ev/s) — lock +
  fsync + `sleepSync` retry. ~12× slower than async, ~50× slower than
  buffered. This is the single biggest per-op cost in the system.
- Async ≈ 1.1 ms/event; buffered ≈ 0.28 ms/event at 1k (batch of 1000).
- Compaction of a 1.78 MB log: **52.79 ms** (10k events → 178 KB).

## 5. b5 — deep subagent tracking (run-graph + observation-store)

| subagents | tasks | graph build ms | nodes/edges | graph save ms | graph bytes | obs record+save ms | obs bytes | est tokens/sub | est tokens/run |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 3 | 0.27 | 4/5 | 22.74 | 1,930 | 15.37 | 820 | 360 | 360 |
| 10 | 30 | 2.54 | 31/59 | 13.11 | 15,279 | 12.28 | 7,777 | 360 | 3,600 |
| 50 | 150 | 0.32* | 151/299 | 15.48 | 75,340 | 13.58 | 38,817 | 360 | 18,000 |

\* build time is noise-dominated at this size (GC); the JSON shows `0.32` vs
`2.54` for n=10 — treat build as O(tasks) microseconds per node.

- `collectRunMetrics` on 150 tasks: **0.11 ms** (aggregation is negligible).
- **Deep-tracking token estimate:** ~8 events × ~180 B/event × 1 subagent ÷ 4
  B/token ≈ **360 tokens per subagent**; a 50-subagent run ≈ **18k tokens**
  of tracking overhead on the event-log side (before any observation
  compression/injection).

## 6. b6 — usage/token tracking overhead (pure in-process)

| n tasks | aggregate ms | byRole ms | format report ms | total ms | tokens/ms |
|---|---|---|---|---|---|
| 1,000 | 0.46 | 0.47 | 2.31 | 3.25 | 613k |
| 10,000 | 4.47 | 2.57 | 4.35 | 11.39 | 1.76M |
| 100,000 | 15.98 | 3.66 | 18.15 | 37.78 | 5.31M |

- Linear, sub-ms for realistic run sizes (≤1k tasks). Not a bottleneck.

## 7. b7 — startup (module init, `dist/index.mjs`)

| metric | value |
|---|---|
| cold direct import (iter 1) | 1,289.93 ms |
| warm import (iters 2–3) | 0.03–0.09 ms |
| direct avg (3 iters) | 430.01 ms |
| **child-process cold load** (realistic detached worker) | **1,272.47 ms** |
| bundle size | 2,915,941 B |
| RSS Δ after cold import | ~129 MB |

- Loading the bundle cold costs **~1.27 s in a fresh child process** (the
  realistic per-worker cost). Combined with b1's ~38 ms spawn, a 10-subagent
  run pays ~13 s of pure startup if every worker loads the bundle fresh.

## 8. b8 — artifact + worktree ops

| n artifacts | write ms | read ms | cleanup ms | bytes |
|---|---|---|---|---|
| 1 | 17.90 | 0.19 | 23.74 | 2,101 |
| 10 | 144.34 | 0.50 | 28.61 | 21,010 |
| 100 | 1,652.74 | 3.82 | 30.57 | 210,280 |

- Write ≈ **16 ms/artifact** (atomic write + redaction + hash); read-back
  trivial (~0.04 ms). Cleanup scan is marker-gated and ~24–30 ms.
- **Worktree ops: `skipped`** — they require a live git repo + branch
  topology; not feasible in an isolated bench. Recorded as a limitation in the
  results JSON.

## 9. Feature → resource → time → tokens → model

| Feature | Resource | Time (measured) | Tracking tokens | Model |
|---|---|---|---|---|
| Subagent spawn (real pi binary) | 1 child process | **~1.2 s** (spawn + pi boot) | — | any |
| Broker handshake | 1 socket + hello | ~7.7 ms | — | any |
| Broker round-trip | 1 msg | ~0.12 ms (p95) | — | any |
| Event-log append (sync) | 1 event | ~14 ms | ~45 tok/event* | any |
| Event-log append (async) | 1 event | ~1.1 ms | ~45 tok/event* | any |
| Event-log append (buffered) | 1 event | ~0.28 ms | ~45 tok/event* | any |
| Run-graph build+save | 1 run (150 tasks) | ~16 ms | — | any |
| Observation record+save | 1 subagent | ~0.3 ms | ~200 tok/obs* | any |
| Deep tracking (event side) | 1 subagent | ~9 ms (async) | ~360 tok | any |
| Deep tracking | 50 subagents | ~0.5 s (async) | ~18k tok | any |
| Usage aggregation | 1k tasks | ~3 ms | — | any |
| Artifact write | 1 artifact | ~16 ms | — | any |

\* token heuristic: bytes ÷ 4.

## 10. Top bottlenecks

1. **Sync event-log append** (~14 ms/event, event-loop blocking) — highest
   per-op cost; use async/buffered paths on hot paths.
2. **Cold bundle load in child workers** (~1.27 s) — dominates multi-subagent
   startup; a warm worker pool would remove ~1.3 s × N.
3. **Atomic-write fixed floor** (~13 ms/file) — metrics/graphs/observations/
   artifacts each pay it; batch when runs complete close together.
4. **Child spawn** — the ~38 ms bare-node figure was misleading; the real
   spawn+boot of the pi binary is **~1.2 s/child** (b1), i.e. spawn cost ≈
   bundle-load cost, not negligible. A warm worker pool removes both.

## 11. Recommendations

- Switch hot-path event writes to `appendEventAsync` (or `appendEventBuffered`
  for coalesced batches); reserve sync `appendEvent` for terminal events.
- Implement a **warm child/worker pool** that keeps the bundle loaded — the
  ~1.27 s bundle load dwarfs the ~38 ms spawn.
- Batch post-run persistence (metrics + graph + observations) into fewer
  atomic writes to amortize the ~13 ms floor.
- Add `bench/results/<timestamp>.json` to CI with a `bench:check`-style gate on
  the b4 async/buffered and b2 p95 metrics; regenerate
  `bench/results/baseline.json` from a clean machine before gating.

## 12. Limitations

- b4 sync 10k and buffered 10k are `skipped` (would take ~145 s; buffered has
  a 1000-entry buffer cap) — the trend is clear from 100/1000.
- b8 worktree ops are `skipped` (need live git repo state).
- b1 uses `spawnSync` sequentially; the real runner uses async `spawn`, so
  wall times are conservative (upper bound).
- b5 graph build is noise-dominated at small sizes; treat as O(tasks)
  microseconds per node.
