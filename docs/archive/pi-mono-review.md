# pi-mono Review: Full May 2026 Analysis

**Date:** 2026-05-28  
**Reviewed:** Direct source reading of `packages/agent/`, `packages/ai/`, `packages/coding-agent/`  
**Source:** `origin/main` (up to date)

> **Focused coding-agent analysis:** See [`docs/coding-agent-optimization.md`](./coding-agent-optimization.md) for actionable optimization opportunities for pi-crew.

---

## Executive Summary

**No breaking changes found.** The entire May refactor is additive or internal. Both `Agent` (legacy harness) and `AgentHarness` (new harness) coexist. pi-crew's usage of the `Agent` class via `child-pi.ts` spawning is **fully compatible**.

---

## 1. Architecture: Two Harnesses Coexist

### Legacy Harness: `Agent` class (`packages/agent/src/agent.ts`)

```typescript
// Still the primary harness used by coding-agent
export class Agent {
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void>
  async abort(): void
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void): () => void
  // ... existing API unchanged
}
```

This is what pi-crew's `child-pi.ts` spawns — **no breaking changes**.

### New Harness: `AgentHarness` class (`packages/agent/src/harness/agent-harness.ts`)

```typescript
// New harness, built on top of runAgentLoop, with richer APIs
export class AgentHarness {
  async prompt(text: string, options?: AgentHarnessPromptOptions): Promise<AssistantMessage>
  async steer(text: string): Promise<void>
  async setModel(model: Model<any>): Promise<void>
  async setThinkingLevel(level: ThinkingLevel): Promise<void>
  async setResources(resources: AgentHarnessResources): Promise<void>
  async navigateTree(options: NavigateTreeOptions): Promise<NavigateTreeResult>
  async abort(): Promise<AbortResult>
}
```

**Both use the same `runAgentLoop`** internally. `AgentHarness` wraps it with richer state management, resource loading, and session persistence.

### Session System (`packages/agent/src/harness/session/`)

New formal session infrastructure (1,008 lines across 7 files):

```typescript
// Session storage with JSONL backend
SessionStorage<TMetadata> {
  getMetadata(), setLeafId(), createEntryId(), appendEntry(),
  getEntry(), findEntries(), getLabel(), getPathToRoot(), getEntries()
}

// Session repo with fork/list/delete
SessionRepo<TMetadata, TCreateOptions, TListOptions> {
  create(), open(), list(), delete(), fork()
}
```

**pi-crew's event log** (`src/state/event-log.ts`) uses its own JSONL format — no conflict.

---

## 2. New Hooks (AgentHarness)

### `context` hook

Fires before each LLM call to allow context transformation:

```typescript
// agent-harness.ts line ~413
const result = await this.emitHook({ type: "context", messages: [...messages] });
```

**pi-crew relevance:** Currently pi-crew uses `before_agent_start` only. The `context` hook would allow per-turn context injection (e.g., pruning, external context injection).

### `resources_update` hook

Fires when resources (skills/prompt templates) change mid-run:

```typescript
type: "resources_update";
resources: AgentHarnessResources;
previousResources: AgentHarnessResources;
```

**pi-crew relevance:** Useful for dynamic skill loading during task execution.

### `model_select` / `thinking_level_select` hooks

Fire when the model or thinking level changes mid-run.

**pi-crew relevance:** Supports the `prepareNextTurn` dynamic model switching pattern.

---

## 3. New `prepareNextTurn` API

```typescript
// packages/agent/src/types.ts
prepareNextTurn?: (
  context: PrepareNextTurnContext,
) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

interface AgentLoopTurnUpdate {
  context?: AgentContext;      // replacement context
  model?: Model<any>;          // new model for next turn
  thinkingLevel?: ThinkingLevel; // new thinking level
}
```

Called after each `turn_end` and before deciding whether to start another LLM call. Enables **dynamic model routing** mid-run without restarting.

**pi-crew relevance:** Process-per-task model means each task is already isolated. No use for `prepareNextTurn`. However, this could enable a future single-process execution mode.

---

## 4. New `shouldStopAfterTurn` API

```typescript
shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
```

Called after each turn completes. Return `true` to gracefully stop after the current turn (without starting another LLM call).

**pi-crew relevance:** Could be used to implement turn-count-based task completion (instead of relying on `maxTurns` in child-pi).

---

## 5. New `transformContext` API

```typescript
transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
```

Applied to context before `convertToLlm` at each turn. For context window management or external context injection.

**pi-crew relevance:** Could replace the current approach of rewriting prompts in `before_agent_start` — instead, transform the full context between turns.

---

## 6. Result Type System

```typescript
// packages/agent/src/harness/types.ts
export type Result<TValue, TError> = 
  | { ok: true; value: TValue } 
  | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError>
export function err<TValue, TError>(error: TError): Result<TValue, TError>
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue
```

Formal result type for all harness filesystem and execution operations. Prevents thrown exceptions for expected failures.

**pi-crew relevance:** No current use. If pi-crew ever uses `AgentHarness` directly, this would be the expected error-handling pattern.

---

## 7. Image Generation API (`@earendil-works/pi-ai`)

```typescript
// packages/ai/src/images.ts
export async function generateImages<TApi extends ImagesApi>(
  model: ImagesModel<TApi>,
  context: ImagesGenerationContext,
  options?: ImagesGenerationOptions
): Promise<ImageResult[]>
```

New image generation capability. Providers: OpenRouter images, Flux, DALL-E, etc.

**pi-crew relevance:** Tasks can now use image generation. No API change needed — pi handles it.

---

## 8. Explicit Session ID Naming

```typescript
// packages/coding-agent/src/core/session-manager.ts
this.sessionId = options?.id ?? createSessionId();
```

Users can now specify a custom session ID on startup.

**pi-crew relevance:** Could enhance `inheritContext` feature — pass a named session instead of raw JSON.

---

## 9. Stream Options Patch System

```typescript
// AgentHarnessStreamOptionsPatch — returned by before_provider_request hooks
export interface AgentHarnessStreamOptionsPatch {
  transport?: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string | undefined>; // undefined = delete
  metadata?: Record<string, unknown | undefined>;
}
```

Hooks can now **modify stream options** before each LLM call (per-turn patching).

**pi-crew relevance:** Could enable per-task timeout/retries via hooks instead of process-level limits.

---

## 10. Bug Fixes Affecting pi-crew

### Tool Preflight Abort (`b9448276`)

**Before:** When a run was aborted, sibling tool calls kept preparing in parallel.

**After:** `signal?.aborted` check breaks the tool execution loop immediately.

```typescript
// agent-loop.ts
if (signal?.aborted) {
  break; // Stop preparing sibling tool calls
}
```

**pi-crew relevance:** When pi-crew calls `cancel` on a running task, pi now correctly stops tool preflight immediately. Previously, pending tool calls could continue executing even after cancellation.

### RPC Child Process Exit (`e007fcd0`)

RPC now rejects pending requests when child process exits. Affects `child-pi.ts` communication.

---

## 11. AgentHarness Key Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `harness/agent-harness.ts` | ~950 | Main orchestrator |
| `harness/types.ts` | ~817 | All types, hooks, error codes |
| `harness/session/session.ts` | 252 | Session abstraction |
| `harness/session/jsonl-storage.ts` | 293 | JSONL persistence |
| `harness/session/session-repo.ts` | 231 | Session CRUD |
| `harness/skills.ts` | 375 | Skill loading + formatting |
| `harness/prompt-templates.ts` | 267 | Prompt template processing |
| `harness/compaction/compaction.ts` | 842 | Transcript compaction |
| `harness/compaction/branch-summarization.ts` | 355 | Branch summarization |
| `harness/env/nodejs.ts` | 370+ | Node.js execution environment |
| `harness/execution-env.ts` | Abstract | FS + shell abstraction |

---

## 12. Opportunities for pi-crew Enhancement

> **Full plans:** [`docs/pi-mono-opportunities.md`](./pi-mono-opportunities.md)

### High Priority

**BM25 Semantic Reranking** — Fix `recommendTeam()` keyword failures by integrating existing BM25 search.

### Medium Priority

**Extended Hook Phases** — `before_turn`/`after_turn` hooks using existing `turn_end` tracking in `child-pi.ts`.

**Hook Lifecycle Tests** — Cover untested hooks: `task_result`, `before_retry`, `before_publish`, `session_before_switch`, `run_recovery`.

### Future (6+ months)

**AgentHarness Migration** — When `AgentHarness` stabilizes (removes `Agent` dependency), pi-crew could replace `child-pi.ts` spawning with harness-based in-process execution. **Not a current concern.**

---

## 13. Summary

| Check | Result |
|-------|--------|
| Breaking API changes | **None** |
| `Agent` class API | **Unchanged** — pi-crew compatible |
| `AgentHarness` class | **New** — additive, not used by pi-crew |
| New hooks | `context`, `resources_update`, `model_select`, `thinking_level_select` |
| New lifecycle APIs | `prepareNextTurn`, `shouldStopAfterTurn`, `transformContext` |
| New providers/features | Together AI, Xiaomi MiMo, Image generation, Codex websocket |
| Bug fixes affecting pi-crew | Tool preflight abort, RPC child exit |
| Migration path | AgentHarness (6+ months out, not urgent) |

**Conclusion:** pi-crew is fully compatible with the latest pi source. The `AgentHarness` refactor is substantial but additive — it coexists with the legacy `Agent` class that pi-crew uses. Focus on pi-crew-specific enhancements. Monitor `AgentHarness` stabilization for future migration.
