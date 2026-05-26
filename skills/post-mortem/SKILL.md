---
name: post-mortem
description: "Write engineering RCA record after bug is fixed. Use when asking: write post-mortem, RCA, root cause analysis, document this fix, close out this bug. Triggers: post-mortem, postmortem, root cause, RCA, document this fix, write up the cause, close out bug."
---

# post-mortem

The canonical engineering record of a bug fix. Written after debugging lands a real fix.

## Required Inputs — Refuse to Draft Without These

- [ ] **Reliable repro exists** (deterministic or high-rate flake)
- [ ] **Root cause is known** (mechanism identified, not a hypothesis)
- [ ] **Fix is identified** (PR / commit / branch)
- [ ] **Fix is validated** (original repro now passes)

If any missing → list what's missing and stop. Do not draft.

## Structure

### 1. Summary

What broke (user terms), what fixed it (one sentence). JIRA key, PR, owner. A reader who stops here should have the right answer.

### 2. Symptom

Concrete: test output, error message, log line. No paraphrase. What was actually observed.

### 3. Root Cause

The actual bug mechanism. Code identifiers welcome — function names, file paths, branch conditions. Walk the cause chain end-to-end.

### 4. Why It Produced the Symptom

Walk the chain so reader connects symptom to cause. Often non-obvious — bug is in X but visible failure is in Y.

### 5. Fix

What changed and why this addresses root cause. Link to PR/commit. If a previous fix attempt papered over the symptom, name it and explain what was wrong.

### 6. How It Was Found

Short. The debugging path:

- What repro made it deterministic
- What tools cracked it
- Hypotheses tried and rejected (with one-line reason each)
- The single experiment that confirmed the cause

### 7. Why It Slipped Through

CI gap? Latent code? Workload gap? Incomplete prior fix? Review miss? Be specific.

If honest answer is "no good reason" — say so. **Blameless** — describe the gap, not the person.

### 8. Validation

How we know the fix works:

- Original failing test now passes (test name)
- Customer workload now completes (workload identifier)
- Other affected configs/workloads also tested

If only one config validated, say so explicitly.

### 9. Action Items

What + owner + tracking artifact:

- Regression test added at <seam>. (Owner, test name)
- CI gap closed: <new check>. (Owner, ticket)
- Doc/runbook updated. (Owner, link)

If none needed: "None — fix is sufficient and no class-of-bug follow-up warranted."

## Tone

This is engineer-to-engineer:

- **Code identifiers are first-class.** Keep them — future engineers grep their way back.
- **Mechanism over narrative.** Walk the cause chain, don't soften.
- **Blameless.** Describe gaps and bugs, never people.
- **No hedging.** State it or don't write it.

## Rules

- Never invent facts.
- Never strip code identifiers (they are the index).
- State validation coverage honestly.
- Get sign-off before posting to JIRA.
