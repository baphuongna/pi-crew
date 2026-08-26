# MuxSurface A1 — workers live in mux panes (process ownership flip)

**Date:** 2026-08-26
**Status:** Accepted — A1 core implemented on `feature/mux-surface-a1` (spec `docs/superpowers/specs/2026-08-26-mux-surface-design.md` v0.7 + v0.7.1 errata); A2 deferred, see Follow-ups
**Relates to:** `src/runtime/surface/*` (resolve-surface, launch-script, surface-spawn, degrade), `src/runtime/child-pi/child-pi.ts`, `src/prompt/surface-worker.ts`, `src/runtime/event-log-tail-source.ts`, `src/runtime/process/zombie-scanner.ts`, `src/extension/team-tool/doctor.ts`, `src/runtime/broker/crew-broker.ts`

## Context

Until now every crew worker was a headless `pi` process (`--mode json -p`,
stdio JSON pipe): the host orchestrator spawned it, so the host **owned** the
process — worker died with the host, and the stdout JSON stream was the single
event channel (transcript, liveness, completion all piggy-backed on it).

MuxSurface A1 lets tier-1 workers run inside real tmux/herdr panes so a human
can watch and type into them (the observability model of
`pi-interactive-subagents`). That flips process ownership: **the worker becomes
a child of the mux server, not of the host.** Everything the old architecture
derived from the parent/child relationship had to be rebuilt on mux primitives:

| Old mechanism (headless) | Surface replacement (A1) |
|---|---|
| Events from stdout JSON | worker-side recorder → per-agent `agents/{taskId}/events.jsonl` + host `EventLogTailSource` |
| Kill/timeout via `killProcessTree` | SIGTERM by pid → 3s → `closeSurface({force})` → SIGKILL (pid from `worker.started`) |
| Death detection via child `close` | `SurfaceHandle.onExit` (pane-closed / mux-dead) — **no heartbeat** |
| Transcript from stdout | same recorder file (identical `{seq, time, event}` shape, shared compaction fn) |
| Dies with host | worker-side parent-guard (pid + `/proc` starttime, PID-reuse safe) |

Constraints that shaped A1:

- **Surface is tier-1 only.** `PI_CREW_DEPTH > 0` never gets a pane. The guard
  is two layers: `resolveSurface` returns null (layer 1) and the launch-script
  builder refuses to build at caller depth > 0 (layer 2 — defense-in-depth
  because delegate grandchild spawn bypasses dispatch).
- **Async runs force headless in A1** — background runs outlive the host, and
  A1 has no re-attach, so a surface pane there would be orphaned by design.
  `PI_CREW_ASYNC_RUN=1` gates the whole async tree.
- Pi rejects unknown argv flags, so the pane boots via a host-written bash
  launch script (`bash <script>; exit`) that exports the worker env, `cd`s to
  the worktree, execs the pi TUI, and self-deletes (early backgrounded `rm`
  narrows the token-on-disk window to milliseconds).
- Everything must fail closed: no mux detected (or mux half-dead) → headless,
  exactly today's code path. Never throw because a multiplexer is missing.

## Decision

1. **Surface is an attribute of dispatch, not a 4th runtime mode.** After
   `resolveTaskRuntimeKind` picks `child-process`, `resolveSurface` decides
   pane vs headless (auto-detect tmux/herdr, env+binary+socket checks, cap
   `MAX_SURFACE_WORKERS = 6` hardcoded, `surface.mode` can pin or disable).
   Scheduler, task graph, mailbox, broker, steering, budgets are untouched.
2. **Lifecycle is worker-driven (D7):** the prompt-runtime extension watches
   the session, auto-exits on a settled turn (see errata below), emits
   terminal events (`worker.started` / `worker.completed` / `worker.error`)
   through the rate-limit-bypassing `emitTerminal` channel. Host classifies a
   pane exit by waiting ≤2s for `worker.completed` (classify timeout).
3. **Degrade, don't crash:** on pane/mux death mid-task the run records
   `surface.degraded`, revokes the broker task token, applies a per-run
   cause-group lockout (one mux-dead event = one count even if N panes died),
   and re-dispatches the unit headless with prompt re-render + scratchpad
   restore + pendingSteers replay + a "continue from where you left off"
   resume note. No retry-budget impact. Three spawn-fails in a row is a
   separate lockout (mux half-dead protection).
4. **Backstops:** zombie-scanner reads surface markers from `/proc/<pid>/environ`
   (env markers only — surface workers emit no heartbeat, T9 handoff), and
   `doctor focus=zombies` closes orphan panes (zombie scan + terminal-run
   manifests) plus sweeps orphan launch scripts past the 60s TTL.

## Consequences

- Humans get real TUI panes they can read and type into while the scheduler,
  dashboards and durable state keep working off the same on-disk truth.
- The host no longer owns worker processes — every lifecycle guarantee now
  rests on the four mechanisms above instead of the OS parent/child contract.
  This is the load-bearing trade of the whole design.
- Surface transcript/stdout are empty on the host side; the per-agent event
  log is the only narrative source in surface mode.

### D7 errata (spec v0.7.1 — implementation truth)

- The spec originally said auto-exit fires on stopReason `done`/`end_turn`;
  real pi `StopReason` values are `pending | stop | length | toolUse | error |
  aborted | deferred`. **Auto-exit fires on `"stop"` (+ defensive
  `end_turn`/`done` aliases)** — taken literally, the spec text would have
  made auto-exit dead code. `error` deliberately does NOT exit (pane stays
  open for debugging; host watchdogs own that lifecycle).
- The spec's "fsync before shutdown" is dropped on purpose: the recorder's
  single-line `appendFileSync` (O_APPEND) is visible to the same-machine
  reader immediately via page cache — enough for the ≤2s classify window.
  fsync only protects against power loss and re-introduces the ~13ms stall
  measured in perf round 3.

### Follow-ups

**Deferred to A2 (design already in the spec, §14):**

- **Re-attach + token re-issue** (and the async-runner trigger). A1 blocks the
  need by forcing async runs headless; the broker already mints a fresh token
  when a respawned worker re-hellos after a revoke (so degrade respawn works).
- **Dashboard readScreen mirror + screen sanitizer** — only needed once
  anything renders pane content; A1 renders nothing.
- **Rebalance layout** — cosmetic at ≤6 panes.
- **`limits.maxSurfaceWorkers` config** — A1 hardcodes 6.
- **`visibleAgents` default `["*"]`** — GA default after A1 stabilizes in
  real use; A1 default is `[]` (opt-in).

**Session resume is the missing 4th degrade component (A2 follow-up):** the
degrade re-dispatch ships 3 of the 4 resume components for real (prompt,
scratchpad, steers). Session resume needs (a) a `--session <path>` flag on the
headless respawn and (b) workers self-reporting their sessionPath — but pi
does not expose the session path to extensions, so `manifest.sessionPaths`
stays empty in A1 and fabricating the flag risks breaking respawns. The seam
(capture + manifest type) is in place.

**Known sharp edges (accepted for A1):**

- **Response-timeout env override parity is half-done** (T7 obs): the surface
  branch honors the per-task `responseTimeoutMs` input but the headless
  branch's env-override path is not mirrored 1:1. Harmless today, worth
  unifying when timeouts get touched again.
- **Relative `baseDir` used to make the script self-delete a no-op** (T7 obs):
  `rm -f -- "$0"` runs after the pane `cd`, so a relative script path pointed
  at the wrong place. Fixed in T14 — the builder now `path.resolve`s the
  script path (absolute `$0` survives the `cd`), with a regression test.
- **Pane-id collision after a mux restart** (T12 note): pane ids are unique
  only within a mux server's lifetime; a stale manifest entry can name a pane
  id that now belongs to an unrelated process. Mitigation to harden: verify
  pane title == taskId before force-closing in doctor cleanup (panes have
  carried `title = taskId` since T7, so the data is there).
- **E2E surface proof is opt-in local only:** `npm test` (unit+integration)
  does NOT run `test/system`; `test/system/surface-tmux.e2e.test.ts` runs the
  real-pane chain via `npm run test:system` inside tmux (3/3 local) and skips
  under CI. CI never exercises a real pane — by design, documented so nobody
  mistakes the green CI check for pane coverage.
