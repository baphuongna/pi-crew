---
name: ownership-session-security
description: >
  Session ownership and authorization workflow.
  When NOT to use: general session lifecycle questions (use live-agent-lifecycle); for non-session auth issues.

origin: pi-crew
triggers:
  - "cancel run"
  - "respond to task"
  - "cross-session action"
  - "ownership verify"
  - "session security"

---
# ownership-session-security

Use this skill for cross-session safety and trust-boundary work.

## Source patterns distilled

- Pi session IDs: `ctx.sessionManager.getSessionId()` from Pi core `ExtensionContext`
- pi-crew ownership: `TeamRunManifest.ownerSessionId`, `src/extension/team-tool/run.ts`, `cancel.ts`, `respond.ts`
- Path safety: `src/utils/safe-paths.ts`, `src/state/state-store.ts`, `src/state/mailbox.ts`
- Destructive actions: `src/extension/team-tool/lifecycle-actions.ts`, `src/worktree/cleanup.ts`

## Rules

- Propagate the active Pi session ID into `TeamContext` for every production tool/command path.
- New runs should record `ownerSessionId` when available.
- For owned runs, cross-session actions that mutate state must be rejected unless explicit force/admin semantics are designed and tested.
- Legacy runs without `ownerSessionId` may remain permissive for backward compatibility, but document this behavior.
- User/LLM-controlled path fields (`cwd`, import paths, artifact paths, task IDs) must be normalized and contained under an allowed base.
- Use `resolveContainedPath`, `resolveRealContainedPath`, `assertSafePathId`, and symlink checks rather than ad-hoc `startsWith` checks.
- Destructive management actions must require `confirm: true`; referenced resource deletes must require `force: true` where applicable.

## Enforcement — Ownership Session Security Gate

**Before mutating run state or cross-session operations, verify:**

- [ ] Session ID propagated into TeamContext for production paths
- [ ] ownerSessionId verified before respond/cancel/mutate operations
- [ ] Path fields (cwd, import, artifact) normalized and contained under allowed base
- [ ] Safe path helpers used (resolveContainedPath, assertSafePathId) not startsWith checks
- [ ] Destructive actions require explicit confirm/force parameters

If ANY answer is NO → Stop. Verify ownership before mutating state.

## Anti-patterns

- Assuming `ctx.sessionId` exists directly on Pi context.
- Letting `cwd: ../other-project` move run state into another project.
- Letting `respond`/`cancel` mutate a foreign owned run.
- Trusting task IDs, run IDs, or artifact paths from tool params without validation.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/cancel-ownership.test.ts test/unit/respond-tool.test.ts test/unit/cwd-override-security.test.ts test/unit/api-artifact-security.test.ts
npm test
```
