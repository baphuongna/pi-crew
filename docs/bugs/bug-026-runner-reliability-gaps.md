# Bug 026 — Runner reliability gaps discovered during the 2026-08-15 full-remediation session

Status: OPEN (3 sub-issues, none blocking the refactor branch)
Discovered: 2026-08-15, while running 6 team runs (verification sweep + Waves 1A/1B/2A/2B)
Context: ENOSPC incident (disk 100% full → 91 GB freed mid-session), loadavg ~11 external load

## Sub-issue A — stderr-only result artifact persisted as "completed"

**Symptom.** Explorer task `02_explore-core` of run
`team_20260815144514_3e60a1596271897c` reported `completed` with zero usable
output; its result artifact contained pure stderr (corrupted/empty payload).

**Impact.** Downstream tasks (analyst merge) silently received garbage input.
The run's final report only stayed correct because a sibling explorer's
independent sweep covered the same rounds and the analyst batch-verified
22 remaining symbols with zero hits.

**Root cause (hypothesis).** Result-artifact output validation accepts
stderr-only content as a pass. The completion path checks artifact
*existence*, not *usability*.

**Evidence paths.**
- `.crew/artifacts/team_20260815144514_3e60a1596271897c/results/02_explore-core.txt`
- Final sweep report notes the compensation:
  `.crew/artifacts/team_20260815144514_3e60a1596271897c/results/07_write.txt` ("Risks & caveats")

**Proposed fix.** In the result-artifact write path: if the artifact is
stderr-only (or below a minimal size threshold when the task reported
bash usage), mark the task `failed` / trigger one retry instead of
`completed`. Add a regression test with a worker that writes only stderr.

## Sub-issue B — ENOSPC never surfaced as a failure cause

**Symptom.** During the disk-full window, multiple workers died
"unresponsive"/ETIMEDOUT and one `waitForRun` failed with
`ENOSPC: no space left on device, write` — but worker failure records
showed generic timeout diagnostics, never the errno. Operators had to
discover the root cause via `df -h` themselves.

**Impact.** Hours of misdirected debugging (suspected model routing,
suspected runner bugs) while the actual cause was trivially detectable.

**Evidence paths.**
- `.crew/state/runs/team_20260815144514_3e60a1596271897c/` — run-level error
  `ENOSPC ... write` (post-retry failure record)
- `.crew/artifacts/team_20260815144514_3e60a1596271897c/logs/` — worker logs
  from the disk-full window showing generic unresponsive/timeout entries

**Proposed fix.** When a child write fails with `ENOSPC`/`EDQUOT`/`EMFILE`,
surface the errno prominently: task result = `failed (disk full)`,
operator notification, and a `doctor` line. Cheap heuristic:
catch fs errors in child-executor/atomic-write, classify errno, attach
`failureCause: "enospc"` to the task record.

## Sub-issue C — health alert never dismisses for terminal runs (stale snapshot pinned in memory)

**Symptom.** After Wave 2B (`team_20260815174409_374ab538e91aa0eb`) completed
8/8, the session TUI kept re-emitting "has N dead worker(s)" every ≥5 min
(dedup window), with N oscillating 1→2→1, until the pi session was restarted.

**Root cause chain (verified 2026-08-15).**
1. The extension loads a pre-built bundle (`dist/index.mjs`) at session
   start; this session's bundle predated the terminal-gate fixes
   (`GATE 1` / `FIX #1` / `GATE 2` in
   `src/extension/registration/lifecycle-handlers.ts:702-727`).
2. A stale snapshot for the completed run stayed pinned in the in-memory
   `lastPreloadedManifests` list with status `running`.
3. `summarizeHeartbeats` (`src/ui/heartbeat-aggregator.ts:34`) compares
   heartbeats against wall-clock `now` → the older the session ran, the
   more tasks crossed `deadMs` (5 min) → count grew/oscillated.
4. On-disk state was clean the whole time (manifest `completed`, all 8
   agent `status.json` `completed`, 0 zombie processes per
   `doctor zombies`, 0 runs with status `running` anywhere) — the alert
   was purely in-memory, so dashboard actions (K = mark stale dead on
   disk) could not stop it: `dispatchKillStaleWorkers`
   (`src/ui/run-action-dispatcher.ts:125-158`) found 0 eligible tasks.

**Fixes already landed (prevent recurrence for fresh sessions).** The
three terminal gates above (purge snapshot + clear health notifications
when preloaded/fresh-manifest/snapshot says terminal) shipped in the
Wave 1B/2B commits; bundle rebuilt the same day. Restarting pi cleared
the pinned state — verified post-restart: 0 running runs on disk.

**Remaining gap.** A long-lived session that loaded an older bundle can
still pin stale `running` snapshots; the gates only run in newer code.
Two hardening options:
- On `run.completed` event, also evict the run from
  `lastPreloadedManifests` (in-memory), not just the snapshot cache.
- Make `summarizeHeartbeats` ignore tasks whose manifest/task status is
  terminal (defense in depth vs stale snapshots of any age).

## Priority

A and B affect result integrity/operator diagnosis (P2). C is already
half-fixed (gates) with a small residual hardening (P3). None block the
`refactor/maintainability` branch or its merge.
