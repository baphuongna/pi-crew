---
name: child-pi-spawning
description: >
  Child Pi worker spawning, lifecycle callbacks, and failure modes.
  When NOT to use: non-Pi subprocess execution (use safe-bash); for general async reliability (use async-worker-recovery).

origin: pi-crew
triggers:
  - "worker crashed"
  - "worker blink"
  - "spawn failed"
  - "pid not found"
  - "child process error"
---
# child-pi-spawning

Child Pi workers are subprocesses spawned by `task-runner.ts` via `runChildPi()` in `child-pi.ts`. Understanding the spawn flow, lifecycle events, and failure modes is essential for debugging worker crashes and "worker blinks" issues.

## Spawn Flow

```
task-runner.ts (runTeamTask)
  → runChildPi({ cwd, task, agent, model, skillPaths, signal, onLifecycleEvent })
    → child-pi.ts (runChildPi main function)
      → buildPiWorkerArgs() → getPiSpawnCommand() → spawn(command, args, options)
        → ChildProcess spawned
        → activeChildProcesses.set(pid, child)
        → input.onLifecycleEvent({ type: "spawned", pid, ts })
        → stdout.on("data") → ChildPiLineObserver
        → stderr.on("data")
        → child.on("error") → onLifecycleEvent("spawn_error")
        → child.on("exit") → onLifecycleEvent("exit")
        → child.on("close") → onLifecycleEvent("close"), settle(result)
```

### Key components

- **ChildPiLineObserver**: Parses JSON events and stdout lines from child Pi's output stream
- **Response timeout**: 5-minute timer resets on every stdout/stderr chunk; on timeout → SIGTERM
- **Final drain**: After last assistant event, waits `finalDrainMs` (default 2s) then SIGTERM
- **Hard kill**: After `hardKillMs` (default 2s) from SIGTERM, SIGKILL
- **Active process tracking**: `activeChildProcesses` Map for global cleanup

## Lifecycle Events

`ChildPiLifecycleEvent` interface — emitted via `onLifecycleEvent` callback:

```typescript
interface ChildPiLifecycleEvent {
  type: "spawned" | "spawn_error" | "response_timeout" | "final_drain" | "hard_kill" | "exit" | "close";
  pid?: number;
  exitCode?: number | null;
  error?: string;
  ts: string;
}
```

### Event sequence for normal completion:

```
1. spawned      pid=12345            ← child.pid assigned
2. [stdout events: message, tool_execution_start, tool_execution_end, message_end...]
3. final_drain  pid=12345            ← last assistant event received, SIGTERM sent
4. exit         exitCode=0           ← process exited
5. close        exitCode=0           ← stdio fully closed
```

### Event sequence for crash:

```
1. spawned      pid=12345
2. spawn_error   error="..."         ← OR →
3. exit         exitCode=1
4. close        exitCode=1
```

### Event sequence for timeout:

```
1. spawned      pid=12345
2. [no stdout for 5 min]
3. response_timeout error="No output for 300000ms"
4. final_drain  pid=12345
5. hard_kill    pid=12345            ← SIGKILL after hardKillMs
6. exit         exitCode=null
7. close        exitCode=null
```

## onLifecycleEvent Callback Pattern

The callback bridges child-pi events → events.jsonl:

```typescript
// task-runner.ts
onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
  appendEvent(manifest.eventsPath, {
    type: `worker.${event.type}`,
    runId: manifest.runId,
    taskId: task.id,
    message: event.error ?? `Worker ${event.type}`,
    data: { pid: event.pid, exitCode: event.exitCode, error: event.error },
  });
}
```

**Why a callback instead of direct logging:** child-pi.ts has no access to manifest/eventsPath. The callback lets the caller (task-runner) decide how to log.

## Scaffold Mode

**When:** `executeWorkers = false` or `runtime.kind === 'scaffold'`

**Behavior:** No child process spawned. `runChildPi` is never called. The task:
1. Writes the prompt to disk as an artifact
2. Immediately completes with a scaffold result artifact
3. No `worker.spawned` event — the agent appears and completes instantly

**Display implication:** In widget, scaffold agents appear and complete within 1 frame. This is normal behavior, not a bug.

**Detection:** `runtimeKind === "child-process"` triggers child spawning; `"scaffold"` or `"live-session"` skip it.

## Child Args and Environment

### Args built by `buildPiWorkerArgs()` (`pi-args.ts`)

```
pi
  --role <role>
  --task-id <taskId>
  --run-id <runId>
  --cwd <cwd>
  [--session]
  [--model <model>]
  [--thinking <level>]           # off/minimal/low/medium/high/xhigh
  [--max-depth <n>]              # from limits.maxTaskDepth (default 2)
  [--skill-dir <path>]           # one per skill directory
  [--transcript <path>]           # output transcript
  --task
  <task-prompt-text>
```

### Environment variables

```
PI_EXECUTION_MODE=child           # marks child process context
PI_TEAMS_WORKER=1                # enables team-worker features
PI_CREW_PARENT_PID=<pid>         # parent process PID (added by child-pi.ts)
<redacted secrets>               # API keys filtered by sanitizeEnvSecrets()
```

### GetPiSpawnCommand

Resolves the `pi` binary path and builds the final command/args. On Windows, uses `pi.cmd` or `pi.exe`.

## Common Spawn Failures

| Symptom | Root cause | Fix |
|---|---|---|
| `spawn_error: spawn returned no pid` | `child.pid` is undefined — spawn call failed silently | Check binary path via `getPiSpawnCommand()` |
| `spawn_error: not a valid Win32 application` | Wrong binary (32-bit vs 64-bit) | Reinstall pi binary |
| `spawn_error: Access is denied` | Binary not executable, or antivirus blocking | Check file permissions, run as admin |
| `spawn_error: ENOENT: no such file or directory` | `pi` not in PATH | Add pi to PATH, or use full path |
| Worker crashes with exitCode=1, no output | API key missing or wrong | Check `PI_API_KEY` / `ANTHROPIC_API_KEY` |
| Worker crashes with exitCode=1, "Model not available" | Wrong model name | Check model name in config |
| Worker spawns, logs in, then crashes | Model rate limit / quota exceeded | Check provider limits |
| `response_timeout: No output for 300000ms` | Child process hung (network issue, model timeout) | Increase `responseTimeoutMs`, check network |
| Worker completes but output not captured | stdout/stderr stream issue | Check `ChildPiLineObserver` parsing |

## Exit Code Mapping

| Exit code | Meaning |
|---|---|
| `0` | Success — worker produced output and completed |
| `1` | Error — worker encountered a non-fatal error (API error, validation failure) |
| `null` | Killed — worker was SIGTERM'd or SIGKILL'd (timeout, cancel, drain) |
| `130` | SIGINT — interrupted by user cancel |

**Note:** `final_drain` followed by `exitCode=0` means the worker completed its output before being killed. The 0 exit code preserves the result.

## PID Tracking

- PID recorded in `manifest.async.pid` at spawn (via `checkpointTask`)
- PID checked by `hasStaleAsyncProcess()` (process-status.ts) to detect dead processes
- PID used by `killProcessPid()` (child-pi.ts) for termination
- PID in `childHardKillTimers` Map for timer cleanup on exit

## Enforcement — Child Pi Spawning Gate

**Before debugging worker spawn issues, verify:**

- [ ] Spawn error type identified (binary not found, permission denied, API key missing)
- [ ] PID tracking status confirmed (recorded in manifest, process alive/dead)
- [ ] Lifecycle event sequence matches expected pattern (spawned → output → exit)
- [ ] Timeout source determined (5-min response timeout, hard kill, final drain)
- [ ] Scaffold mode correctly identified (no worker.spawned event expected)

If ANY answer is NO → Stop. Re-examine events.jsonl and manifest before proceeding.

## Anti-patterns

- **Blocking on spawn**: `spawn()` is async — never await it synchronously. Use the Promise-based API.
- **Not handling exit**: Always handle `child.on("exit")` and `child.on("close")`. Without handlers, zombie processes accumulate.
- **Ignoring lifecycle events**: Without `onLifecycleEvent` handling, worker crashes leave no traceable evidence.
- **Not cleaning up timers**: Hard-kill timers, response-timeout timers, and final-drain timers must be cleared on all exit paths.
- **Passing secrets in args**: Child args are visible in process list. Use env vars (with redaction) instead.
- **Not handling `spawn_error`**: Errors on spawn (binary not found, permission denied) must be caught and logged.

## Source patterns

- `src/runtime/child-pi.ts` — runChildPi, ChildPiLifecycleEvent, activeChildProcesses, killProcessPid
- `src/runtime/task-runner.ts` — executeTask loop, onLifecycleEvent callback, runtimeKind
- `src/runtime/pi-args.ts` — buildPiWorkerArgs, applyThinkingSuffix
- `src/runtime/runtime-resolver.ts` — resolveCrewRuntime, isLiveSessionRuntimeAvailable, scaffold detection
- `src/runtime/model-resolver.ts` — model fallback chain
- `src/utils/env-filter.ts` — sanitizeEnvSecrets
- `src/config/defaults.ts` — responseTimeoutMs, finalDrainMs, hardKillMs

## Verification

```bash
cd pi-crew
# Test scaffold mode (no worker spawn)
PI_TEAMS_MOCK_CHILD_PI=json-success node --experimental-strip-types -e "
import { runChildPi } from './src/runtime/child-pi.ts';
const r = await runChildPi({ cwd: '.', task: 'test', agent: {name:'test'}, mock: 'success' });
console.log('exitCode:', r.exitCode);
"
npx tsc --noEmit
node --experimental-strip-types --test test/unit/task-runner.test.ts test/unit/child-pi.test.ts 2>/dev/null || echo "Tests may need specific files"
npm test
```