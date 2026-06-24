# Troubleshooting

Common problems and their fixes. If you hit an error code (E001–E012), see the
[Error codes](#error-codes) table below.

## Quick health check

```text
team action='doctor'
team action='health'
```

`doctor` validates your config, runtime, and worker setup. `health` shows live
run/process status. Start here.

## Runs won't start / workers are "blocked"

**Symptom:** `team action='run'` returns a `blocked` status with a message like
"Child worker execution is disabled".

**Cause:** Worker execution is off. pi-crew refuses to create no-op scaffold
subagents by default until you opt in.

**Fix — pick one:**
- Set in your config (`~/.pi/agent/pi-crew.json`): `"executeWorkers": true`
- Or set the env var: `PI_CREW_EXECUTE_WORKERS=1`
- Or pass at run time: `team action='run' config={runtime:{mode:'live-session'}}`

The blocked-run message lists the exact config + env vars in play — read it.

## "Run not found" / I lost my run ID

Run IDs are long (`team_20260615180014_a1b2c3d4e5f60718`). To recover:

```text
team action='list'              # recent runs + IDs
team action='status'            # status of in-flight runs in this project
team action='artifacts' runId=… # if you only have a partial ID
```

Every "Run not found" error now appends a `Tip: run action='list'` hint.

## "Unknown action: X"

You typo'd an action. The error now suggests the closest match
(`Did you mean 'status'?`). To see all valid actions:

```text
team action='help'
team action='list' resource='workflow'
```

## Worktree runs fail ("not a git repo" / "tree is dirty")

Worktree mode (`workspaceMode: 'worktree'`) requires:
1. The target directory is a **git repository** (`git rev-parse` succeeds).
2. The working tree is **clean** (no uncommitted changes) unless you pass
   `force: true`.

If you don't need isolation, use single mode instead:
`team action='run' workspaceMode='single'`.

## Stale async process / run stuck in "running"

A background run whose process died (crash, Ctrl+C, reboot) can appear stuck
in `running`. The stale-reconciler eventually marks it `failed`, but you can
force recovery:

```text
team action='status' runId=…    # check the async liveness line
team action='cleanup' runId=…   # repair stuck state
team action='cancel' runId=…    # cancel a truly-dead run
```

The error message explains the heartbeat mechanism + remediation.

### "Run not found" but `team list` shows it / scheduler appears frozen at 25%

**Symptom:** an async `team action='run'` (e.g. a review) gets through the
first task (e.g. explorer), then the scheduler appears to stop responding.
`team action='status' runId=…` returns `Run not found`; the run's
`stateRoot` (in `<project>/.crew/state/runs/<runId>/`) is missing. TUI
progress shows the run stuck at the same task percentage forever, and the
only workaround was killing the parent `pi` process.

**This was the v0.9.4 symptom** caused by two coupled runtime bugs:

- **Bug X** (proximate): `purgeStaleActiveRunIndex` destroyed the
  `stateRoot` of long-running legitimate async runs based on a frozen
  `entry.updatedAt` (set at registration, never refreshed).
- **Bug Y** (root cause): the bg-runner crashed with an unhandled `EPIPE`
  on the first `console.debug` after the parent detached its stdio pipes.

**Fixed in v0.9.5** (see [CHANGELOG.md](../CHANGELOG.md#v095--fix-team-run-hangs-forever-at-25-2026-06-23)).
With the fix, a long-running run is no longer falsely purged, and even if the
bg-runner dies, the `stateRoot`, `background.log`, `events.jsonl`, and
`heartbeat.json` survive — runs stay queryable and resumable.

**Recovering a stuck run from v0.9.4 or earlier:** the `stateRoot` for
those runs is already gone (Bug X nuked it). Re-dispatch the workflow. New
runs on v0.9.5+ are fully protected.

## Model fallback exhausted

**Symptom:** `All N candidates exhausted (tried: a → b → c)`.

**Cause:** Every model in your fallback chain failed (rate limit, auth, quota).

**Fix:** Check your provider config / API keys. The error now lists the full
chain tried and the last failure reason.

## Config is malformed / ignored

If your `pi-crew.json` has a syntax or type error, `team action='run'` emits a
`config.warning` event (visible via `team action='events'`) and proceeds with
defaults — it does **not** hard-fail. To validate explicitly:

```text
team action='config'            # show loaded config + any warnings
team action='doctor'            # full validation
```

## Compact vs full status

`team action='status'` defaults to full output (~40 lines). For a quick check:

```text
team action='status' details=false   # compact: status, progress, goal, issues only
```

## Error codes

pi-crew uses a structured error taxonomy (E001–E012). Each error renders its
code + a help hint inline. Common ones:

| Code | Name | Meaning | First check |
|------|------|---------|-------------|
| E001 | FileReadError | a required file couldn't be read | check the file exists + read perms; may need `cleanup` |
| E002 | FileWriteError | an atomic write failed | check disk space + dir write perms |
| E003 | TaskNotFound | a referenced task id doesn't exist | `team status` to verify the run's tasks |
| E004 | InvalidStatusTransition | illegal run/task status change | verify status via `team status` before retrying |
| E005 | ConfigError | config has a syntax/type error | `team config` shows the offending field |
| E006 | ResourceNotFound | agent/team/workflow not found | `team list` to see available resources |
| E007 | ChildTimeout | a worker Pi didn't finish in time | raise `runtime.responseTimeoutMs` or simplify the task |
| E008 | ModelExhausted | all fallback models failed | see "Model fallback exhausted" above |
| E009 | PreStepFailed | a workflow pre-step hook failed | check the hook stderr in events; set `preStepOptional: true` on the step to make it advisory (non-fatal) |
| E010 | EventLogLockTimeout | event log locked under contention | transient; retry, or lower concurrency |
| E011 | DepthLimitExceeded | crew nesting too deep | raise `crew.maxDepth` or flatten the call |
| E012 | RunStale | run reconciled as stale | see "Stale async process" above |

## Still stuck

- `team action='explain' runId=…` — structured per-task analysis (why, files,
  complexity).
- `team action='summary' runId=…` — includes common failure-pattern detection
  ("4 of 5 failures share 2 root causes").
- `team action='events' runId=…` — full event timeline for forensics.

## Stuck / orphaned sub-agent processes ("zombies")

A pi-crew sub-agent whose parent crashed may linger as an orphaned process.
**Do NOT kill `pi` processes by eye** (uptime/RSS heuristics will match your
own interactive main session — that is unrecoverable). Use the safe scanner:

```
team action='doctor' focus='zombies'
```

This is **read-only**. It matches ONLY processes carrying the authoritative
`PI_CREW_KIND=subagent` env marker (set by every child-pi spawn) whose
`PI_CREW_PARENT_PID` is no longer alive. Your main session never carries the
marker, so it can never appear in the list. (The marker is an env var, not an
argv flag — pi's strict option parser rejects unknown flags, so we can't use
a `--crew-subagent` CLI flag.)

To kill a confirmed zombie: `kill <PID>` (the OS reaps it). The scanner never
kills on your behalf.

### Why the marker exists

Before `PI_CREW_KIND`, a heuristic zombie "cleanup" killed a live main session
by accident. The marker makes sub-agent identity authoritative rather than
guessed. See `src/runtime/zombie-scanner.ts` and `.crew/knowledge.md`.

## `ctx.agent({disableTools: true})` — historical `exit null` (FIXED)

Previously, `ctx.agent({disableTools: true, maxTurns: 1})` could return
`exit null` because the steer-injection code mis-treated normal Node stdin
backpressure (`write() === false`) as a fatal failure and `killProcessTree`'d
the worker mid-answer. **Fixed**: steer injection is now advisory — a
backpressure return or non-writable stdin is logged, not fatal; the
hard-abort at `maxTurns + graceTurns` remains the safety net for genuine
runaways. The `disableTools` correlation was a red herring — the real trigger
was `maxTurns:1` hitting on the first turn. See CHANGELOG "Real-world smoke
testing findings" and `test/unit/child-pi-steer-backpressure.test.ts`.

## Running the real-binary smoke suite (HB-004)

The default `npm test` mocks child-pi (`PI_TEAMS_MOCK_CHILD_PI`), so it cannot
catch bugs that only manifest against the real `pi` binary. The smoke suite
shells out to real pi + makes real LLM calls, so it bills tokens and is gated
behind `PI_CREW_SMOKE=1`.

### Run locally

```bash
# All smoke tests (~5 tests, ~1 min, bills tokens):
PI_CREW_SMOKE=1 npm run test:smoke

# One smoke test in isolation:
PI_CREW_SMOKE=1 npx tsx --test test/smoke/agent-disabletools.smoke.ts
```

Smoke tests live in `test/smoke/*.smoke.ts` and are NOT picked up by the default
`npm test` glob (`test/unit/*` + `test/integration/*`). Each test self-skips
unless `PI_CREW_SMOKE=1`.

### What each covers

| File | Feature family | Catches |
|---|---|---|
| `argv-flags.smoke.ts` | buildPiWorkerArgs argv | unknown-flag rejection (e.g. `--crew-subagent`) |
| `agent-plain.smoke.ts` | ctx.agent() baseline | spawn-path breakage |
| `agent-schema.smoke.ts` | ctx.agent({schema, systemPrompt}) | persona-leak / schema-validation failures |
| `agent-disabletools.smoke.ts` | ctx.agent({disableTools, maxTurns:1}) ×5 | HB-003a steer-backpressure exit-null (flaky → 5×) |
| `dwf-workflow.smoke.ts` | full DWF end-to-end | phase/log/args/budget/pipeline/agent/setResult integration |

### Run in CI (manual dispatch)

GitHub Actions → "Smoke (real-binary, manual)" → Run workflow → pick OS.
Requires the `PI_AUTH_JSON` repo secret (the contents of `~/.pi/agent/auth.json`)
so the spawned `pi` can authenticate with the model provider. If unset, the
LLM-calling smoke tests fail with a clear auth error.
