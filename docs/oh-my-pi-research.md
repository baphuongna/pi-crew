# Research: oh-my-pi v15.0.0 — Tính năng có thể áp dụng vào pi-crew

> Date: 2026-05-13
> Source: `D:/my/my_project/source/oh-my-pi` (v15.0.0)
> Purpose: Tìm features có thể port vào pi-crew

---

## 1. Feature: Hashline Engine (`hashline/`)

### Mục đích
Thay thế hoàn toàn hashline cũ bằng engine mới hỗ trợ:
- Line-level content addressing (hash mỗi dòng)
- Semantic anchors (không chỉ line number mà hash content)
- Recovery mode (phục hồi từ crash)
- Conflict resolution (3-way merge)
- Streaming diff output

### Cách hoạt động

**Core types** (`hashline/types.ts`):
```typescript
export type Anchor = { line: number; hash: string; contentHint?: string };
export type HashlineCursor =
  | { kind: "bof" }
  | { kind: "eof" }
  | { kind: "before_anchor"; anchor: Anchor }
  | { kind: "after_anchor"; anchor: Anchor };
export type HashlineEdit =
  | { kind: "insert"; cursor: HashlineCursor; text: string; lineNum: number; index: number }
  | { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };
```

**Key modules:**
- `hash.ts` (694→) — Line hashing với bigram index
- `parser.ts` (192 lines) — Parse hashline input
- `apply.ts` (716 lines) — Apply edits với validation
- `recovery.ts` (72 lines) — Recovery từ crash state
- `execute.ts` (267 lines) — Execute hashline commands
- `diff.ts` / `diff-preview.ts` — Streaming diff

### Potential apply cho pi-crew

**Option A — Dùng trực tiếp (nếu oh-my-pi tách hashline thành package riêng):**
- Pi-crew cần edit files trong worktree
- Hashline engine có thể giúp detect conflicts khi nhiều agents edit cùng file

**Option B — Conflict detection (đã có `conflict-detect.ts` rồi):**
- Xem feature tiếp theo

**Effort: HIGH** — hashline strongly coupled với oh-my-pi internals (ToolSession, LSP batch request, etc.)

### Risk/Dependency
- Requires oh-my-pi package hoặc fork lại
- Strong dependency on oh-my-pi tool execution model

---

## 2. Feature: Conflict Detection & Resolution (`conflict-detect.ts`)

### Mục đích
Detect git merge conflicts (<<<<<<, =======, >>>>>>>) trong file content mà không cần extra I/O. Mỗi conflict block được assign stable id, agent có thể resolve bằng cách write vào `conflict://<id>`.

### Cách hoạt động

```typescript
export interface ConflictBlock {
  startLine: number;      // 1-indexed line of <<<<<<<
  separatorLine: number;  // 1-indexed line of =======
  endLine: number;        // 1-indexed line of >>>>>>>
  baseLine?: number;      // 1-indexed line of ||||||| (diff3 only)
  oursLabel?: string;
  baseLabel?: string;
  theirsLabel?: string;
  oursLines: string[];
  baseLines?: string[];
  theirsLines: string[];
}

// scanConflictLines: scan array of lines (no extra I/O)
// registerConflict: assign stable id via ConflictHistory
// resolveConflict: write chosen content via conflict://<id>
```

**Workflow:**
1. `read` collects lines từ disk
2. `scanConflictLines` inspects cho `<<<<<<<` / `=======` / `>>>>>>>` markers
3. Each completed block → `ConflictHistory` (stable id)
4. Read output trả về kèm footer với conflict ids
5. Agent gọi `write({ path: "conflict://<id>", content })` để resolve

**Key insight:** Marker shape phải strict — column-0, exact prefix length, followed by EOL or single space + label.

### Potential apply cho pi-crew

**HIGH VALUE cho pi-crew:**
- Khi nhiều agents edit cùng file trong worktree, có thể xảy ra conflicts
- Conflict detection giúp agent nhận biết và resolve tự động

**Implementation approach:**
1. Fork `conflict-detect.ts` (license OK — MIT)
2. Integrate vào pi-crew's file read path
3. Register conflicts vào `LiveAgentHandle.activity` hoặc artifact store
4. Provide `conflict://` protocol trong write tool
5. Add `detect-conflicts` tool cho agents

**Effort: MEDIUM** — standalone module, có thể copy + adapt

### Risk/Dependency
- Cần xử lý `conflict://` protocol trong write tool
- Cần update read tool để detect và report conflicts

---

## 3. Feature: ACP Client Bridge (`acp-client-bridge.ts`)

### Mục đích
Bridge giữa oh-my-pi internal ClientBridge interface và ACP (Agent Client Protocol) SDK. Cho phép tools (read/write/bash/edit) route qua client khi client có capabilities.

### Cách hoạt động

```typescript
export interface ClientBridgeCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
  requestPermission: boolean;
}

export interface ClientBridge {
  capabilities: ClientBridgeCapabilities;
  readTextFile?: (params: { path: string; line?: number; limit?: number }) => Promise<string>;
  writeTextFile?: (params: { path: string; content: string }) => Promise<void>;
  terminal?: (params: ClientBridgeCreateTerminalParams) => Promise<ClientBridgeTerminalHandle>;
  requestPermission?: (params: ClientBridgePermissionToolCall) => Promise<ClientBridgePermissionOutcome>;
}
```

**Pattern:** Feature detection → conditional implementation. Nếu client không có capability thì fallback sang default implementation.

### Potential apply cho pi-crew

**LOW-MEDIUM VALUE:**

pi-crew đã có `LiveExtensionBridge` và `LiveAgentControl` — không cần ACP bridge. Tuy nhiên, pattern này hữu ích cho:

1. **pi-crew tool permission system** — Có thể dùng pattern này để check permission trước khi cho phép tool execution
2. **Cross-extension communication** — `ClientBridge` pattern có thể adapt cho `CrossExtensionRPC`

**Effort: LOW** — chỉ cần học pattern, không cần port code

### Risk/Dependency
- ACP SDK là proprietary (`@agentclientprotocol/sdk`)
- Pattern có thể apply không cần SDK

---

## 4. Feature: Todo Helper (`todo.ts`)

### Mục đích
Slash command helper cho phép agents quản lý todo list trong project. Hỗ trợ subcommands: `done`, `drop`, `rm`, và parsing markdown todo format.

### Cách hoạt động

**Tokenize approach:**
```typescript
// Handle escape sequences, quoted strings, whitespace
function tokenize(input: string): string[] {
  let current = "";
  let inQuote = false;
  // ... parsing logic
}

// Subcommands:
// /todo done <phase> <task> — mark task done
// /todo drop <phase> <task> — remove task
// /todo rm <phase> <task> — alias for drop
```

**Markdown ↔ Phases conversion:**
- `markdownToPhases` — Parse markdown todo format
- `phasesToMarkdown` — Convert back to markdown
- `getLatestTodoPhasesFromEntries` — Get latest version

**Tokenize features:**
- Quoted strings: `"task with spaces"`
- Escape sequences: `\<char>`
- Whitespace splitting

### Potential apply cho pi-crew

**HIGH VALUE cho pi-crew:**

pi-crew có `YieldReminder` và `TaskRunner` — có thể tích hợp todo management:

1. **Team task tracking** — Workflow tasks có thể represented as todos
2. **Yield + Todo integration** — Khi agent yields với todo request, có thể parse và update todo list
3. **Slash command `/crew todo`** — Management interface cho team tasks

**Implementation approach:**
1. Fork `todo.ts` helper (279 lines)
2. Integrate vào `CrewTaskRunner` hoặc `YieldHandler`
3. Add `/crew todo` slash command
4. Wire vào `TaskDisplay` component

**Effort: MEDIUM** — có thể copy module, cần integrate với existing task system

### Risk/Dependency
- Dependency on `todo-write.ts` tool
- Cần sync với actual task state trong manifest

---

## 5. Feature: Compaction Error Types (`compaction/errors.ts`)

### Mục đích
Typed error sentinels cho compaction operations. Dùng `instanceof` discrimination thay vì string matching.

### Cách hoạt động

```typescript
export class CompactionCancelledError extends Error {
  readonly name = "CompactionCancelledError" as const;
  constructor(message = "Compaction cancelled") { super(message); }
}

export type CompactionOutcome = "ok" | "cancelled" | "failed";
```

**Pattern:**
- Sentinel class với `name` property readonly
- Downstream callers dùng `instanceof CompactionCancelledError`
- Source-agnostic: Esc, extension hook, programmatic abort đều cùng type

### Potential apply cho pi-crew

**MEDIUM VALUE cho pi-crew:**

pi-crew có `YieldResult` và compaction tracking — có thể dùng pattern này:

1. **Typed cancellation errors** — `CrewCancelledError`, `CrewTimeoutError`, `CrewDeadletterError`
2. **Better error discrimination** — Thay vì string matching, dùng `instanceof`
3. **Error outcome tracking** — `CrewRunOutcome = "ok" | "cancelled" | "failed" | "deadletter"`

**Implementation approach:**
```typescript
// src/errors/crew-errors.ts
export class CrewCancelledError extends Error {
  readonly name = "CrewCancelledError" as const;
}

export class CrewTimeoutError extends Error {
  readonly name = "CrewTimeoutError" as const;
}

export class CrewDeadletterError extends Error {
  readonly name = "CrewDeadletterError" as const;
  constructor(public readonly agentId: string, public readonly reason: string) {
    super(`Agent ${agentId} deadlettered: ${reason}`);
  }
}
```

**Effort: LOW** — chỉ cần create error classes và replace `instanceof Error` checks

### Risk/Dependency
- None — pure TypeScript, có thể copy pattern
- Cần audit existing error handling để update

---

## 6. Feature: ACP Agent Session (`acp-agent.ts`)

### Mục đích
ACP protocol handler trong oh-my-pi. Mở rộng từ `agent-session.ts` với:
- Fork sessions (clone session state)
- Session list/load/resume
- Model state management
- MCP server discovery

### Cách hoạt động

**ACP Protocol types:**
```typescript
type NewSessionRequest, ForkSessionRequest, LoadSessionRequest, ResumeSessionRequest
type SetSessionModelRequest, SetSessionModeRequest
type SessionInfo, SessionModelState, SessionModeState
type ClientCapabilities (fs, terminal, permission)
```

**Key capabilities:**
- `forkSession` — Clone session với same conversation history
- `listSessions` — Enumerate active sessions
- `loadSession` / `resumeSession` — Restore previous session
- `setSessionModel` — Change model mid-session

### Potential apply cho pi-crew

**HIGH VALUE cho pi-crew:**

1. **Fork session** — Trong workflow orchestration, có thể fork một agent session để chạy parallel experiments
2. **Session resume** — Resume a previous run từ manifest/events
3. **Model switching** — Change model for specific tasks (e.g., cheap model for exploration, expensive model for final generation)

**Current pi-crew state:**
- pi-crew đã có `ResumeSession` cho team runs (re-spawn child Pi)
- Nhưng không có in-process session fork

**Implementation approach:**
- `forkLiveAgentSession()` — Clone `LiveAgentHandle` với same conversation
- Store forked sessions trong `live-agent-manager.ts`
- Add `fork-session` operation vào `team-tool api`

**Effort: HIGH** — cần deep understanding của `LiveSessionHandle` và session state

### Risk/Dependency
- Requires oh-my-pi internals (AgentSession, ToolSession)
- pi-crew dùng child Pi process — fork có thể không tương thích

---

## 7. Feature: User Metrics (`stats/src/user-metrics.ts`)

### Mục đích
Tracking và aggregation của user behavior metrics: edits, tools usage, model selection, cost, session quality.

### Cách hoạt động

**Database schema:**
- Sessions table: session_id, start_time, end_time, model, cost
- Tool usage: session_id, tool_name, count, duration
- Edit patterns: session_id, lines_added, lines_removed, files_changed
- Behavior models: quality score, efficiency score

**Analytics:**
- Behavior chart: edits over time, tool usage distribution
- Model comparison: cost vs quality per model
- Session summary: duration, token usage, task completion rate

### Potential apply cho pi-crew

**MEDIUM VALUE:**

pi-crew đã có `UsageTracker` và `MetricsRegistry` — có thể học:

1. **Team metrics** — Track team run performance (workflow duration, agent utilization, cost)
2. **Agent quality scoring** — Rate agent output quality
3. **Cost tracking** — Per-agent, per-task, per-team cost

**Effort: MEDIUM** — Cần design database schema và API

### Risk/Dependency
- SQLite hoặc separate database
- Privacy implications (storing user behavior data)

---

## 8. Feature: Shell Minimizer (`crates/pi-shell/src/minimizer/`)

### Mục đích
Tự động minimize command output (loại bỏ noise như progress bars, ANSI codes) để LLM đọc được kết quả clean hơn.

### Cách hoạt động

**100+ TOML config files:**
- `cargo.toml` — Filter cargo progress output
- `npm-install.toml` — Filter npm package output
- `terraform-plan.toml` — Simplify terraform plans
- etc.

**Engine:**
```rust
// minimizer/engine.rs
pub struct Minimizer {
    filters: Vec<Box<dyn Filter>>,
}

// Filter types: line removal, replacement, truncation
```

### Potential apply cho pi-crew

**HIGH VALUE cho pi-crew:**

pi-crew agents chạy bash commands — output có thể rất noisy. Minimizer giúp:
- Agent đọc được clean output
- Giảm context usage
- Tập trung vào important information

**Implementation approach:**
1. Fork minimizer engine (Rust) hoặc port sang TypeScript
2. Integrate vào `TaskRunner` bash execution
3. Auto-detect command type và apply appropriate filter

**Effort: HIGH** — Rust code cần rewrite hoặc integration via FFI

### Risk/Dependency
- Rust dependency
- May not be necessary nếu oh-my-pi tách thành standalone tool

---

## 9. Feature: MCP Helper (`slash-commands/helpers/mcp.ts`)

### Mục đích
Helper cho MCP (Model Context Protocol) slash commands. Quản lý MCP server configuration và tool invocation.

### Cách hoạt động

532 lines TypeScript. **Key functions:**
- `resolveMcpServer` — Resolve MCP server config
- `invokeMcpTool` — Call MCP tool
- `listMcpResources` — List available resources
- `mcpServerStatus` — Check server health

### Potential apply cho pi-crew

**MEDIUM VALUE:**

pi-crew đã có `McpProxy` trong `live-extension-bridge.ts` — có thể học thêm:
1. **MCP server lifecycle** — Start/stop MCP servers per team
2. **MCP tool routing** — Route MCP calls qua team session

**Effort: LOW** — chỉ cần học pattern, không cần port code

### Risk/Dependency
- MCP protocol knowledge required
- Có thể reuse existing `buildMcpProxyFromSession`

---

## 10. Feature: Issue-PR Protocol (`internal-urls/issue-pr-protocol.ts`)

### Mục đích
Protocol handler cho `issue://` và `pr://` internal URLs. Cho phép agents interact với GitHub/GitLab issues và PRs qua unified interface.

### Cách hoạt động

```typescript
// Handle URLs like:
// issue://github.com/owner/repo/123
// pr://github.com/owner/repo/456
// issue://gitlab.com/owner/repo/789
```

**Operations:**
- `read` — Get issue/PR content
- `search` — Search issues/PRs
- `comment` — Add comment
- `close` / `reopen` — State transitions

### Potential apply cho pi-crew

**HIGH VALUE cho pi-crew:**

pi-crew workflow agents có thể benefit từ issue/PR integration:
1. **Task creation** — Create issue từ failed task
2. **PR review** — Use `pr://` protocol trong review workflow
3. **Task linking** — Link workflow tasks to issues

**Effort: MEDIUM** — Cần port `issue-pr-protocol.ts` (577 lines)

### Risk/Dependency
- GitHub API authentication
- Complex state machine (open/close/reopen/merge)

---

## Summary: Recommendations

### Tier 1 — High Value, Medium Effort (Ưu tiên cao)

| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Conflict Detection** | Prevents data loss khi multiple agents edit same file | MEDIUM | Fork `conflict-detect.ts`, add `conflict://` protocol |
| **Typed Crew Errors** | Better error handling, cleaner code | LOW | Create `CrewCancelledError`, `CrewTimeoutError`, `CrewDeadletterError` |
| **Todo Integration** | Task tracking cho team workflows | MEDIUM | Fork `todo.ts`, integrate với `TaskRunner` |
| **Issue-PR Protocol** | Link team tasks với GitHub issues | MEDIUM | Port `issue-pr-protocol.ts` |

### Tier 2 — High Value, High Effort (Ưu tiên thấp hơn)

| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Shell Minimizer** | Clean command output cho agents | HIGH | Rust → TypeScript port hoặc FFI |
| **ACP Fork Session** | Parallel agent experiments | HIGH | Cần deep `LiveSessionHandle` understanding |
| **User Metrics** | Team performance analytics | MEDIUM | Design DB schema, build API |

### Tier 3 — Low Value (Không ưu tiên)

| Feature | Why | Effort |
|---|---|---|
| Hashline Engine | Strongly coupled với oh-my-pi | HIGH |
| ACP Client Bridge | pi-crew đã có `LiveExtensionBridge` | LOW |
| MCP Helper | pi-crew đã có `McpProxy` | LOW |

---

## Next Steps

1. **Conflict Detection** — Start với porting `conflict-detect.ts` vì nó standalone và high-value
2. **Typed Errors** — Quick win, chỉ cần create error classes
3. **Todo Integration** — Long-term, cần integrate với workflow engine

## Files cần đọc thêm

- `packages/coding-agent/src/tools/conflict-detect.ts` (toàn bộ)
- `packages/coding-agent/src/tools/todo-write.ts` (dependency của todo.ts)
- `packages/coding-agent/src/session/agent-session.ts` (phần fork/resume session)
- `crates/pi-shell/src/minimizer/engine.rs` (nếu muốn port shell minimizer)