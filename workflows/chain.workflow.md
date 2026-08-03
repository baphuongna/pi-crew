---
name: chain
description: Sequential execution with context passing
topology: dynamic
---

# Chain Workflow - Sequential execution with context passing

**Source:** pi-boomerang integration plan  
**Syntax:** `step1 -> step2 -> step3`  
**Version:** 1.0.0

---

## Overview

The Chain workflow enables sequential execution of multiple teams with automatic context passing between steps. Each step receives a handoff summary from the previous step, enabling informed execution without repeating context.

## Usage

```bash
# Simple team chain
pi team run --chain "@research -> @implement -> @review"

# With model override
pi team run --chain "@research -> @implement --model claude-opus-3 -> @review"

# With inline goals
pi team run --chain '"Research AI trends" -> "Analyze findings" -> "Write report"'

# Global model override
pi team run --chain "@step1 -> @step2 -> @step3" --global-model claude-sonnet-4

# With timeout
pi team run --chain "@step1 --timeout 60 -> @step2"

# Continue on error
pi team run --chain "@step1 -> @step2" --continue-on-error
```

## Chain Syntax

### Step References

| Syntax | Type | Example |
|--------|------|---------|
| `@teamName` | Team reference | `@research` |
| `workflow:name` | Workflow reference | `workflow:build` |
| `template:name` | Template reference | `template:planning` |
| `"goal text"` | Inline goal | `"Research AI trends"` |

### Per-Step Overrides

| Flag | Description | Example |
|------|-------------|---------|
| `--model <model>` | Override model | `--model claude-opus-3` |
| `--skill <skill>` | Override skill | `--skill coding` |
| `--thinking <mode>` | Thinking mode | `--thinking deep` |
| `--timeout <seconds>` | Step timeout | `--timeout 60` |
| `--continue-on-error` | Continue chain on failure | `--continue-on-error` |

### Global Overrides

| Flag | Description | Example |
|------|-------------|---------|
| `--global-model <model>` | Apply to all steps | `--global-model sonnet` |
| `--global-skill <skill>` | Apply to all steps | `--global-skill writing` |
| `--global-thinking <mode>` | Apply to all steps | `--global-thinking fast` |
| `--continue-on-error` | Continue on any step failure | `--continue-on-error` |

## Workflow Definition

```yaml
name: chain
description: Sequential execution with context passing
syntax: "step1 -> step2 -> step3"

steps:
  - id: chain_executor
    role: chain-executor
    task: |
      Execute the chain: {chain}
      
      Each step receives context from previous steps.
      Generate handoff summary after each step.

configuration:
  # Chain parser settings
  parser:
    stepSeparator: "->"
    trimWhitespace: true
    validateReferences: true
  
  # Handoff settings
  handoff:
    generateBetweenSteps: true
    accumulateContext: true
    maxHandoffHistory: 10
  
  # Execution settings
  execution:
    sequential: true
    stopOnFailure: true
    timeoutPerStep: 300000  # 5 minutes
```

## Context Passing

When running a chain:

1. **Initial context** is passed to the first step
2. **Handoff summary** is generated after each step completes
3. **Chain history** is appended to context for subsequent steps

### Handoff Summary Structure

```typescript
interface HandoffSummary {
  taskId: string;
  runId: string;
  timestamp: number;
  
  task: string;
  outcome: "success" | "failure" | "partial";
  
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  
  decisions: Decision[];
  
  blockers: string[];
  nextSteps: string[];
  
  metrics: {
    tokensUsed: number;
    duration: number;
    iterations: number;
    toolsUsed: string[];
  };
  
  contextSnapshot: string;
}
```

### Chain History Format

```typescript
interface ChainHistoryEntry {
  step: string;
  outcome: string;
  filesCreated: string[];
  filesModified: string[];
  decisions: string[];
  nextSteps: string[];
}
```

## Examples

### Research → Implement → Review

```bash
pi team run \
  --team implementation \
  --workflow chain \
  --chain "@research:gather -> @implement:build -> @review:verify" \
  --goal "Build feature X with research, implementation, and review"
```

### Multi-Model Pipeline

```bash
pi team run \
  --chain "@fast-research --model haiku -> @deep-analysis --model opus -> @summary --model sonnet" \
  --goal "Analyze codebase and produce documentation"
```

### Error-Tolerant Pipeline

```bash
pi team run \
  --chain "@step1 -> @step2 -> @step3" \
  --continue-on-error \
  --goal "Run data pipeline with graceful degradation"
```

## Integration Points

### Retry Support

Chains can be combined with retry configuration:

```typescript
interface ChainRetryConfig {
  maxAttempts: number;
  summaryBetweenAttempts: boolean;
  stopOnSuccess: boolean;
  backoffMs?: number;
}

// Example: Retry each step up to 2 times
const config: ChainRetryConfig = {
  maxAttempts: 2,
  summaryBetweenAttempts: true,
  stopOnSuccess: true,
  backoffMs: 1000,
};
```

### Budget Tracking

Chain execution supports budget tracking per step:

```bash
pi team run \
  --chain "@step1 -> @step2" \
  --budget-total 100000 \
  --budget-warning 80000
```

## Event Types

| Event | Description |
|-------|-------------|
| `chain.started` | Chain execution began |
| `chain.step_completed` | Step completed successfully |
| `chain.step_failed` | Step failed |
| `chain.completed` | All steps completed |
| `chain.failed` | Chain failed |

## Error Handling

### Default Behavior

- Chain stops on first failure
- Handoff from failed step includes error details
- Final result includes all attempted steps

### Continue on Error

```bash
pi team run --chain "@step1 -> @step2" --continue-on-error
```

- All steps execute regardless of failures
- Each step receives context from previous (even failed) steps
- Final result indicates overall success/failure

## Related Features

- **HandoffManager** (`src/runtime/handoff-manager.ts`) - Generates structured summaries
- **RetryRunner** (`src/runtime/retry-runner.ts`) - Retry with accumulated context
- **BudgetTracker** - Token budget tracking across steps

---

*Generated from pi-boomerang integration plan.*