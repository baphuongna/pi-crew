# Audit Findings — Benchmark & Observability Suite (iterative-audit, REAL rounds)

> Iterative-audit loop (skill `iterative-audit`) over the new benchmark +
> run-observability code. **Genuine rounds** — each round ONE focus, verified
> by RUNNING the tools against real/edge-case data (not just reading code).
> Each finding cites `file:line` and is verified before claiming fixed.
>
> NOTE: an earlier draft of this doc falsely framed a single analysis pass as
> "5 rounds" and claimed the stop condition was met. That was incorrect. The
> rounds below are the real ones, run after that correction.

## Scope

- `scripts/analyze-run.mjs` — run analyzer (events + transcripts)
- `scripts/resource-sampler.mjs` — external PID resource sampler
- `bench/b1–b8*.bench.ts` — synthetic microbenchmarks (+ `microbench/README.md`)
- `docs/perf-*.md` — reports

## Initial pass (pre-loop) — findings + fixes (kept for record)

| # | Sev | File:line | Issue | Status |
|---|-----|-----------|-------|--------|
| P1 | 🟡 MED | `analyze-run.mjs:449,454,290` | Path injection: unvalidated `runId` → writes outside dirs | ✅ FIXED (regex guard) |
| P2 | 🟡 LOW | `resource-sampler.mjs:236-249` | wrap mode no signal handler → orphan child | ✅ FIXED |
| P3 | 🟡 LOW | `resource-sampler.mjs` cpuPrev | never pruned → slow leak | ✅ FIXED |
| P4 | 🟡 LOW | `analyze-run.mjs:460` | misleading `writeFileSyncSafe` alias | ✅ FIXED |
| P5–7 | ⚪ LOW | `b5:127`, `b7:85`, `b3:43` | methodology caveats (token-guess, cold+warm avg, bulk-write) | ✅ caveat in source |

## Real iterative rounds

### Round 1 — Correctness: cancelled/failed runs (focus: robustness)
- **Probe**: ran analyzer on `team_20260806080902` (cancelled, SIGTERM).
- **Finding R1 (MEDIUM)**: `wallMs`/throughput showed "—" / 0 because the code
  only recognized `run.completed`. Failed/cancelled runs terminate via
  `run.cancelled`/`run.blocked`/`run.failed` — exactly the runs you most want
  to diagnose — and had no wall time.
- **Fix**: `analyze-run.mjs` `analyzeEvents` — accept any terminal event,
  fall back to last-event timestamp. Verified: cancelled run now shows
  wall **39m9s**, Token/s **14.72**, cost **$5.12**.

### Round 2 — Correctness: multi-attempt transcripts (focus: retries)
- **Probe**: synthetic 2-attempt probe + real run with retried `01_explore`.
- **Finding R2 (MEDIUM)**: `result.set(taskId, …)` OVERWROTE earlier attempts
  → only the last attempt's tokens/cost counted for retried tasks.
  Synthetic probe: expected 6000, got 5000 (attempt-0 lost).
- **Fix**: merge across attempts (sum usage/cost, union models, sum counts).
  Verified: probe → 6000 ✓. Real run bonus: `01_explore` now correctly shows
  BOTH models (`deepseek-v4-flash, claude-sonnet-5`) — the retry switched
  model, previously hidden.

### Round 3 — Sampler correctness: descendant discovery (focus: core claim)
- **Probe**: wrapped a process that spawns 2 children (mimics team-runner
  spawning child-pi workers).
- **Finding R3 (POSITIVE)**: sampler caught all 3 PIDs (parent + 2 children),
  19 samples, labels root/child correct. **No bug** — core claim holds.

### Round 4 — Sampler robustness: watched-tree death (focus: resource cleanup)
- **Probe**: watched a process that dies after 2s; observed sampler behavior.
- **Finding R4 (LOW-MED)**: watch-parent mode did NOT auto-stop when the
  watched tree died — kept ticking uselessly until manual Ctrl-C / external
  timeout. (`findDescendants` always includes rootPid even when dead.)
- **Fix**: detect rootPid death for 3 consecutive ticks → clean auto-stop.
  Verified: sampler ran 3214ms (target died @2000ms + grace), stopped with
  "watched PID gone" — no more hanging.

### Round 5 — Error richness (focus: does it surface WHY things failed)
- **Probe**: inspected `worker.exit` + `tasks.json` for the SIGTERM task.
- **Finding R5 (MEDIUM)**: `tasks.json` carries the REAL error
  (`error: "Child Pi exited with 143"`) but the analyzer ignored it,
  showing only the generic label "Worker exit SIGTERM (143)".
- **Fix**: capture `taskMeta.error`, render it in the problems table.
  Verified: report now shows "Worker exit SIGTERM (143) — Child Pi exited
  with 143".

## Verified CORRECT (false-positive guard)

- Model extraction via `message_end.message.model` → `deepseek-v4-flash` ✓
- `tasks.json` is ARRAY; `Object.values()` handles it ✓
- `/proc` reading (RSS/heap/CPU): pi boot 134.7MB / 158.8% ✓
- Exit-code meaning (143=SIGTERM, 137=OOM) ✓

## Diminishing-returns assessment (honest)

- R1 MEDIUM, R2 MEDIUM, R3 (none), R4 LOW-MED, R5 MEDIUM,
  R6 test-coverage (added tests, no new bug), R7 LOW, R8 LOW.

### Round 6 — Test coverage (Pattern 3; continue-trigger: scripts were 0% covered)
- **Finding R6 (process gap)**: the 5 fixes from R1–R5 + pre-loop had ZERO
  tests — a skill anti-pattern ("every fix needs a test that would have
  caught the bug").
- **Fix**: added `test/unit/scripts/analyze-run-audit.test.ts` (4 tests) pinning
  R1 (cancelled-run wall time), R2 (attempt sum), R5 (error text), +
  path-injection rejection. Verified: 4/4 pass.

### Round 7 — Performance/memory (Pattern 5)
- **Probe**: checked `readJsonl` accumulation + real run sizes.
- **Finding R7 (LOW)**: `readJsonl` streams the read but accumulates ALL parsed
  objects in memory (O(file size)); the header comment claimed "stream từng dòng"
  which misleads. Practically harmless (largest real run: 306KB events / 1MB
  transcript; 100× = 30MB, Node handles fine).
- **Fix**: corrected the comment to state memory behavior honestly.

### Round 8 — Code quality (Pattern 6)
- **Probe**: dead-code / unused-param / type-misuse scan.
- **Finding R8 (LOW)**: `firstMsgTime` declared never used; `analyzeTranscripts`
  had an unused `taskIds` parameter.
- **Fix**: removed both. Added types to the new test file (noImplicitAny).
  tsc project-wide = 0 errors.

### Rounds 9–16 (after correcting the stop rule)

> **Rule correction**: an earlier stop claimed "2 LOW rounds" justified
> stopping. The user correctly pointed out that LOW is still a finding — the
> real stop must be **2 consecutive rounds with ZERO new findings**. Resumed.

### Round 9 — microbench execution correctness (b2–b8)
- **Probe**: ran b2–b8 + scanned output for NaN/null/negative.
- **Finding R9 (NONE)**: all run cleanly, valid JSON, sane numbers. b7's
  cold+warm avg already caveated; b4's `null` field is intentional
  (`sync.skipped ?? null`).

### Round 10 — continued dead-code scan
- **Finding R10 (LOW)**: `agentsJson` read (41KB) but never used; `ea.runCreated`/
  `runCompleted` returned but never consumed.
- **Fix**: removed both.

### Round 11 — retry/model-attribution correctness
- **Probe**: compared `attempts` vs `modelAttempts` fields.
- **Finding R11 (MEDIUM)**: retry detection used `attempts.length`, which
  misses **model-fallback retries** (a task can have attempts=1 but
  modelAttempts=2). `modelAttempts` also carries `{model, success, exitCode,
  error}` per try — diagnostic gold the analyzer discarded.
- **Fix**: retry count = max(attempts, modelAttempts); surface the model chain
  in the report. Verified: `01_explore` now shows `deepseek-v4-flash ❌
  ("Upstream stream ended") → claude-sonnet-5 ✓`.

### Round 12 — verification-failure detection
- **Probe**: inspected `verification` field (no current run has satisfied=false).
- **Finding R12 (LOW-MED, latent)**: a task can be status=completed but FAIL
  verification — the analyzer ignored `verification.satisfied`.
- **Fix**: surface `verification_failed` problems + regression test.

### Round 13 — sampler input validation
- **Probe**: `--interval 0` / `--interval abc`.
- **Finding R13 (LOW-MED)**: `parseInt`→NaN or 0 → `setInterval(fn, 0)` spins
  ~60–130×/s, writing huge files + burning CPU.
- **Fix**: reject NaN, clamp <100ms to 100ms.

### Round 14 — missed problem event types
- **Probe**: enumerated all event types across 12 runs.
- **Finding R14 (LOW-MED)**: analyzer dropped `task.failed`, `workflow.phase_failed`,
  `recovery.attempted`, and crucially `adaptive.plan_repair_failed`/
  `plan_missing` — the **ROOT CAUSE** of blocked runs (report only said
  "blocked" with no reason).
- **Fix**: surface these as problems. Verified: blocked run now explains
  "Adaptive planner output could not be repaired".

### Round 15 — numerical consistency
- **Probe**: summary totals vs sum-of-subagents.
- **Finding R15 (NONE)**: input/output/cost/count all match exactly — no
  double-counting.

### Round 16 — transcript matching robustness
- **Probe**: orphan transcripts (file whose taskId ∉ events).
- **Finding R16 (NONE)**: across 12 runs, every transcript matches an event
  task — matching is robust, no silently-dropped usage.

## STOP decision (rule-based)

Per the corrected rule (2 consecutive ZERO-finding rounds):
- **R15 = zero** (numerical consistency verified correct).
- **R16 = zero** (transcript matching verified robust).
- → **2 consecutive zero rounds. STOP.**

This stop is legitimate: between the premature-stop correction and here, the
loop ran 7 more rounds (R10–R16) and found **R11 MEDIUM** (model-fallback
retry + model chain), **R14 LOW-MED** (adaptive root-cause surfacing), plus
R10/R12/R13 LOW-MED fixes — all of which the earlier "2 LOW" stop would have
missed. The stricter rule was correct and productive.

All 7 patterns covered; diminishing returns confirmed by R15/R16.

## Verification after all rounds

- `tsc --noEmit` = 0 errors project-wide.
- Regression tests: 5/5 pass (R1, R2, R5, path-injection, R12).
- Analyzer re-run on real runs (success/cancelled/blocked/retry) produces
  correct, progressively richer output. Sampler verified on
  single/spawning/watched-death + interval-validation cases.

## Resume triggers

Re-open the loop if: a new usage pattern exposes a gap (huge runs, non-Linux
`ps` fallback path, multi-model cost attribution), or a regression test fails.

## Evaluation pass (post per-subagent join + sampler tests)

A focused re-audit after adding the per-subagent resource join, the sampler
test suite, and the zombie/isAlive fix. Same rule: stop on 2 consecutive
zero-finding rounds.

- **R1 — per-subagent join correctness**: cross-checked raw samples vs
  in-window vs analyzer.attribution on REAL data (run team_20260806114118).
  All 4 workers: raw = inWindow = analyzer.samples (14/29/13/29), 0 wrongly
  excluded. **ZERO — join is correct.**
- **R2 — report sanity (finding, LOW-MED)**: "Top Bottlenecks" flagged EVERY
  subagent total with 🔴 (even 24s/26s ones), contradicting the ">30s" legend.
  Fix: only list totals >30s; 🔴 conditional on >30s. Verified.
  *Also noted (R2b)*: grandchildren (verifier's test-runner @ 1GB/300%) are
  not attributed → per-subagent understates tool-heavy subagents (documented
  limitation, real impact here).
- **R3 — finding (LOW)**: aggregate "RSS growth -123.1MB" was meaningless
  (lastSample.rss - firstSample.rss across DIFFERENT PIDs). Fix: sum per-PID
  growth → +891.9MB (meaningful). Removed now-dead firstRss/lastRss vars.
- **R4 — finding (LOW)**: aggregate "Peak RSS 1001MB / CPU 300%" is dominated
  by a grandchild (test-runner), not agents → misleading headline. Fix: added
  a ⚠️ note pointing readers at the per-subagent table.
- **R5 — robustness (ZERO)**: empty / non-existent / malformed --resources
  files all handled gracefully (no crash).
- **R6 — regression (ZERO)**: full unit suite 6943 tests, 6940 pass, 0 fail,
  3 skipped. No regressions from R2/R3/R4 edits.

**Stop: R5 + R6 = 2 consecutive zero rounds.** This pass found 3 real issues
(R2/R3/R4), all in report metrics I had recently added — caught by reading
the rendered report critically rather than the code.

## Deep-dive: remaining limitations → RESOLVED

### Limitation #1 — grandchildren not attributed → SOLVED (ppid-tree)
- **Investigation**: checked the ppid recorded per sampler sample on real data.
  pi-crew's `setsid:true` spawn does NOT reparent workers to init — the ppid
  chain stays intact. Verified: the 1GB/300% process (pid 1748899) chains
  1748899→1748898→1748874→1748873→**1748392 (04_verify)**. So descendants can
  be attributed to their owning worker by walking the ppid tree.
- **Fix**: `analyzeResources` now builds a first-seen-ppid map and, for each
  sample, walks up to find the owning worker (exact-PID OR ancestor), then
  attributes within that worker's window. Tracks `descendantPids` per subagent.
- **Impact (real data)**: 04_verify went from 177MB/59.9% (worker only) to
  **1001.4MB / 300.1% / 20 tool subprocesses** — its true cost (the
  `npm run test:critical` + `tsc` tree). Other agents unchanged (read-only,
  no subprocesses).
- **Test**: `RS-tree` (grandchild via 2-level ppid chain attributes to worker).

### Limitation #2 — manual sampler attach → SOLVED (--watch-run)
- **Investigation**: the runner/leader PID is NOT lost — pi-crew records it in
  `async.pid` (`{pid, startedAt}`), `manifest.async.pid`, and `heartbeat.json`
  (`{pid, memory:{heapUsedMb,rssMb}}`). My earlier "no PID in state" was wrong
  (I grepped top-level manifest keys; the pid is nested at `manifest.async.pid`).
- **Fix**: new `--watch-run <runId> [--crew-root <path>]` mode resolves the
  runner PID from those files (polls briefly if not ready), then reuses the
  existing watch+auto-stop logic. No more manual `pgrep`.
- **Safety**: sampler uses append-only writes, so `--watch-run` on an
  already-finished run (dead PID) writes nothing and stops — no overwrite.
- **Test**: `--watch-run` (resolves pid from a fixture async.pid, auto-stops).
- **Bonus finding**: `heartbeat.json` carries pi-crew's own self-reported
  `{heapUsedMb, rssMb}` per heartbeat — an additional resource source.

### Verification
- tsc: 0 errors. Regression tests: 12/12 (7 analyzer + 5 sampler).
- Full unit suite: 6945 tests, 0 fail, 3 skipped.
- Real-data re-check: 04_verify per-subagent now reflects full tool-tree cost.

### Honest remaining nits (not blocking)
- `--watch-run` on a finished run resolves a dead PID and stops harmlessly
  (append-only); could warn "PID already dead" but causes no data loss.
- ppid attribution uses first-seen ppid (spawn-time parent); robust while the
  parent is alive, which covers the run. Reparenting-after-parent-death is not
  modeled (irrelevant for attribution during the run).

## Audit of the newly-added code (R7–R12)

After solving limitations #1/#2 (ppid-tree attribution, --watch-run), that NEW
code had not been audited. Continued the loop on it.

- **R7 — ppid-tree + resolveRunnerPid**: chain attribution verified correct on
  real data (24/27 PIDs reach a worker; the 3 "broken" are the runner + 2 infra
  processes, correctly excluded — NOT lost grandchildren). **Finding (LOW)**:
  resolveRunnerPid used `spawnSync(node,-e,setTimeout)` as a sleep → up to 20
  throwaway node processes. Fix: `Atomics.wait` (blocks, no spawn).
- **R8 — finding (LOW)**: the R4 note ("aggregate includes tool subprocesses
  NOT attributed") became STALE after the ppid-tree fix (tools now ARE
  attributed). Fix: reworded to "runner + infra, not subagents; tools ARE
  attributed via ppid-tree".
- **R9 — finding (LOW)**: per-subagent Avg RSS mixed worker + descendant
  samples → 04_verify avg 94MB (meaningless, dragged by low-RSS tools). Fix:
  avg now uses worker-own samples only → 155.5MB (the agent's footprint);
  peak stays all-inclusive (1001MB). *(Mid-fix: a botched multi-edit left
  perSubagent.set without the own* fields → avg=0; caught immediately on the
  real-data re-run and fixed.)*
- **R10 — finding (LOW)**: Avg CPU was still all-samples (inconsistent with
  the new own-only Avg RSS). Fix: Avg CPU also worker-own.
- **R11 — breadth (ZERO)**: analyzer run on 4 diverse real runs (deepseek
  success / cancelled / blocked-state-deleted / glm success) — 3 OK, 1
  correctly errors ("run state not found") because that run's state was
  deleted earlier in the session (the corrupted run). No crash.
- **R12 — structural integrity (ZERO)**: perSubagent JSON = 9 fields, 0
  undefined; markdown table rows = 9 pipes (8 cols) consistent; 97 table rows
  well-formed.

**Stop: R11 + R12 = 2 consecutive zero rounds.** This pass found 4 real
refinements (R7–R10), all in code added during the limitation deep-dive —
caught by auditing new code, exactly as the skill prescribes.

---
## Post-audit additions (perf-observability work, 2026-08-07)

- **F1 — accuracy bug (HIGH, FIXED)**: `spawnTime` overwritten on worker
  respawn → `launch` phase measured task→LAST spawn (100s on a 429-storm run
  instead of the true 14s) and `wall` measured last-spawn→exit (18s, missing
  the 105s respawn churn). Fix: track `firstSpawnTime`; `launch`=task→first
  spawn, `wall`=first spawn→exit (full lifetime), new `respawn` phase =
  first→last spawn. This also fixed `run_idle` mis-flagging churn as "idle"
  (ratio was 6.3× → correct 1.14×; 429-run no longer trips it).
- **F2 — honesty bug (HIGH, FIXED)**: provider (zai/glm-5.2, opencode-go)
  reports `cost.total=0` on every transcript → report showed "Tổng cost:
  $0.00" which reads as "free". Fix: `cost_unreported` anomaly (fires when
  tokens>0 & cost=0) + summary shows "— (provider không report cost)".
- **F3 — PID-reuse guard (MEDIUM, FIXED)**: sampler cpuPrev keyed by PID only;
  a recycled PID (respawn churn) carried stale ticks → underreported CPU for
  one sample. Fix: compare /proc starttime; mismatch ⇒ treat as first sample.
- **F4 — first-sample CPU=0 (MEDIUM, FIXED)**: first sample per PID has
  cpuPct=0 by construction (no previous tick) → dragged CPU averages down for
  short-lived subagents. Fix: sampler flags `firstSample:true`; analyzer
  excludes it from avg/p95 CPU (RSS avg unaffected — absolute read).
- **F5 — rss_leak false positive (MEDIUM, FIXED)**: initial rss_leak rule
  (window 8 samples) fired on V8 heap WARMUP (every subagent grows
  monotonically 10-15s then plateaus) — 3 of 4 PIDs flagged in a real e2e run
  were warmup, not leaks. Fix: window 30 samples / +100MB / 75% monotonic —
  only SUSTAINED growth fires. Validated by simulation on the real e2e
  samples (subagents no longer fire; long-lived session growth still does).
- **F6 — observation (open, runtime)**: e2e run showed the pi leader session
  (root PID) growing 325→527→750MB RSS (grow-compact-grow; one compaction
  742→259MB). Consistent with context accumulation across the session, not a
  per-run leak; `rss_leak` live warning covers it. Runtime change would
  require src/ edits (out of scope — bundle constraint).
