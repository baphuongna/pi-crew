# pi-crew Runtime Analysis: child-process vs live-session

> Date: 2026-05-12  
> Status: Performance analysis — proposing a default runtime change

---

## 1. Current problem

pi-crew's default runtime is **child-process** — each worker spawns its own `pi` CLI child process. This causes:

### 1.1 Memory

| Scenario | child-process | live-session | Savings |
|---|---|---|---|
| 1 worker | ~150 MB added | ~15 MB added | **135 MB** |
| 4 workers (parallel) | ~600 MB added | ~60 MB added | **540 MB** |
| 8 workers (max cap) | ~1.2 GB added | ~120 MB added | **~1.1 GB** |

**The parent Pi process already consumes ~308 MB.** Adding 4 child-process workers brings the total to **910 MB**, nearly 1 GB just to run a single team. A machine with 8 GB of RAM will start swapping.

### 1.2 Startup latency

| Stage | child-process | live-session |
|---|---|---|
| Process spawn | ~300ms | 0 |
| Node.js bootstrap | ~500ms | 0 |
| Pi CLI init + load extensions | ~1-2s | 0 |
| pi-crew register() (runs again in child) | ~200ms | 0 |
| createAgentSession() | ~100ms | ~100ms |
| First LLM token | **2-4s total** | **200-500ms total** |

**Each worker takes 2-4s to start.** A team implementation with 3 sequential phases × 2-4s = **6-12s just to spawn processes**, before any work even begins.

### 1.3 CPU overhead

- Each child process runs a separate V8 isolate → separate JIT compiler, separate GC
- `pi-crew register()` runs **repeatedly** in each child (load config, register tools, bind extensions)
- JSON parsing/redaction on child stdout → CPU cost per event

### 1.4 Complexity

- `child-pi.ts` = 461 lines just to manage the subprocess lifecycle
- Hard kill timer (3s), post-exit stdio guard (3s), final drain (5s), response timeout (5 min)
- Process tree kill (`taskkill /t /f` on Windows, `kill -pgid` on Unix)
- Mock system for testing (`PI_TEAMS_MOCK_CHILD_PI`)

---

## 2. live-session is ready

pi-crew **has already implemented** a complete live-session runtime:

- `src/runtime/live-session-runtime.ts` — 600 LOC, feature parity with child-process for most use cases
- `src/runtime/runtime-resolver.ts` — `resolveCrewRuntime()` already handles auto/live-session/child-process
- Soft turn limit + grace period (default 5) — **already present**, identical to pi-subagents3
- Tool filtering — `filterActiveTools()` removes recursive tools
- Yield/submit_result — custom tool + JSON event detection
- Live agent control — steer, resume, real-time tool activity
- Extension bridge — `buildExtensionBridge()` for extension-based APIs
- Health diagnostics — `collectLiveSessionHealth()`, `formatLiveSessionDiagnostics()`

### Current configuration must be set manually:

```json
// .pi/crew-config.json
{
  "runtime": {
    "mode": "live-session"
  }
}
```

Or:
```json
{
  "runtime": {
    "mode": "auto",
    "preferLiveSession": true
  }
}
```

**The current default is `"auto"` WITHOUT `preferLiveSession`** → it always falls back to child-process.

---

## 3. Proposal

### 3.1 Change the default: `preferLiveSession: true` when mode = "auto"

Current `resolveCrewRuntime()`:

```typescript
// src/runtime/runtime-resolver.ts
if (requestedMode === "live-session" || (requestedMode === "auto" && config.runtime?.preferLiveSession === true)) {
    const live = await isLiveSessionRuntimeAvailable(1500, env);
    if (live.available) return liveCaps(requestedMode);
    // fallback to child-process
}
return childCaps(requestedMode);  // ← default: always child-process
```

**Proposed change:**

```typescript
if (requestedMode === "live-session" || requestedMode === "auto") {
    const live = await isLiveSessionRuntimeAvailable(1500, env);
    if (live.available) return liveCaps(requestedMode);
    if (requestedMode === "live-session" && !config.runtime?.allowChildProcessFallback) 
        return scaffoldCaps(requestedMode, live.reason, "blocked");
    return { ...childCaps(requestedMode), fallback: "child-process", reason: live.reason };
}
```

**In other words:** `"auto"` → try live-session first, fall back to child-process if the SDK is unavailable. Users can still force `child-process` if they want.

### 3.2 Add an opt-out for risky tasks

A task-level flag to force child-process for specific tasks:

```json
{
  "runtime": {
    "mode": "auto",
    "preferLiveSession": true,
    "riskyIsolation": "child-process"
  }
}
```

Tasks with the `executor` role, or tasks running in a worktree → automatically use child-process.

### 3.3 Expected benefits

| Metric | Before (child-process default) | After (live-session default) |
|---|---|---|
| **4-worker memory** | ~910 MB | ~370 MB |
| **First token latency** | 2-4s/worker | 200-500ms/worker |
| **Total startup (3 phases)** | 6-12s | 0.6-1.5s |
| **Steering** | ❌ | ✅ |
| **Resume** | ❌ | ✅ |
| **Crash isolation** | ✅ | ❌ (fallback available) |
| **Parent crash risk** | None | Low (session.abort handles most) |

### 3.4 Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Agent crash → parent crash | Medium | `try/catch` around `session.prompt()`, `AbortController` per-agent, cleanup on unhandled rejection |
| Memory pressure (many sessions) | Low | Keep the `maxConcurrent` cap (default 4); the limit is sufficient |
| Recursive team calls | Low | `filterActiveTools()` already removes recursive tools |
| SDK unavailable (old Pi version) | Low | Auto-fallback to child-process |
| Unhandled errors in session | Medium | Global `unhandledRejection` handler per-session |

---

## 4. Conclusion

**pi-crew is using an overly heavy runtime for most use cases.** child-process provides excellent crash isolation, but:

- **9× the memory** compared to live-session
- **8× the startup latency**
- **No steer/resume** — loses interactive capability

live-session **is already implemented**; only the default needs to change. The crash isolation trade-off is acceptable because:
1. The Pi SDK `createAgentSession()` already handles most errors
2. A child-process fallback is still available when needed
3. The benefits (540 MB saved, 3s faster startup, steer/resume) outweigh the risks

**Action:** Change the `resolveCrewRuntime()` default so `"auto"` prefers live-session, keeping child-process as a fallback.
