# Plan: pi-crew Optimization Opportunities

> Ngày: 2026-04-29 | Revised: 2026-04-29 (after design review)
> Based on: research-pi-coding-agent.md, research-extension-system.md, research-extension-examples.md

## Overview

Sau khi đọc sâu extension system của pi-mono và toàn bộ 60+ example extensions, dưới đây là
danh sách cơ hội tối ưu cho pi-crew, được phân loại theo effort và impact.

**Revision notes (2026-04-29):**
- Re-order Phase 1 để compliance-required task (permission gate) đi trước optimization task.
- Tách `terminate: true` thành 2 sub-task vì rủi ro UX khác nhau.
- Hạ "custom compaction model" từ Phase 2 xuống Phase 3 (risk vs ROI).
- Đổi cancel-compaction thành **defer + retry** (tránh context overflow).
- Threshold compaction động theo `contextWindow` thay vì hardcode 150k.
- Thêm rollback strategy ở cấp roadmap + gap research bổ sung.

## Priority Matrix

```
Impact
  ↑
  │  HIGH   │  HIGH   │
  │  Effort │  Effort │
  │  LOW    │  MEDIUM │
  │  ───────┼─────────│
  │  MEDIUM │  LOW    │
  │  Effort │  Effort │
  │  LOW    │  MEDIUM │
  └──────────────────→ Effort
```

## Implementation Status (2026-04-29)

Implemented in code:

- Phase 1.4 permission gate for destructive `team` tool calls.
- Phase 1.6 telemetry baseline fields for subagent completion (`turnCount`, `terminated`, `durationMs`).
- Phase 1.2 compaction guard as defer + retry, moved into `src/extension/registration/compaction-guard.ts`.
- Phase 1.1a `terminate: true` for background/queued subagent launches.
- Phase 1.3 public event bus events (`crew.subagent.completed`, `crew.run.completed`, `crew.run.failed`, `crew.run.cancelled`).
- Phase 1.5 auto session naming for new team runs when no custom session name exists.
- Phase 2.1 proactive compaction with dynamic context-window threshold.
- Phase 2.3 Pi session entries for run start/completion (`crew:run-started`, `crew:run-completed`).
- Phase 2.4 config-driven subagent tool aliases via `config.tools`.
- Phase 2.5 foreground working indicator, using optional API compatibility shim because older `pi-coding-agent` type surfaces may not expose `ctx.ui.setWorkingIndicator`.
- Phase 3.3 safe mailbox event bus publication (`crew.mailbox.message`, `crew.mailbox.acknowledged`).

Deferred by design:

- Phase 1.1b foreground `terminate: true` is implemented as opt-in via `config.tools.terminateOnForeground=true`; default remains safe/off pending telemetry.
- Phase 3.4 structured artifact index is implemented for pi-crew-triggered compactions via `crew:artifact-index` session entries plus compaction custom instructions. Direct `CompactionEntry.details` augmentation is not available through the current upstream extension API without replacing default compaction.
- Phase 3.1, 3.3b, 3.5, and 4.2 are now marked won't-do/research-only after deeper risk/ROI analysis.
- Phase 3.2 remains conditional on agent-level opt-in design. Phase 4.1 remains deferred pending format-compat research.

Validation:

- `npm run typecheck` passes.
- `npm test` passes: 283 unit tests + 26 integration tests.

## Roadmap-level Rollback Strategy

- **1 sub-task = 1 commit** có thể revert độc lập. KHÔNG gộp toàn bộ Phase 1 vào 1 commit.
- Mỗi commit phải có test riêng. Nếu fail trong production, `git revert <sha>` không kéo theo task khác.
- Phase 1.6 (telemetry) làm trước Phase 1.1 để có baseline đo lường.

---

## Phase 1: Quick Wins & Compliance (HIGH impact, LOW effort)

Thời gian ước tính: 2-3 sessions. **Thứ tự đã re-order so với research gốc.**

### 1.4 (FIRST) Permission gate cho destructive team actions

**Lý do làm trước:** AGENTS.md quy định *"Management deletes must require confirm: true; referenced
resources blocked unless force: true"* — đây là **rule bắt buộc**, không phải optimization.

**Files cần sửa:** `src/extension/registration/team-tool.ts` (hoặc file mới)

**Hiện tại:** Có check trong handler nhưng không có `tool_call` hook → message lỗi không nhất quán.

**Tối ưu:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "team") return;
  const input = event.input as Record<string, unknown>;
  const destructiveActions = ["delete", "forget", "prune", "cleanup"];

  if (destructiveActions.includes(input.action as string)) {
    if (!input.confirm && !input.force) {
      return {
        block: true,
        reason: `Destructive action '${input.action}' requires confirm=true (or force=true to bypass)`,
      };
    }
  }
});
```

**Note về precedence:** Nếu schema validate đã check `confirm`, **CHỌN 1 chỗ duy nhất**:
- Option A: Để schema validate → bỏ hook (đơn giản hơn).
- Option B: Để hook validate → gỡ check trong handler (consistent error message).

→ Đề nghị Option B vì hook gate tất cả entry points (kể cả nếu sau này có entry point bypass schema).

**Expected benefit:** Compliance với AGENTS.md, safety net production.

---

### 1.6 (NEW) Telemetry baseline cho terminate impact

**Lý do làm trước 1.1:** Plan gốc claim "giảm 30-50% LLM turns" — chỉ là phỏng đoán. Cần baseline đo lường thực tế.

**Files cần sửa:** `src/runtime/subagent-manager.ts`, `src/extension/register.ts`

**Tối ưu:** Log `turnCount` + `terminated: boolean` vào event `crew.subagent.completed`:
```typescript
pi.events.emit("crew.subagent.completed", {
  id: record.id,
  runId: record.runId,
  type: record.type,
  status: record.status,
  usage: record.usage,
  turnCount: record.turnCount,      // ← NEW
  terminated: record.terminated,    // ← NEW (false trước Phase 1.1)
  durationMs: record.durationMs,    // ← NEW
});
```

**Expected benefit:** Đo trước/sau Phase 1.1 để xác định ROI thực tế. Nếu < 10% turn saving, có thể quyết định không deploy 1.1b.

---

### 1.2 `session_before_compact` guard cho foreground runs (DEFER, không CANCEL)

**Files cần sửa:** `src/extension/register.ts`

**Hiện tại:** Không hook compaction → có thể compact giữa chừng foreground run.

**Tối ưu (revised):** Defer + retry thay vì cancel cứng (tránh context overflow):
```typescript
let pendingCompactReason: string | null = null;

pi.on("session_before_compact", async (event, ctx) => {
  if (foregroundControllers.size > 0) {
    pendingCompactReason = "deferred-during-foreground-run";
    ctx.ui.notify("Compaction deferred until foreground run completes", "info");
    return { cancel: true };
  }
});

// Retry sau khi run xong:
pi.on("turn_end", (_event, ctx) => {
  if (foregroundControllers.size === 0 && pendingCompactReason) {
    pendingCompactReason = null;
    ctx.compact({
      onComplete: () => ctx.ui.notify("Deferred compaction completed", "info"),
    });
  }
});
```

**Expected benefit:** Ngăn lỗi context mất mát trong foreground run, vẫn đảm bảo compact eventually chạy.

**Risk:** Nếu run cực dài + foregroundControllers chưa bao giờ về 0 → vẫn overflow. Mitigation: hard threshold (vd 95% context window) bypass deferral, force compact.

---

### 1.1a `terminate: true` cho **background queued** results (SAFE)

**Lý do tách:** Background queue không có UX risk, foreground completed có risk (xem 1.1b).

**Files cần sửa:** `src/extension/registration/subagent-tools.ts`

**Tối ưu:**
```typescript
// Agent tool — khi background: terminate ngay sau khi đã queued
if (params.run_in_background) {
  return {
    ...subagentToolResult(...),
    terminate: true,  // ← Tiết kiệm 1 LLM turn, không có rủi ro UX
  };
}
```

**Expected benefit:** Giảm LLM turn cho mọi background spawn. Verify bằng telemetry từ 1.6.

---

### 1.3 Public events qua `pi.events`

**Files cần sửa:** `src/extension/register.ts`

**Hiện tại:** Event bus chỉ dùng cho internal `subagent.stuck-blocked`.

**Naming convention (revised):** Thống nhất với upstream pattern `dot.kebab` (đã dùng cho `subagent.stuck-blocked`):
```typescript
// Document trong README là PUBLIC API:
pi.events.emit("crew.subagent.completed", { ... });
pi.events.emit("crew.run.completed", { runId, team, workflow, status, taskCount, totalUsage });
pi.events.emit("crew.run.failed", { runId, team, workflow, error, failedTaskId });
pi.events.emit("crew.run.cancelled", { runId, team, workflow, status, taskCount });
```

**Versioning:** Note trong README rằng event payload là semver-stable từ pi-crew 0.2.0.

**Expected benefit:** Extension khác (logging, notification, metrics) có thể subscribe.

---

### 1.5 Auto session name từ team run context

**Files cần sửa:** `src/extension/registration/team-tool.ts`

**Tối ưu:**
```typescript
// Trong team tool execute, trước khi start run:
pi.setSessionName(`pi-crew: ${team}/${workflow} — ${goal.slice(0, 60)}`);
```

**Expected benefit:** Better session organization khi xem session list.

---

### 1.1b (OPT-IN DONE, DEFAULT OFF) `terminate: true` cho **foreground completed** results

**Lý do default off:** UX risk — nếu LLM không có turn để summarize result, user có thể không hiểu output.

**Implementation:** opt-in flag, default safe:

```json
{
  "tools": {
    "terminateOnForeground": true
  }
}
```

When enabled, foreground `Agent`/`crew_agent` completed results set `terminate: true` and persist `record.terminated=true` for telemetry. Decision to make this default-on still requires telemetry evidence:

- Average turn count sau Agent foreground completion ≥ 2.
- Output đã đủ self-explanatory (đo qua user feedback hoặc retry rate).

---

## Phase 2: Medium Effort Optimizations

Thời gian ước tính: 2-3 sessions. (Đã giảm 1 task so với plan gốc.)

### 2.1 Proactive compaction monitoring (DYNAMIC threshold)

**Files cần sửa:** File mới `src/extension/registration/compaction-guard.ts`

**Hiện tại:** Chỉ dựa vào built-in auto-compaction (có thể chậm).

**Tối ưu (revised):** Threshold động theo `contextWindow`:
```typescript
export function registerCompactionGuard(pi: ExtensionAPI) {
  const TRIGGER_RATIO = 0.75;  // 75% context window → trigger

  pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const ctxWindow = ctx.model?.contextWindow ?? 200_000;
    const threshold = ctxWindow * TRIGGER_RATIO;

    if (usage?.tokens && usage.tokens > threshold) {
      // Foreground guard từ Phase 1.2 sẽ defer nếu cần
      ctx.compact({
        customInstructions: "Prioritize keeping team run state, task results, and artifact references. Keep the conversation context brief.",
        onComplete: () => ctx.ui.notify("Auto-compacted context during team run", "info"),
        onError: (err) => ctx.ui.notify(`Compaction failed: ${err.message}`, "error"),
      });
    }
  });
}
```

**Lý do dùng ratio thay vì hardcode:** Claude Haiku 200k, Gemini Pro 2M, GPT-4o 128k, model nhỏ 32k. Hardcode 150k sai cho 90% trường hợp.

**Expected benefit:** Tránh context overflow error khi foreground run quá dài.

---

### 2.3 `pi.appendEntry` cho cross-session run awareness

**Files cần sửa:** `src/extension/register.ts`

**Tối ưu:**
```typescript
// Khi bắt đầu run:
pi.appendEntry("crew:run-started", {
  runId, team, workflow, goal, timestamp: Date.now(),
});

// Khi hoàn thành run:
pi.appendEntry("crew:run-completed", {
  runId, status, taskCount, totalUsage, timestamp: Date.now(),
});
```

**Expected benefit:**
- Khi reload session, biết được các run liên quan.
- Session export bao gồm run context.
- Dễ dàng track history.

---

### 2.4 Config-driven tool registration

**Files cần sửa:** `src/extension/registration/subagent-tools.ts`

**Hiện tại:** Luôn register 6 tool variants (Agent, crew_agent, + result + steer).

**Tối ưu:**
```typescript
export function registerSubagentTools(pi: ExtensionAPI, subagentManager: SubagentManager) {
  const cfg = loadConfig(pi.getFlag("cwd") as string || process.cwd());

  // Conflict-safe tools (luôn register)
  pi.registerTool(crewAgentTool);
  pi.registerTool(crewAgentResultTool);

  // Claude-style aliases: only if not disabled
  if (cfg.config.tools?.enableClaudeStyleAliases !== false) {
    try { pi.registerTool(agentTool); } catch {}
    try { pi.registerTool(getSubagentResultTool); } catch {}
  }

  // Steer: only if supported
  if (cfg.config.tools?.enableSteer !== false) {
    try { pi.registerTool(crewAgentSteerTool); } catch {}
    try { pi.registerTool(steerSubagentTool); } catch {}
  }
}
```

**Expected benefit:** Tránh pollute tool namespace, fine-grained control cho user.

---

### 2.5 Custom working indicator trong foreground runs

**Files cần sửa:** `src/extension/register.ts`

**Tối ưu:**
```typescript
// Khi foreground run active:
ctx.ui.setWorkingIndicator({
  frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  intervalMs: 80,
});
ctx.ui.setWorkingMessage(
  `Team run: ${completedTasks}/${totalTasks} tasks done...`
);

// Khi kết thúc:
ctx.ui.setWorkingIndicator();   // Restore default
ctx.ui.setWorkingMessage();     // Clear
```

**Compat shim note:** Implementation dùng optional API compatibility shim:

```typescript
(ctx.ui as { setWorkingIndicator?: (...) => void }).setWorkingIndicator?.(...)
```

Lý do: một số version/type surface của `@mariozechner/pi-coding-agent` chưa expose
`setWorkingIndicator` trên `ExtensionUIContext`. Optional shim giữ backward compatibility và
tránh crash/runtime type mismatch; nếu API không tồn tại thì chỉ bỏ qua custom spinner và vẫn dùng
`setWorkingMessage()`.

**Expected benefit:** Better UX, cho user biết team run đang chạy.

---

## Phase 3: Future Considerations (HIGH effort hoặc Risky)

### 3.1 (WON'T DO unless concrete pain point appears) Branch-level task isolation

Dùng `ctx.fork()` để tạo branch mới cho mỗi task trong team run.

**Decision:** không triển khai mặc định. Worktree isolation đã giải quyết phần quan trọng nhất (file-system/task isolation). Branch-level isolation tạo branch explosion, navigation UX phức tạp, và state-sync risk giữa flat run manifest/tasks/events với Pi session tree. Chỉ reconsider nếu có user complaint cụ thể về context contamination không giải quyết được bằng worktree/dependency-context controls.

### 3.2 Session handoff cho long-running tasks

Khi 1 task quá dài, handoff sang session mới (pattern từ `handoff.ts`), isolate context.

**Conditional trigger:** chỉ enable cho agent/task opt-in, ví dụ agent frontmatter `handoff: true`, hoặc heuristic token estimate > 30% context window.

**Result transport:** child session trả về artifact reference hoặc mailbox message để parent session vẫn aggregate được kết quả mà không cần import toàn bộ transcript.

### 3.3 Mailbox qua `pi.events`

#### 3.3a (DONE) Publish mailbox lifecycle events while preserving file-backed mailbox

Implementation publishes safe public events without changing the durable mailbox source of truth:

```typescript
pi.events.emit("crew.mailbox.message", { runId, id, direction, from, to, taskId, source });
pi.events.emit("crew.mailbox.acknowledged", { runId, messageId, delivery });
```

This keeps file-backed mailbox semantics intact while enabling observers/notification extensions.

#### 3.3b (WON'T DO) Replace file-backed mailbox with pure event-bus mailbox

Thay vì file-based mailbox, dùng event bus làm transport chính cho real-time communication giữa tasks.

**Decision:** won't do. Latency gain is marginal; durability/restart/replay loss is catastrophic for long-running pi-crew runs. 3.3a gives best-of-both-worlds: durable file-backed mailbox remains source of truth, event bus is an observer/notification layer.

### 3.4 (PROMOTED + DONE) Compaction với structured artifact index

Preserve pi-crew artifact references across compaction.

**Implementation:** `compaction-guard.ts` collects recent run artifacts and:

- appends a structured `crew:artifact-index` session entry for machine-readable continuity;
- adds a markdown artifact index to pi-crew-triggered compaction `customInstructions` so the compaction summary preserves run IDs and artifact paths.

**Note:** Directly augmenting `CompactionEntry.details` is not supported by the current upstream `session_before_compact` result contract unless pi-crew replaces default compaction entirely. We intentionally avoid full custom compaction because summary quality/regression risk is higher.

### 3.5 (WON'T DO unless cost telemetry shows pain) Custom compaction với model nhẹ

**Decision:** won't do by default.

- Phụ thuộc vào auth setup của user cho Gemini Flash / Haiku — pi-crew không kiểm soát được.
- Bad summary làm mất context → ảnh hưởng cả run.
- ROI không rõ: compaction chạy không thường xuyên.

Reconsider only if telemetry/user feedback shows compaction cost is a real pain point. Reference remains `examples/extensions/custom-compaction.ts` upstream.

---

## Phase 4 (NEW): Research bổ sung

Hai pattern upstream chưa được khai thác trong plan gốc:

### 4.1 (DEFER — research format compat first) `resources_discover` event integration

Pi-crew có thể inject builtin agents/teams như Pi resources native (skills/prompts):
```typescript
pi.on("resources_discover", () => ({
  skillPaths: [path.join(__dirname, "..", "agents")],
  promptPaths: [path.join(__dirname, "..", "workflows")],
}));
```

**Decision:** defer. Cần research format compat giữa pi-crew agent markdown vs Pi skill/prompt format trước khi implement. Key risk: dual exposure UX confusion (same capability reachable via `Agent` tool and native skill/prompt) plus loss of pi-crew durable run semantics if exposed as stateless skills.

### 4.2 (RESEARCH-ONLY) `pi.registerProvider` cho virtual "team" model

Đăng ký team như virtual provider để user gọi:
```bash
pi --model crew/researcher
```
Thay vì dùng tool `Agent`.

**Decision:** research-only / not an implementation target. Provider API semantics (single LLM stream, context window, thinking levels, token pricing) do not map cleanly to orchestrator semantics (multi-agent task events, aggregate usage/cost, per-worker contexts). Likely requires upstream provider API changes.

---

## Implementation Order (REVISED)

```
Phase 1 (Quick Wins & Compliance):
  [x] 1.4 permission gate destructive team actions  ← FIRST (compliance)
  [x] 1.6 telemetry baseline                        ← SECOND (measure first)
  [x] 1.2 session_before_compact defer (not cancel)
  [x] 1.1a terminate: true on background queued (safe)
  [x] 1.3 public crew.* events
  [x] 1.5 auto session name
  [x] 1.1b terminate: true on foreground (OPT-IN, default off; default-on conditional on telemetry)

Phase 2 (Medium):
  [x] 2.1 proactive compaction (dynamic threshold)
  [x] 2.3 pi.appendEntry cross-session awareness
  [x] 2.4 config-driven tool registration
  [x] 2.5 custom working indicator

Phase 3 (Future / Risky):
  [-] 3.1 branch-level task isolation (WON'T DO unless concrete pain point appears)
  [ ] 3.2 session handoff for long tasks (CONDITIONAL on agent opt-in)
  [x] 3.3a publish mailbox lifecycle events (safe subset)
  [-] 3.3b replace file-backed mailbox with pure event bus (WON'T DO)
  [x] 3.4 structured artifact index in compaction (promoted/done)
  [-] 3.5 custom compaction with cheap model (WON'T DO unless cost telemetry shows pain)

Phase 4 (Research):
  [ ] 4.1 resources_discover integration (DEFER; format compat research first)
  [-] 4.2 virtual team provider (RESEARCH-ONLY)
```

## Files affected

```
PHASE 1:
  src/extension/registration/team-tool.ts         ← 1.4 permission gate
  src/extension/registration/subagent-tools.ts    ← 1.1a terminate + 1.1b opt-in terminate
  src/extension/register.ts                       ← 1.2 defer guard, 1.3 events, 1.5 session name
  src/runtime/subagent-manager.ts                 ← 1.6 telemetry fields

PHASE 2:
  src/extension/registration/compaction-guard.ts  ← NEW: 1.2 defer guard + 2.1 proactive + 3.4 artifact index
  src/extension/register.ts                       ← 2.3 appendEntry, 2.5 working indicator
  src/extension/registration/subagent-tools.ts    ← 2.4 config-driven

PHASE 3:
  src/extension/team-tool/api.ts                  ← 3.3a mailbox lifecycle events
```

## Risk Assessment (REVISED)

| Change | Risk | Mitigation |
|---|---|---|
| Permission gate (1.4) | Block legitimate use | Allow `force=true` bypass, document trong README |
| Telemetry (1.6) | Privacy / log size | No PII in subagent telemetry payload; opt-out applied via `config.telemetry.enabled=false`; no sampling currently because payload is small/local event-bus data |
| Defer compaction (1.2) | Run dài infinite → overflow | Hard threshold 95% bypass deferral |
| `terminate: true` background (1.1a) | None significant | Background không cần LLM follow-up by design |
| Public events (1.3) | Event storm, breaking change | Rate limit, semver document |
| Auto session name (1.5) | Override user-set name | Applied: chỉ set nếu chưa có name custom (`!pi.getSessionName()`) |
| `terminate: true` foreground (1.1b) | LLM không summarize khi enabled | OPT-IN flag (`config.tools.terminateOnForeground`, default off); default-on requires telemetry evidence |
| Dynamic threshold (2.1) | contextWindow undefined | Default 200_000 fallback |
| Artifact index in compaction (3.4) | Index size bloat / format drift | Cap recent index (10 runs / 80 artifacts), structured `crew:artifact-index` session entry, non-replacing default compaction |
| appendEntry (2.3) | Session bloat | TTL/cleanup strategy |
| Config-driven tools (2.4) | User confused | Default = current behavior, opt-in change |
| Working indicator (2.5) | Conflict với extension khác / older Pi UI type surface | Applied: restore default on finally; compat shim makes `setWorkingIndicator` optional |
| Custom compaction model (3.5) | Bad summary, auth missing | Fall back to default, multi-model retry |

## Testing Strategy

- **Unit tests:**
  - `terminate: true` flag in tool results (1.1a/b).
  - Permission gate blocks/allows correctly với confirm/force matrix (1.4).
  - Threshold calculation từ contextWindow (2.1).
  - Telemetry payload schema (1.6).
  - Artifact index payload structure + cap behavior (3.4).
- **Integration tests:**
  - Foreground run + compaction interaction (1.2 defer + 2.1 trigger).
  - Multiple concurrent runs + permission gate (1.4).
  - Event publish/subscribe round-trip (1.3).
  - Compaction with N artifacts includes artifact index in custom instructions (3.4).
- **Manual:**
  - UI behavior với working indicator + session name (1.5, 2.5).
  - Real LLM turn count trước/sau 1.1b với telemetry data (1.6 → 1.1b decision).
- **Regression:**
  - Run full suite (`npm test`) sau mỗi commit, không gộp Phase.
  - Doctor tests phải dùng `--test-timeout=90000` trên Windows.
