---
name: default
description: Explore, plan, execute, and verify
topology: sequential
---

## explore
role: explorer

Explore the codebase for the goal: {goal}

## plan
role: planner
dependsOn: explore
output: plan.md

Create a concise implementation plan for: {goal}

## execute
role: executor
dependsOn: plan

Implement the plan for: {goal}

## verify
role: verifier
dependsOn: execute
verify: true

Verify completion for: {goal}
Run FAST checks ONCE (cache output to .crew/cache/): `npm run test:critical && npx tsc --noEmit` (completes in <60s). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with the changes. Do NOT re-run tests. Give PASS or FAIL with specific test evidence.
