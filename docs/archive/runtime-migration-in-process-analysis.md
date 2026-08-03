# Analysis: Migrating pi-crew fully to in-process execution

> Date: 2026-05-12  
> Question: What if we move entirely to in-process like pi-subagents3?

---

## 1. Current state

pi-crew has **3 runtime modes**, with child-process as the default:

```
scaffold      → no workers run (dry-run)
child-process → spawn a `pi` CLI subprocess per worker (DEFAULT)
live-session  → createAgentSession() in-process per worker
```

### Code related to child-process

| File | LOC | Role |
|---|---|---|
| `child-pi.ts` | 461 | Subprocess lifecycle, stdout parsing, kill process tree |
| `pi-args.ts` | 165 | Build CLI args for the child `pi` process |
| `pi-spawn.ts` | 167 | Detect the `pi` binary path (local/global) |
| `post-exit-stdio-guard.ts` | 86 | Drain child stdout after exit, hard kill timer |
| `async-runner.ts` | 153 | Spawn background team runs (detached process) |
| **Total** | **1,032** | **Code only used by child-process** |

### Code related to live-session (already present)

| File | LOC | Role |
|---|---|---|
| `live-session-runtime.ts` | 600 | In-process execution, soft turn limit, yield, custom tools |
| `runtime-resolver.ts` | 92 | Auto-detect available runtime |
| `task-runner/live-executor.ts` | 95 | Adapter: live-session → task-runner interface |

### Files that use the child-process path

- `task-runner.ts` — 8 references, ~120 lines of child-process-specific logic (heartbeat, progress, model retry)
- `register.ts` — `terminateActiveChildPiProcesses()` cleanup
- `doctor.ts` — diagnose child-process issues
- `async-runner.ts` — spawn background team runs

### Related tests

- ~37 test files reference child-process / mock child
- ~3 test files reference the live-session mock
- All integration tests use `PI_TEAMS_MOCK_CHILD_PI` — **would need rewriting** if child-process is dropped

---

## 2. If we move fully to in-process

### 2.1 What we GAIN

#### Immediate benefits

| Metric | child-process | in-process | Improvement |
|---|---|---|---|
| Memory / worker | ~150 MB | ~15 MB | **10× lighter** |
| 4 workers peak | ~600 MB added | ~60 MB added | **540 MB saved** |
| Startup / worker | 2-4s | 200-500ms | **8× faster** |
| Team startup (3 phases) | 6-12s overhead | ~1s overhead | **6-12× faster** |
| Steering | ❌ | ✅ | **New feature** |
| Resume | ❌ | ✅ | **New feature** |
| Context inheritance | ❌ | ✅ (parentContext) | **New feature** |
| Live tool activity | ❌ | ✅ | **New feature** |
| Yield/submit_result | ✅ (JSON event) | ✅ (custom tool) | Parity |
| Worktree isolation | ✅ | ✅ | Parity |

#### Architectural benefits

- **Delete ~1,000 LOC** of subprocess management code
- Simplify `task-runner.ts` (remove 120 lines of child-process logic)
- Remove `post-exit-stdio-guard.ts`, `pi-spawn.ts`, `pi-args.ts` subprocess overhead
- Remove `responseTimeoutMs`, `hardKillMs`, `postExitStdioGuardMs` — no need to kill a process tree
- **Zero npm dependencies for execution** (currently requires `jiti` for async-runner TypeScript loading)

### 2.2 What we LOSE

#### ❌ Process isolation — biggest loss

```
child-process:  worker crash → worker dies → parent continues
in-process:     worker crash → can crash parent → entire team lost
```

The Pi SDK `createAgentSession()` handles most errors, but:
- **Unhandled promise rejection** within a session
- **Infinite loop** inside a custom tool
- **OOM** — one session consuming all memory affects everything
- **Node.js segfault** — rare, but when it happens = total death

#### ❌ Async background team runs

`async-runner.ts` spawns a **detached process** to run a team when the user closes the terminal. In-process cannot do this — the process dies when the terminal closes.

**Solution:** Keep `async-runner.ts` specifically for background runs — it spawns the entire team runner, not individual workers.

#### ❌ Simple depth guard

`checkCrewDepth()` counts the `PI_CREW_PARENT_PID` env var. In-process has no process boundary → counting depth is harder. A global counter or thread-local equivalent is needed.

#### ❌ 37+ test files need updating

All integration tests use `PI_TEAMS_MOCK_CHILD_PI`. They would need to switch to `PI_CREW_MOCK_LIVE_SESSION` or have new mocks written.

#### ❌ `_CrewRuntimeKind` type union

`"scaffold" | "child-process" | "live-session"` → if child-process is dropped, only `"scaffold" | "in-process"` remains. Breaking change for config.

### 2.3 Specific risks

| Risk | Severity | Details |
|---|---|---|
| Parent crash | **Medium** | Unhandled error in agent session → parent dies. The Pi SDK wraps most of them but not 100%. |
| Memory pressure | **Medium** | 4 in-process sessions + context windows can consume >500MB within the same heap. V8 GC pauses. |
| Extension conflicts | **Low** | In-process extensions can conflict (global state, tool registry). Filtering exists but there are edge cases. |
| Recursive team calls | **Low** | The `team` tool inside an agent session → infinite recursion. Already filtered but a guarantee is needed. |
| Background runs | **Solved** | Keep `async-runner.ts` separate; it only spawns 1 detached process for the full team. |
| Breaking config | **Low** | Users currently setting `mode: "child-process"` → need a migration path. |

---

## 3. Two directions

### Direction A: Drop child-process entirely (like pi-subagents3)

```
                 ┌─────────────────────────┐
                 │   task-runner.ts         │
                 │   runtime = "in-process" │
                 ├─────────────────────────┤
                 │ live-session-runtime.ts  │
                 │ createAgentSession()     │
                 │ session.prompt()         │
                 │ session.steer()          │
                 ├─────────────────────────┤
                 │    Pi SDK (shared)       │
                 └─────────────────────────┘
```

**Delete:** `child-pi.ts`, `pi-args.ts`, `pi-spawn.ts`, `post-exit-stdio-guard.ts` (~879 LOC)  
**Keep:** `async-runner.ts` (for background team runs — spawns 1 process for the whole team, not per-worker)  
**Change:** `task-runner.ts` → drop the child-process branch, use only live-session  
**Change:** All 37+ test files  

**Pros:** Clean architecture, simplest, lowest maintenance  
**Cons:** Loses per-worker crash isolation; many tests need rewriting

### Direction B: Live-session default + child-process opt-in (recommended)

```
                 ┌─────────────────────────────────┐
                 │        task-runner.ts            │
                 │   default: live-session          │
                 │   opt-in: child-process          │
                 │   background: async-runner       │
                 ├──────────┬───────────────────────┤
                 │ in-proc  │  child-process         │
                 │ (fast)   │  (isolated, fallback)  │
                 └──────────┴───────────────────────┘
```

**Change:** `runtime-resolver.ts` → `"auto"` prefers live-session  
**Keep:** All child-process code (as fallback)  
**Keep:** All tests  
**Add:** Config `"riskyIsolation": true` so the executor role auto-uses child-process  

**Pros:** Best of both worlds, zero breaking changes  
**Cons:** Still maintaining 2 code paths

---

## 4. Recommendation: Direction B

**Do not drop child-process entirely** — too risky for production. Instead:

### Step 1: Change the default runtime (fast, low risk)

```typescript
// runtime-resolver.ts
// Before: "auto" → always child-process
// After:  "auto" → try live-session, fall back to child-process

export async function resolveCrewRuntime(config, env) {
    const requestedMode = config.runtime?.mode ?? "auto";
    if (requestedMode === "auto") {
        const live = await isLiveSessionRuntimeAvailable(1500, env);
        if (live.available) return liveCaps(requestedMode);
        return { ...childCaps(requestedMode), fallback: "child-process", reason: live.reason };
    }
    // Explicit modes still work
    if (requestedMode === "child-process") return childCaps(requestedMode);
    if (requestedMode === "live-session") { /* ... */ }
    // ...
}
```

### Step 2: Add a per-role isolation policy

```json
// crew-config.json
{
  "runtime": {
    "mode": "auto",
    "isolationPolicy": {
      "executor": "child-process",   // risky code changes → isolated
      "test-engineer": "child-process", // test runs → isolated
      "default": "in-process"         // everything else → fast
    }
  }
}
```

### Step 3: Observability for in-process errors

```typescript
// Wrap session.prompt() with a global error handler
process.on('unhandledRejection', (err) => {
    logInternalError('live-session.unhandled', err);
    // Don't crash — attempt recovery
});
```

### Expected benefits of Direction B

| | Current | After Step 1 | After Step 2 |
|---|---|---|---|
| **Default runtime** | child-process | live-session (auto) | live-session + per-role |
| **Memory (4 workers)** | ~910 MB | ~370 MB | ~450 MB (mixed) |
| **Startup** | 2-4s/worker | 200-500ms/worker | Mixed |
| **Crash isolation** | ✅ all | ✅ fallback | ✅ risky roles |
| **Steering** | ❌ | ✅ | ✅ |
| **Breaking changes** | — | None | None |
| **Code deleted** | — | 0 | 0 (keep fallback) |
| **Tests to change** | — | 0 | 0 |

---

## 5. Conclusion

**Do not move 100% to in-process.** Reasons:

1. **Crash isolation is too important** for executor/test-engineer roles — these agents run code, write files, and can infinite-loop
2. **Background runs need a detached process** — impossible in-process
3. **37+ test files need rewriting** — high migration cost
4. **Breaking change** for users currently using `mode: "child-process"`

**Instead: Change the default to live-session + keep child-process as a fallback/opt-in.** This is precisely the design already built into `resolveCrewRuntime()` — just flip the default in `"auto"` mode. Zero code deleted, zero breaking changes, and users choose isolation when they need it.
