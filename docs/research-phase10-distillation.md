# Phase 10: Source Distillation & Development Roadmap

> Synthesized from deep-reads of `pi-mono`, `pi-subagents`, and `pi-crew@melihmucuk` reference fork.
> Date: 2026-05-04

---

## 1. Source Insights

### 1.1 pi-mono (v0.72.1)

| Insight | Impact on pi-crew |
|---|---|
| **Compact read rendering** — AGENTS.md, SKILL.md, Pi docs auto-collapsed in TUI | Our agents' prompts that reference these files still work, but users won't see full content inline. Ensure tool-call descriptions are self-contained. |
| **Session resource cleanup registry** — Providers register cleanup fns; `dispose()` calls all | Our `child-pi.ts` should register cleanup for child processes. Currently we handle SIGINT/beforeExit — align with Pi's new `registerSessionResourceCleanup()`. |
| **Codex WebSocket SSE fallback** — Transparent fallback on WS failure | No direct impact, but note: child Pi processes may switch transports mid-session. |
| **Xiaomi per-region token plan providers** | No impact — provider list is internal to Pi. |
| **Model catalog generator with overrides** | Our `model-fallback.ts` should track new models as Pi adds them. |

### 1.2 pi-subagents (v0.24.0)

| Insight | Impact on pi-crew |
|---|---|
| **Chain directories** — Dedicated `.pi/chains/` and `~/.pi/agent/chains/` | Our workflows are similar but directory-based discovery with `listMarkdownFilesRecursive` is a good pattern. |
| **Supervisor contact** — Children call `contact_supervisor` | Our mailbox system already serves this purpose, but subagent-initiated communication is one-directional. Consider adding `supervisor_contact` event for child→parent. |
| **Model thinking levels** — Respect `thinking` from agent frontmatter | We already have `model-fallback.ts` but don't propagate thinking levels to child Pi. |
| **Session-scoped status** — Filter status by session | Our `run-index.ts` already merges scopes, but individual run status should be session-scoped to avoid cross-contamination. |
| **Foreground kept alive during intercom** | Our `completion-guard.ts` handles some of this, but the pattern of pausing parent while child waits for supervisor is worth aligning. |
| **File-only outputs** — Some subagents only write to files | Our `task-output-context.ts` already supports file-only output extraction. Validate compatibility. |
| **Packaged recursive agents** — Agents can spawn sub-agents | Our task-runner already supports this via child Pi, but we should document the recursive depth guard. |
| **UI simplification** — Removed overlays, consolidated to tool actions | Our dashboard is more advanced but we should ensure TUI simplicity is preserved. |

### 1.3 pi-crew reference fork (melihmucuk v1.0.14)

| Insight | Impact on pi-crew |
|---|---|
| **CrewRuntime singleton** — Process-level, survives session replacement | Our `crew-agent-runtime.ts` is similar but not a true singleton. Consider hardening. |
| **DeliveryCoordinator** — Routes results to owner session, queues when inactive | We lack this pattern. Our result delivery goes through artifacts + notification, but not session-aware routing. |
| **Ownership model** — `abortOwned()` returns `{ abortedIds, missingIds, foreignIds }` | Our `cancel.ts` returns `results[]` but doesn't distinguish foreign IDs. Adopt. |
| **Interactive subagents** — `interactive: true` → `waiting` state, `crew_respond`/`crew_done` | We don't have this. Our agents run to completion. Interactive subagents would enable oracle/planner patterns. |
| **Overflow recovery** — Detect context overflow → compaction → auto_retry → recovered, with 120s timeout | We have no overflow recovery. Child Pi processes that hit context limits silently fail. |
| **3-tier agent discovery with JSON overrides** | Our discovery uses teams/agents/workflows with schema validation. JSON overrides for model/thinking/tools are worth adding. |
| **BootstrapSession** — Excludes own extension, uses `SessionManager.create().newSession()` | Our `child-pi.ts` uses `--extension` flags. Align with Pi 0.65+ `session_start` API. |
| **Bundled subagents inherit parent model** | Our `model-fallback.ts` resolves model chain differently. Consider simplifying. |

---

## 2. Distilled Development Axes

### Axis A: Runtime Hardening (Critical)

**A1. Session-aware result delivery**
- Current: Results go to artifacts + notification router
- Target: Add `DeliveryCoordinator` pattern that routes results to the **owner session** specifically, queues when inactive, flushes on `session_start`
- Why: Prevents result loss when a session is replaced/reloaded; matches Pi's lifecycle

**A2. Overflow recovery for child processes**
- Current: Child Pi hitting context limits fails silently or with generic errors
- Target: Detect `agent_end` → `compaction_start/end` → `auto_retry_start/end` event sequence; mark task as `"overflow_recovering"` → `"recovered"` or `"failed"`
- Why: Long tasks with large context currently fail unrecoverably

**A3. Interactive subagent protocol**
- Current: All agents run to completion; no mid-run interaction
- Target: `interactive: true` in agent frontmatter → agent pauses after response, enters `waiting` state; parent sends `crew_respond` to continue, `crew_done` to finalize
- Why: Enables oracle (decision evaluation), planner (multi-turn refinement), and any agent that needs human/team guidance mid-task

**A4. Session resource cleanup alignment**
- Current: SIGINT + beforeExit handlers
- Target: Register cleanup via Pi's `registerSessionResourceCleanup()` when available; fall back to current handlers
- Why: Aligns with Pi's new lifecycle; prevents orphan processes on session reload

### Axis B: Discovery & Configuration (High)

**B1. JSON config overrides for agents/teams**
- Current: Agent frontmatter is the sole source of truth
- Target: `~/.pi/agent/pi-crew.json` (global) and `.pi/pi-crew.json` (project) can override `model`, `thinking`, `tools`, `skills` for any agent
- Why: Per-project model tuning without editing bundled agents; environment-specific tool access

**B2. Thinking level propagation**
- Current: Agent frontmatter has `model` but no `thinking` field
- Target: Add `thinking` to agent schema; propagate to child Pi via `--thinking` flag or session params
- Why: Aligns with Pi's thinking levels; cost control for expensive models

**B3. Parent model inheritance for bundled agents**
- Current: `model-fallback.ts` has a complex chain with config fallbacks
- Target: Simplify: agent frontmatter model → parent session model → config default
- Why: Reduces configuration burden; bundled agents work with whatever model the parent uses

### Axis C: Ownership & Safety (High)

**C1. Foreign-aware ownership model**
- Current: `cancel.ts` returns flat results array
- Target: `cancelOwned(runId, taskIds)` returns `{ abortedIds, missingIds, foreignIds }`; tool responses clearly distinguish "you can't abort foreign tasks"
- Why: Prevents confusion in multi-session scenarios; security improvement

**C2. Supervisor contact event (child→parent)**
- Current: Mailbox is parent→child only; child can write artifacts
- Target: Add `supervisor_contact` event type where child signals "I need a decision" with structured data; parent can respond via mailbox or `steer_subagent`
- Why: Enables interactive subagent protocol (A3); currently children are fire-and-forget

**C3. Session-scoped status filtering**
- Current: `run-index.ts` merges project + user scope runs
- Target: Default status/inspect to session-scoped; cross-scope access only via explicit `scope:` parameter
- Why: Prevents accidental cross-contamination; matches pi-subagents' session scoping

### Axis D: Compatibility & Polish (Medium)

**D1. Compact read rendering awareness**
- Current: Agent prompts reference AGENTS.md, SKILL.md, etc.
- Target: Ensure agent prompts are self-contained enough that collapsed reads don't lose critical instructions; add fallback descriptions in team/workflow frontmatter
- Why: Pi v0.72+ collapses these files in TUI; agents still receive full content via tool calls

**D2. Pi 0.65+ API alignment**
- Current: `child-pi.ts` uses CLI flags (`--model`, `--extension`, etc.)
- Target: When Pi SDK exposes `SessionManager.create()` + `session_start` event in extension API, migrate child session creation to programmatic API
- Why: More reliable than CLI flag parsing; better lifecycle control; Pi is moving toward SDK-first

**D3. UI simplification**
- Current: Full dashboard with 6 panes
- Target: Ensure each pane works as a standalone tool action; no pane depends on another's state. Consider adding compact/expanded modes.
- Why: pi-subagents removed overlays entirely; our dashboard should be usable without full TUI

### Axis E: Observability Gaps (Medium)

**E1. Overflow recovery metrics**
- Add `tasks_overflow_recovering` and `tasks_overflow_recovered` counters to MetricRegistry

**E2. Interactive subagent state tracking**
- Add `tasks_waiting` state to heartbeat/watcher; track wait duration

**E3. Foreign ownership audit logging**
- Log foreign access attempts with session ID; detect potential conflicts

---

## 3. Priority Matrix

| Priority | Item | Axis | Effort | Impact |
|---|---|---|---|---|
| 🔴 P0 | A1: Session-aware result delivery | A | M | High — prevents result loss |
| 🔴 P0 | A2: Overflow recovery for child processes | A | M | High — long tasks currently fail silently |
| 🟡 P1 | C1: Foreign-aware ownership model | C | S | High — security + UX |
| 🟡 P1 | A4: Session resource cleanup alignment | A | S | Medium — aligns with Pi lifecycle |
| 🟡 P1 | B1: JSON config overrides | B | M | Medium — per-project customization |
| 🟡 P1 | B2: Thinking level propagation | B | S | Medium — cost control |
| 🟡 P1 | D1: Compact read rendering awareness | D | S | Medium — compatibility |
| 🟢 P2 | A3: Interactive subagent protocol | A | L | High — enables oracle/planner |
| 🟢 P2 | B3: Parent model inheritance | B | S | Low — simplification |
| 🟢 P2 | C2: Supervisor contact event | C | M | Medium — depends on A3 |
| 🟢 P2 | C3: Session-scoped status | C | S | Low — UX improvement |
| 🟢 P2 | D2: Pi 0.65+ API alignment | D | L | Low — future-proofing |
| 🟢 P2 | D3: UI simplification | D | M | Low — nice to have |
| 🔵 P3 | E1-E3: Observability gaps | E | S | Low — monitoring |

---

## 4. Implementation Order (Proposed)

### Phase 10a: Runtime Hardening (P0 + P1)
1. **A1: DeliveryCoordinator** — session-aware result routing
2. **A2: OverflowRecoveryTracker** — detect context overflow → compaction → retry
3. **C1: Foreign-aware ownership** — `abortOwned()` with foreign detection
4. **A4: Session resource cleanup** — `registerSessionResourceCleanup()` adapter

### Phase 10b: Discovery & Configuration (P1)
5. **B1: JSON config overrides** — `.pi/pi-crew.json` per-project settings
6. **B2: Thinking level propagation** — `thinking` frontmatter field
7. **D1: Compact read awareness** — self-contained agent prompts

### Phase 10c: Interactive Protocol (P2)
8. **A3: Interactive subagent** — `waiting` state + `crew_respond`/`crew_done` pattern
9. **C2: Supervisor contact event** — child→parent communication channel
10. **B3: Parent model inheritance** — simplified resolve chain

### Phase 10d: Polish & Compatibility (P2-P3)
11. **C3: Session-scoped status** — default filter to session
12. **D3: UI compact/expanded modes** — standalone pane usability
13. **E1-E3: Observability gaps** — overflow, waiting, foreign metrics
14. **D2: Pi 0.65+ API alignment** — programmatic session creation (when SDK available)

---

## 5. Key Code References

| Pattern | Source File | Lines |
|---|---|---|
| Compact read rendering | `pi-mono/packages/coding-agent/src/core/tools/read.ts` | `CompactReadClassification`, `formatCompactReadCall()` |
| Session resource cleanup | `pi-mono/packages/ai/src/session-resources.ts` | `registerSessionResourceCleanup()`, `cleanupSessionResources()` |
| Codex WS SSE fallback | `pi-mono/packages/ai/src/providers/openai-codex-responses.ts` | `isWebSocketSseFallbackActive()` |
| Chain directories | `pi-subagents/src/agents/agents.ts` | `getUserChainDir()`, `resolveNearestProjectChainDirs()` |
| Supervisor contact | `pi-subagents/src/runs/shared/supervisor-contact.ts` | `contact_supervisor` event |
| Thinking levels | `pi-subagents/src/agents/agents.ts` | frontmatter `thinking` field |
| Session scoping | `pi-subagents/src/runs/foreground/foreground-run-queue.ts` | session-scoped filtering |
| CrewRuntime singleton | `pi-crew-ref/extension/runtime/crew-runtime.ts` | Process-level singleton |
| DeliveryCoordinator | `pi-crew-ref/extension/runtime/delivery-coordinator.ts` | Owner-session routing |
| Ownership model | `pi-crew-ref/extension/integration/tools/crew-abort.ts` | `abortOwned()` |
| Interactive subagent | `pi-crew-ref/extension/runtime/subagent-state.ts` | `waiting` state |
| Overflow recovery | `pi-crew-ref/extension/runtime/overflow-recovery.ts` | `OverflowRecoveryTracker` |
| Bootstrap session | `pi-crew-ref/extension/bootstrap-session.ts` | Extension exclusion, parent model |