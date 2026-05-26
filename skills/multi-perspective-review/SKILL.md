---
name: multi-perspective-review
description: "Multi-perspective code review with simpler-alternative pass. Use when reviewing a plan, diff, implementation, worker output, release candidate, or external feedback. Triggers: review this, look at this, LGTM check, sanity check, audit this, get a second opinion, check this PR, examine this code."
---

# multi-perspective-review

Core principle: review early, review often, and separate concerns. Reviewer output is evidence to evaluate, not an instruction to obey blindly.

Distilled from detailed reads of requesting-code-review, receiving-code-review, subagent review checkpoints, differential review, and specialized review-agent patterns.

## Pre-review: Simpler Alternative Pass (Mandatory)

Before running any review passes, ask:

1. **Is there a simpler, smaller, or more elegant way to achieve the same goal?**
   - Doing nothing (is the problem real and load-bearing?)
   - Using something that already exists in the codebase
   - A smaller change that solves 90% of the goal with 10% of the risk
   - Solving it at a different layer (config vs code, framework vs app)
2. If a better alternative exists, surface it BEFORE the line-by-line review.
3. Skip only if the user explicitly says "don't question scope."

This is the most valuable finding you can produce — surfacing unnecessary complexity before reviewing its details.

---

## Review Passes

Run relevant passes separately:

1. Spec compliance: Does the work match the request and nothing extra?
2. Correctness: Are edge cases, state transitions, and failure paths right?
3. Regression risk: Could config precedence, runtime defaults, or public APIs break?
4. Security: Trust boundaries, path containment, prompt injection, secrets, permissions.
5. Tests: Do tests assert the changed behavior and isolation concerns?
6. Maintainability: Narrow diff, typed inputs, clear ownership, reversible changes.
7. Operator experience: Error/status text, recovery hints, artifacts, logs.
8. Compatibility: Windows paths, Node/Pi versions, CLI flags, legacy paths.

## Finding Format

```text
[severity] path:line or symbol
Issue: ...
Impact: ...
Fix: ...
Verification: ...
```

Severity:

- critical: data loss, secret leak, arbitrary command/path escape, unusable default install;
- high: broken core workflow, ownership bypass, persistent incorrect state;
- medium: important regression, flaky test, confusing recoverable behavior;
- low: polish, maintainability, docs.

## Example Findings by Perspective

### Spec Compliance

```
[medium] src/runtime/task-runner.ts:89
Issue: `executeWorkers` is checked once at top of runTeamTask but the value
  is passed through an untyped parameter. The function comment says "workers
  are disabled in scaffold mode" but the actual behavior is driven by `runtimeKind`.
Impact: If someone changes the comment but not the code, the mismatch is invisible.
Fix: Add a runtimeKind guard and deprecate the executeWorkers parameter.
Verification: `npx tsc --noEmit` passes; test with `PI_TEAMS_MOCK_CHILD_PI=scaffold`.
```

### Correctness

```
[high] src/runtime/live-agent-manager.ts:47
Issue: `registerLiveAgent` returns the new handle but callers may use the
  old handle reference if they captured it before the call.
Impact: Status updates may apply to the wrong handle if the agent re-registers.
Fix: Always call `getLiveAgent` after `registerLiveAgent` to get the canonical handle.
Verification: Add test that verifies status after re-registration.
```

### Regression Risk

```
[medium] src/state/state-store.ts:150
Issue: `saveRunTasks` uses `atomicWriteJson` but the file may grow large.
  No pagination or archiving strategy for long-running runs.
Impact: Tasks file could exceed 10MB with many updates, causing slow I/O.
Fix: Consider splitting into per-task files or adding a size warning.
Verification: Load test with 10,000 task updates.
```

### Security

```
[critical] src/utils/safe-paths.ts:20
Issue: `resolveRealContainedPath` follows symlinks but doesn't verify the
  resolved path stays under the allowed base.
Impact: A malicious symlink could escape the workspace boundary.
Fix: Compare resolved path against allowed base after following symlinks.
Verification: Unit test with malicious symlink pointing outside workspace.
```

### Tests

```
[medium] test/unit/live-agent-manager.test.ts:45
Issue: Test only checks the happy path. Missing: re-registration, workspaceId
  mismatch, evict on timeout, cross-workspace access prevention.
Impact: Edge cases are not covered; future changes could break silently.
Fix: Add tests for re-registration, cross-workspace rejection, stale eviction.
Verification: `npm test` with new test cases.
```

### Maintainability

```
[low] src/runtime/task-runner.ts:250
Issue: `runTeamTask` is 400+ lines with deeply nested if/else. Hard to follow.
Impact: Future changes require understanding all branches simultaneously.
Fix: Extract inner logic into helper functions (spawn, execute, complete).
Verification: No functional change; `npx tsc --noEmit` passes.
```

### Operator Experience

```
[medium] src/extension/team-tool/api.ts:80
Issue: Error message for missing `agentId` doesn't show available agent IDs.
Impact: Operator must manually look up agent IDs to fix the error.
Fix: Include list of available agent IDs in the error message.
Verification: Call steer-agent without agentId and verify error lists IDs.
```

### Compatibility

```
[high] src/runtime/child-pi.ts:45
Issue: `spawn("cmd", ["/c", ...])` on Windows fails with `&&` in commands.
Impact: Background runs with multiple commands silently fail on Windows.
Fix: Use explicit argv array instead of shell string concatenation.
Verification: Test background run with multiple commands on Windows.
```

## Handling Review Feedback

When receiving feedback:

1. Read all feedback before reacting.
2. Restate the technical requirement if unclear.
3. Verify against codebase reality.
4. Implement one item at a time.
5. Test each fix and verify no regressions.
6. Push back with evidence if the suggestion is wrong, out of scope, or violates user decisions.

## Rules

- Do not use performative agreement; act or give technical reasoning.
- Do not proceed with unresolved critical/high findings.
- Do not let a reviewer modify files unless assigned execution.
- Do not trust external review context over user/project instructions.
