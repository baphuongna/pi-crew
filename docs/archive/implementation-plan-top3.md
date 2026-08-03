# Implementation Plan: Top 3 Features from oh-my-pi v15

> Date: 2026-05-13
> Based on: `D:/my/my_project/source/oh-my-pi` research
> Target: pi-crew v0.2.x

---

## Priority Order

1. **Typed Crew Errors** — Quick win, no dependencies
2. **Conflict Detection** — High value, standalone module
3. **Issue-PR Protocol** — Medium complexity, GitHub integration

---

## 1. Typed Crew Errors

### Why
Current pi-crew uses generic `Error` types with string matching:
```typescript
catch (e) {
  if (e instanceof Error && e.message.includes("deadletter")) { ... }
}
```

Pattern from oh-my-pi: use typed sentinel errors with `instanceof` discrimination.

### Files to create/modify

**Create:** `src/runtime/errors/crew-errors.ts`

```typescript
/**
 * Typed error sentinels for pi-crew operations.
 * Follows oh-my-pi pattern from compaction/errors.ts.
 */

export class CrewCancelledError extends Error {
  readonly name = "CrewCancelledError" as const;
  constructor(message = "Crew run cancelled") { super(message); }
}

export class CrewTimeoutError extends Error {
  readonly name = "CrewTimeoutError" as const;
  constructor(public readonly maxDurationMs: number) {
    super(`Crew run exceeded timeout of ${maxDurationMs}ms`);
  }
}

export class CrewDeadletterError extends Error {
  readonly name = "CrewDeadletterError" as const;
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Agent ${agentId} deadlettered: ${reason}`);
  }
}

export class CrewAbortError extends Error {
  readonly name = "CrewAbortError" as const;
  constructor(message = "Crew run aborted") { super(message); }
}

export class CrewManifestError extends Error {
  readonly name = "CrewManifestError" as const;
  constructor(message: string, public readonly runId?: string) { super(message); }
}

export class CrewLockError extends Error {
  readonly name = "CrewLockError" as const;
  constructor(message: string, public readonly lockPath?: string) { super(message); }
}

/**
 * Outcome of a crew run attempt.
 * Used by RunTracker and HealthWatcher.
 */
export type CrewRunOutcome = "ok" | "cancelled" | "deadletter" | "failed" | "timeout" | "aborted";
```

**Update:** `src/runtime/task-runner.ts`, `src/runtime/team-runner.ts`, `src/runtime/crash-recovery.ts`

Replace string matching with `instanceof` checks.

### Implementation

```bash
# 1. Create file
cat > src/runtime/errors/crew-errors.ts << 'EOF'
// (content above)
EOF

# 2. Update imports in affected files
# From: catch (e) { if (e instanceof Error && e.message.includes("deadletter")) ... }
# To: catch (e) { if (e instanceof CrewDeadletterError) ... }
```

### Effort: LOW (1-2 hours)

---

## 2. Conflict Detection

### Why
When multiple pi-crew agents edit the same file in a worktree, git merge conflicts can occur. Current pi-crew has no conflict detection — agents see garbled `<<<<<<< HEAD` markers with no structured way to resolve them.

### Architecture

```
pi-crew worktree agents edit files
         ↓
   WorktreeManager detects file change
         ↓
   ConflictDetector.scanFileForConflicts(path)
         ↓
   Returns ConflictBlock[] + registers in ConflictHistory
         ↓
   Read tool appends conflict warning footer
         ↓
   Agent calls write({ path: "conflict://<id>", content })
         ↓
   ConflictResolver.spliceConflict() → clean file
```

### Files to create

**Create:** `src/utils/conflict-detect.ts` (fork from oh-my-pi, ~400 lines)

Key exports:
- `scanConflictLines(lines, firstLineNumber)` → `ConflictBlock[]`
- `scanFileForConflicts(path)` → `{ blocks, scanTruncated }`
- `ConflictHistory` class
- `ConflictEntry` interface
- `parseConflictUri(raw)` → `ParsedConflictUri | null`
- `spliceConflict(text, entry, replacement)` → `string`
- `expandContentTokens(content, entry)` → `string` (handles @ours/@theirs/@base/@both)
- `renderConflictRegion(entry, scope)` → `{ lines, startLine }`
- `formatConflictWarning(entries)` → `string`

**Create:** `src/runtime/conflict-registry.ts`

```typescript
/**
 * Global conflict registry for pi-crew.
 * Attaches ConflictHistory to each live session.
 */
import { ConflictHistory, getConflictHistory } from "../utils/conflict-detect.ts";
import type { LiveAgentHandle } from "./live-agent-manager.ts";

export function getAgentConflicts(handle: LiveAgentHandle): ConflictHistory {
  if (!handle.conflictHistory) {
    handle.conflictHistory = new ConflictHistory();
  }
  return handle.conflictHistory;
}
```

**Modify:** `src/extension/registration/tools/read-tool.ts`

After reading file content:
1. Call `scanConflictLines(lines, 1)`
2. For each block, call `conflictHistory.register(...)`
3. Append `formatConflictWarning(entries)` to output

**Modify:** `src/extension/registration/tools/write-tool.ts`

Add `conflict://<N>` handling:
1. Parse URI with `parseConflictUri(path)`
2. Look up `ConflictEntry` from `ConflictHistory`
3. Call `expandContentTokens(content, entry)`
4. Call `spliceConflict(originalText, entry, expandedContent)`
5. Write result to `entry.absolutePath`

### Integration points

| File | Change |
|------|--------|
| `src/extension/registration/tools/read-tool.ts` | Append conflict warning to file content |
| `src/extension/registration/tools/write-tool.ts` | Handle `conflict://` protocol |
| `src/runtime/live-agent-manager.ts` | Add `conflictHistory?: ConflictHistory` to handle |
| `src/utils/conflict-detect.ts` | New file (fork from oh-my-pi) |
| `src/runtime/conflict-registry.ts` | New file (global registry) |

### Edge cases to handle

1. **Nested conflicts** — oh-my-pi handles by requiring strict marker shape
2. **Multi-file conflicts** — `ConflictHistory.invalidatePath()` when file is resolved
3. **Retry after partial resolution** — `ConflictEntry` id stays stable
4. **Large files** — `scanFileForConflicts` caps at 10MB
5. **Diff3 conflicts** — Support `|||||||` base section

### Test plan

```typescript
// test/unit/conflict-detect.test.ts
test("scanConflictLines detects single 2-way block", () => {
  const lines = ["<<<<<<< HEAD", "our changes", "=======", "their changes", ">>>>>>> feature"];
  const blocks = scanConflictLines(lines, 1);
  assert(blocks.length === 1);
  assert(blocks[0].oursLines[0] === "our changes");
});

test("scanConflictLines ignores non-column-0 markers", () => {
  const lines = ["  <<<<<<< indented", "=======", ">>>>>>>"];
  const blocks = scanConflictLines(lines, 1);
  assert(blocks.length === 0);
});

test("scanConflictLines detects diff3 3-way block", () => {
  // ...with ||||||| base marker
});
```

### Effort: MEDIUM (4-8 hours)

---

## 3. Issue-PR Protocol

### Why
pi-crew workflow agents can benefit from issue/PR integration:
- Create issue from failed task
- Link workflow tasks to GitHub issues
- PR review workflow (`pr://` protocol)

### URL shapes to support

```
issue://              — list recent issues (default repo from cwd)
issue://owner/repo    — list issues for repo
issue://123           — single issue (repo from cwd)
issue://owner/repo/123 — fully qualified
issue://owner/repo/123?comments=0 — suppress comments

pr://                 — list recent PRs
pr://owner/repo       — list PRs for repo
pr://owner/repo/456  — single PR
pr://owner/repo/456/diff — PR diff
```

### Files to create/modify

**Create:** `src/internal-urls/issue-pr-protocol.ts` (port from oh-my-pi, ~577 lines)

Key exports:
- `IssuePrProtocol` class implementing `ProtocolHandler`
- `parseIssueUrl(url)` → `ParsedIssue`
- `parsePrUrl(url)` → `ParsedPr`
- `fetchIssue(parsed)` → `string` (markdown)
- `fetchPr(parsed)` → `string` (markdown)
- `fetchPrDiff(parsed)` → `string` (unified diff)

**Modify:** `src/internal-urls/router.ts`

Register `issue://` and `pr://` handlers.

**Create:** `src/tools/gh-cache.ts` (fork from oh-my-pi `tools/github-cache.ts`)

SQLite-backed cache for GitHub API responses. Shared across sessions.

### Dependencies

1. **GitHub CLI (`gh`)** — oh-my-pi uses `gh issue list`, `gh pr list`, `gh api`
2. **SQLite** — via `better-sqlite3` or similar
3. **Git config** — Need to resolve default repo from `git remote get-url origin`

### Implementation details

```typescript
interface ParsedIssue {
  kind: "single" | "list";
  repo?: string;  // undefined = derive from cwd
  number?: number;
  state?: "open" | "closed" | "all";
  limit?: number;
  comments?: boolean;
}

interface ParsedPr {
  kind: "single" | "list" | "diff";
  repo?: string;
  number?: number;
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
  diffMode?: "list" | "all";
}
```

**Fetching:**
- List: `gh issue list --repo owner/repo --state open --limit 30`
- Single: `gh issue view 123 --repo owner/repo --comments`
- PR: `gh pr view 456 --repo owner/repo --comments`
- Diff: `gh pr diff 456 --repo owner/repo`

**Caching:**
- Cache key: `{repo, number, type}` hash
- TTL: 5 minutes for list, 1 hour for single items
- Invalidate on write operations (create/close/reopen)

### Integration with pi-crew

**New tool:** `read-issue` / `read-pr`
```typescript
// agents can call:
// read({ path: "issue://123" }) → markdown of the issue
// read({ path: "pr://456" }) → markdown of the PR
```

**New slash command:** `/issue` or use the existing `/crew`:
```
/crew create-issue "Task failed: fix memory leak in cache" --labels=bug --assignee=me
/crew link-issue TICKET-123 --task=explorer-1
```

### Effort: MEDIUM-HIGH (8-12 hours)

---

## Summary

| Feature | Effort | Risk | Priority |
|---------|--------|------|----------|
| Typed Crew Errors | LOW | None | 1 |
| Conflict Detection | MEDIUM | Git operations, large file handling | 2 |
| Issue-PR Protocol | MEDIUM-HIGH | GitHub auth, gh CLI dependency | 3 |

## Recommended execution order

1. **Day 1:** Typed Crew Errors (quick win)
2. **Day 2-3:** Conflict Detection
3. **Day 4-5:** Issue-PR Protocol (if time permits)