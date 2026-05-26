---
name: workspace-isolation
description: "Workspace isolation boundaries. Use when ensuring agents from workspace A cannot access workspace B, or worktree-based parallel execution. Triggers: workspace isolation, cross-workspace access, escape boundary, worktree safety."
---

# workspace-isolation

pi-crew enforces workspace isolation so that agents, runs, and live sessions from one project folder cannot be accessed from another. The workspace boundary is `manifest.cwd` — the directory where a run was initiated.

## Workspace Boundary Definition

**`manifest.cwd`** is the canonical workspace root. Every run record carries the directory where it was created.

**Why it matters:** Pi can have multiple workspace folders open simultaneously. Without isolation, an agent from workspace A could be steered/controlled from workspace B.

**Rules:**
- Every run's `manifest.cwd` is set at creation time
- Every live agent handle carries `workspaceId = manifest.cwd`
- Widget queries filter by `manifest.cwd`
- API operations reject cross-workspace access

## Live Agent Workspace Check

`LiveAgentHandle.workspaceId` field (added to prevent cross-workspace access):

```typescript
interface LiveAgentHandle {
  // ... other fields
  /** Workspace where this agent was spawned — used for session-scoped visibility. */
  workspaceId: string;
}
```

**Enforcement in `api.ts`** (team-tool operations):

```typescript
// list-active-live-agents: filter by workspace
listActiveLiveAgentsByWorkspace(manifest.cwd);

// steer-agent, follow-up-agent, stop-agent, resume-agent:
const live = getLiveAgent(agentId);
if (live && live.workspaceId !== manifest.cwd)
  return result(`Live agent '${agentId}' does not belong to workspace ${manifest.cwd}.`, { status: "error" }, true);
```

**Enforcement in `live-agent-manager.ts`**:

```typescript
// listLiveAgentsByWorkspace(workspaceId): filter by workspaceId
export function listLiveAgentsByWorkspace(workspaceId: string): LiveAgentHandle[] {
  return listLiveAgents().filter((a) => a.workspaceId === workspaceId);
}
```

## Team Workspace Modes

### `single` (default)

- All agents run in the project root (`manifest.cwd`)
- No worktree creation
- Simpler, but all workers share the same git state

### `worktree` (parallel isolation)

- Each task (or phase) gets its own git worktree
- Worktree path: `<repo-root>/.worktrees/<runId>/<taskId>/`
- Branch name: `crew/<runId>-<taskId>` (sanitized)
- Allows parallel code-changing tasks without git conflicts

**Entry point in `team-runner.ts`:**
```typescript
const worktree = workspaceMode === "worktree" && task.worktree !== undefined
  ? { path: task.worktree.path, branch: task.worktree.branch, reused: task.worktree.reused }
  : undefined;
```

**Worktree lifecycle:**

1. **Creation** (`prepareTaskWorkspace` in `worktree-manager.ts`):
   - Check leader repo is clean (`assertCleanLeader`)
   - `git worktree add <path> <branch>`
   - Link `node_modules` if present
   - Mark reused if already exists

2. **Naming convention**:
   ```
   Branch: crew/<sanitized-runId>-<sanitized-taskId>
   Path: .worktrees/<runId>/<taskId>/
   ```

3. **Cleanup** (on task/run completion):
   - Check dirty state
   - `git worktree remove <path> --force` (only if force=true)
   - Preserve dirty worktrees unless explicitly forced

**Safety rules:**
- Leader repo must be clean before creating worktrees
- One owner per file/symbol/migration path
- Branch names derived deterministically from run/task IDs (no user-controlled path fragments)

## Cross-Workspace Prevention

**In api.ts (`handleTeamToolCall`):**

```typescript
if (operation === "list-live-agents") {
  return result(JSON.stringify(
    listActiveLiveAgentsByWorkspace(loaded.manifest.cwd),  // ← filtered by workspace
    null, 2
  ), { action: "api", status: "ok", runId: loaded.manifest.runId });
}
```

**In cancel.ts:**
- Verifies run ownership before allowing cancel
- Cross-session cancel rejected unless force=true

**In respond.ts:**
- Verifies task ownership before responding
- Cross-session respond rejected unless force=true

**In crash-recovery.ts:**
- `purgeStaleActiveRunIndex` only affects runs in the current workspace (cwd)
- `reconcileAllStaleRuns` only scans the current workspace's `.crew/state/runs/`

## Live Session Workspace

`LiveSessionConfig` carries workspaceId:

```typescript
interface LiveSessionConfig {
  // ... other fields
  /** Workspace directory — used for path containment and isolation. */
  workspaceId: string;
}
```

**Propagation chain:**
```
team-tool.ts (handleTeamToolCall)
  → TeamContext { workspaceId: cwd }
  → LiveSessionConfig { workspaceId }
  → registerLiveAgent({ workspaceId })
  → LiveAgentHandle { workspaceId }
```

## Configuration

**defaults.ts isolation settings:**

```typescript
const DEFAULT_PATHS = {
  crewRoot: ".crew",           // under project root
  stateRoot: ".crew/state",     // under project root
};
```

All paths are resolved relative to `manifest.cwd`, ensuring state stays under the project root.

## Anti-patterns

- **Passing raw cwd without validation**: Always use `resolveContainedPath` to ensure paths stay under workspace root.
- **Cross-workspace respond/cancel**: Even with force=true, foreign session operations should be rejected. Check `ownerSessionId`.
- **Symlink traversal**: Use `resolveRealContainedPath` to resolve symlinks and detect escape attempts.
- **Worktree name collision**: Use deterministic names from run/task IDs. Never accept user-controlled branch names.
- **Dirty worktree removal**: Never force-remove worktrees with uncommitted changes unless explicitly confirmed.

---

## Source patterns

- `src/extension/team-tool/api.ts` — workspaceId filter in list-live-agents, steer-agent, follow-up-agent, stop-agent, resume-agent
- `src/runtime/live-agent-manager.ts` — workspaceId in LiveAgentHandle, listLiveAgentsByWorkspace, listActiveLiveAgentsByWorkspace
- `src/runtime/live-session-runtime.ts` — LiveSessionConfig, workspaceId in session creation
- `src/runtime/team-runner.ts` — workspaceId passed through executeTeamRun
- `src/state/state-store.ts` — initRunManifest with cwd, manifest.cwd
- `src/worktree/worktree-manager.ts` — prepareTaskWorkspace, assertCleanLeader, linkNodeModulesIfPresent
- `src/config/defaults.ts` — DEFAULT_PATHS (state under project root)

---

## Verification

```bash
cd pi-crew
# Verify workspace filter in list-live-agents
node --experimental-strip-types -e "
import { listLiveAgentsByWorkspace, listActiveLiveAgentsByWorkspace } from './src/runtime/live-agent-manager.ts';
console.log('By workspace:', listLiveAgentsByWorkspace(process.cwd()).length);
console.log('Active by workspace:', listActiveLiveAgentsByWorkspace(process.cwd()).length);
"

# Verify worktree creation
node --experimental-strip-types -e "
import { prepareTaskWorkspace } from './src/worktree/worktree-manager.ts';
// Requires a clean git repo and workspaceMode='worktree'
"

npx tsc --noEmit
node --experimental-strip-types --test test/unit/worktree-manager.test.ts test/unit/isolation-policy.test.ts
npm test
```