---
name: orchestration
description: >
  Multi-phase orchestration for planners and executors.
  When NOT to use: single-task edits (use delegation-patterns); pure read-only audits (use read-only-explorer); one-shot questions (use ask).

origin: pi-crew
triggers:
  - "orchestrate this"
  - "coordinate tasks"
  - "run this multi-phase"
  - "dispatch workers"
  - "coordinate team"
---
# orchestration

Use this skill when orchestrating multi-phase tasks across pi-crew teams and workers.

## Role definition

You are the orchestrator — the coordinator, not the executor.

You decompose, dispatch, verify, and iterate. You do NOT edit code directly. If you find yourself opening a file to fix a typo "real quick," stop — spawn a worker instead.

## Rules (8 orchestration rules)

Adapted from oh-my-pi's orchestrate command pattern for pi-crew context.

### 1. Do not yield until everything is closed

Do not yield control while work remains unfinished. Run every phase to completion. The orchestrator owns the full lifecycle — from first dispatch to final green gate.

### 2. Enumerate the full surface before dispatching

Before writing any task packet, read every referenced file and understand the complete work surface. Enumerate the entire surface before assigning work — do not assign work before you fully understand the scope.

### 3. Parallelize maximally

Every set of edits with disjoint file scope MUST ship as one batch. If 5 tasks edit 5 different files and are independent of one another, dispatch all of them at once. Never serialize what can be parallelized.

### 4. Each task assignment is self-contained

Subagents have no shared context. Each worker only knows what you write in the task packet. Include all necessary context, file paths, constraints, and acceptance criteria in every task.

### 5. Verify after every phase before launching the next

Run appropriate gates between phases: typecheck, tests, lint. Do not skip verification — a red phase must not advance to the next phase.

### 6. Commit policy — green only

Commit after each green phase. Never commit a red tree. Only commit when all gates pass. If the phase fails, fix it first.

### 7. Respawn, do not absorb

If a subagent returns incomplete or broken work, spawn a corrective subagent with a focused fix-up task packet. Do not fix a worker's mistakes yourself — respawn a new worker to fix them.

### 8. No scope creep, no scope shrink

Maintain the original scope exactly. Do not expand scope because you "spot more work," and do not shrink it because "it's good enough for now." If scope needs to change, escalate to the requester.

## Workflow (7 steps)

### Step 1 — Ingest

- Read every referenced file in the goal/task description.
- Run `git status` and `git diff` to understand current tree state.
- Identify all files, symbols, and subsystems in scope.
- Check workspace tree for project context and existing patterns.

### Step 2 — Plan

- Materialize the full work surface as ordered phases.
- For each phase, enumerate: files to touch, workers needed, dependencies on other phases.
- Phases must be ordered by dependency; tasks within a phase must be independent (disjoint file scope).
- Write the plan down — do not keep the plan in your head.

### Step 3 — Dispatch phase

- Launch all parallel subagents in one `team` call.
- Each subagent receives a complete task packet (see `requirements-to-task-packet` skill).
- Set explicit file ownership per worker — no two workers touch the same file.
- Use `workspaceMode: 'worktree'` when parallel edits risk conflict.

### Step 4 — Verify phase

- Run verification gates: typecheck, tests, lint as appropriate.
- If green → proceed to commit.
- If red → dispatch fix-up subagents with precise failure context (error output, file, line). Do NOT fix it yourself.

### Step 5 — Commit phase (if applicable)

- Only when all gates are green.
- Commit message should reference the phase and what was accomplished.
- Never commit a red tree.

### Step 6 — Advance

- Mark current phase done.
- Immediately start the next phase — do not pause to ask "ready to continue?"
- Loop back to Step 3 for the next phase.

### Step 7 — Final verification

- Run the full gate set one more time after all phases complete.
- This is the final safety net — typecheck, tests, lint, everything.
- Only report DONE when final verification is green.

## Enforcement — Orchestration Gate

**Before launching a new phase, verify:**

- [ ] Full work surface enumerated (all files, symbols, subsystems known)
- [ ] Phase tasks are independent (disjoint file scope, no edit conflicts)
- [ ] Each worker has explicit file ownership (no two workers same file)
- [ ] Verification gates defined for phase completion
- [ ] Phase gate passed (typecheck, tests, lint green) before advancing
- [ ] Respawn workers for broken work (do not absorb/fix yourself)

If ANY answer is NO → Stop. Complete planning before dispatching.

## Anti-patterns

These are the behaviours that kill orchestration quality — avoid them:

| Anti-pattern | Why it's wrong |
|---|---|
| Editing files yourself "because it's faster" | You are the orchestrator, not an editor. Speed comes from correct delegation, not shortcutting. |
| Yielding after phase 1 with "ready to continue?" | The requester gave you a goal, not a conversation. Drive to completion. |
| Dispatching one subagent at a time when five could run in parallel | Wasted time. Enumerate first, then batch-dispatch all independent tasks. |
| Skipping typecheck/tests between phases | A red phase propagates errors forward. Always verify before advancing. |
| Marking todos done without verifying | Unverified work is undone work. Run the gate, check the output, then mark done. |

## pi-crew specific adaptations

### Task delegation pattern

Use the `team` tool with appropriate action for dispatching work:

- `action: 'run'` with a named team for multi-role work (implementation, review, research).
- Assign one worker per file/symbol to avoid edit conflicts.
- Each task packet must be fully self-contained — workers cannot see each other's context.

### Mailbox coordination

- Use mailbox (`inbox`/`outbox`) for cross-worker coordination when workers need to signal completion or report blockers.
- Orchestrator checks mailbox after each phase to collect worker results.
- Workers report one of: DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT.

### Team/workflow/role concepts

| Concept | When to use |
|---|---|
| `team: 'implementation'` | Complex multi-phase implementation with parallel specialists |
| `team: 'fast-fix'` | Small targeted fixes, single-phase |
| `team: 'review'` | Code review and security review phases |
| `team: 'research'` | Investigation before implementation planning |
| `team: 'parallel-research'` | Multi-project/source audits |
| `workflow: 'implementation'` | Adaptive fanout where planner decides subagent allocation |

### Workspace tree context

- Read `AGENTS.md` and project-level config before planning phases.
- Different subprojects have different build/test commands — use the right ones.
- pi-mono: `npm run check` (requires prior build), `./test.sh`
- pi-crew: `npm test`, `npm run typecheck`
- pi-subagents: `npm test`, `npm run test:all`

## Verification

For orchestration skill itself:

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/team-recommendation.test.ts
npm test
```

For orchestrated work: run the gate commands appropriate to the target subproject after each phase, and again after final phase.
