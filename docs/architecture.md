# pi-crew Architecture

`pi-crew` is a Pi package for coordinated multi-agent work. It is intentionally durable-first: every run is represented on disk, every task has a state record, and child workers stream progress into JSONL/status files so foreground sessions, background jobs, dashboards, and later restarts all read the same source of truth.

## Layers

```text
Pi extension layer
  register tools, slash commands, widget/dashboard, notifier, lifecycle cleanup

Runtime layer
  team runner, task graph scheduler, child Pi process runner, async runner,
  model fallback, policy engine, worktree manager, live-session experimental path

State layer (project root resolves to <crewRoot>:
  - .crew/             when no .pi/ exists in the repo (default)
  - .pi/teams/         when the repo already has .pi/ (legacy reuse))
  <crewRoot>/state/runs/{runId}/manifest.json
  <crewRoot>/state/runs/{runId}/tasks.json
  <crewRoot>/state/runs/{runId}/events.jsonl
  <crewRoot>/state/runs/{runId}/agents/{taskId}/status.json
  <crewRoot>/artifacts/{runId}/...
```

## Run flow

```text
user/team tool
  │
  ▼
handleTeamTool(action=run)
  ├─ discover agents/teams/workflows
  ├─ validate team/workflow refs
  ├─ create run manifest + task graph
  ├─ write goal artifact
  └─ choose foreground/session-bound or async/background mode
        │
        ├─ foreground: startForegroundRun() schedules executeTeamRun()
        │
        └─ async: spawnBackgroundTeamRun()
              ├─ node --import jiti-register.mjs background-runner.ts
              ├─ background-runner writes async.started + async.pid marker
              └─ executeTeamRun()
                    ├─ resolve ready task batch
                    ├─ resolveBatchConcurrency() with hard cap
                    ├─ runTeamTask() per task
                    │    ├─ build prompt + dependency context
                    │    ├─ choose configured Pi model candidates
                    │    ├─ spawn child `pi` worker
                    │    ├─ observe JSONL/stdout progress
                    │    ├─ persist agent status/events/output
                    │    └─ write result/log/transcript artifacts
                    ├─ merge task updates monotonically
                    ├─ write progress artifacts
                    └─ synthesize policy closeout
```

## Extension layer

`src/extension/register.ts` wires the package into Pi:

- `team` tool and management actions.
- Conflict-safe subagent tools: `crew_agent`, `crew_agent_result`, `crew_agent_steer`.
- Claude-style aliases: `Agent`, `get_subagent_result`, `steer_subagent` when available.
- Slash commands including `/team-run`, `/team-status`, `/team-dashboard`, `/team-doctor`, `/team-config`, `/team-summary`.
- Active-only widget and optional dashboard/sidebar UI.
- Foreground run scheduling and shutdown cleanup.
- Async completion notifier and session-start active-run summary.

The extension layer should remain thin: user input is normalized into tool parameters, then delegated to runtime/state modules.

## Runtime layer

### Team runner

`src/runtime/team-runner.ts` drives workflow execution. It reads queued tasks, computes the ready set from the task graph, applies concurrency limits, runs a batch, then merges results back into the latest task state. Terminal task states are monotonic: stale parallel snapshots must not regress completed/failed/cancelled/skipped tasks back to queued/running.

### Task runner

`src/runtime/task-runner.ts` executes one task. It prepares workspace/worktree context, renders a task prompt, chooses model candidates from Pi configuration, launches a child Pi process by default, and writes result artifacts. Scaffold mode is explicit dry-run only.

### Child Pi runtime

`src/runtime/child-pi.ts` is the default worker runtime. It:

- launches real `pi` child processes,
- hides Windows console windows with `windowsHide: true`,
- streams JSONL output into transcripts,
- compacts noisy message updates,
- isolates observer callback failures so progress persistence cannot kill orchestration,
- applies post-exit stdio guards for late output.

### Async background runner

`src/runtime/async-runner.ts` spawns detached background runs. Installed packages use an absolute `jiti-register.mjs` loader path because Node strip-types refuses TypeScript under `node_modules`. The runner fail-fasts if jiti is missing, and writes `async.pid` once startup begins so the parent can distinguish a healthy start from an early import crash.

### Concurrency and policy

`src/runtime/concurrency.ts` picks batch size from explicit limits, team settings, workflow settings, or built-in defaults. User-provided `limits.maxConcurrentWorkers` is hard-capped by default to prevent local DoS; `limits.allowUnboundedConcurrency=true` is an explicit opt-out and emits an observability event.

`src/runtime/policy-engine.ts` applies closeout and safety policy decisions such as limit exceeded, failed task blocking, stale workers, and green-contract failures.

### Model routing

Model choice is based on Pi's current configuration/model registry, not hardcoded providers. Task and agent records persist model attempts and routing metadata so dashboards/status can show requested model, selected model, fallback chain, and fallback reason.

## State layer

Run state is under `<crewRoot>` (`.crew/` for new projects, or `.pi/teams/` when the repo already has `.pi/`):

```text
<crewRoot>/state/runs/{runId}/
  manifest.json        run metadata/status/artifacts/async pid
  tasks.json           task graph and per-task status
  events.jsonl         append-only run events
  events.jsonl.seq     event sequence cache
  agents.json          aggregate agent cache
  async.pid            background startup marker
  agents/{taskId}/
    status.json        per-agent status source
    events.jsonl       per-agent event stream
    output.log         compact worker output
    sidechain.output.jsonl
    live-control.jsonl
```

Artifacts are under:

```text
<crewRoot>/artifacts/{runId}/
  goal.md
  prompts/{taskId}.md
  results/{taskId}.txt
  logs/{taskId}.log
  transcripts/{taskId}.jsonl
  metadata/*.json
  progress.md
  summary.md
```

`<crewRoot>` resolution is centralised in `src/utils/paths.ts#projectCrewRoot()`:

- if `<repoRoot>/.pi/` already exists, return `<repoRoot>/.pi/teams/` (legacy reuse, no parallel `.crew/`)
- otherwise return `<repoRoot>/.crew/` (default for fresh projects)

User-global fallback (when no project root is detected) lives under `~/.pi/agent/extensions/pi-crew/`.

Atomic writes use temp-file replace with retry for transient Windows `EPERM`/`EBUSY`/`EACCES`. JSONL append paths are best-effort where used for observers/progress; write failures must not crash child output parsing.

## UI and observability

- The persistent widget shows active runs only.
- Stale async runs with dead background pids are hidden from the active widget.
- `/team-status` is the canonical detailed state view and can mark stale active async runs failed.
- `/team-dashboard` provides live history/details from `RunSnapshotCache`, with panes for agents, progress/events, mailbox attention, recent output, health, and metrics.
- Phase 9 observability uses a per-session `MetricRegistry` (`Counter`, `Gauge`, `Histogram`) wired to `crew.*` events via unsubscribe-returning `events.on()` handlers. The registry is disposed on session shutdown/reload; no global metric singleton is used.
- Metrics can be inspected with `/team-metrics` or `team api metrics-snapshot`, exported as redacted daily JSONL under `<crewRoot>/state/metrics/` when telemetry is enabled, formatted for Prometheus, or pushed to an opt-in OTLP HTTP endpoint.
- Heartbeat observability is split between dashboard summaries and a background `HeartbeatWatcher`: healthy/warn/stale/dead gradient metrics are emitted, first-dead detections notify operators, and consecutive dead ticks can append deadletter entries.
- Powerbar publishing is optional and event-compatible: pi-crew emits `powerbar:register-segment` for `pi-crew-active` / `pi-crew-progress`, emits `powerbar:update` payloads (`id`, `text`, optional `suffix`, `bar`, `color`), and mirrors status through `ctx.ui.setStatus("pi-crew", ...)` when no powerbar listener is detected.
- Transcript viewer is file-backed so it works for foreground and async runs; it defaults to bounded tail reads and can load full content on demand.

## Lifecycle and cleanup

Foreground runs are session-bound and should be interrupted on session shutdown or session switch. Only explicit `async: true` runs are allowed to survive the Pi session. Runtime cleanup is registered through Pi lifecycle hooks and a global reload cleanup guard.

## Configuration

Key config sections:

- `runtime`: `auto`, `child-process`, `scaffold`, experimental `live-session`.
- `limits`: concurrency/task/depth safety controls.
- `ui`: widget/dashboard/powerbar/model-token display settings.
- `observability`: in-memory metrics, heartbeat watcher interval, metric file retention.
- `telemetry`: opt-out switch for local telemetry sinks.
- `reliability`: opt-in auto-retry/auto-recover defaults and deadletter threshold.
- `otlp`: opt-in OTLP HTTP metric export.
- `agents`: builtin overrides for models/fallbacks/tools.
- `autonomous`: policy injection/profile for proactive team delegation.

See `usage.md`, `resource-formats.md`, `runtime-flow.md`, and `live-mailbox-runtime.md` for operational details.
