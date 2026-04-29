# Research: pi-mono coding-agent Deep Read

> Ngày: 2026-04-29 | Read-only research | Source: `source/pi-mono/packages/coding-agent/`

## 1. Vai trò trong monorepo

`@mariozechner/pi-coding-agent` là package trung tâm nhất của pi-mono. Nó chứa CLI binary `pi`,
toàn bộ agent session lifecycle, extension host system, 3 run modes, 7 built-in tools, session
persistence, compaction, branch summarization, và SDK cho programmatic usage.

Package version: `0.70.5` (lockstep với toàn bộ monorepo).

## 2. Cấu trúc source

```
src/
├── cli.ts                        # Binary entry point (shebang #!/usr/bin/env node)
├── main.ts                       # CLI logic: parse args, dispatch mode (731 dòng)
├── index.ts                      # Public API exports (~250 dòng re-exports)
├── config.ts                     # Path constants (agentDir, VERSION, APP_NAME)
├── cli/                          # CLI subsystems
│   ├── args.ts                   # Argument parsing (yargs-style)
│   ├── file-processor.ts         # @file argument expansion
│   ├── initial-message.ts        # Build initial prompt from args/stdin
│   ├── list-models.ts            # --list-models output
│   └── session-picker.ts         # Interactive session selection
├── core/                         # ═══ CORE LAYER ═══
│   ├── agent-session.ts          # AgentSession class (3099 dòng) — TRUNG TÂM
│   ├── agent-session-runtime.ts  # AgentSessionRuntime wrapper (session replacement)
│   ├── agent-session-services.ts # Dịch vụ tạo cwd-bound runtime
│   ├── sdk.ts                    # createAgentSession() public factory (~408 dòng)
│   ├── session-manager.ts        # Session file I/O, entries, tree (1425 dòng)
│   ├── settings-manager.ts       # settings.json manager (~1069 dòng)
│   ├── system-prompt.ts          # System prompt builder (172 dòng)
│   ├── resource-loader.ts        # Load extensions/skills/prompts/themes (~920 dòng)
│   ├── model-registry.ts         # Model + auth registry
│   ├── model-resolver.ts         # Model resolution / scope / fallback
│   ├── keybindings.ts            # Keybinding manager (KeybindingsManager)
│   ├── messages.ts               # AgentMessage type definitions + converters
│   ├── bash-executor.ts          # Bash execution abstraction layer
│   ├── prompt-templates.ts       # File-based prompt templates (@file expansion)
│   ├── skills.ts                 # Skill loading + formatting for system prompt
│   ├── slash-commands.ts         # 21 built-in slash commands
│   ├── event-bus.ts              # Shared event bus for cross-extension communication
│   ├── footer-data-provider.ts   # Footer data provider (git branch + extension statuses)
│   ├── auth-storage.ts           # API key / OAuth credential storage
│   ├── auth-guidance.ts          # User-facing auth error messages
│   ├── extensions/               # ═══ EXTENSION SYSTEM ═══
│   │   ├── types.ts              # Type surface (1545 dòng)
│   │   ├── loader.ts             # jiti-based extension loader (~607 dòng)
│   │   ├── runner.ts             # ExtensionRunner lifecycle manager (~1024 dòng)
│   │   ├── wrapper.ts            # Tool wrapping utilities
│   │   └── index.ts              # Re-exports (~170 dòng)
│   ├── compaction/               # ═══ COMPACTION ═══
│   │   ├── compaction.ts         # Context compaction logic (~840 dòng)
│   │   ├── branch-summarization.ts # Tree navigation summarization (~356 dòng)
│   │   ├── utils.ts              # File ops tracking + serialization
│   │   └── index.ts
│   └── tools/                    # ═══ BUILT-IN TOOLS ═══
│       ├── index.ts              # Tool registry + factories (~198 dòng)
│       ├── read.ts               # File reading with truncation
│       ├── bash.ts               # Shell command execution
│       ├── edit.ts               # Exact text replacement
│       ├── write.ts              # File creation/overwrite
│       ├── grep.ts               # Regex search
│       ├── find.ts               # File name search
│       ├── ls.ts                 # Directory listing
│       ├── file-mutation-queue.ts # Serialized file writes
│       ├── truncate.ts           # Output truncation strategies
│       └── render-utils.ts
├── modes/                        # ═══ RUN MODES ═══
│   ├── index.ts                  # Re-exports
│   ├── interactive/              # Interactive TUI mode (5470 dòng)
│   │   ├── interactive-mode.ts   # Main TUI loop + all slash commands
│   │   ├── components/           # 30+ TUI components (assistant messages, diffs, editors...)
│   │   └── theme/                # Theme engine (JSON-based, hot-reload)
│   ├── print-mode.ts             # Non-interactive / JSON output mode
│   └── rpc/                      # JSON-RPC mode for embedding (parent-child protocol)
│       ├── rpc-mode.ts           # RPC server loop
│       ├── rpc-client.ts         # RPC client for SDK/programmatic use
│       ├── rpc-types.ts          # JSON-RPC message types
│       └── jsonl.ts              # JSONL output formatting
└── utils/                        # Shared utilities
    ├── clipboard.ts              # Clipboard integration
    ├── frontmatter.ts            # YAML frontmatter parser
    ├── shell.ts                  # Shell detection/config
    ├── paths.ts                  # Path utilities
    └── sleep.ts                  # Promise-based sleep
```

## 3. Các file chính - số dòng

| File | Dòng | Mô tả |
|---|---|---|
| `modes/interactive/interactive-mode.ts` | 5470 | Interactive TUI + tất cả 21 slash command handlers |
| `core/agent-session.ts` | 3099 | AgentSession class: prompt, compaction, bash, model management |
| `core/extensions/types.ts` | 1545 | Toàn bộ type surface cho extension system |
| `core/session-manager.ts` | 1425 | Session file I/O, entry types, tree operations |
| `core/settings-manager.ts` | ~1069 | JSON settings management (global + project) |
| `core/extensions/runner.ts` | ~1024 | ExtensionRunner: event emission, context binding |
| `core/resource-loader.ts` | ~920 | Unified loader for extensions/skills/prompts/themes |
| `core/compaction/compaction.ts` | ~840 | Compaction logic + cut-point detection |
| `main.ts` | 731 | CLI entry: arg parsing → mode dispatch |
| `core/extensions/loader.ts` | ~607 | jiti-based TypeScript module loading |

## 4. Luồng thực thi chính

### 4.1 Startup sequence (`main.ts`)

```
main(args)
  ├── parseArgs(args)                          # Parse CLI flags
  ├── resolveAppMode()                         # interactive | print | json | rpc
  ├── runMigrations()                          # Upgrade old session formats
  ├── createSessionManager()                   # new/fork/continue/resume/in-memory
  ├── createAgentSessionRuntime(createRuntime) # Build full runtime
  │     └── createRuntime(cwd, agentDir, sessionManager)
  │           ├── createAgentSessionServices()  # authStorage, modelRegistry, resourceLoader
  │           ├── resolveModelScope()           # --models flag → scoped models
  │           ├── buildSessionOptions()         # model, thinking, tools, scopedModels
  │           └── createAgentSessionFromServices() → AgentSession
  ├── readPipedStdin()                         # Pipe support
  ├── prepareInitialMessage()                  # text + images
  └── dispatch:
        ├── interactive → new InteractiveMode(runtime).run()
        ├── print/json  → runPrintMode(runtime, {...})
        └── rpc         → runRpcMode(runtime)
```

### 4.2 AgentSession.prompt() lifecycle

```
session.prompt(text)
  ├── parseSkillBlock()                  # <skill name="..." location="...">
  ├── expandPromptTemplate()             # @file expansion
  ├── emitInput()                        # Extension can transform/block input
  ├── emitBeforeAgentStart()             # Extension can inject custom message / swap system prompt
  ├── agent.runAgentLoop()
  │     ├── context → extension transform messages
  │     ├── before_provider_request → extension modify payload
  │     ├── streamSimple(model, context, ...)
  │     ├── after_provider_response → extension observe response
  │     ├── tool_call → extension intercept/block/mutate args
  │     ├── tool_execution_start/update/end
  │     ├── tool_result → extension modify result
  │     └── auto-compaction check (after turn_end)
  └── emitAgentEnd()
```

### 4.3 Run modes

| Mode | Class/Function | Đặc điểm |
|---|---|---|
| **Interactive** | `InteractiveMode` (5470 dòng) | Full TUI: chat history, editor, widgets, themes, overlays, keybindings |
| **Print/JSON** | `runPrintMode()` | Pipe/script: plain text or JSON mode, no TUI |
| **RPC** | `runRpcMode()` | JSON-RPC 2.0 over stdin/stdout — dùng làm child process protocol |

## 5. AgentSession class chi tiết

### 5.1 Properties

```typescript
class AgentSession {
  readonly agent: Agent;                    // Core agent instance
  readonly sessionManager: SessionManager;  // Session file I/O
  readonly settingsManager: SettingsManager;// Settings

  // Model access
  get model(): Model<any> | undefined;
  get thinkingLevel(): ThinkingLevel;
  get scopedModels(): Array<{model, thinkingLevel}>;

  // Tool access
  get toolNames(): string[];               // Currently active tools
  get tools(): ToolInfo[];                 // All registered tools with metadata
  getAllTools(): ToolInfo[];

  // Context
  getContextUsage(): ContextUsage | undefined;
  isIdle(): boolean;

  // Core operations
  prompt(text, options?): Promise<void>;   // Send user message
  abort(): void;                           // Abort current operation
  shutdown(): void;                        // Graceful shutdown

  // Model management
  cycleModel(forward?): ModelCycleResult;  // Ctrl+P cycling
  setModel(model): Promise<boolean>;       // Switch model
  setThinkingLevel(level): void;

  // Compaction
  compact(options?): void;                 // Manual compaction
  getSessionStats(): SessionStats;         // Usage stats
}
```

### 5.2 Internal state machine

Key internal flags:
- `_steeringMessages[]` / `_followUpMessages[]`: Queued messages
- `_compactionAbortController` / `_autoCompactionAbortController`: Compaction control
- `_overflowRecoveryAttempted`: Context overflow recovery flag
- `_retryAttempt` / `_retryPromise`: Auto-retry state
- `_bashAbortController` / `_pendingBashMessages[]`: Bash execution state
- `_turnIndex`: Current turn counter

### 5.3 Tool hooks

`_installAgentToolHooks()` installs interceptors on the Agent instance:
- `beforeToolCall`: Check if extension wants to intercept/block
- `onToolResult`: Check if extension wants to modify result

## 6. Session Persistence (`session-manager.ts`)

### 6.1 Session file format

JSONL file (`.pi/sessions/{id}.jsonl`) với các entry types:

| Entry Type | Purpose | Fields |
|---|---|---|
| `session` | Header | version, id, timestamp, cwd, parentSession |
| `message` | AgentMessage (user/assistant/toolResult) | message |
| `thinking_level_change` | Thinking level change | thinkingLevel |
| `model_change` | Model switch | provider, modelId |
| `compaction` | Compaction summary | summary, firstKeptEntryId, tokensBefore, details |
| `branch_summary` | Branch navigation | summary, fromId, details |
| `custom_message` | Extension-defined for LLM context | customType, content, display, details |
| `custom` | Extension state (not in LLM context) | customType, data |

Current version: `CURRENT_SESSION_VERSION = 3`

### 6.2 Session tree

- Mỗi session có `parentSession` reference (khi fork)
- `SessionManager.forkFrom()` tạo session mới
- `buildSessionContext()` dựng messages từ entries (cả compaction + branch summary)
- `navigateTree()` di chuyển giữa các branch trong cùng session

## 7. Compaction System

### 7.1 Auto-compaction (`compaction/compaction.ts`)

Default settings:
```
reserveTokens: 16384    # Dành cho system prompt + LLM response
keepRecentTokens: 20000 # Giữ các messages gần đây
```

Process:
1. `shouldCompact()` — kiểm tra context usage sau mỗi turn
2. `findCutPoint()` — tìm vị trí cắt dựa vào file operations
3. `prepareCompaction()` — build messagesToSummarize + turnPrefixMessages
4. `compact()` — serialize → LLM summarize → return CompactionResult
5. SessionManager lưu `CompactionEntry` + tạo session mới (reload)

### 7.2 Branch summarization (`compaction/branch-summarization.ts`)

Khi user navigate session tree, tạo summary của branch hiện tại:
- `collectEntriesForBranchSummary()` — thu thập entries cần summarize
- `prepareBranchEntries()` — extract messages + file operations
- `generateBranchSummary()` — gọi LLM tạo summary

### 7.3 Cut-point strategy

Tìm cut-point dựa trên:
- File operations: ưu tiên cắt ở điểm không có pending file modifications
- Assistant messages: không cắt giữa tool calls
- Keep recent tokens: giữ ít nhất `keepRecentTokens` cuối cùng

## 8. Built-in Tools

7 tools, mỗi tool có 2 representations:
- `AgentTool` — runtime execution contract
- `ToolDefinition` — type-safe definition với schema + render

| Tool | File | Key params | Đặc điểm |
|---|---|---|---|
| `read` | `tools/read.ts` | path, offset, limit | Head/tail truncation, image support |
| `bash` | `tools/bash.ts` | command, timeout | AbortController, timeout |
| `edit` | `tools/edit.ts` | path, edits[{oldText,newText}] | Exact replacement, multi-edit |
| `write` | `tools/write.ts` | path, content | Overwrite/create |
| `grep` | `tools/grep.ts` | pattern, path | Regex search |
| `find` | `tools/find.ts` | pattern, path | File name glob |
| `ls` | `tools/ls.ts` | path | Directory listing |

**File mutation queue** (`file-mutation-queue.ts`): Serializes write operations to prevent
parallel tool conflicts. Used internally by edit/write tools.

## 9. Settings Manager (`settings-manager.ts`)

Quản lý `settings.json` với các section:

| Section | Key settings | Default |
|---|---|---|
| `compaction` | enabled, reserveTokens, keepRecentTokens | true, 16384, 20000 |
| `retry` | enabled, maxRetries, baseDelayMs | true, 3, 2000 |
| `retry.provider` | timeoutMs, maxRetries, maxRetryDelayMs | (SDK defaults) |
| `terminal` | showImages, imageWidthCells, clearOnShrink, showTerminalProgress | true, 60, false, false |
| `images` | autoResize, blockImages | true, false |
| `thinkingBudgets` | minimal, low, medium, high | (per-level defaults) |
| `markdown` | codeBlockIndent | "  " |

Scope: global (`~/.pi/agent/settings.json`) + project-local (`.pi/settings.json`).

## 10. Slash Commands

21 built-in commands (`slash-commands.ts`):

| Command | Purpose |
|---|---|
| `settings` | Open settings menu |
| `model` | Select model (selector UI) |
| `scoped-models` | Enable/disable models for Ctrl+P |
| `export` | Export session (HTML/JSONL) |
| `import` | Import session from JSONL |
| `share` | Share as GitHub gist |
| `copy` | Copy last message |
| `name` | Set session display name |
| `session` | Show session info + stats |
| `changelog` | Show changelog |
| `hotkeys` | Show keyboard shortcuts |
| `fork` | Fork from previous message |
| `clone` | Duplicate session |
| `tree` | Navigate session tree |
| `login`/`logout` | Auth management |
| `new` | Start new session |
| `compact` | Manual compaction |
| `resume` | Resume different session |
| `reload` | Reload extensions/skills/themes |
| `quit` | Exit |

## 11. RPC Mode

JSON-RPC 2.0 protocol qua stdin/stdout:

```typescript
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "prompt", "params": { "text": "..." } }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": { "messages": [...], "usage": {...} } }

// Notification (no id)
{ "jsonrpc": "2.0", "method": "event", "params": { "type": "message_start", ... } }
```

Đây là protocol chính cho parent-child communication trong pi-subagents và pi-crew.

## 12. Các điểm đáng chú ý

1. **Interactive mode quá lớn** (5470 dòng) — chứa hầu hết slash command implementations
2. **AgentSession quá lớn** (3099 dòng) — mixed concerns: prompt, compaction, bash, lifecycle
3. **Extension type surface** (1545 dòng) — rất comprehensive nhưng complex
4. **Lockstep versioning** — tất cả packages cùng version 0.70.5
5. **jiti-based extension loading** — cho phép TypeScript extensions không cần compile
6. **Virtual modules** — cho Bun compiled binary, bundle sẵn các dependencies
