---
name: verify-evidence
description: Final verification evidence checklist. Use before finalizing implementation, review, or audit work to report changed files, checks run, artifacts, risks, and rollback notes.
---

# verify-evidence

Use this skill before finalizing implementation, review, or audit work.

## Required final evidence

Include:

- changed files, or `none` for read-only work;
- tests/checks run with pass/fail result;
- relevant artifacts, run IDs, or log paths;
- unresolved risks and rollback notes when code changed.

## Verification ladder

Prefer the smallest reliable check first, then escalate:

1. Targeted unit tests for touched behavior.
2. Typecheck for TypeScript changes.
3. Integration tests for runtime/spawn/state changes.
4. `npm pack --dry-run` for package/release/doc changes.
5. Real Pi smoke only when needed and safe.
