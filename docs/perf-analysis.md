# pi-crew Performance Analysis (v0.9.62)

> Companion to [`perf-report.md`](./perf-report.md) (measured numbers) and the
> `bench/b*.bench.ts` suite (repeatable measurements).

## 1. Architecture at a glance

pi-crew is a Pi extension that orchestrates AI teams. A run dispatches
subagents as child Pi processes; every run accumulates state through several
persistence layers. Understanding what each layer stores, when it writes, and
its I/O pattern is the key to reasoning about performance.

```
                ┌──────────────────────────────┐
                │  team-runner (orchestrator)  │
                └──────┬───────────┬───────────┘
                       │           │
        spawn child Pi │           │ broker (unix socket)
                       ▼           ▼
               ┌────────────┐ ┌─────────────┐
               │ subagent   │ │ CrewBroker  │  b2
               │ workers    │ │ + client    │
               └─────┬──────┘ └─────────────┘
                     │ events / task state (JSONL)
                     ▼
        ┌──────────────────────────────┐
        │ .crew/state:                 │
        │  runs/<id>/events.jsonl      │  b4
        │  runs/<id>/tasks.json        │
        │  metrics/<runId>.json        │  b3
        │  graphs/<runId>.json         │  b5
        │  observations/<...>.json     │  b5
        │  artifacts/<...>             │  b8
        └──────────────────────────────┘
```

## 2. Deep subagent tracking — what each component stores

### 2.1 event-log (`src/state/event-log/`)

| Aspect | Detail |
|---|---|
| **What it stores** | One JSONL line per `TeamEvent` (worker spawn, task.transition, task.progress, message_end usage, run.budget_*, …). Sidecar `.seq` file tracks the last sequence number. |
| **When it writes** | Every event, through one of three paths: `appendEvent` (sync), `appendEventAsync` (async queue), `appendEventBuffered` (coalesced batch). |
| **I/O pattern** | Append-only JSONL + per-write lock. Sync path takes a `.mkdirlock` (mkdir + `sleepSync` retry loop) and fsyncs; async path takes an `.alock` (async mkdir + `await sleep(50)` retry); buffered path batches into one flush. |
| **Memory** | In-process `sequenceCache` (FIFO, 256 entries) + `appendCounters` (FIFO, 256 entries). Bounded. |
| **Retention** | Rotation at 4 MB or 50k events (`needsRotation`); compaction rewrites to `compactToCount` (1000) events. 50 MB hard cap. |

**Known cost (measured in b4):** sync append ≈ **14 ms/event** (~70 events/s) —
lock acquisition + fsync dominate; it blocks the event loop (uses `sleepSync`).
Async append ≈ **1 ms/event** (~900 events/s); buffered ≈ **0.3 ms/event** at
1k. See [`perf-report.md`](./perf-report.md#b4-event-log) for the table.

### 2.2 observation-store (`src/state/stores/observation-store.ts`)

| Aspect | Detail |
|---|---|
| **What it stores** | `Observation[]` (tool, input, output, filesRead/filesModified, sessionId) + `CompressedObservation[]` (summaries + relevanceScore). Privacy tags stripped before storage. |
| **When it writes** | `record()` mutates in-memory; `save()` persists atomically (temp-file + rename). Loaded once at construction if the file exists. |
| **I/O pattern** | Single JSON document write (not append). `atomicWriteJson` = write temp + rename → atomic, but O(file size). |
| **Memory** | In-memory arrays capped by `maxObservations` (default 1000) and `maxCompressed` (default 200) — FIFO slice on overflow. |

### 2.3 run-graph (`src/state/stores/run-graph.ts`)

| Aspect | Detail |
|---|---|
| **What it stores** | `RunGraph` = nodes (run/task/agent/artifact/file) + edges (contains/dependsOn/produces/runs) + layers. |
| **When it writes** | `buildRunGraph(manifest, tasks)` after a run; `saveRunGraph` writes `<crewRoot>/graphs/<runId>.json` atomically. |
| **I/O pattern** | One atomic JSON write per run; O(tasks) build in memory. |
| **Memory** | Transient — held only during build/save. |

### 2.4 run-metrics (`src/state/stores/run-metrics.ts`)

| Aspect | Detail |
|---|---|
| **What it stores** | One `RunMetrics` snapshot per run: taskCount, completed/failed, totalTokens, totalCost, durationMs, consistencyScore. |
| **When it writes** | `collectRunMetrics` after a run; `saveRunMetrics` writes `<crewRoot>/state/metrics/<runId>.json` atomically. |
| **I/O pattern** | One atomic JSON write per run; summary scans newest files first (bounded at 500, reads at most `limit`). |

### 2.5 metric-sink (`src/observability/metric-sink.ts`)

| Aspect | Detail |
|---|---|
| **What it stores** | Periodic `MetricSnapshot[]` (registry snapshot) as one JSONL line per tick. |
| **When it writes** | On a 60s interval (`intervalMs` default) + on explicit `writeSnapshot`. |
| **I/O pattern** | One open fd per UTC date (`<date>.jsonl`), async write per tick — deliberately avoids open/close syscalls each tick. `rotateOldFiles` deletes files older than `retentionDays` (default 7). |
| **Memory** | One fd held open per date. |

### 2.6 artifacts (`src/state/stores/artifact-store.ts`)

| Aspect | Detail |
|---|---|
| **What it stores** | Task deliverables (prompt/result/log/diff/patch/…) under `<crewRoot>/artifacts/`. |
| **When it writes** | `writeArtifact` per deliverable: atomic temp-file + rename + redaction + content hash. |
| **I/O pattern** | One atomic write per artifact; cleanup scan is marker-gated (24h grace) to avoid re-scanning every run. |

## 3. Memory per subagent (estimate)

Deep tracking per subagent generates roughly:

- **8 events** (spawn, 3–4 progress, transition, message_end) × ~180 B ≈ **1.4 KB JSONL** on disk;
- **1 observation** ≈ **0.8 KB** in the observation store;
- **1 task node + edges** in the run graph (transient);
- ~**360 tokens** of event-log payload (bytes/4 heuristic) per subagent.

Scaling (measured in b5): 50 subagents → ~75 KB run graph, ~39 KB
observation store, ~18k estimated tracking tokens. See the
[deep-tracking cost table](./perf-report.md#b5-deep-tracking).

## 4. I/O summary table

| Component | File | Write pattern | Frequency | Blocking? |
|---|---|---|---|---|
| event-log (sync) | `events.jsonl` + `.seq` | append + fsync + lock | per event | **yes** (`sleepSync`) |
| event-log (async) | `events.jsonl` + `.seq` | append + async lock | per event | no |
| event-log (buffered) | `events.jsonl` | batch flush | per flush window | no |
| run-metrics | `metrics/<runId>.json` | atomic rewrite | once per run | no |
| run-graph | `graphs/<runId>.json` | atomic rewrite | once per run | no |
| observation-store | `observations/<…>.json` | atomic rewrite | on save | no |
| metric-sink | `state/metrics/<date>.jsonl` | fd-append, async | 60s tick | no |
| artifacts | `artifacts/<…>` | atomic write | per deliverable | no |

## 5. Measured bottlenecks (summary — details in perf-report)

1. **Sync event-log append** — ~14 ms/event, event-loop blocking lock. Highest
   per-op cost in the system. Mitigations already present: async/buffered paths.
2. **Child spawn cold start** — real `pi` binary spawn+boot ≈ **1.2 s/child**
   (b1, measured via `getPiSpawnCommand` + `buildFinalChildPiSpawnOptions`);
   bundle load alone ≈ 1.27 s (b7). Bounded by Node bootstrap + strip-types
   parse + pi runtime init, not by pi-crew code.
3. **Atomic write fixed cost** — `atomicWriteJson` ≈ 13–21 ms even for tiny
   payloads (b3) due to temp-file + rename + symlink-safety checks; amortizes
   only for large payloads.
4. **Artifact write per-file cost** — ~16 ms/artifact (b8), dominated by the
   same atomic-write + redaction pipeline; read-back is trivial.

## 6. Recommendations

- Prefer `appendEventAsync`/`appendEventBuffered` over `appendEvent` on hot
  paths; keep `appendEvent` only for terminal/crash-critical events.
- Batch `atomicWriteJson`-based snapshots (metrics, graphs, observations) when
  many runs complete close together; the fixed ~13 ms floor is per-file.
- Consider reusing a warm child pool for workers to amortize the ~38 ms spawn
  cost (b1) and the ~1.25 s bundle-load cost (b7) — this is the single biggest
  win for multi-subagent runs.
- Keep artifact payloads out of the redaction/atomic path when content is
  already trusted (bench b8 shows write dominates read by ~100×).
