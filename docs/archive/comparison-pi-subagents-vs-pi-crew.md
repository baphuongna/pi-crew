# Architecture Comparison: pi-subagents3 vs pi-crew

> Date: 2026-05-12  
> Source: `@tintinweb/pi-subagents` v0.7.1 (6.082 LOC, 28 files) vs `pi-crew` v0.2.3 (35.809 LOC, ~200+ files)

---

## 1. Overview

| Criterion | pi-subagents3 | pi-crew |
|---|---|---|
| **Author** | tintinweb | baphuongna |
| **Version** | 0.7.1 | 0.2.3 |
| **Goal** | Single subagent (Agent tool) — spawn, resume, steer | Team orchestration — multi-agent workflows, phases, parallel dispatch |
| **LOC** | ~6.000 | ~36.000 |
| **Entry point** | `src/index.ts` (1.885 lines — monolith) | `index.ts` → `register.ts` (668 lines) → modular registration |
| **Architecture** | Simple, direct, single-agent focus | Layered, event-driven, state-machine based |
| **Peer deps** | pi-ai ≥0.70.5, pi-coding-agent ≥0.70.5, pi-tui ≥0.70.5 | pi-coding-agent (runtime) |
| **Npm deps** | `@sinclair/typebox`, `croner`, `nanoid` | 0 (zero runtime dependencies) |
| **Test runner** | vitest | Node built-in `--experimental-strip-types` |
| **Subprocess model** | **In-process** (reuses Pi SDK `createAgentSession`) | **Out-of-process** (spawn child Pi instance via `child-pi.ts`) |

---

## 2. Core architecture

### 2.1 pi-subagents3 — In-process Agent Sessions

```
┌─────────────────────────────────────────────┐
│              index.ts (1885 LOC)             │
│  Extension entry: tools, commands, menus,    │
│  lifecycle hooks, settings, scheduling       │
├─────────┬──────────┬──────────┬──────────────┤
│agent-   │agent-    │agent-    │schedule.ts   │
│runner   │manager   │types     │ScheduleStore │
│(310 LOC)│(310 LOC) │(140 LOC) │(365 LOC)     │
├─────────┴──────────┴──────────┴──────────────┤
│ memory.ts │ prompts.ts │ context.ts │ env.ts │
│ worktree  │ model-     │ settings   │ usage  │
│           │ resolver   │            │        │
├──────────────────────────────────────────────┤
│           Pi SDK (createAgentSession)         │
│     In-process, shared event loop            │
└──────────────────────────────────────────────┘
```

**Key characteristics:**
- Agent runs **in the same process** as the parent Pi session
- Uses `createAgentSession()` + `session.prompt()` — direct Pi SDK API
- Tool filtering, extension binding, skill preloading in-process
- Event subscription (`session.subscribe()`) to track turns, tool uses, streaming text
- A single huge `index.ts` file contains nearly all the logic

### 2.2 pi-crew — Out-of-process Child Workers

```
┌─────────────────────────────────────────────────────────┐
│                   register.ts (668 LOC)                  │
│  Extension entry: lifecycle, commands, tool registration  │
├────────────────┬─────────────────┬───────────────────────┤
│  team-tool.ts  │  team-runner.ts │  subagent-manager.ts  │
│  (344 LOC)     │  (945 LOC)      │  (400 LOC)            │
│  Tool handler  │  Workflow engine │  Agent tracking       │
├────────────────┴─────────────────┴───────────────────────┤
│  child-pi.ts (461 LOC) │ task-runner.ts (459 LOC)        │
│  Subprocess spawn      │ Per-worker execution             │
├─────────────────────────┬───────────────────────────────┤
│     State Layer         │        UI Layer                │
│  state-store.ts         │  crew-widget.ts                │
│  event-log.ts           │  run-dashboard.ts              │
│  locks.ts               │  transcript-viewer.ts          │
│  atomic-write.ts        │  powerbar-publisher.ts         │
├─────────────────────────┴───────────────────────────────┤
│       Pi CLI (child process via spawn)                   │
│     Isolated process, independent event loop             │
└─────────────────────────────────────────────────────────┘
```

**Key characteristics:**
- Worker runs **in a separate process** — spawns `pi` CLI child process
- Communicates via JSON events on stdout (`--json-output` mode)
- State persistence: JSONL event log, manifest files, atomic writes
- Distributed architecture: team → workflow → phases → tasks → workers
- Full isolation: crash recovery, stuck detection, deadletter

---

## 3. Detailed module-by-module comparison

### 3.1 Agent Execution

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Runtime** | `createAgentSession()` in-process | `spawn("pi", [...])` child process |
| **Tool access** | Direct — `session.setActiveToolsByName()` | Limited by child Pi args |
| **Context sharing** | `buildParentContext()` — copy conversation | None (isolated by design) |
| **Steering** | `session.steer(message)` — immediate in-process | `child.stdin.write()` — JSON event |
| **Resume** | `resumeAgent(session, prompt)` — reuse session | Re-spawn child process |
| **Turn limits** | Soft limit → steer "wrap up" → hard abort | `--max-turns` CLI arg → child exit |
| **Grace turns** | Configurable (default 5) | N/A |
| **Streaming** | `session.subscribe()` — real-time deltas | JSON event polling on stdout |
| **Compaction** | Tracked via `compaction_end` events | Child handles independently |
| **Memory overhead** | Low (shared process) | High (separate Node.js process) |
| **Isolation** | Process-shared (same memory space) | Process-isolated (crash-safe) |
| **Max concurrent** | Queue with configurable limit (default 4) | Queue with configurable limit (default 4) |

### 3.2 Agent Configuration

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Built-in agents** | 3: general-purpose, Explore, Plan | 10: explorer, planner, executor, reviewer, verifier, analyst, critic, writer, security-reviewer, test-engineer |
| **Custom agents** | `.md` files in `.pi/agents/` or `~/.pi/agents/` | `.md` files in `agents/` (project) |
| **Agent config** | 22 fields: systemPrompt, promptMode, extensions, skills, model, thinking, maxTurns, memory, isolation, disallowedTools... | agent-config.ts: name, systemPrompt (frontmatter), maxTurns |
| **Prompt mode** | `replace` (standalone) or `append` (parent twin) | Always replace (isolated subprocess) |
| **Tool filtering** | Allowlist (builtinToolNames) + denylist (disallowedTools) + extension filter | CLI arg `--allowed-tools` |
| **Model lock** | Per-agent model in config | Per-agent model in frontmatter |
| **Thinking level** | Per-agent `thinking` field | Per-agent `thinkingLevel` in frontmatter |
| **Agent discovery** | `custom-agents.ts` → `.md` frontmatter parse | `discover-agents.ts` → `.md` frontmatter parse |

### 3.3 Memory / Persistence

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Agent memory** | ✅ Persistent MEMORY.md per agent (user/project/local scope) | ❌ No built-in agent memory |
| **Memory tools** | Injected dynamically based on write capability | N/A |
| **State persistence** | In-memory AgentRecord + JSON schedule store | Full state machine: manifest.json + events.jsonl + tasks.json |
| **Crash recovery** | Worktree prune on dispose | Detect interrupted runs, deadletter, stuck-blocked notifications |
| **Locking** | PID-based file lock for schedule store | `mkdirSync` atomic lock + PID stale detection for event log |
| **Atomic writes** | temp+rename (POSIX) | Full atomic-write.ts with O_NOFOLLOW, symlink checks, sync/async parity |

### 3.4 Scheduling

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Scheduling** | ✅ Full scheduler: cron (6-field), interval, one-shot | ❌ No scheduling |
| **Cron engine** | `croner` library | N/A |
| **Persistence** | Session-scoped JSON with PID-locked store | N/A |
| **Queue bypass** | `bypassQueue: true` for scheduled fires | N/A |
| **Events** | `subagents:scheduled` (added/removed/fired/error) | N/A |
| **Master switch** | `schedulingEnabled` setting (strips tool param) | N/A |

### 3.5 Worktree Isolation

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Worktree support** | ✅ `createWorktree()` / `cleanupWorktree()` | ✅ Full `worktree-manager.ts` (8.8 KB) |
| **Branch management** | Auto-branch, auto-commit changes | Branch freshness, reuse, file node_modules skip |
| **Error handling** | Strict — throws if worktree creation fails | Retry + fallback |
| **Cleanup** | On completion (success or error) + prune on dispose | On completion + cleanup.ts + branch-freshness |

### 3.6 Cross-extension Communication

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **RPC protocol** | ✅ Event bus RPC: ping/spawn/stop | ✅ Event bus RPC: ping/spawn/status/cancel |
| **Protocol version** | v2 | Versioned |
| **Reply envelope** | `{ success: true, data? }` / `{ success: false, error }` | Similar |
| **Singleton access** | `Symbol.for("pi-subagents:manager")` on globalThis | `globalThis.__piCrewRuntimeCleanup` |

### 3.7 UI / TUI

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Agent widget** | `agent-widget.ts` (518 LOC) — overlay | `crew-widget.ts` (16 KB) — sidebar + dashboard |
| **Conversation viewer** | `conversation-viewer.ts` (243 LOC) | `transcript-viewer.ts` (13.9 KB) — JSONL-based |
| **Schedule menu** | `schedule-menu.ts` (104 LOC) | N/A |
| **Dashboard** | N/A (overlay-based) | `run-dashboard.ts` (22.7 KB) — multi-pane |
| **Status bar** | Inline status in overlay | `powerbar-publisher.ts` (8.9 KB) |
| **Live sidebar** | N/A | `live-run-sidebar.ts` (8.6 KB) |
| **Notification render** | Custom `renderCall` / `renderResult` | `notification-router.ts` + `notification-sink.ts` |
| **Context % indicator** | ✅ Token count + context % (colored) + compaction count | ❌ No context indicator |

### 3.8 Settings / Configuration

| Aspect | pi-subagents3 | pi-crew |
|---|---|---|
| **Settings file** | `.pi/subagents.json` (project) + `~/.pi/agent/subagents.json` (global) | `config.ts` → `.pi/crew-config.json` + `defaults.ts` |
| **Runtime settings** | maxConcurrent, defaultMaxTurns, graceTurns, defaultJoinMode, schedulingEnabled | maxConcurrent, telemetry, notifications |
| **Validation** | `sanitize()` with ceiling values | `config.ts` schema validation |
| **Hot reload** | Apply on change + emit event | Load on register |

---

## 4. Unique features

### pi-subagents3 has but pi-crew doesn't:

1. **In-process agent sessions** — Zero subprocess overhead, direct Pi SDK access, shared event loop
2. **Persistent agent memory** — MEMORY.md per agent with 3 scopes (user/project/local), auto-injected tools
3. **Soft turn limit + grace period** — Steer "wrap up" before hard-aborting, configurable grace turns
4. **Scheduling** — Full cron/interval/one-shot scheduler with croner, session-scoped persistence
5. **Parent context inheritance** — `inheritContext` forks the conversation for the subagent
6. **Append mode** — Agent runs as a "twin" of the parent (inherits system prompt + tools)
7. **Context % indicator** — Live context window utilization (%), compaction count (↻N)
8. **Agent memory tools** — Dynamic tool injection based on write capability (read-only vs read-write)
9. **Skill preloading** — Load skill content directly into the system prompt (string[])
10. **Batch grouping** — 100ms debounce batches multiple background completions into 1 notification
11. **Cancelable nudges** — 200ms hold before sending a notification, get_subagent_result cancels the nudge
12. **Agent creation wizard** — `/agents` → spawn an agent to create an agent config .md file

### pi-crew has but pi-subagents3 doesn't:

1. **Team orchestration** — Multi-agent teams with workflows, phases, parallel dispatch
2. **Workflow engine** — Declarative workflow definitions (step → agent → gate → next)
3. **Out-of-process isolation** — Child Pi process, crash-safe, independent event loop
4. **Full state machine** — manifest.json + tasks.json + events.jsonl, durable persistence
5. **Crash recovery** — Detect interrupted runs, deadletter queue, stuck-blocked detection
6. **Mailbox system** — Interactive respond/nudge/ack workflow for waiting tasks
7. **Heartbeat monitoring** — `heartbeat-watcher.ts` + gradient-based health tracking
8. **Observability** — Metrics registry, OTLP exporter, Prometheus exporter
9. **Run export/import** — Bundle/unbundle runs for cross-machine sharing
10. **Live session management** — Live IRC, live agent control, live extension bridge
11. **UI dashboard** — Multi-pane dashboard with agents/capabilities/health/mailbox/progress
12. **Run snapshot cache** — Efficient state snapshots for UI rendering
13. **Delivery coordination** — Overflow recovery, delivery coordinator for message routing
14. **i18n** — Internationalization support
15. **Post-checks** — Configurable post-execution verification hooks
16. **Iteration hooks** — Pre/post iteration hooks for external integrations
17. **Model fallback chain** — Multi-model fallback with cost tracking
18. **Compaction summary** — Context compaction for long-running agents
19. **Task quality scoring** — Automatic quality assessment of task outputs
20. **Agent capability inventory** — Dynamic tool/skill capability detection

---

## 5. Pros and cons analysis

### pi-subagents3

**Pros:**
- **Simple**: ~6K LOC, easy to understand and maintain
- **Performance**: In-process, zero subprocess overhead, shared memory
- **Deep features**: Memory, scheduling, context inheritance, turn management are very detailed
- **SDK-first**: Uses the Pi SDK directly, fully leveraging the API
- **Interactive**: Resume, steer, conversation viewer are very smooth
- **Settings**: Hot-reload, master switch for features

**Cons:**
- **Monolith**: `index.ts` 1.885 lines — hard to maintain, hard to test
- **No team support**: No workflow, phases, parallel dispatch
- **Crash propagation**: Agent crash affects the parent process
- **Limited observability**: No metrics, export, monitoring
- **No run persistence**: Agent record is in-memory only (except the schedule store)

### pi-crew

**Pros:**
- **Strong architecture**: Layered, event-driven, state-machine based
- **Team orchestration**: Workflow engine with phases, parallel, gates
- **Crash isolation**: Out-of-process workers, child crash doesn't affect parent
- **Full persistence**: JSONL event log, manifest, atomic writes
- **Observability**: Metrics, OTLP, Prometheus, heartbeat monitoring
- **Modular**: 200+ files, each file one responsibility
- **Enterprise features**: Export/import, i18n, compaction, quality scoring

**Cons:**
- **Complex**: 36K LOC, steep learning curve
- **Subprocess overhead**: Each worker spawns its own process (RAM, startup time)
- **No memory**: Agents have no persistent memory between sessions
- **No scheduling**: No cron/interval/one-shot
- **No context inheritance**: Workers run isolated, can't see parent context
- **No soft turn limit**: Hard cutoff, no grace period
- **No interactive steer**: Cannot steer a worker after spawning

---

## 6. Recommendations

### What pi-crew should learn from pi-subagents3:

1. **Persistent agent memory** — The MEMORY.md pattern is very valuable for long-running projects
2. **Soft turn limit + grace period** — More elegant than hard abort
3. **Scheduling** — Cron/interval scheduling for automated tasks
4. **Context % indicator** — Helps the parent LLM know how much room the subagent has left
5. **Batch notification grouping** — Reduces noise when many workers complete simultaneously
6. **In-process mode** (optional) — For lightweight tasks that don't need process isolation
7. **Cancelable nudges** — Avoid notification spam
8. **Agent settings hot-reload** — Change settings without restarting

### What pi-subagents3 should learn from pi-crew:

1. **Modular architecture** — Split `index.ts` into multiple files
2. **State persistence** — Durable state instead of in-memory only
3. **Crash recovery** — Detect interrupted runs, deadletter
4. **Observability** — Metrics, monitoring, health checks
5. **Team support** — Multi-agent workflows
6. **Out-of-process option** — For heavy tasks needing isolation
7. **Run export/import** — Cross-machine sharing

---

## 7. Conclusion

**pi-subagents3** is a **focused** extension — it does one thing very well: spawn and manage individual subagents. It leverages the Pi SDK maximally, in-process, interactive, with deep features like memory and scheduling.

**pi-crew** is an **orchestration platform** — broader scope, strong in team workflows, state management, crash recovery, and enterprise features. But much more complex, and missing some "nice-to-have" features that pi-subagents3 has.

The two extensions **complement** each other more than they compete:
- pi-subagents3 for **quick, interactive subagent tasks** (code review, exploration, one-off analysis)
- pi-crew for **complex, multi-phase team workflows** (full feature implementation, multi-perspective review, parallel research)

An ideal architecture might combine both: use pi-subagents3's in-process execution for lightweight tasks, and pi-crew's orchestration layer for complex workflows.
