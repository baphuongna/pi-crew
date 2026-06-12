# pi-crew UI Optimization & Beautification Plan

> Based on deep analysis of oh-my-pi patterns + pi-crew current UI state.
> Date: 2026-06-12
> Status: Draft — awaiting approval

## Current State

### pi-crew UI (~7,800 lines across 45 files)

| Component | Lines | Status |
|---|---|---|
| `run-snapshot-cache.ts` | 827 | Complex, over-engineered |
| `settings-overlay.ts` | 723 | Functional |
| `crew-widget.ts` | 544 | **High complexity, hard to read** |
| `run-dashboard.ts` | 536 | Dense, many responsibilities |
| `mascot.ts` | 444 | Cute but bloated |
| `tool-render.ts` | 380 | **Needs pattern overhaul** |
| `theme-adapter.ts` | 190 | Defensive but verbose |

### Key Problems

1. **No theme color consistency** — `CrewThemeColor` has ~22 slots vs oh-my-pi's 40+
2. **Tool rendering reimplements logic** — pi-brief's delegate-execute pattern is cleaner
3. **Widget is monolithic** — 544 lines doing state management, rendering, caching, and formatting
4. **No structured interaction** — `respond` action is free-text only; no `ask_user`-style schema
5. **Raw ANSI codes in places** — mixing `theme.fg()` with `\x1b[38;5;2m`
6. **No brief/compact mode** — all output is verbose, no toggle for condensed display
7. **Checkpoint display is text-heavy** — run history shows full text vs compact stats

---

## Phase 1: Theme System Upgrade

**Priority**: HIGH — foundation for all other UI work
**Effort**: 2-3 days
**Risk**: LOW (additive changes, no breaking API)

### 1.1 Expand Theme Color Slots

**Current** (`src/ui/theme-adapter.ts`):
```typescript
export type CrewThemeColor =
  | "accent" | "border" | "borderAccent" | "borderMuted"
  | "success" | "error" | "warning" | "muted" | "dim" | "text"
  | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"
  | "syntaxKeyword" | "syntaxString" | "syntaxNumber"
  | "syntaxComment" | "syntaxFunction" | "syntaxVariable"
  | "syntaxType" | "syntaxOperator" | "syntaxPunctuation"
  | "mdCodeBlock";
```

**Target** — add from oh-my-pi's 40+ slots:
```typescript
export type CrewThemeColor =
  // Existing (keep)
  | "accent" | "border" | "borderAccent" | "borderMuted"
  | "success" | "error" | "warning" | "muted" | "dim" | "text"
  | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"
  | "syntaxKeyword" | "syntaxString" | "syntaxNumber"
  | "syntaxComment" | "syntaxFunction" | "syntaxVariable"
  | "syntaxType" | "syntaxOperator" | "syntaxPunctuation"
  | "mdCodeBlock"
  // NEW — message display
  | "userMessageText" | "customMessageLabel"
  // NEW — tool rendering
  | "toolTitle"       // already used in tool-render.ts but missing from type
  | "toolOutput"
  | "toolPending" | "toolSuccess" | "toolError"
  // NEW — markdown
  | "mdHeading" | "mdLink" | "mdCode" | "mdQuote" | "mdHr" | "mdListBullet"
  // NEW — thinking gradient (6 levels)
  | "thinkingOff" | "thinkingMinimal" | "thinkingLow"
  | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh"
  // NEW — special
  | "bashMode" | "thinkingText";

export type CrewThemeBg =
  // Existing
  | "selectedBg" | "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"
  // NEW
  | "customMessageBg";
```

**Files to change**: `src/ui/theme-adapter.ts`

### 1.2 Theme Color Fallback Map

Add default ANSI values for all new slots so widgets work even with minimal themes:

```typescript
const THEME_FALLBACKS: Record<CrewThemeColor, string> = {
  toolTitle: "\x1b[36m",     // cyan
  toolOutput: "\x1b[38;5;245m", // gray
  toolPending: "\x1b[38;5;240m",
  toolSuccess: "\x1b[32m",
  toolError: "\x1b[31m",
  mdHeading: "\x1b[33m",     // yellow
  mdLink: "\x1b[35m",        // indigo
  mdCode: "\x1b[32m",        // green
  // ... all new slots
};
```

### 1.3 Remove Raw ANSI from Business Logic

Find and replace all raw `\x1b[38;5;XXXm` in non-UI files with `theme.fg("slot", text)` calls.

**Files to audit**:
- `src/ui/tool-render.ts` — check for raw ANSI
- `src/extension/registration/commands.ts` — status line rendering
- `src/runtime/task-display.ts` — display formatting

---

## Phase 2: Tool Rendering Overhaul

**Priority**: HIGH — visible improvement to every tool call display
**Effort**: 2-3 days
**Risk**: MEDIUM (changes how tool calls look)

### 2.1 Adopt Rendering-Only Override Pattern

**From oh-my-pi's pi-brief**: Register tool rendering that delegates execution to original.

**Current pi-crew approach** (`src/ui/tool-render.ts`):
- 380 lines of monolithic rendering functions
- Separate `renderTeamToolCall`, `renderAgentToolCall`, `renderTeamToolResult`, `renderAgentToolResult`
- Each function handles both collapsed and expanded mode internally

**Target**: Split into focused renderers using a registry pattern:

```typescript
// src/ui/tool-renderers/index.ts
export interface ToolRenderer {
  renderCall(args: unknown, theme: CrewTheme, expanded: boolean): Component;
  renderResult(result: unknown, theme: CrewTheme, expanded: boolean): Component;
}

// src/ui/tool-renderers/team-renderer.ts
export const teamToolRenderer: ToolRenderer = {
  renderCall(args, theme, expanded) { ... },
  renderResult(result, theme, expanded) { ... },
};

// src/ui/tool-renderers/agent-renderer.ts
export const agentToolRenderer: ToolRenderer = { ... };
```

### 2.2 Compact Brief Mode for Tool Output

**From pi-brief**: Add a configurable "brief" toggle that shows one-line summaries.

```typescript
// New: src/ui/tool-renderers/brief-mode.ts
export function briefResult(result: ToolResult, theme: CrewTheme): string {
  // read → "→ 142 lines"
  // bash → "→ done" or "→ 12 lines"
  // edit → "→ edited +3 -1"
  // write → "→ written"
  // team → "→ 3/3 tasks · 1.2m · 45k tok"
  // agent → "✓ explorer · 8 tools · 23.4s"
}
```

Add `/crew-brief on|off` command and persist state via `pi.appendEntry()`.

### 2.3 Team Tool Result — Compact Stats Display

**From pi-rewind's checkpoint display**: Show goal + task stats in one line.

**Current**:
```
team action='run' (implementation) · status=completed · runId=team_2026... · goal="Investigate failing..."
```

**Target** (compact):
```
✓ team/implementation · 3/3 tasks · 1.2m · ↑45k ↓12k · $0.042
```

With expanded (Ctrl+O):
```
✓ team/implementation · 3/3 tasks · 1.2m · ↑45k ↓12k · $0.042
├─ ✓ explorer · 8 tools · 23.4s · ↑12k ↓4k
├─ ✓ executor · 15 tools · 41.2s · ↑22k ↓6k
└─ ✓ verifier · 5 tools · 12.1s · ↑11k ↓2k
```

---

## Phase 3: Widget Refactor

**Priority**: MEDIUM — internal cleanup, same visual output
**Effort**: 3-4 days
**Risk**: MEDIUM (core display component)

### 3.1 Split crew-widget.ts into Modules

**Current**: 544 lines monolith doing everything.

**Target structure**:
```
src/ui/widget/
├── index.ts              # Public API: updateCrewWidget, stopCrewWidget
├── widget-component.ts   # CrewWidgetComponent class (~100 lines)
├── widget-model.ts       # Data fetching + caching (~100 lines)
├── widget-renderer.ts    # Line building + colorizing (~150 lines)
├── widget-formatters.ts  # formatTokens, formatDuration, agentStats (~100 lines)
└── widget-types.ts       # Shared types
```

### 3.2 Adopt SessionStateMap Pattern

**From oh-my-pi**: Generic session-scoped state container instead of scattered maps.

```typescript
// src/state/session-state-map.ts (new)
export class SessionStateMap<T> {
  private map = new Map<string, T>();
  getOrUndefined(sessionId: string): T | undefined { ... }
  set(sessionId: string, value: T): void { ... }
  delete(sessionId: string): void { ... }
}
```

Use this in widget, dashboard, and live-agent-manager instead of separate `Map<string, ...>` instances.

### 3.3 Render Coalescing Optimization

The widget currently rebuilds signature strings on every render call. Optimize:
- Pre-compute signatures when data changes, not on render
- Use a simple counter-based invalidation instead of string concatenation
- Eliminate `this.cacheSignature` string comparison in hot path

---

## Phase 4: Dashboard Polish

**Priority**: MEDIUM
**Effort**: 3-4 days
**Risk**: LOW

### 4.1 Run History — Compact Checkpoint Style

**From pi-rewind**: Show runs with file-change statistics.

**Current** (status command output):
```
Run: team_20260612100313...
Status: completed
Team: implementation
Goal: Fix failing tests
Tasks: 3/3
Duration: 5m23s
Tokens: 45.2k
```

**Target** (compact):
```
✓ team_...3d7f  implementation · Fix failing tests
   3/3 tasks · 5m23s · ↑45k ↓12k
   14 files +342 -87
```

### 4.2 Agent Progress — Thinking Level Visualization

**From oh-my-pi's thinking gradient**: Show thinking intensity with color gradient.

```typescript
function thinkingColor(level: number, theme: CrewTheme): CrewThemeColor {
  // level 0-5 → off, minimal, low, medium, high, xhigh
  return ["thinkingOff", "thinkingMinimal", "thinkingLow",
          "thinkingMedium", "thinkingHigh", "thinkingXhigh"][level];
}
```

Apply to agent activity line when agent is "thinking..." (no tool call, just LLM processing).

### 4.3 Dashboard Pane Improvements

**Agents pane**: Add compact/expanded toggle per agent
**Progress pane**: Use brief mode rendering from Phase 2
**Mailbox pane**: Add structured response schema option
**Health pane**: Color-code issues by severity

---

## Phase 5: Structured Interaction

**Priority**: MEDIUM
**Effort**: 4-5 days
**Risk**: MEDIUM (new feature)

### 5.1 Structured Respond Action

**From pi-clarify**: Add schema validation to `respond` action.

```typescript
// In team-tool/respond.ts
interface RespondOptions {
  message: string;
  // NEW: structured answer option
  answer?: {
    type: "select" | "text" | "confirm";
    value: string | boolean;
    label?: string;
  };
}
```

### 5.2 Secret Rejection in Tool Inputs

**From pi-clarify's SECRET_WORDS**: Add to all tool inputs that accept user text.

```typescript
const SECRET_PATTERNS = [
  "api key", "apikey", "auth token", "cookie", "credential",
  "password", "private key", "secret", "token",
];
```

Already partially done in `env-filter.ts`, but should extend to `goal`, `message`, `task` parameters.

---

## Phase 6: Code Quality from oh-my-pi

**Priority**: LOW-MEDIUM (foundation for long-term)
**Effort**: 2-3 days
**Risk**: LOW

### 6.1 Type Guard Library

**From runtime-core**: Create `src/utils/guards.ts` with systematic type guards.

```typescript
// src/utils/guards.ts
export function isRecord(value: unknown): value is Record<string, unknown> { ... }
export function isString(value: unknown): value is string { ... }
export function isNumber(value: unknown): value is number { ... }
export function isNonEmptyString(value: unknown): value is string { ... }
export function isArrayOf<T>(guard: (v: unknown) => v is T): (v: unknown) => v is readonly T[] { ... }
export function getStringField(value: unknown, key: string): string | undefined { ... }
export function getNumberField(value: unknown, key: number): number | undefined { ... }
export function errorMessage(err: unknown): string { ... }
```

Replace scattered `typeof x === "string"` checks across codebase.

### 6.2 No-Any Lint Rule

Add ESLint rule to enforce `unknown` over `any`:

```javascript
// .eslintrc
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-call": "error"
  }
}
```

### 6.3 mkdir-Based Locking (Optional)

**From pi-checkpoint**: Replace JSON token-based locks with `mkdir` atomic locks.

This is a bigger change — could be Phase 7 if needed.

---

## Implementation Order & Timeline

| Phase | Duration | Depends On | Impact |
|---|---|---|---|
| **Phase 1**: Theme System | 2-3 days | Nothing | Foundation for all UI |
| **Phase 2**: Tool Rendering | 2-3 days | Phase 1 | Every tool call looks better |
| **Phase 3**: Widget Refactor | 3-4 days | Phase 1 | Internal cleanup |
| **Phase 4**: Dashboard Polish | 3-4 days | Phase 1, 2 | Visible improvement |
| **Phase 5**: Structured Interaction | 4-5 days | Phase 2 | New feature |
| **Phase 6**: Code Quality | 2-3 days | Nothing | Long-term maintainability |

**Total estimated**: 16-22 days (can parallelize Phase 1+6, Phase 2+3)

### Recommended Execution

```
Week 1: Phase 1 (Theme) + Phase 6 (Code Quality)  [parallel]
Week 2: Phase 2 (Tool Rendering)
Week 3: Phase 3 (Widget) + Phase 4 (Dashboard)  [sequential]
Week 4: Phase 5 (Structured Interaction) + polish
```

---

## Success Metrics

| Metric | Current | Target |
|---|---|---|
| Theme color slots | 22 | 40+ |
| Raw ANSI in business logic | ~15 instances | 0 |
| Widget lines of code | 544 | ~150 (per module) |
| Tool result compact display | N/A | All 7 tool types |
| Structured respond | Free text only | Schema-validated |
| `any` in production code | ~40 instances | 0 |
| Type guard reuse | Scattered | Centralized in guards.ts |

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Theme slot additions break existing themes | All new slots have fallback ANSI values |
| Widget refactor breaks live updates | Keep same public API, refactor internals only |
| Brief mode confuses users | Default OFF, toggle via `/crew-brief on` |
| Structured respond breaks existing workflows | `message` field still accepts free text; `answer` is optional |
| No-any lint produces too many errors | Incremental: start with new files, then expand |

---

## Files to Create/Modify

### New Files
- `src/ui/tool-renderers/index.ts`
- `src/ui/tool-renderers/team-renderer.ts`
- `src/ui/tool-renderers/agent-renderer.ts`
- `src/ui/tool-renderers/brief-mode.ts`
- `src/ui/widget/index.ts`
- `src/ui/widget/widget-component.ts`
- `src/ui/widget/widget-model.ts`
- `src/ui/widget/widget-renderer.ts`
- `src/ui/widget/widget-formatters.ts`
- `src/ui/widget/widget-types.ts`
- `src/state/session-state-map.ts`
- `src/utils/guards.ts`

### Modified Files
- `src/ui/theme-adapter.ts` — expand color types + fallbacks
- `src/ui/tool-render.ts` — slim down, delegate to renderers
- `src/ui/crew-widget.ts` — split into widget/ modules
- `src/ui/run-dashboard.ts` — compact display + thinking gradient
- `src/ui/status-colors.ts` — add new status colors
- `src/extension/team-tool/respond.ts` — structured response option
- `src/extension/registration/commands.ts` — add `/crew-brief` command
