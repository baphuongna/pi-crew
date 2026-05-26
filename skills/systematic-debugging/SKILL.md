---
name: systematic-debugging
description: "Four-phase debugging discipline with refuse gates. Use when encountering a bug, test failure, blocked run, provider error, stale state, crash, or unexpected behavior. Triggers: debug this, investigate, fix this bug, something is broken, crash, error, test failed, it broke, not working, unexpected."
---

# systematic-debugging

Core principle: no fixes without root-cause investigation first. Symptom patches create new bugs and hide the real failure.

Distilled from detailed reads of systematic-debugging, root-cause tracing, TDD, and error-analysis skill patterns.

## Invocation — Read Before Debugging

Before beginning any debug session, recite these four steps:

> **1. First is reproducibility.** Can the issue be reproduced reliably?
> **2. Know the fail path.** Where does the code break and what stops it from breaking?
> **3. Question your hypothesis.** What would disprove it?
> **4. Every run is a breadcrumb.** Cross-reference all of them.

If the user says "skip the ritual" → skip the recitation but still apply the four phases silently.

---

## Refuse Gate — Do NOT Proceed Without These

Before proposing ANY fix:

- [ ] **Can you reproduce the issue reliably?** (deterministic or >50% flake rate)
- [ ] **Do you know the root cause?** (confirmed mechanism, not a hypothesis)
- [ ] **Have you tried to FALSIFY your hypothesis first?** (disproof before proof)

If ANY answer is NO:
→ Stop.
→ State what's missing.
→ Do not propose a fix.

Exception: if the user explicitly says "just patch the symptom" — proceed but flag it as a symptom patch, not a root-cause fix.

---

## Four Phases

### 1. Root Cause Investigation

Before any fix:

- read error messages, stack traces, failing assertions, task status, and logs completely;
- reproduce narrowly and record the exact command/steps;
- check recent diffs, commits, config changes, dependency changes, and environment differences;
- trace data/control flow across component boundaries;
- add temporary diagnostics only when they answer a specific question.

For pi-crew, trace:

```text
user/tool params → config resolution → team/workflow/agent discovery → model/runtime routing → child args/env → state/events/artifacts → status/UI
```

### 2. Pattern Analysis

- Find a similar working path in the codebase.
- Compare working vs broken behavior field-by-field.
- Identify dependencies: config home, project root markers, env vars, locks, stale caches, provider model capabilities.
- Do not assume small differences are irrelevant.

### 3. Hypothesis and Test — Falsify First

- State one hypothesis: "I think X is the root cause because Y."
- Generate 3-5 ranked hypotheses, not one. Single-hypothesis thinking anchors on the first plausible idea.
- For each hypothesis:
  - What is the simplest **proof**? What is the cleanest **disproof**?
  - Run the **disproof FIRST**. If the hypothesis survives, it's real. If it dies, you saved time chasing a phantom.
  - Does it explain the symptom end-to-end? Walk it through.
- Test one variable at a time with the smallest read-only probe or targeted test.
- If wrong, discard the hypothesis instead of piling on fixes.
- After three failed fixes, question architecture or assumptions before continuing.

### 4. Implementation

- Add or identify a failing regression test when practical.
- Fix the root cause, not the symptom.
- Avoid "while I'm here" refactors.
- Verify targeted behavior, then broader gates.

## Evidence to Collect

- failing command and exit code;
- relevant manifest/tasks/events/mailbox files;
- effective config paths and redacted config;
- child Pi args/env after redaction;
- git diff and recent commits;
- provider/model/thinking resolution;
- async timing/race indicators.

## Anti-patterns

- Proposing a fix before reproducing (the refuse gate exists for a reason).
- Running proof experiments before disproof (disproof first saves time).
- Trusting a single passing run as validation (check against all prior breadcrumbs).
- Assuming real user global config cannot pollute tests.
- Treating provider errors as only transient network failures.
- Removing guards because they reveal a blocked state.
- Editing unrelated layers before checking the hypothesis.

## Breadcrumb Ledger

Maintain a running ledger of every experiment in this session. Each entry:

| # | What Changed | What Happened | Ruled In/Out |
|---|-------------|--------------|-------------|
| 1 | Added `[DBG-001]` probe | Got `[output]` | Hypothesis A ruled out |
| 2 | Changed X to Y | Same error persists | Not X |
| 3 | Checked Z config | Found mismatch | Z is contributing |

When a new hypothesis surfaces, walk the ledger:
- Does it hold for **every** prior observation?
- If any past run contradicts it, the hypothesis is wrong or incomplete.

When in doubt, design the **single experiment** whose outcome makes it certain — run that next.

Update the ledger after every run. It is your memory across the session.
