# Phase 10+ Deep Distillation — Round 2

**Date**: 2026-05-04
**Sources**: `pi-mono` v0.72.1 (`324aa1d`), `pi-subagents` v0.24.0 (`3ee17de`), `pi-crew` ref v1.0.14 (`c0631a3`)

## Executive Summary

Sau khi deep-read lần 2 vào runtime internals của cả 3 repos, phát hiện **15 insights mới** chưa được implement trong pi-crew. Phân thành 4 axes: Runtime Architecture, Extension API Adoption, Observability/Reliability, và Developer Experience.

---

## Axis F: Runtime Architecture Alignment

### F1. Process-Level Singleton for CrewRuntime ⭐⭐⭐
**Source**: pi-crew ref `crew-runtime.ts`
**Finding**: Module-level singleton (`export const crewRuntime = new CrewRuntime()`) sống xuyên suốt process lifetime. Khi Pi thay extension instance (session switch), singleton vẫn tồn tại vì Node.js module cache. New extension instance chỉ cần gọi `crewRuntime.activateSession(binding)`.
**Current pi-crew**: Mỗi session tạo mới state. Chưa có survive-across-session mechanism.
**Action**: Refactor `SubagentManager` thành process-level singleton với `activateSession()` pattern. In-flight child processes survive session switches.

### F2. Fire-and-Forget Spawn với Immediate ID Return ⭐⭐⭐
**Source**: pi-crew ref `crew-runtime.ts`
**Finding**: `spawn()` tạo state → return ID ngay lập tức → chạy `spawnSession()` async (fire-and-forget). Caller không block.
**Current pi-crew**: `runChildPi` là async block. Task runner phải await.
**Action**: Tách spawn thành sync ID allocation + async execution. Task runner fire-and-forget, poll status qua event log.

### F3. Final Drain Window Pattern ⭐⭐
**Source**: pi-subagents `execution.ts`
**Finding**: Khi `message_end` với `stopReason === "stop"` và không có tool calls → start 1s grace timer → SIGTERM → 3s → SIGKILL. Giúp child process flush output cuối cùng.
**Current pi-crew**: Child Pi timeout đơn giản, không có grace period sau completion signal.
**Action**: Implement `FINAL_STOP_GRACE_MS` drain window trong `child-pi.ts`.

### F4. Atomic JSON Writes cho Status Persistence ⭐⭐
**Source**: pi-subagents `async-execution.ts`
**Finding**: `writeAtomicJson()` ghi file temp → rename. Tránh torn writes khi process crash giữa chừng.
**Current pi-crew**: `JSON.stringify` + `writeFileSync` trực tiếp — rủi ro torn write.
**Action**: Implement `writeAtomicJson()` utility. Apply cho status.json, manifest writes.

### F5. Two-Level Process Hierarchy cho Async ⭐
**Source**: pi-subagents `subagent-runner.ts`
**Finding**: Orchestrator spawn runner (detached) → runner spawn Pi children. Runner track PIDs, write status.json. Orchestrator poll status.json.
**Current pi-crew**: Async run chỉ fire background, không có intermediate runner process.
**Action**: (Low priority) Xem xét thêm intermediate runner cho reliable async tracking.

### F6. Stale Run Reconciler — Three-Phase Pattern ⭐⭐
**Source**: pi-subagents `stale-run-reconciler.ts`
**Finding**: 3-phase: (1) check result file exists → use it, (2) check PID liveness, (3) for dead PIDs → repair immediately, for alive PIDs → fail only if stale > 24h.
**Current pi-crew**: Có `crash-recovery.ts` nhưng chưa có full 3-phase reconciliation.
**Action**: Nâng cấp crash recovery với 3-phase pattern: result-check → PID-check → stale-threshold.

---

## Axis G: Extension API Adoption

### G1. `session_before_compact` Hook — Custom Compaction ⭐⭐⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: Hook `session_before_compact` returns `{ cancel?, compaction?: CompactionResult }`. Extensions có thể **thay thế hoàn toàn** compaction logic — bao gồm structured details (artifact indices, version markers). Đây là extensibility point mạnh nhất.
**Current pi-crew**: `compaction-guard.ts` chỉ phát hiện compaction events, không can thiệp.
**Action**: Implement `session_before_compact` handler để cung cấp structured compaction thay vì raw text summarization. Preserve team run state across compaction.

### G2. `session_before_switch` Hook — Pre-Switch State Save ⭐⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: `session_before_switch` fires trước khi Pi switches session (new/resume). Return `{ cancel? }`. Pi-crew có thể save in-memory state → file trước khi switch.
**Current pi-crew**: Không hook vào session switch. State mất khi switch.
**Action**: Hook `session_before_switch` để flush pending deliveries và save subagent state snapshot.

### G3. `resources_discover` Hook — Dynamic Agent/Team Discovery ⭐⭐⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: `resources_discover` event returns `{ additionalSkillPaths?, additionalPromptPaths?, additionalThemePaths? }`. Extensions có thể dynamically inject resources.
**Current pi-crew**: Discovery chỉ đọc từ filesystem. Không dynamic.
**Action**: Hook `resources_discover` để inject team-specific skills/prompts dựa trên config. VD: auto-inject `safe-bash` skill cho projects có `package.json`.

### G4. `before_agent_start` — System Prompt Override ⭐⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: Can inject `message` and/or override `systemPrompt` before agent loop begins. Powerful for child agents.
**Current pi-crew**: Child Pi system prompt built từ task packet, không override qua hook.
**Action**: (Low priority — already handled via task packet prompt builder)

### G5. `tool_result` Event — Post-Execution Output Modification ⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: Can modify tool output `content`, `details`, `isError` after execution. Useful for enrichment/filtering.
**Current pi-crew**: Không hook vào tool results.
**Action**: Hook `tool_result` cho `team` tool để enrich output với structured metadata (run URL, artifact count, duration).

### G6. `input` Event — User Input Interception ⭐
**Source**: pi-mono `extensions/types.ts`
**Finding**: Can transform user input text/images or fully handle it (`action: "continue" | "transform" | "handled"`).
**Current pi-crew**: Không intercept user input.
**Action**: Hook `input` để detect `@team-name` mentions → auto-route to team run.

---

## Axis H: Observability & Reliability Gaps

### H1. Completion Mutation Guard ⭐⭐
**Source**: pi-subagents `completion-guard.ts`
**Finding**: Sau khi subagent trả về "success", check xem nếu task là "implementation" nhưng **không có file edits** → mutate completion thành warning. Tránh false-positive completions.
**Current pi-crew**: Task complete khi child Pi exits 0. Không verify actual work done.
**Action**: Implement completion guard: verify artifacts exist, files changed, hoặc output non-trivial.

### H2. Snapshot-Before-Emit Pattern ⭐
**Source**: pi-subagents `execution.ts`
**Finding**: Progress object snapshotted (spread) trước mỗi `onUpdate` callback. Tránh mutation during callback.
**Current pi-crew**: Task state mutated directly, events emit references.
**Action**: Snapshot task state trước khi emit events để avoid race conditions.

### H3. Intercom Bridge với Delivery Confirmation ⭐⭐
**Source**: pi-subagents `intercom-bridge.ts`
**Finding**: Bidirectional intercom: `deliverSubagentResultIntercomEvent()` emit event → wait for confirmation với 500ms timeout. Agent injection pattern: mutate config để add `contact_supervisor` tool + instructions.
**Current pi-crew**: Có `supervisor-contact.ts` parse từ stdout, nhưng không có bidirectional confirmation.
**Action**: Nếu Pi expose intercom API, upgrade supervisor contact thành bidirectional với delivery confirmation.

### H4. writeAtomicJson Utility ⭐⭐
**Source**: pi-subagents (pervasive)
**Finding**: Atomic file writes used everywhere: status, manifest, results. Pattern: `writeFileSync(path + ".tmp", data) → renameSync(path + ".tmp", path)`.
**Action**: Shared utility trong `src/utils/atomic-write.ts`.

---

## Axis I: Developer Experience

### I1. Tool Presentation — Emoji + Grouping ⭐
**Source**: pi-crew ref `tool-presentation.ts`
**Finding**: `crew_spawn` renders "🚀 Spawning {agent}...", `crew_respond` renders "💬 Sending response...". Grouped tool calls have custom collapse UI.
**Current pi-crew**: Tool output plain text.
**Action**: Add emoji prefixes và structured formatting cho tool output.

### I2. renderCall/renderResult cho Team Tool ⭐⭐
**Source**: pi-mono `tools/index.ts`
**Finding**: `ToolDefinition` supports `renderCall` và `renderResult` callbacks returning TUI Components. Allows rich rendering in Pi terminal UI.
**Current pi-crew**: Không có custom renderers.
**Action**: Implement `renderCall` cho `team` tool để show spinner/agent-list thay vì raw JSON. Implement `renderResult` để show summary dashboard.

### I3. Prompt Snippet + Guidelines trong Tool Definition ⭐
**Source**: pi-mono `tools/index.ts`
**Finding**: `promptSnippet` — one-liner in system prompt. `promptGuidelines` — bullets appended to system prompt. Tools without `promptSnippet` are excluded from LLM awareness.
**Current pi-crew**: Tool description chỉ trong JSON schema description.
**Action**: Khi Pi hỗ trợ `promptSnippet`/`promptGuidelines` trong custom tools, adopt để improve LLM tool usage.

---

## Priority Matrix

| ID | Feature | Impact | Effort | Priority |
|---|---|---|---|---|
| F1 | Process-level singleton | High | High | P1 |
| F2 | Fire-and-forget spawn | Medium | Medium | P2 |
| F3 | Final drain window | Medium | Low | P2 |
| F4 | Atomic JSON writes | High | Low | P1 |
| F5 | Two-level async hierarchy | Low | High | P3 |
| F6 | 3-phase stale reconciliation | Medium | Medium | P2 |
| G1 | Custom compaction hook | High | Medium | P1 |
| G2 | Pre-switch state save | Medium | Low | P2 |
| G3 | Dynamic resource discovery | High | Medium | P1 |
| G4 | System prompt override | Low | Low | P3 |
| G5 | Post-execution output mod | Low | Low | P3 |
| G6 | User input interception | Medium | Medium | P3 |
| H1 | Completion mutation guard | High | Low | P1 |
| H2 | Snapshot-before-emit | Medium | Low | P2 |
| H3 | Bidirectional intercom | Medium | High | P3 |
| H4 | writeAtomicJson utility | High | Low | P1 |
| I1 | Tool presentation emojis | Low | Low | P3 |
| I2 | Custom TUI renderers | High | High | P2 (when API available) |
| I3 | Prompt snippet/guidelines | Medium | Low | P3 (when API available) |

---

## Recommended Implementation Order

### Phase 11a: Reliability Foundations (F4 + H4 + H1 + H2)
- `src/utils/atomic-write.ts` — writeAtomicJson utility
- Apply atomic writes to all manifest/state writes
- Completion mutation guard for task results
- Snapshot-before-emit for task state events

### Phase 11b: Extension API Hooks (G1 + G2 + G3)
- `session_before_compact` handler — structured compaction
- `session_before_switch` handler — pre-switch state flush
- `resources_discover` handler — dynamic skill/prompt injection

### Phase 11c: Runtime Architecture (F1 + F2 + F3)
- Refactor SubagentManager → process-level singleton
- Fire-and-forget spawn pattern
- Final drain window for child process cleanup

### Phase 11d: Reconciliation & Recovery (F6 + H3)
- 3-phase stale run reconciliation
- Upgrade supervisor contact toward bidirectional (if API available)

---

## Already Implemented (Phase 10a-10d) ✅
- DeliveryCoordinator (session-aware routing with queue/flush)
- OverflowRecoveryTracker (compaction → retry state machine)
- Foreign-aware cancel (ownership detection)
- Session resource cleanup adapter
- Interactive subagent waiting state + respond action
- Supervisor contact parsing from child stdout
- Parent model inheritance
- Session-scoped run listing
- Observability metrics for overflow/waiting/supervisor
- Skills override + .pi/pi-crew.json config path
