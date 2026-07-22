---
name: fast-fix
description: Minimal workflow for small fixes
topology: sequential
---

## explore
role: explorer

Find the likely source of the issue: {goal}

## execute
role: executor
dependsOn: explore

Make the smallest safe fix.

## verify
role: verifier
dependsOn: execute
verify: true

Verify the fix with available evidence.
Run FAST checks ONCE (cache output to .crew/cache/): `npm run test:critical && npx tsc --noEmit` (completes in <60s). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with the fix. Do NOT re-run tests. Give PASS or FAIL with specific test evidence.
