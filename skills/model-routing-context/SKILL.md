---
name: model-routing-context
description: >
  Model routing, parent context, thinking level, and prompt construction workflow. Use when changing model fallback, child Pi args, inherited context, task prompts, or compact-read behavior.
  When NOT to use: project-level config (use resource-discovery-config); routing for non-pi-crew agents.

origin: pi-crew
triggers:
  - "change model"
  - "parent context"
  - "thinking level"
  - "task prompts"
  - "compact read"

---
# model-routing-context

Use this skill when working on model/context propagation.

## Source patterns distilled

- Pi session context/model state: `source/pi/packages/coding-agent/src/core/session-manager.ts`, `agent-session.ts`, compaction modules
- pi-crew model and prompt code: `src/runtime/model-fallback.ts`, `src/runtime/pi-args.ts`, `src/runtime/task-runner/prompt-builder.ts`, `src/runtime/task-output-context.ts`, `src/extension/team-tool/context.ts`

## Rules

- Preserve parent model inheritance unless an agent/task/user explicitly provides a non-empty model override.
- Treat empty strings and whitespace model values as absent.
- Carry relevant parent conversation context as reference-only; do not let it override explicit task instructions or safety constraints.
- Respect compact-read/compaction summaries when building context; avoid ballooning prompts with redundant transcript data.
- Avoid inline dynamic imports for model providers or prompt helpers.
- When changing model precedence, add tests for undefined, empty, whitespace, agent, task, parent, and explicit tool override cases.
- Redact secrets in context snippets and child prompts where logs/artifacts may persist them.

## Enforcement — Model Routing Context Gate

**Before changing model precedence or building task prompts, verify:**

- [ ] Empty/whitespace model values treated as absent (not as explicit overrides)
- [ ] Model precedence chain understood: tool override → step model → team role → agent model → parent → registry default
- [ ] Thinking level suffix applied correctly (or intentionally omitted)
- [ ] Secrets redacted in context snippets and child prompts
- [ ] Tests cover: undefined, empty, whitespace, agent, task, parent, and explicit tool override cases

If ANY answer is NO → Stop. Verify model routing before proceeding.

## Anti-patterns

- Letting `agentModel: ""` block parent model fallback.
- Treating parent conversation text as executable instructions rather than context.
- Passing full session transcripts to every child by default.
- Losing thinking level or model changes across session switch/fork flows.

## Worked Examples

### Model precedence chain with all fields

When every level provides a model:

```typescript
// Requested by user/tool: "sonnet-4-2025-01-16"
// Step model (workflow): undefined
// Team role model: undefined
// Agent model: "haiku-4"
// Parent model: "sonnet-4-2025-01-16"
// Model registry: { default: "claude-sonnet-4" }

const result = buildConfiguredModelRouting({
  overrideModel: "sonnet-4-2025-01-16",  // tool override wins
  stepModel: undefined,
  teamRoleModel: undefined,
  agentModel: "haiku-4",
  fallbackModels: ["haiku-3"],
  parentModel: "sonnet-4-2025-01-16",
  modelRegistry: { default: "claude-sonnet-4" },
  cwd,
});

// Result: candidates = ["sonnet-4-2025-01-16"]
// resolved = "sonnet-4-2025-01-16" (override wins)
// reason = "tool override"
```

### Override at each level

```typescript
// Level 1: tool override (highest)
buildConfiguredModelRouting({ overrideModel: "sonnet-4-2025-01-16" });
// → candidates = ["sonnet-4-2025-01-16"]

// Level 2: step model
buildConfiguredModelRouting({ overrideModel: undefined, stepModel: "haiku-4" });
// → candidates = ["haiku-4"]

// Level 3: team role model
buildConfiguredModelRouting({ overrideModel: undefined, stepModel: undefined, teamRoleModel: "sonnet-3.5" });
// → candidates = ["sonnet-3.5"]

// Level 4: agent model with fallback
buildConfiguredModelRouting({ overrideModel: undefined, stepModel: undefined, teamRoleModel: undefined, agentModel: "haiku-3", fallbackModels: ["claude-3-5-haiku-20241022"] });
// → candidates = ["haiku-3", "claude-3-5-haiku-20241022"]
```

### Empty/whitespace/null handling

```typescript
// Empty string treated as absent
buildConfiguredModelRouting({ agentModel: "" });
// → agentModel ignored, falls through to parent

// Whitespace treated as absent
buildConfiguredModelRouting({ agentModel: "   " });
// → agentModel ignored

// null/undefined treated as absent
buildConfiguredModelRouting({ agentModel: undefined });
// → agentModel ignored

// With thinking level suffix
applyThinkingSuffix("sonnet-4-2025-01-16", "medium")
// → "sonnet-4-2025-01-16:medium"

// Invalid thinking level falls back to model without suffix
applyThinkingSuffix("sonnet-4-2025-01-16", "invalid")
// → "sonnet-4-2025-01-16" (suffix ignored)
```

## Common Mistakes

1. **Empty string blocking parent fallback**:
   ```typescript
   // ❌ agentModel: "" blocks parent fallback
   buildConfiguredModelRouting({ agentModel: "" });

   // ✅ Empty string treated as absent
   buildConfiguredModelRouting({ agentModel: undefined });
   ```

2. **Losing thinking level on session switch**:
   ```typescript
   // ❌ Thinking level not persisted in config
   const config = { model: "sonnet-4" }; // no thinking

   // ✅ Thinking level in model suffix
   const config = { model: "sonnet-4:medium" };
   ```

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/model-inheritance.test.ts test/unit/model-precedence.test.ts test/unit/task-output-context-security.test.ts test/unit/extension-api-surface.test.ts
npm test
```
