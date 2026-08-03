# Feature Analysis: 3 Features to Port from pi-subagent4

## 1. Safe Bash Tool

### Current State in pi-crew
- **No dangerous command blocking** - pi-crew relies on user config
- `src/utils/env-filter.ts` has `sanitizeEnvSecrets()` for env var filtering, but nothing for bash commands
- `src/runtime/skill-instructions.ts` references `safe-bash` skill, but it's a guidance document, not enforcement

### How subagent4 Does It

```typescript
// tools/safe-bash.ts
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
];

function isDangerous(command: string): string | null {
  const normalized = command.replace(/\\\n/g, " ");
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
    }
  }
  return null;
}

// Wraps pi's built-in bash tool
pi.registerTool({
  name: "safe_bash",
  execute(toolCallId, params, signal, onUpdate, ctx) {
    const danger = isDangerous(params.command);
    if (danger) throw new Error(danger);
    return bashTool.execute(toolCallId, params, signal, onUpdate);
  }
});
```

### Implementation Options for pi-crew

**Option A: Wrapper Tool (Recommended)**
```typescript
// src/tools/safe-bash.ts
// Extends pi's bash tool with pattern blocking
// Registered as a custom tool that agents can use instead of bash
```

**Option B: Config-based Pattern Matching**
```typescript
// In pi-crew config
{
  "tools": {
    "bash": {
      "safeMode": true,
      "blockedPatterns": ["rm -rf /", "sudo", "mkfs", ...]
    }
  }
}
```

**Option C: Skill-based Guidance**
```typescript
// Already exists: skills/safe-bash/SKILL.md
// But this is guidance only, not enforcement
```

### Effort Assessment
| Aspect | Estimate |
|--------|----------|
| Code complexity | Low (~60 lines) |
| Integration points | 1 (bash tool wrapper) |
| Testing needed | Medium (regex pattern coverage) |
| **Total effort** | **0.5-1 day** |

### Risks
- **Pattern gaps**: Regex may miss edge cases (e.g., `curl -sL` with `|` on separate line)
- **Performance**: Pattern matching on every command adds latency
- **User override**: Users might need to bypass for legitimate uses

### Recommendation
**IMPLEMENT** - Low effort, high value. Start with Option A (wrapper tool) and iterate.

---

## 2. Dynamic Agent Registration

### Current State in pi-crew
- **Static configuration**: Agents defined in `.team.md` files
- **No runtime API**: Can't add/remove agents after startup
- **Manifest-based**: Agents loaded from manifest at run start

### How subagent4 Does It

```typescript
// Global bridge for cross-module access
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

export function registerAgent(config: AgentConfig): void {
  // Validate not already registered
  if (agents.find((a) => a.name === config.name)) {
    throw new Error(`Agent already registered: ${config.name}`);
  }
  // Check allowlist if PI_SUBAGENT_ALLOWED is set
  if (SUBAGENT_ALLOWLIST && !SUBAGENT_ALLOWLIST.includes(config.name)) return;
  agents.push(config);
}

export function unregisterAgent(name: string): void {
  agents = agents.filter((a) => a.name !== name);
}

// Agent config schema
interface AgentConfig {
  name: string;           // "scout", "researcher", "worker"
  model: string;          // "haiku-4-5", "sonnet-4-6"
  tools: string[];       // ["read", "grep", "find", "ls"]
  systemPrompt?: string;  // Custom system prompt
  subagentAgents?: string[];  // For worker: ["scout", "researcher"]
}
```

### Implementation Options for pi-crew

**Option A: Manifest Extension API**
```typescript
// Add to team-tool.ts
export function registerAgent(config: AgentConfig): void {
  // Validate against schema
  // Add to global agent registry
  // Notify active runs to reload
}
```

**Option B: globalThis Bridge (subagent4 style)**
```typescript
// In extension/register.ts
(globalThis as any).__pi_crew = {
  registerAgent: (config: AgentConfig) => { ... },
  unregisterAgent: (name: string) => { ... },
  listAgents: () => { ... }
};
```

**Option C: File-based Hot Reload**
```typescript
// Watch .team.md files for changes
// Reload agents on file change
// No API change needed
```

### Effort Assessment
| Aspect | Estimate |
|--------|----------|
| Code complexity | Medium (~150 lines) |
| Integration points | 3 (extension, team-tool, runtime) |
| State management | Complex (need to handle active runs) |
| **Total effort** | **2-3 days** |

### Use Cases Enabled
1. **Plugin system**: Third-party agents can register at runtime
2. **Dynamic workflows**: Agents added based on project needs
3. **A/B testing**: Swap agents without restart

### Risks
- **Race conditions**: Concurrent registration could cause duplicates
- **State sync**: Active runs might use stale agent list
- **Security**: Allowlist enforcement needed to prevent unauthorized agents

### Recommendation
**DEFER** - Medium effort, unclear value. Current manifest-based approach works for most use cases. Revisit if plugin system becomes a priority.

---

## 3. JSON Event Stream Parsing

### Current State in pi-crew
- **Lifecycle events**: spawn, spawn_error, response_timeout, etc.
- **No tool-level events**: No visibility into what tools are running
- **Completion-based**: Only sees final result, not progress

### How subagent4 Does It

```typescript
// stdout JSON event stream parsing
child.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim() || !line.startsWith("{")) continue;
    const evt = JSON.parse(line);

    // Event types handled
    if (evt.type === "tool_execution_start") {
      // Tool started - update UI, track count
    }
    if (evt.type === "tool_execution_update") {
      // Tool progress - nested subagent results
    }
    if (evt.type === "tool_execution_end") {
      // Tool completed - finalize
    }
    if (evt.type === "message_end") {
      // Final output + usage stats
    }
  }
});

// Tool args preview extraction
function extractToolArgsPreview(args: Record<string, unknown>): string {
  if (args.command) return flatten(String(args.command));
  if (args.path) return flatten(String(args.path));
  if (args.query) return `"${flatten(String(args.query))}"`;
  // ... more types
}
```

### Implementation Options for pi-crew

**Option A: Event Stream Bridge (Recommended)**
```typescript
// src/runtime/event-stream-bridge.ts
// Parses JSON events from child stdout
// Emits structured events to event bus
// Updates task state in real-time

interface ToolEvent {
  type: "tool_execution_start" | "tool_execution_end" | "tool_execution_update";
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  result?: unknown;
  timestamp: number;
}
```

**Option B: Periodic Snapshot Polling**
```typescript
// Poll child process state every N seconds
// Less real-time, but simpler implementation
// Lower fidelity but still useful
```

**Option C: Log-based Analysis**
```typescript
// Parse .events.jsonl files after completion
// No real-time, but enables post-run analysis
// Good for debugging, not for live UI
```

### Effort Assessment
| Aspect | Estimate |
|--------|----------|
| Code complexity | High (~300 lines) |
| Integration points | 4 (child-pi, event-bus, task-runner, UI) |
| Error handling | Complex (malformed JSON, partial events) |
| **Total effort** | **3-5 days** |

### Benefits Enabled
1. **Live tool progress**: See what tools are running in real-time
2. **Nested subagent visibility**: See child subagent activity
3. **Token usage tracking**: Real-time context window monitoring
4. **Error isolation**: Know exactly which tool failed
5. **Better UX**: Progress indicators, not just spinner

### Risks
- **Event format changes**: Pi might change JSON event format
- **Performance overhead**: JSON parsing on every stdout chunk
- **Buffer handling**: Partial JSON lines need buffering

### Recommendation
**IMPLEMENT** - High effort, high value. This would significantly improve UX. Start with Option A and target `tool_execution_start/end` events first (most impactful).

---

## Summary

| Feature | Effort | Value | Priority | Recommendation |
|---------|--------|-------|----------|----------------|
| Safe Bash | Low (0.5-1 day) | High | P0 | **IMPLEMENT NOW** |
| Dynamic Registration | Medium (2-3 days) | Medium | P2 | DEFER |
| JSON Event Stream | High (3-5 days) | High | P1 | **IMPLEMENT** |

### Recommended Roadmap

**Phase 1 (This week)**
- Safe bash tool with pattern blocklist

**Phase 2 (Next sprint)**
- JSON event stream parsing for tool progress

**Phase 3 (Future)**
- Dynamic agent registration (if needed)