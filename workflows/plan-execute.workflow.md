---
name: plan-execute
description: Plan and execute a goal already analyzed by the calling session (no explore step)
topology: sequential
---

## plan
role: planner
output: plan.md
reads: analysis.md

Create a concise implementation plan for: {goal}

The calling session has already analyzed the problem. Its analysis is provided
as shared context (analysis.md). Build directly on that analysis; only re-verify
file paths and facts you need. Do not redo full discovery.

## execute
role: executor
dependsOn: plan

Implement the plan for: {goal}

## verify
role: verifier
dependsOn: execute
verify: true

Verify completion for: {goal}
Run tests ONCE (cache to .crew/cache/), read changed files from executor context. Cross-reference test output with the changes. Do NOT re-run tests. Give PASS or FAIL with specific test evidence.
