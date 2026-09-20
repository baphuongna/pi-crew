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
Run FAST checks ONCE and cache output WITH provenance to `.crew/cache/` (per `agents/verifier.md`: unique per-attempt filename, `set -o pipefail` so the recorded exit code is the command's — not `tee`'s — and a sibling `.meta` recording command, git revision, tree fingerprint): `npm run test:critical && npx tsc --noEmit` (completes in <60s; if this repo lacks these scripts, use its fastest documented check instead). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with the changes — reuse a cached log only when its provenance matches. Do NOT re-run tests. Give PASS or FAIL with specific test evidence.
