# pi-crew Enhancement Opportunities: Detailed Implementation Plans

**Date:** 2026-05-28  
**Based on:** pi-mono `origin/main` review  
**Priority:** Ordered by impact-to-effort ratio

---

## Opportunity 1: BM25 Semantic Reranking for `team action='recommend'`

**Priority:** HIGH  
**Effort:** Medium (2–3 days)  
**Impact:** Significant improvement in team/agent recommendation accuracy

### Problem Statement

Current `recommendTeam()` in `src/extension/team-recommendation.ts` uses **keyword matching** — a simple term-overlap approach. It checks if goal text contains specific keywords (`"review"`, `"security"`, `"implement"`, etc.) to select teams and workflows.

**Weaknesses:**
- `"review my security setup"` → works by accident (contains both keywords)
- `"check if my code has vulnerabilities"` → **fails** (no keyword match, misclassifies as generic)
- `"analyze the authentication flow"` → **fails** (research-like phrasing, but actually review)
- `"find all uses of eval()"` → **fails** (investigation but not security review)
- `"audit the dependency tree"` → **fails** (audit ≠ review keyword in current impl)

BM25 search (`src/utils/bm25-search.ts`) already exists with `searchAgents()` and `searchTeams()`. It's used in `team action='search'` but **not** in `team action='recommend'`.

### Current Architecture

```
recommendTeam(goal)
├── detectTeamIntent()       ← keyword + pattern matching
├── decomposeGoal()         ← parses numbered/bulleted/conjunction lists
└── metadata routing        ← team routing metadata (triggers, useWhen)
    └── NOT using: BM25 search
```

### Proposed Architecture

```
recommendTeam(goal)
├── Phase 1: Keyword Intent (fast path for obvious cases)
│   ├── detectTeamIntent()  ← keep for explicit triggers
│   └── metadata routing    ← keep for exact matches
│
├── Phase 2: BM25 Semantic Reranking (fallback + nuance)
│   ├── searchTeams(goal)   ← BM25 over team name/description/roles
│   └── searchAgents(goal)  ← BM25 over agent name/description/skills
│
├── Phase 3: Score Fusion
│   ├── Combine keyword score + BM25 score
│   └── Boost agents matched on skills (weighted)
│
├── decomposeGoal()         ← keep as-is
└── Format + return
```

### Implementation Details

#### Step 1: Create a scoring fusion module

**File:** `src/extension/recommendation-scoring.ts` (new)

```typescript
import { searchAgents, searchTeams } from "../utils/bm25-search.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { AgentConfig } from "../agents/agent-config.ts";

/**
 * BM25-boosted team/agent score with normalized scores.
 */
export interface SemanticTeamScore {
  team: string;
  bm25Score: number;      // normalized 0-1
  matchedOn: string[];
  blendedScore?: number;  // after fusion
}

export interface SemanticAgentScore {
  agent: string;
  bm25Score: number;      // normalized 0-1
  matchedOn: string[];
  skills: string[];
  blendedScore?: number;  // after fusion
}

/**
 * Fuse keyword-based intent with BM25 semantic search.
 * 
 * Algorithm:
 * 1. Run keyword intent (existing) → base score per team
 * 2. Run BM25 search → semantic score per team/agent
 * 3. Normalize BM25 scores to [0, 1]
 * 4. Blend: final_score = α × keyword_score + (1-α) × bm25_score
 *    where α = 0.4 (keyword still matters for explicit triggers)
 */
export async function computeSemanticScores(
  goal: string,
  resources?: { teams?: TeamConfig[]; agents?: AgentConfig[] }
): Promise<{
  teamScores: Map<string, SemanticTeamScore>;
  agentScores: Map<string, SemanticAgentScore>;
}> {
  const [teamResults, agentResults] = await Promise.all([
    searchTeams(goal, { limit: 10 }),
    searchAgents(goal, { limit: 20 }),
  ]);

  const teamScores = new Map<string, SemanticTeamScore>();
  const agentScores = new Map<string, SemanticAgentScore>();

  const maxTeamScore = teamResults[0]?.score ?? 1;
  const maxAgentScore = agentResults[0]?.score ?? 1;

  for (const r of teamResults) {
    const normalized = maxTeamScore > 0 ? r.score / maxTeamScore : 0;
    teamScores.set(r.team.name, {
      team: r.team.name,
      bm25Score: normalized,
      matchedOn: r.matchedOn,
    });
  }

  for (const r of agentResults) {
    const normalized = maxAgentScore > 0 ? r.score / maxAgentScore : 0;
    agentScores.set(r.agent.name, {
      agent: r.agent.name,
      bm25Score: normalized,
      matchedOn: r.matchedOn,
      skills: r.agent.skills ?? [],
    });
  }

  return { teamScores, agentScores };
}

/**
 * Blend keyword intent with semantic BM25 scores.
 * 
 * Blend formula:
 *   team_score = α × base_intent_score + (1-α) × bm25_score
 *   where:
 *     α = 0.4
 *     base_intent_score = 1.0 if keyword matches, else 0.3
 *     bm25_score = normalized BM25 from searchTeams()
 */
export function blendScores(
  keywordTeam: string,
  teamScores: Map<string, SemanticTeamScore>,
  agentScores: Map<string, SemanticAgentScore>,
  ALPHA = 0.4
): void {
  const intentScore = keywordTeam ? 1.0 : 0.3;

  // Team: blend keyword + BM25
  for (const [team, score] of teamScores) {
    const bm25Component = score.bm25Score * (1 - ALPHA);
    const intentComponent = (team === keywordTeam ? intentScore : 0.3) * ALPHA;
    score.blendedScore = intentComponent + bm25Component;
  }

  // Agent: BM25 + skill domain bonus
  const SKILL_DOMAINS: Record<string, string[]> = {
    "test-engineer": ["test", "spec", "coverage", "verify", "qa", "unit", "integration"],
    "security-reviewer": ["security", "vulnerability", "auth", "owasp", "penetration", "audit"],
    "reviewer": ["review", "check", "verify", "lint", "style"],
    "writer": ["write", "doc", "readme", "guide", "document"],
    "explorer": ["research", "investigate", "find", "trace", "explore", "discover"],
    "planner": ["plan", "design", "architecture", "strategy"],
    "executor": ["implement", "code", "build", "create", "add", "fix"],
  };

  for (const [, score] of agentScores) {
    const skillBonus = Object.entries(SKILL_DOMAINS)
      .filter(([_, keywords]) => keywords.some((kw) => score.agent.toLowerCase().includes(kw)))
      .length * 0.05;
    score.blendedScore = score.bm25Score + Math.min(skillBonus, 0.2);
  }
}
```

#### Step 2: Integrate into `recommendTeam()`

**File:** `src/extension/team-recommendation.ts` (modify)

```typescript
import { computeSemanticScores, blendScores } from "./recommendation-scoring.ts";

// In recommendTeam(), after keyword intent detection.
// Add as optional enhancement with try/catch:

// Replace the metadata routing section with:
const bm25BoostedTeam = await (async () => {
  try {
    const { teamScores } = await computeSemanticScores(goal, resources);
    if (teamScores.size > 0) {
      blendScores(team, teamScores, new Map(), 0.4);
      const sorted = [...teamScores.values()].sort(
        (a, b) => (b.blendedScore ?? 0) - (a.blendedScore ?? 0)
      );
      const top = sorted[0];
      // If BM25 strongly prefers a different team, override
      if (top && top.team !== team && (top.blendedScore ?? 0) > (teamScores.get(team)?.blendedScore ?? 0) + 0.2) {
        return { team: top.team, reason: `BM25 semantic match (${top.matchedOn.join(", ")})` };
      }
    }
  } catch {
    // BM25 scoring is best-effort
  }
  return null;
})();

if (bm25BoostedTeam) {
  team = bm25BoostedTeam.team as typeof team;
  reasons.push(bm25BoostedTeam.reason);
  confidence = "high";
}
```

#### Step 3: Add config flag

**File:** `src/config/types.ts`

```typescript
export interface PiTeamsAutonomousConfig {
  // ... existing fields ...
  /** Use BM25 semantic reranking (default: true) */
  useSemanticReranking?: boolean;
}
```

#### Step 4: Add tests

**File:** `test/unit/recommendation-semantic.test.ts` (new)

Key test cases:
- `"audit dependency tree"` → should suggest `review` team
- `"find XSS vulnerabilities"` → should suggest `security-reviewer` agent
- `"analyze auth flow"` → should suggest `review` team (not research)
- `"check code quality"` → should suggest `review` team (not executor)
- Existing keyword matches should still work (regression)

### Expected Outcomes

| Scenario | Before | After |
|----------|--------|-------|
| `"audit dependency tree"` | `default`, low confidence | `review`, high confidence |
| `"find XSS vulnerabilities"` | `default`, medium | `security-reviewer`, high |
| `"analyze auth flow"` | `default`, low | `review`, high |
| `"implement feature X"` | `implementation` (keyword) | `implementation`, high |

---

## Opportunity 2: Extended Hook Phases (`before_turn` / `after_turn`)

**Priority:** MEDIUM  
**Effort:** Medium (2 days)  
**Impact:** Enables observability, per-turn policies, early abort

### Problem Statement

pi-crew currently has **no turn-level hooks**. When a task runs:
1. `before_task_start` — fires once per task
2. [Task executes — many turns silently]
3. `task_result` — fires once when task completes

Users can't:
- Abort a task mid-execution based on turn content
- Log per-turn metrics (turn count, token usage, thinking time)
- Inject turn-specific instructions
- Detect dangerous operations before they complete

pi-mono's `AgentHarness` formalizes `turn` as a first-class phase with `turn_end` events.

### Key Discovery

`child-pi.ts` already tracks `turnCount` via `onJsonEvent` listening for `turn_end` events from pi:

```typescript
// child-pi.ts line ~457
onJsonEvent: (event) => {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const obj = event as Record<string, unknown>;
    if (obj.type === "turn_end") {
      turnCount += 1;  // ← turn tracking already exists!
      // ... soft/hard limit logic ...
    }
  }
}
```

The `turn_end` event from pi contains:
- `message: AgentMessage` — assistant's response
- `toolResults: ToolResultMessage[]` — tools called in this turn

We can hook into this to fire `before_turn` / `after_turn` hooks.

### Design

Add two new **non-blocking** hooks:

```typescript
// src/hooks/types.ts
export interface TurnContext extends HookContext {
  taskId: string;
  runId: string;
  turnNumber: number;
  messageLength: number;
  toolCallCount: number;
  thinkingMs?: number;
  model?: string;
}
```

### Implementation

#### Step 1: Extend hook types

**File:** `src/hooks/types.ts`

```typescript
// Add TurnContext
export interface TurnContext extends HookContext {
  taskId: string;
  runId: string;
  turnNumber: number;
  messageLength: number;
  toolCallCount: number;
  thinkingMs?: number;
  model?: string;
}

// Add to HookName (registry must be updated first)
export type HookName =
  | "before_run_start" | "before_task_start" | "task_result"
  | "before_cancel" | "before_retry" | "before_forget"
  | "before_cleanup" | "before_publish" | "session_before_switch"
  | "run_recovery"
  | "before_turn" | "after_turn";  // NEW
```

#### Step 2: Add hook to registry

**File:** `src/hooks/registry.ts`

```typescript
// No changes needed — registry is generic over HookName.
// Just need to add "before_turn" | "after_turn" to the HookName union in types.ts.
// All executeHook() calls will work automatically.
```

#### Step 3: Extend ChildPiLifecycleEvent

**File:** `src/runtime/child-pi.ts`

```typescript
// In ChildPiLifecycleEvent type (line ~109):
export interface ChildPiLifecycleEvent {
  type: "spawned" | "spawn_error" | "response_timeout" | "final_drain"
      | "hard_kill" | "exit" | "close" | "turn_begin" | "turn_end";  // NEW
  pid?: number;
  exitCode?: number | null;
  error?: string;
  stderr?: string;
  ts: string;
  // NEW fields for turn events:
  turnNumber?: number;
  messageLength?: number;
  toolCallCount?: number;
  thinkingMs?: number;
}
```

#### Step 4: Instrument turn tracking in child-pi

**File:** `src/runtime/child-pi.ts` (around line 450-470)

Replace the existing `onJsonEvent` block:

```typescript
onJsonEvent: (event) => {
  restartNoResponseTimer();
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const obj = event as Record<string, unknown>;

    // Emit before_turn hook BEFORE processing turn_end
    if (obj.type === "turn_end") {
      const turnNumber = turnCount + 1; // next turn number
      const message = obj.message as Record<string, unknown> | undefined;
      const toolResults = obj.toolResults as unknown[] | undefined;
      const messageLength = JSON.stringify(message).length;
      const toolCallCount = toolResults?.length ?? 0;
      
      // Fire before_turn via lifecycle event
      input.onLifecycleEvent?.({
        type: "turn_begin",
        pid: child.pid,
        turnNumber,
        messageLength,
        toolCallCount,
        ts: new Date().toISOString(),
      });
    }

    // Existing turn-count-based steering
    if (obj.type === "turn_end") {
      turnCount += 1;
      // ... existing soft/hard limit logic ...

      // Fire after_turn via lifecycle event
      input.onLifecycleEvent?.({
        type: "turn_end",
        pid: child.pid,
        turnNumber: turnCount,
        messageLength: JSON.stringify(obj.message).length,
        toolCallCount: (obj.toolResults as unknown[])?.length ?? 0,
        ts: new Date().toISOString(),
      });
    }
  }
  input.onJsonEvent?.(event);
  // ... rest unchanged ...
}
```

#### Step 5: Wire lifecycle events to hooks in task-runner

**File:** `src/runtime/task-runner.ts` (around line 429)

```typescript
// In runChildPi call, add onLifecycleEvent handler:
const childResult = await runChildPi({
  // ... existing params ...
  onLifecycleEvent: async (event) => {
    // Existing logging logic ...

    // NEW: Fire turn hooks
    if (event.type === "turn_begin") {
      await executeHook("before_turn", {
        taskId: task.id,
        runId: manifest.runId,
        turnNumber: event.turnNumber ?? 0,
        messageLength: event.messageLength ?? 0,
        toolCallCount: event.toolCallCount ?? 0,
        thinkingMs: event.thinkingMs,
        cwd: task.cwd,
      }).catch(() => {}); // non-blocking
    }

    if (event.type === "turn_end") {
      await executeHook("after_turn", {
        taskId: task.id,
        runId: manifest.runId,
        turnNumber: event.turnNumber ?? 0,
        messageLength: event.messageLength ?? 0,
        toolCallCount: event.toolCallCount ?? 0,
        thinkingMs: event.thinkingMs,
        cwd: task.cwd,
      }).catch(() => {}); // non-blocking
    }
  },
});
```

#### Step 6: Add tests

**File:** `test/unit/turn-hooks.test.ts` (new)

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerHook, clearHooks, executeHook } from "../../src/hooks/registry.ts";

describe("before_turn hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("fires with correct turn context", async () => {
    registerHook({
      name: "before_turn",
      mode: "non_blocking",
      handler: (ctx) => {
        assert.equal(ctx.taskId, "task-1");
        assert.equal(ctx.turnNumber, 3);
        assert.equal(ctx.messageLength, 150);
        assert.equal(ctx.toolCallCount, 2);
        return { outcome: "allow" };
      },
    });

    const report = await executeHook("before_turn", {
      taskId: "task-1",
      runId: "run-1",
      turnNumber: 3,
      messageLength: 150,
      toolCallCount: 2,
      cwd: "/tmp",
    });

    assert.equal(report.outcome, "allow");
  });

  it("does not block task execution (non-blocking)", async () => {
    registerHook({
      name: "before_turn",
      mode: "non_blocking",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { outcome: "allow" };
      },
    });

    const start = Date.now();
    const report = await executeHook("before_turn", {
      taskId: "task-1",
      runId: "run-1",
      turnNumber: 1,
      messageLength: 0,
      toolCallCount: 0,
      cwd: "/tmp",
    });
    const elapsed = Date.now() - start;

    assert.equal(report.outcome, "allow");
    assert.ok(elapsed < 50, "Non-blocking hook should not delay execution");
  });
});

describe("after_turn hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("receives complete turn metrics", async () => {
    const received: Record<string, unknown> = {};
    registerHook({
      name: "after_turn",
      mode: "non_blocking",
      handler: (ctx) => {
        Object.assign(received, ctx);
        return { outcome: "allow" };
      },
    });

    await executeHook("after_turn", {
      taskId: "task-1",
      runId: "run-1",
      turnNumber: 5,
      messageLength: 1024,
      toolCallCount: 3,
      thinkingMs: 3500,
      cwd: "/tmp",
    });

    assert.equal(received.turnNumber, 5);
    assert.equal(received.messageLength, 1024);
    assert.equal(received.toolCallCount, 3);
    assert.equal(received.thinkingMs, 3500);
  });
});
```

### Expected Outcomes

| Use Case | Before | After |
|----------|--------|-------|
| Per-turn observability | None | `before_turn`/`after_turn` fire per turn |
| Dangerous operation detection | Only at task end | Can abort mid-task via `before_turn` block |
| Turn metrics logging | None | Available: turn count, message length, tool calls, thinking time |
| Thinking time tracking | Not exposed | Available via `thinkingMs` |

---

## Opportunity 3: Hook Lifecycle Test Suite

**Priority:** MEDIUM  
**Effort:** Small (1 day)  
**Impact:** Ensures hook reliability, prevents regressions

### Current State

pi-crew has 3 hook test files:
- `test/unit/hooks.test.ts` — basic registry/execution tests (8 tests)
- `test/unit/lifecycle-hooks.test.ts` — lifecycle integration (6 tests)  
- `test/unit/recovery-hooks.test.ts` — recovery hooks

**Gap:** No tests for `task_result`, `before_publish`, `session_before_switch`, `run_recovery`, `before_retry` hooks.

### Test Suite Plan

**File:** `test/unit/hook-full-lifecycle.test.ts` (new)

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { registerHook, clearHooks, executeHook } from "../../src/hooks/registry.ts";
import type { HookResult } from "../../src/hooks/types.ts";

describe("task_result hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("receives task context and result data", async () => {
    let receivedCtx: Record<string, unknown> = {};
    registerHook({
      name: "task_result",
      mode: "non_blocking",
      handler: (ctx) => {
        receivedCtx = { ...ctx };
        return { outcome: "allow" };
      },
    });

    await executeHook("task_result", {
      taskId: "task-1",
      runId: "run-1",
      cwd: "/tmp",
      data: { status: "success", outputLength: 2048 },
    });

    assert.equal(receivedCtx.taskId, "task-1");
    assert.deepEqual((receivedCtx as Record<string, unknown>).data, { status: "success", outputLength: 2048 });
  });

  it("non-blocking hook does not affect task completion", async () => {
    registerHook({
      name: "task_result",
      mode: "non_blocking",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { outcome: "allow" };
      },
    });

    const start = Date.now();
    const report = await executeHook("task_result", {
      taskId: "task-1",
      runId: "run-1",
      cwd: "/tmp",
    });
    assert.ok(Date.now() - start < 100);
    assert.equal(report.outcome, "allow");
  });
});

describe("run_recovery hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("fires with run context on crash recovery", async () => {
    registerHook({
      name: "run_recovery",
      mode: "blocking",
      handler: (ctx) => ({ outcome: "allow" }),
    });

    const report = await executeHook("run_recovery", {
      runId: "run-crash-1",
      cwd: "/tmp",
      data: { crashReason: "child process exit", pid: 12345 },
    });

    assert.equal(report.outcome, "allow");
  });

  it("can block recovery", async () => {
    registerHook({
      name: "run_recovery",
      mode: "blocking",
      handler: () => ({ outcome: "block", reason: "Maintenance hold" }),
    });

    const report = await executeHook("run_recovery", {
      runId: "run-blocked",
      cwd: "/tmp",
    });

    assert.equal(report.outcome, "block");
    assert.match(report.reason ?? "", /Maintenance hold/);
  });
});

describe("before_retry hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("can allow retry", async () => {
    registerHook({
      name: "before_retry",
      mode: "blocking",
      handler: () => ({ outcome: "allow" }),
    });

    const report = await executeHook("before_retry", {
      runId: "run-1",
      cwd: "/tmp",
      data: { attemptNumber: 2 },
    });

    assert.equal(report.outcome, "allow");
  });

  it("can block retry with reason", async () => {
    registerHook({
      name: "before_retry",
      mode: "blocking",
      handler: () => ({ outcome: "block", reason: "Max retries exceeded" }),
    });

    const report = await executeHook("before_retry", {
      runId: "run-max",
      cwd: "/tmp",
    });

    assert.equal(report.outcome, "block");
  });
});

describe("before_publish hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("fires before run publication", async () => {
    registerHook({
      name: "before_publish",
      mode: "blocking",
      handler: () => ({ outcome: "allow" }),
    });

    const report = await executeHook("before_publish", {
      runId: "run-pub",
      cwd: "/tmp",
    });

    assert.equal(report.outcome, "allow");
  });
});

describe("session_before_switch hook", () => {
  beforeEach(() => clearHooks());
  afterEach(() => clearHooks());

  it("receives session context", async () => {
    registerHook({
      name: "session_before_switch",
      mode: "blocking",
      handler: () => ({ outcome: "allow" }),
    });

    const report = await executeHook("session_before_switch", {
      runId: "run-session",
      cwd: "/tmp",
      data: { fromSession: "old", toSession: "new" },
    });

    assert.equal(report.outcome, "allow");
  });
});
```

### Additional Coverage

Add edge case tests to `test/unit/hooks.test.ts`:
- Hook timeout: if a non-blocking hook hangs >5s, it should not block
- Multiple hooks same name: all execute in registration order
- Hook with modify outcome: context is mutated correctly
- Error in non-blocking hook: error is logged, execution continues
- Dynamic hook registration during hook execution: safe (no concurrent modification)

---

## Opportunity 4: Phase Tracking + Hook Documentation

**Priority:** LOW-MEDIUM  
**Effort:** Small-Medium (1-2 days)  
**Impact:** Developer experience, observability

### A. Task Phase Tracking

Add a `phase` field to task records for observability.

**File:** `src/state/types.ts`

```typescript
// Add to TaskRecord or create new TaskPhase type
export type TaskPhase = 
  | "pending"      // Queued, not started
  | "exploring"    // Initial research/discovery
  | "planning"     // Planning subtasks
  | "executing"    // Actively running
  | "verifying"    // Running verification
  | "finalizing"   // Wrapping up
  | "done"         // Complete
  | "failed"       // Error
  | "cancelled";   // User cancelled

// In TaskRecord:
export interface TaskRecord {
  // ... existing fields ...
  phase?: TaskPhase;
  phaseHistory?: Array<{ phase: TaskPhase; at: string; turnNumber?: number }>;
}
```

**File:** `src/runtime/task-runner.ts` — update phase at key points:

```typescript
// On task start:
updateTaskPhase(task.id, "exploring");

// After planner produces plan:
updateTaskPhase(task.id, "planning");

// During execution:
updateTaskPhase(task.id, "executing");

// After verification:
updateTaskPhase(task.id, "verifying");

// On completion:
updateTaskPhase(task.id, "done");

// On error:
updateTaskPhase(task.id, "failed");
```

**File:** `src/extension/team-tool/status.ts` — surface phase in `team action='status'`:

```
Task: 01_explore [exploring] ████████░░ 80%
Task: 02_plan [pending] ░░░░░░░░░░ 0%
```

### B. Hook Documentation

**File:** `docs/hooks.md` (new)

```markdown
# pi-crew Hook System

Hooks allow you to intercept and modify pi-crew lifecycle events. They can block operations, 
inject data, or log for observability.

## Available Hooks

| Hook | Type | Blocking | Description |
|------|------|----------|-------------|
| `before_run_start` | Run | ✅ | Fires before a team run begins. Return `block` to prevent the run. |
| `before_task_start` | Task | ✅ | Fires before each task begins. Return `block` to skip the task. |
| `task_result` | Task | ❌ | Fires after each task completes. Non-blocking — won't affect task outcome. |
| `before_cancel` | Run | ✅ | Fires before a run is cancelled. Return `block` to prevent cancellation. |
| `before_retry` | Run | ✅ | Fires before a failed run is retried. Return `block` to prevent retry. |
| `before_forget` | Run | ✅ | Fires before run state is deleted. Return `block` to preserve state. |
| `before_cleanup` | Run | ✅ | Fires before cleanup operation. Return `block` to prevent cleanup. |
| `before_publish` | Run | ✅ | Fires before a run is published. Return `block` to prevent publishing. |
| `session_before_switch` | Session | ✅ | Fires before switching sessions. Return `block` to prevent switch. |
| `run_recovery` | Run | ✅ | Fires during crash recovery. Return `block` to abort recovery. |
| `before_turn` | Turn | ❌ | Fires before each turn (requires implementation). |
| `after_turn` | Turn | ❌ | Fires after each turn completes (requires implementation). |

## Hook Modes

### Blocking
Blocking hooks receive the context and return a decision. If the decision is `block`, 
the operation is aborted immediately.

```typescript
registerHook({
  name: "before_run_start",
  mode: "blocking",
  handler: (ctx) => {
    if (ctx.data?.someCondition) {
      return { outcome: "block", reason: "Condition not met" };
    }
    return { outcome: "allow" };
  },
});
```

### Non-Blocking
Non-blocking hooks run asynchronously. Errors are caught and logged but don't affect the operation.

```typescript
registerHook({
  name: "task_result",
  mode: "non_blocking",
  handler: async (ctx) => {
    await sendToExternalSystem(ctx.data);
    return { outcome: "allow" };
  },
});
```

## Modify Outcome

Hooks can modify context data for subsequent hooks or the operation itself.

```typescript
registerHook({
  name: "before_task_start",
  mode: "non_blocking",
  handler: (ctx) => ({
    outcome: "modify",
    data: { ...ctx.data, injectedField: "value" },
  }),
});
```

## Example: Auto-cancel duplicate runs

```typescript
registerHook({
  name: "before_run_start",
  mode: "blocking",
  handler: (ctx) => {
    const activeRuns = getActiveRuns();
    if (activeRuns.some(r => r.goal === ctx.data?.goal && r.runId !== ctx.runId)) {
      return { outcome: "block", reason: "Another run with the same goal is already active." };
    }
    return { outcome: "allow" };
  },
});
```

## Example: External logging

```typescript
registerHook({
  name: "task_result",
  mode: "non_blocking",
  handler: async (ctx) => {
    await fetch("https://metrics.example.com/hook", {
      method: "POST",
      body: JSON.stringify({ runId: ctx.runId, taskId: ctx.taskId, ...ctx.data }),
    });
    return { outcome: "allow" };
  },
});
```

## Example: Rate limiting

```typescript
const recentCancellations = new Map<string, number>();
registerHook({
  name: "before_cancel",
  mode: "blocking",
  handler: (ctx) => {
    const count = (recentCancellations.get(ctx.runId) ?? 0) + 1;
    recentCancellations.set(ctx.runId, count);
    if (count > 3) {
      return { outcome: "block", reason: "Too many cancellations. Wait before cancelling again." };
    }
    return { outcome: "allow" };
  },
});
```
```

---

## Implementation Priority

| # | Opportunity | Priority | Effort | Impact | Action |
|---|-------------|----------|--------|--------|--------|
| 1 | BM25 Semantic Reranking | HIGH | Medium | High | Start next sprint |
| 2 | Extended Hook Phases | MEDIUM | Medium | Medium | Design review needed |
| 3 | Hook Lifecycle Tests | MEDIUM | Small | Medium | Write tests now |
| 4A | Task Phase Tracking | LOW | Small | Low | Nice-to-have |
| 4B | Hook Documentation | LOW | Small | Medium | Write docs now |
