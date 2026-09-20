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

Run FAST checks ONCE and cache output WITH provenance to `.crew/cache/` (per `agents/verifier.md`: unique per-attempt filename, `set -o pipefail` so the recorded exit code is the command's — not `tee`'s — and a sibling `.meta` recording command, git revision, tree fingerprint): `npm run test:critical && npx tsc --noEmit` (completes in <60s; if this repo lacks these scripts, use its fastest documented check instead). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with reviewer and security-reviewer findings — reuse a cached log only when its provenance matches. Confirm each finding against real test output. Give PASS if findings match evidence, FAIL if critical findings are false positives or tests reveal new issues.
