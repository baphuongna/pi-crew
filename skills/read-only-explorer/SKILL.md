---
name: read-only-explorer
description: >
  Read-only exploration and audit workflow.
  When NOT to use: any task that needs write actions; deep adversarial analysis (use council); quick one-line lookups (use bash directly).

origin: pi-crew
triggers:
  - "explore code"
  - "audit source"
  - "review code"
  - "analyze codebase"
  - "source audit"

---
# read-only-explorer

Use this skill for explorer, analyst, reviewer, and source-audit roles. These roles must inspect code without modifying it.

## Core Contract

1. **Do not edit files** — no write, no edit, no delete
2. **Do not write generated artifacts** outside the run artifact directory
3. **Prefer read-only commands**: `read`, `rg`, `find`, `ls`, `git status`
4. **Record exact files inspected** — include path and relevant line numbers
5. **Distinguish direct evidence from inference** — don't guess
6. **If implementation is needed, recommend** — don't modify code

## Tool Selection Guide

Choosing the right tool for the task reduces noise and speeds up discovery.

### `rg` (ripgrep) — Code pattern search

**Best for:** Finding function definitions, imports, patterns, usages
```
# Find all uses of a function
rg "functionName" --type ts

# Find with context (2 lines before/after)
rg "pattern" -B2 -A2

# Case-insensitive
rg -i "error handling"

# Only match whole word
rg -w "agent"

# JSON output for machine parsing
rg "pattern" --json | head -20

# Respect .gitignore (skip node_modules)
rg "pattern" --type-add 'exclude:*.json' --type ts
```

### `find` — File and directory search

**Best for:** Finding files by name, type, or path pattern
```
# Find all TypeScript files
find . -name "*.ts" -not -path "*/node_modules/*" | head -20

# Find recently modified files
find . -name "*.ts" -mtime -7 | head -20

# Find files larger than 100KB
find . -size +100k -name "*.ts"

# Find by path pattern
find . -path "*/runtime/*" -name "*.ts" | head -10
```

### `read` — File content inspection

**Best for:** Reading specific files or file sections
```
# Read full file
read file.ts

# Read with line numbers
read -n file.ts  # (use read tool with offset/limit)

# Read first N lines
read --limit 50 file.ts

# Read specific section
read --offset 100 --limit 30 file.ts
```

### `ls` — Directory structure

**Best for:** Listing directories, understanding layout
```
ls src/runtime/
ls -la .crew/state/runs/ | head -20
ls skills/ | head -20
```

### `git` — Version control inspection

**Best for:** Understanding history, changes, and authorship
```
git status --short
git diff HEAD~3 --stat
git log --oneline -10
git show <commit-hash> --stat
git blame src/file.ts | head -20
git branch -a
```

## Scope Containment

Limit searches to relevant areas to avoid noise.

### By directory
```
# Only search runtime directory
rg "pattern" src/runtime/ --type ts

# Exclude test and node_modules
rg "pattern" --type ts --exclude "test/**" --exclude "node_modules/**"
```

### By file type
```
# Only TypeScript files
rg "pattern" --type ts

# Only test files
rg "pattern" --type-add 'test:*.test.ts' --type test

# Exclude generated files
rg "pattern" --glob "!**/*.generated.ts"
```

### By depth
```
# Only top-level config files
find . -maxdepth 2 -name "*.json" | head -20
```

## Findings Format

Every finding should be documented with:

```text
path/to/file.ts:123
Evidence: <what you read>
Severity: critical|high|medium|low
Finding: <what the problem is>
Impact: <why it matters>
Recommendation: <what to do next>
```

**Example:**
```
src/runtime/agent-manager.ts:87
Evidence: throw new Error("Agent not found") with no error code
Severity: medium
Finding: Error thrown without structured error code makes debugging harder
Impact: Hard to distinguish "not found" from "access denied" or other failures
Recommendation: Use typed CrewError with error code enum instead
```

## Risk Assessment Criteria

| Severity | Criteria |
|---|---|
| **critical** | Data loss, secret leak, arbitrary command/path escape, broken install |
| **high** | Broken core workflow, ownership bypass, persistent incorrect state |
| **medium** | Important regression, flaky test, confusing behavior |
| **low** | Polish, maintainability, missing docs |

## Next Steps Format

When recommending implementation, structure it as:

```
1. Files to create:
   - src/new-feature.ts (new module)

2. Files to modify:
   - src/existing.ts (add function X, change line Y)

3. Tests to add:
   - test/unit/new-feature.test.ts

4. Verification:
   - npx tsc --noEmit
   - npm test
```

## Reading Large Codebases Efficiently

### Chunk strategy
1. Start with entry point (main file, index, README)
2. Find key function calls → follow the chain
3. Read function signatures before bodies
4. Skip test files unless investigating specific test behavior

### Trace data flow
```
user input → config resolution → function call → state write → UI update
```

For each step, identify:
- What data enters
- What transforms it
- What exits
- Where it could fail

### Distinguish evidence from inference

| Type | Description | Example |
|---|---|---|
| **Direct evidence** | Exact content read from file | `"type": "worker.spawned"` found at line 42 |
| **Inference** | Interpretation based on evidence | "Worker likely crashed because exit code was 1" |
| **Unknown** | Not confirmed | "This might be a race condition" |

Always label uncertainty clearly. Use "may", "might", "could" for inference; "is", "shows", "contains" for evidence.

## Enforcement — Read-Only Explorer Gate

**Before reporting findings, verify:**

- [ ] No files edited, written, or deleted (read-only contract maintained)
- [ ] Findings include: path, line, evidence, severity, impact, recommendation
- [ ] Exact files inspected recorded with paths and line numbers
- [ ] Direct evidence distinguished from inference (cite vs guess)
- [ ] If implementation needed, recommend (do not modify code)

If ANY answer is NO → Stop. Adhere to read-only contract.

## Anti-patterns

- **Editing during exploration**: If you need to add logging or print statements, use a separate test script instead of modifying source files.
- **Broad searches without context**: `rg "error"` returns thousands of results. Narrow by file, directory, or surrounding context.
- **Trusting comments over code**: Comments can be outdated. Read the actual code.
- **Skipping test files**: Tests often reveal the intended behavior and edge cases. Read them.
- **Not recording files inspected**: Without exact paths, findings can't be verified.
- **Inference as fact**: If unsure, mark it as inference.

## Source patterns

- `src/runtime/task-runner.ts` — task execution pipeline
- `src/runtime/child-pi.ts` — worker spawning
- `src/runtime/live-agent-manager.ts` — live agent lifecycle
- `src/state/event-log.ts` — event logging system
- `src/extension/team-tool/` — API and tool handling
- `src/ui/` — widget and TUI rendering

## Verification

```bash
cd pi-crew

# Verify no files were modified
git status --short

# Count inspected files
rg "pattern" --type ts | wc -l

# Check for direct evidence in event log
cat .crew/state/runs/<runId>/events.jsonl | grep "worker.spawned"

# TypeScript
npx tsc --noEmit
```