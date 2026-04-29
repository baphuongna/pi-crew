# Research: Pi Extension System Deep Dive

> Ngày: 2026-04-29 | Read-only research | Source: `source/pi-mono/packages/coding-agent/src/core/extensions/`

## 1. Extension System Architecture

Pi extension system là plugin framework cho coding agent. Extensions được viết bằng TypeScript,
load qua jiti (JIT compiler), và có thể hook vào mọi phase của agent lifecycle.

```
┌─────────────────────────────────────────────────────────────┐
│                    ExtensionAPI ("pi.*")                    │
│  Event sub:   pi.on(event, handler)                        │
│  Tools:       pi.registerTool(def)                         │
│  Commands:    pi.registerCommand(name, opts)               │
│  Shortcuts:   pi.registerShortcut(key, opts)               │
│  Flags:       pi.registerFlag(name, opts)                  │
│  Messages:    pi.sendMessage() / pi.sendUserMessage()      │
│  State:       pi.appendEntry(customType, data)             │
│  Provider:    pi.registerProvider(name, config)            │
│  Event bus:   pi.events.emit/on()                          │
│  Model:       pi.setModel() / getThinkingLevel()           │
│  Tools mgmt:  pi.getActiveTools() / setActiveTools()       │
├─────────────────────────────────────────────────────────────┤
│               ExtensionFactory                              │
│        (pi: ExtensionAPI) => void | Promise<void>          │
├─────────────────────────────────────────────────────────────┤
│  loader.ts ──► jiti → TypeScript module loading            │
│  runner.ts ──► ExtensionRunner → lifecycle + event emit    │
│  types.ts ───► 1545 dòng type definitions                  │
└─────────────────────────────────────────────────────────────┘
```

## 2. Extension Loading Flow

```
discoverAndLoadExtensions(cwd, agentDir, extensionPaths)
  ├── Scan directories:
  │     ├── ~/.pi/agent/extensions/**/index.ts  (user-global)
  │     ├── .pi/extensions/**/index.ts           (project-local)
  │     └── CLI --extension paths                (explicit)
  ├── Create ExtensionRuntime (shared state + action stubs)
  ├── For each extension file:
  │     ├── jiti.import(path)                    # Load TS module
  │     ├── Call default export: factory(pi)     # Register handlers/tools/commands
  │     └── Collect into Extension object
  └── Return LoadExtensionsResult

ExtensionRunner.initialize(session, context, actions)
  ├── Bind real action implementations to runtime
  ├── Process queued provider registrations
  └── Emit session_start event
```

### 2.1 Discovery priority

Project-local > user-global. Extensions cùng tên: project override user.

### 2.2 Runtime replacement (reload)

Khi `/reload` hoặc session switch:
1. `emitSessionShutdownEvent("reload")`
2. Invalidate old ExtensionRuntime (throws if stale extension tries to act)
3. Re-discover + re-load tất cả extensions
4. Re-initialize ExtensionRunner

## 3. Full Event Lifecycle

### 3.1 Event model (23 event types)

**Session events** — session-level lifecycle:
```
session_start              ← Khi session được tạo/load/reload
resources_discover          ← Extension có thể inject thêm paths
session_before_switch       ← Trước khi switch session (có thể cancel)
session_before_fork         ← Trước khi fork session (có thể cancel)
session_before_compact      ← Trước khi compaction (có thể cancel hoặc custom)
session_compact             ← Sau khi compaction hoàn tất
session_before_tree         ← Trước khi navigate tree (có thể cancel)
session_tree                ← Sau khi navigate tree
session_shutdown            ← Khi session bị hủy (quit/reload/new/resume/fork)
```

**Agent events** — per-prompt:
```
input                       ← Khi user input received (có thể transform/block)
before_agent_start          ← Trước khi agent loop chạy (inject custom message / swap system prompt)
context                     ← Transform messages trước khi gửi LLM
before_provider_request     ← Thay đổi payload trước khi gửi provider
after_provider_response     ← Quan sát response status/headers
agent_start                 ← Agent loop bắt đầu
agent_end                   ← Agent loop kết thúc
```

**Turn events** — per-turn:
```
turn_start                  ← Bắt đầu turn mới
turn_end                    ← Kết thúc turn (có message + tool results)
```

**Message events** — per-message:
```
message_start               ← Message bắt đầu (user/assistant/toolResult)
message_update              ← Streaming token-by-token update
message_end                 ← Message hoàn tất
```

**Tool events** — per-tool:
```
tool_call                   ← Trước khi tool execute (có thể block/mutate args)
tool_execution_start        ← Tool bắt đầu chạy
tool_execution_update       ← Partial/streaming result
tool_execution_end          ← Tool hoàn tất
tool_result                 ← Sau khi tool execute (có thể modify result)
```

**Other:**
```
model_select                ← Khi model được chọn/thay đổi
user_bash                   ← Khi user dùng ! prefix cho bash
```

### 3.2 Event result contracts

Mỗi event có thể return result để ảnh hưởng đến behavior:

| Event | Result type | Effect |
|---|---|---|
| `input` | `{ action: "continue" \| "transform" \| "handled" }` | Transform/block input |
| `before_agent_start` | `{ message?, systemPrompt? }` | Inject custom message, swap system prompt |
| `context` | `{ messages? }` | Replace context messages |
| `before_provider_request` | `any` | Replace payload |
| `tool_call` | `{ block?, reason? }` | Block tool execution |
| `tool_result` | `{ content?, details?, isError? }` | Modify result |
| `user_bash` | `{ operations?, result? }` | Custom bash execution |
| `session_before_*` | `{ cancel? }` | Cancel session operation |
| `session_before_compact` | `{ cancel?, compaction? }` | Cancel or custom compact |
| `session_before_tree` | `{ cancel?, summary?, customInstructions? }` | Cancel or custom summary |
| `resources_discover` | `{ skillPaths?, promptPaths?, themePaths? }` | Inject resource paths |

## 4. Context Objects Available to Extensions

### 4.1 ExtensionContext (`ctx.*`) — có sẵn trong mọi event handler

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;         // UI methods (select, confirm, notify, widgets...)
  hasUI: boolean;                 // false in print/RPC mode
  cwd: string;                    // Current working directory
  sessionManager: ReadonlySessionManager; // Session access (read-only)
  modelRegistry: ModelRegistry;   // Auth + model discovery
  model: Model<any> | undefined;  // Current model
  isIdle(): boolean;              // Check if agent is streaming
  signal: AbortSignal | undefined;// Current abort signal
  abort(): void;                  // Abort current operation
  hasPendingMessages(): boolean;  // Check message queue
  shutdown(): void;               // Graceful shutdown
  getContextUsage(): ContextUsage | undefined; // Token usage
  compact(options?): void;        // Trigger compaction
  getSystemPrompt(): string;      // Current system prompt
}
```

### 4.2 ExtensionCommandContext — extends Context, chỉ trong command handler

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;   // Wait for agent to finish
  newSession(options?): Promise<{cancelled}>;
  fork(entryId, options?): Promise<{cancelled}>;
  navigateTree(targetId, options?): Promise<{cancelled}>;
  switchSession(sessionPath, options?): Promise<{cancelled}>;
  reload(): Promise<void>;
}
```

### 4.3 ReplacedSessionContext — sau khi switch/new session

```typescript
interface ReplacedSessionContext extends ExtensionCommandContext {
  sendMessage(message, options?): Promise<void>;
  sendUserMessage(content, options?): Promise<void>;
}
```

### 4.4 ExtensionUIContext (`ctx.ui.*`) — chỉ khi `hasUI=true`

```typescript
interface ExtensionUIContext {
  select(title, options, opts?): Promise<string | undefined>;
  confirm(title, message, opts?): Promise<boolean>;
  input(title, placeholder?, opts?): Promise<string | undefined>;
  notify(message, type?): void;
  custom<T>(factory, options?): Promise<T>;   // Custom overlay component
  setWidget(key, content, options?): void;     // Widget above/below editor
  setFooter(factory): void;                    // Custom footer
  setHeader(factory): void;                    // Custom header
  setEditorComponent(factory): void;           // Custom editor
  setStatus(key, text): void;                  // Status bar
  setTitle(title): void;                       // Terminal title
  setWorkingMessage(message?): void;           // Working loader text
  setWorkingVisible(visible): void;            // Show/hide loader
  setWorkingIndicator(options?): void;         // Custom loader animation
  setHiddenThinkingLabel(label?): void;        // Thinking block label
  onTerminalInput(handler): () => void;        // Raw terminal input
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded): void;
  theme: Theme;
  getAllThemes(): {name, path}[];
  getTheme(name): Theme | undefined;
  setTheme(theme): {success, error?};
}
```

## 5. ToolDefinition Contract

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
  name: string;                   // Unique tool name
  label: string;                  // Human-readable for UI
  description: string;            // For LLM
  parameters: TParams;            // TypeBox schema
  promptSnippet?: string;         // 1-line for system prompt "Available tools"
  promptGuidelines?: string[];    // Bullets for system prompt "Guidelines"
  renderShell?: "default" | "self"; // Who renders the outer frame
  executionMode?: "sequential" | "parallel"; // Concurrency control
  prepareArguments?: (args: unknown) => Static<TParams>;

  // Core execution
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  // Rendering (optional)
  renderCall?(args, theme, context): Component;       // Custom call display
  renderResult?(result, options, theme, context): Component; // Custom result display
}
```

### 5.1 `terminate: true` pattern

Tool có thể set `terminate: true` trong result để kết thúc turn ngay sau tool call,
tiết kiệm 1 follow-up LLM turn:

```typescript
return {
  content: [{ type: "text", text: "Done" }],
  details: { ... },
  terminate: true,  // ← Kết thúc turn, không cần LLM follow-up
};
```

## 6. Provider Registration

Extension có thể đăng ký provider tùy chỉnh:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "PROVIDER_API_KEY",
  api: "anthropic-messages",
  models: [{
    id: "my-model",
    name: "My Model",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  }],
  // Optional OAuth:
  oauth: {
    name: "My Provider (SSO)",
    async login(callbacks) { ... },
    async refreshToken(credentials) { ... },
    getApiKey(credentials) { return credentials.access; },
  },
});
```

Hiệu lực ngay lập tức sau `session_start` (không cần `/reload`).

## 7. API Comparison: ExtensionAPI vs ExtensionContext

| Capability | `pi.*` (ExtensionAPI) | `ctx.*` (ExtensionContext) |
|---|---|---|
| Subscribe events | ✅ `pi.on(...)` | ❌ |
| Register tools | ✅ `pi.registerTool()` | ❌ |
| Register commands | ✅ `pi.registerCommand()` | ❌ |
| Register shortcuts | ✅ `pi.registerShortcut()` | ❌ |
| Register flags | ✅ `pi.registerFlag()` | ❌ |
| Register providers | ✅ `pi.registerProvider()` | ❌ |
| Send messages | ✅ `pi.sendMessage()` | ❌ |
| Send user messages | ✅ `pi.sendUserMessage()` | ❌ |
| Append entries | ✅ `pi.appendEntry()` | ❌ |
| Session name | ✅ `pi.setSessionName()` / `getSessionName()` | ❌ |
| Event bus | ✅ `pi.events` | ❌ |
| Get/set active tools | ✅ `pi.getActiveTools()` / `setActiveTools()` | ❌ |
| Get model | ❌ (register-time only) | ✅ `ctx.model` |
| Check idle | ❌ | ✅ `ctx.isIdle()` |
| Abort | ❌ | ✅ `ctx.abort()` |
| Trigger compaction | ❌ | ✅ `ctx.compact()` |
| Context usage | ❌ | ✅ `ctx.getContextUsage()` |
| System prompt | ❌ | ✅ `ctx.getSystemPrompt()` |
| Session manager | ❌ | ✅ `ctx.sessionManager` |
| UI interaction | ❌ | ✅ `ctx.ui` |
| Session control | ❌ | ✅ `ctx.newSession()` / `fork()` (command ctx) |

**Rule of thumb:**
- `pi.*`: Registration-time API (trong factory function, `session_start`)
- `ctx.*`: Runtime API (trong event handlers, command handlers)

## 8. Key Design Decisions

1. **No sandbox** — Extensions run in same Node.js process, full system access
2. **jiti loader** — TypeScript extensions compiled JIT, no build step
3. **Virtual modules** — For Bun compiled binary, built-in dependencies bundled
4. **Throwing stubs** — Runtime actions start as stubs, real implementations bound by runner
5. **Stale detection** — After reload, old extension instances throw on any API call
6. **Event bus** — Separate from extension events, for cross-extension communication
