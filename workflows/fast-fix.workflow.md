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
Run FAST checks ONCE and cache output WITH provenance to `.crew/cache/` (per `agents/verifier.md`: unique per-attempt filename, `set -o pipefail` so the recorded exit code is the command's — not `tee`'s — and a sibling `.meta` recording command, git revision, tree fingerprint): `npm run test:critical && npx tsc --noEmit` (completes in <60s; if this repo lacks these scripts, use its fastest documented check instead). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with the fix — reuse a cached log only when its provenance matches. Do NOT re-run tests. Give PASS or FAIL with specific test evidence.
