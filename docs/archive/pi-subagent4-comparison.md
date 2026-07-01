# pi-subagent4 vs pi-crew: Comparative Analysis

## Overview

| Aspect | pi-subagent4 | pi-crew |
|--------|--------------|---------|
| **Size** | ~560 lines (single file) | ~50+ files, 10K+ lines |
| **Architecture** | Single `subagent` tool | Full team orchestration system |
| **Agent Model** | 3 built-in (scout, researcher, worker) | Configurable, extensible |
| **Concurrency** | Semaphore (default 4) | DAG scheduler with phases |
| **Context** | No inheritance (must be in task) | Full context preservation |

---

## 1. Extension & Registration

### pi-subagent4
```typescript
// Dynamic agent registration via globalThis bridge
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

export function registerAgent(config: AgentConfig): void {
  agents.push(config);
}
```
- **File-based**: Loads agents from `.md` files at startup
- **Global bridge**: Uses `globalThis.__pi_subagents` for cross-module registration
- **Frontmatter config**: YAML frontmatter in `.md` files define agents

### pi-crew
- **Manifest-based**: Teams/workflows defined in `.team.md`/`.workflow.md` files
- **Skills system**: Extensible skill system for agents
- **No dynamic registration API**: Static configuration

---

## 2. Child Process Spawning

### pi-subagent4
```typescript
const args = [
  ...piBin.baseArgs,
  "--mode", "json",
  "-p",
  "--no-session",
  "--no-skills",
  "--no-extensions",
  "--tools", allowlist.join(","),
  // ... custom tools, model, thinking level
];

const child = spawn(command, spawnArgs, { stdio: ["ignore", "pipe", "pipe"] });
```
- **JSON mode**: `--mode json` for structured output
- **Heavy isolation**: `--no-session --no-skills --no-extensions`
- **Tool allowlist**: `--tools` for fine-grained control
- **PI_SUBAGENT_ALLOWED**: Env var restricts nested subagents

### pi-crew
```typescript
const child = spawn(spawnSpec.command, spawnSpec.args, buildChildPiSpawnOptions(...));
```
- **Similar isolation**: Filters env vars, preserves essentials
- **More complex args**: Based on task config
- **No direct env restriction**: Uses runtime mode instead

---

## 3. Concurrency Control

### pi-subagent4
```typescript
class Semaphore {
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Simple acquire/release pattern
  }
}

const semaphore = new Semaphore(config.maxConcurrency ?? 4);
```
- **Per-parent semaphore**: Default 4, configurable via `config.json`
- **Promise.all fan-out**: Parallel subagent calls in one turn

### pi-crew
```typescript
// DAG scheduler with phase-based concurrency
resolveBatchConcurrency({
  workflowMaxConcurrency,
  teamMaxConcurrency,
  maxConcurrentWorkers,
  workspaceMode,
});

// Tasks in same phase run concurrently
```
- **Phase-based**: Tasks grouped by workflow phase
- **DAG dependency**: Respects task dependencies
- **Configurable limits**: Per-workflow and per-team

---

## 4. Input Handling

### pi-subagent4
```typescript
// Long tasks written to temp file
if (task.length > 8000) {
  const tempFile = createTempFile(task);
  args.push("@" + tempFile);
} else {
  args.push("--task", task);
}
```
- **8K char threshold**: Uses temp file for large tasks
- **Single task format**: `--task <text>` or `@<file>`

### pi-crew
```typescript
// Prompt builder with system prompt, context, task
const built = await buildPrompt({ task, role, goal, cwd, ... });
// Args built from task configuration
```
- **Prompt builder**: Constructs full prompt with context
- **File-based context**: Can read from workspace files

---

## 5. Output Handling

### pi-subagent4
```typescript
// JSON event stream on stdout
child.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (line.startsWith("{")) {
      const event = JSON.parse(line);
      // tool_execution_start/end, message_end
    }
  }
});
```
- **JSON event stream**: Structured events from child process
- **Event types**: `tool_execution_start`, `tool_execution_end`, `message_end`
- **Streaming**: Real-time event processing

### pi-crew
```typescript
// JSON output mode + structured response
const output = await runChildPi({
  onLifecycleEvent: (event) => { ... },
  // ...
});
```
- **Lifecycle events**: spawn, spawn_error, response_timeout, etc.
- **Structured result**: `{ content, details, usage }`

---

## 6. Safety Features

### pi-subagent4
```typescript
// tools/safe-bash.ts
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  // ... 15+ patterns
];
```
- **Regex blocklist**: 15+ dangerous command patterns
- **Safe bash wrapper**: Wraps built-in bash tool

### pi-crew
- **Env var filtering**: Strips secrets before spawning
- **No built-in safe bash**: Trust-based (user config required)
- **Sandbox modes**: scaffold, child-process, live-session

---

## 7. UI/Rendering

### pi-subagent4
```typescript
// Throttled live rendering
const updateThrottle = 150; // ms
// Context window meter for depth >= 1 subagents
// Tool preview extraction
```
- **150ms throttle**: Prevents UI thrashing
- **Context gauge**: Shows token usage
- **Tool preview**: Single-line argument preview

### pi-crew
- **Rich UI widget**: Live status, progress, model/token display
- **Dashboard**: Full run dashboard
- **Event bus**: Real-time updates

---

## 8. Agent Hierarchy

### pi-subagent4
```
worker (depth 2)
  ├─ scout (depth 1)
  └─ researcher (depth 1)
```
- **Depth-2 cap**: Worker can spawn scout/researcher
- **PI_SUBAGENT_ALLOWED**: Enforces restriction

### pi-crew
- **No nested subagent**: Each task is independent
- **Team roles**: explorer, planner, executor, etc.
- **Phase-based**: Sequential phases with parallel within

---

## Key Insights

### What pi-subagent4 does better:
1. **Simpler API**: Single tool, minimal config
2. **Dynamic registration**: `registerAgent()` for runtime changes
3. **JSON event stream**: Real-time structured events
4. **Safe bash**: Built-in dangerous command blocking
5. **Context gauge**: Token monitoring per turn

### What pi-crew does better:
1. **Complex workflows**: DAG scheduler, phases, dependencies
2. **Durable state**: Manifest, events, artifacts persisted
3. **Worktree isolation**: Safe parallel edits
4. **Async runs**: Background execution with notifications
5. **Rich UI**: Full dashboard and widget system
6. **Multiple teams**: Built-in teams for different use cases

---

## Potential Improvements for pi-crew

1. **Dynamic agent registration API**
   - Add `registerAgent(config)` similar to subagent4
   - Allow runtime agent creation

2. **Safe bash tool**
   - Port dangerous pattern blocklist from subagent4
   - Configurable via project config

3. **JSON event stream parsing**
   - Extract real-time tool events from child process
   - Display tool progress in UI

4. **Context window monitoring**
   - Show token usage per task
   - Alert when approaching limits

5. **Simpler single-agent mode**
   - Maybe a `subagent` tool for simple delegation?
   - Current API is team/workflow based, could be heavy for simple cases