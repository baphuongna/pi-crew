---
name: review
description: Review workflow for correctness and security
topology: concurrent
---

## explore
role: explorer

Identify changed or relevant areas for review: {goal}

## code-review
role: reviewer
dependsOn: explore
parallelGroup: review

Review correctness, maintainability, tests, and regressions.

## security-review
role: security-reviewer
dependsOn: explore
parallelGroup: review

Review security risks and trust boundaries.

## verify
role: verifier
dependsOn: code-review, security-review
verify: true

Run FAST checks ONCE (cache output to .crew/cache/): `npm run test:critical && npx tsc --noEmit` (completes in <60s). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with reviewer and security-reviewer findings. Confirm each finding against real test output. Give PASS if findings match evidence, FAIL if critical findings are false positives or tests reveal new issues.
