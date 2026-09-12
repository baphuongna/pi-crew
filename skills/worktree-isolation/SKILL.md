---
name: worktree-isolation
description: >
  Conflict-safe git worktree workflow.
  When NOT to use: non-git changes (use direct edit); single-commit patches (use git-master).

origin: pi-crew
triggers:
  - "create worktree"
  - "parallel workers"
  - "isolate edits"
  - "cleanup worktree"
  - "branch freshness"
---
# worktree-isolation

Use this skill for worktree-based execution or cleanup. Git worktrees create isolated working directories that allow parallel code-changing tasks without git conflicts.

## How Worktrees Work

A git worktree is a separate working directory linked to the same repository. It has its own:
- Working directory (different path)
- HEAD (can be on a different branch)
- Staged/unstaged changes

But it shares:
- Object database (`.git/objects`)
- Refs (branches, tags)

This means creating a worktree is cheap (no clone needed) and fast.

## When to Use Worktrees

**Use worktree mode when:**
- Running parallel implementation workers that modify the same repo
- Isolating risky changes that might need to be discarded
- Running multiple agents on the same codebase simultaneously
- Running a long task that would block other work

**Don't use worktree mode when:**
- The task is read-only (use scaffold mode instead)
- Only one agent needs to work at a time
- The repository has uncommitted changes (must be clean)

## Worktree Lifecycle

### 1. Creation

**Prerequisites:**
- Leader repository must be clean (`git status` empty)
- Sufficient disk space for worktree directory

**Creation flow:**
```
team-runner.ts (workspaceMode: "worktree")
  → prepareTaskWorkspace(manifest, task)
    → assertCleanLeader(repoRoot)
    → git worktree add <path> <branch>
    → linkNodeModulesIfPresent(repoRoot, worktreePath)
    → return { cwd: worktreePath, worktreePath, branch }
```

**Naming convention:**
- Branch: `crew/<sanitized-runId>-<sanitized-taskId>`
- Path: `.worktrees/<runId>/<taskId>/`
- Deterministic from run/task IDs — no user-controlled fragments

**Example:**
```
Run: team_20260514092752_218fe358085d7115
Task: 01_explore

Branch: crew/team-20260514092752-218fe358085d7115/01-explore
Path: .worktrees/team-20260514092752-218fe358085d7115/01-explore/
```

### 2. Reuse

If a worktree with the same branch already exists, it is reused instead of recreated:

```typescript
// Check if worktree already exists
const existing = git(cwd, ["worktree", "list", "--porcelain"]);
if (existing.includes(branch)) {
  return { reused: true, worktreePath: parsePath(existing) };
}
```

Reuse is safe when the worktree's base branch hasn't diverged (checked via `branch-freshness.ts`).

### 3. Work in worktree

Each task works in its own worktree directory:
- `cwd` = worktree path
- `git status` shows only that task's changes
- Changes are isolated from other worktrees and the leader

### 4. Cleanup

**On task completion:**
1. Check dirty state (uncommitted changes)
2. If dirty and not forced → preserve (report to operator)
3. If clean → `git worktree remove <path>`

**On force cleanup:**
- `git worktree remove <path> --force`
- Removes even if there are changes (but logs a warning)

**Safety rules:**
- Never force-remove dirty worktrees by default
- Always check `git status` before cleanup
- Report worktree paths in events/artifacts for recovery

## Stale Worktree Detection

Worktrees can become stale when:
- The base branch has moved
- The run was abandoned mid-task
- Node modules are out of date

**Detection approach:**
```typescript
// Check if base branch has diverged
function isStaleWorktree(worktreePath: string, baseBranch: string): boolean {
  const current = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const ahead = git(worktreePath, ["rev-list", "--count", `${baseBranch}..HEAD`]);
  const behind = git(worktreePath, ["rev-list", "--count", `HEAD..${baseBranch}`]);
  return Number(ahead) > 10 || Number(behind) > 0;
}
```

**Cleanup stale worktrees:**
```bash
# List all worktrees
git worktree list

# Remove stale worktree
git worktree remove .worktrees/stale-task --force
```

## Merge Conflict Strategy

When worktrees complete and changes need to be merged back:

1. **One owner per file/symbol**: Assign each file to exactly one worktree. No two worktrees modify the same file.
2. **Merge order**: If multiple worktrees produce changes, merge in reverse creation order.
3. **Conflict detection**: `git status --porcelain` shows conflicts.
4. **Conflict resolution**: Resolve in the leader branch, then continue.

**If conflicts occur:**
```bash
git merge --no-commit <branch>
# Resolve conflicts manually
git add <resolved-files>
git commit -m "Merge branch and resolve conflicts"
```

## Branch Freshness Check

Before reusing a worktree, verify the base branch hasn't diverged:

```typescript
function checkBranchFreshness(worktreePath: string, baseBranch: string): {
  fresh: boolean;
  ahead: number;
  behind: number;
} {
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (status.trim()) return { fresh: false, ahead: 0, behind: 0 }; // dirty

  const current = git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (current !== baseBranch) return { fresh: false, ahead: 0, behind: 0 }; // different branch

  // Check divergence
  const ahead = Number(git(worktreePath, ["rev-list", "--count", `${baseBranch}..HEAD`]));
  const behind = Number(git(worktreePath, ["rev-list", "--count", `HEAD..${baseBranch}`]));
  return { fresh: ahead === 0 && behind === 0, ahead, behind };
}
```

## Crash Recovery

If a task crashes mid-worktree:
1. Find orphaned worktrees: `git worktree list`
2. Check for abandoned runs in `.crew/state/runs/`
3. If run is failed/cancelled and worktree is dirty → report to operator
4. If run is completed → safe to clean up

## Enforcement — Worktree Isolation Gate

**Before creating or cleaning up worktrees, verify:**

- [ ] Leader repo is clean before creating worktrees (assertCleanLeader passes)
- [ ] One owner per file/symbol (no two worktrees edit same file)
- [ ] Worktree naming is deterministic from run/task IDs (no user-controlled fragments)
- [ ] Branch freshness checked before reuse (base branch hasn't diverged)
- [ ] Dirty worktrees preserved by default (force=true only for forced removal)
- [ ] Worktree paths under <repo-root>/.worktrees/ (never outside workspace)

If ANY answer is NO → Stop. Verify worktree safety before proceeding.

## Anti-patterns

- **Parallel editing same file**: Assign one owner per file. Use the task ID in branch names to track ownership.
- **Force-removing dirty worktrees**: Always report dirty state to operator before cleanup.
- **Reusing stale worktrees**: Check `branch-freshness.ts` before reuse. If base branch moved, recreate instead.
- **Storing worktrees outside workspace root**: All worktrees must be under `<repo-root>/.worktrees/`. Never store outside.
- **Worktree name collision**: Use deterministic naming from run/task IDs, not user input.

## Source patterns

- `src/worktree/worktree-manager.ts` — prepareTaskWorkspace, assertCleanLeader, linkNodeModulesIfPresent, sanitizeBranchPart
- `src/worktree/cleanup.ts` — worktree cleanup logic, dirty state detection
- `src/worktree/branch-freshness.ts` — branch divergence detection
- `src/runtime/team-runner.ts` — workspaceMode handling, worktree passed to task
- `src/runtime/task-runner.ts` — worktreePath in task context

## Verification

```bash
cd pi-crew

# List all worktrees
git worktree list

# Check leader repo is clean
git status --short

# Verify worktree creation
node --experimental-strip-types -e "
import { prepareTaskWorkspace } from './src/worktree/worktree-manager.ts';
// Requires clean repo and workspaceMode='worktree'
"

# TypeScript
npx tsc --noEmit

# Tests
node --experimental-strip-types --test test/unit/worktree-manager.test.ts test/integration/worktree-mode.test.ts
npm test
```