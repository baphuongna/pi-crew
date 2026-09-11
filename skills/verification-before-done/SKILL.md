---
name: verification-before-done
description: >
  Evidence before claims.
  When NOT to use: mid-task self-correction (use scrutinize); pure execution tasks where output IS evidence.

origin: pi-crew
triggers:
  - "done"
  - "verify this"
  - "is it working"
  - "check if it passes"
  - "ready to ship"


---
# verification-before-done

Core principle: evidence before claims. A worker report, green-looking log, or previous run is not fresh verification.

Distilled from detailed reads of agent-skill patterns for verification-before-completion, TDD, review reception, and QA workflows.

## Gate Function

Before any completion claim:

1. Identify the command or inspection that proves the claim.
2. Run the full command fresh, or explicitly state why a command cannot be run.
3. Read the output, including exit code and failure counts.
4. Compare the output to the claim.
5. Report the claim only with the evidence.

## Claim-to-Evidence Table

| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | Fresh test output with zero failures | Prior run, "should pass" |
| Typecheck passes | Typecheck command exit 0 | Lint or targeted tests only |
| Bug fixed | Original symptom/regression test passes | Code changed |
| Requirements met | Checklist against request/plan | Generic test success |
| Agent completed | Worker output plus artifact/diff/state inspection | Worker says DONE |
| Safe to commit | Relevant checks pass and status reviewed | Partial local confidence |

## Verification Ladder

Choose the smallest reliable gate, then escalate when risk requires it:

1. Read-only inspection for plans/reviews.
2. Targeted unit test for touched behavior.
3. Typecheck for TypeScript/schema/API changes.
4. Integration test for runtime, subprocess, state, filesystem, UI, config, or session behavior.
5. Full suite before commit/release or broad changes.
6. Real Pi smoke only when safe and needed.

## Done Report

Include:

- changed files or read-only status;
- commands run and pass/fail result;
- artifacts, run IDs, logs, or state paths inspected;
- behavior actually verified;
- skipped checks and why;
- risks and rollback notes.

## Required Final Evidence

Before finalizing any work, report:

- **changed files**: list of files modified (or `none` for read-only work)
- **tests/checks run**: command and pass/fail result for each
- **artifacts**: run IDs, log paths, or state files inspected
- **risks and rollback notes**: any known risks, how to undo the changes

## Red Flags

Stop before saying done if you are using words like "should", "probably", "looks", "seems", "I think", or if you are trusting an agent report without checking evidence.

## Anti-Patterns

- **Don't** claim "tests pass" without running them in the current session
- **Don't** trust agent reports without checking evidence yourself
- **Don't** use fuzzy language like "seems", "probably", "looks like"
- **Don't** skip providing verification commands for claims
- **Don't** claim done if you're still using hypotheses instead of evidence

## Budget

This skill applies a 3-attempt budget: 1 initial + max 2 re-attempts.

Stamp every invocation:

```
attempt X of 3 (Y attempts remaining)
```

An attempt is one fresh verification run (identify command → run → read output → compare to claim). Re-attempt when output contradicts the claim or reveals a new failure mode.

Re-attempts only when the previous attempt materially changes the decision or risk. Do NOT spend a re-attempt on mechanical changes or already-resolved findings. When exhausted, escalate to the user with options (accept risk / change scope / exceptional budget).
