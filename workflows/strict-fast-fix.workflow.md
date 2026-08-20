---
name: strict-fast-fix
description: T4 follow-up — fast-fix variant with strict spec binding (ADR-6 §5). Use this to exercise provenance v2 / freeze-at-dispatch / strict-mode gate end-to-end. Imports the spec via `scripts/spec-import.mjs` first.
topology: sequential
---

## explore
role: explorer
specRefs: b5-t4-strict-probe
specStrict: true

Find the likely source of the issue: {goal}. You are held to the SPEC-EVIDENCE contract for the referenced spec — emit a `=== SPEC-EVIDENCE ===` block with `cited: <id>:<id>` lines for each requirement the work touches, then `=== END ===`.

## execute
role: executor
dependsOn: explore

Make the smallest safe fix. Continue the SPEC-EVIDENCE contract from explore: cite every requirement the implementation satisfies.

## verify
role: verifier
dependsOn: execute
verify: true

Verify the fix with available evidence, AND cross-reference the SPEC-EVIDENCE footer from explore+execute against the spec's requirements (machine-check the citations vs the spec id set).
Run FAST checks ONCE (cache output to .crew/cache/): `npm run test:critical && npx tsc --noEmit` (completes in <60s). Do NOT run `npm run test:unit` or `npm test` — too slow (642 files, >4 min). Cross-reference cached output with the fix. Do NOT re-run tests. Give PASS or FAIL with specific test evidence + spec gate verdict.
