---
name: scrutinize
description: "Outsider-perspective review questioning intent before tracing code. Use when asking: should this even exist?, is there a simpler way?, get a second opinion, before deep code review. Triggers: scrutinize this, question this, is there a better way?, simplify this, overkill?, too complex."
---

# Scrutinize

Stand outside the change and ask whether it should exist at all, then verify it actually does what it claims end-to-end.

## Operating Stance

- **Outsider.** Forget who wrote it and why they think it's right. Read the artifact cold.
- **End-to-end, not diff-local.** The diff is the entry point, not the scope.
- **Actionable, concise, with rationale.** Every finding states what to change, why, and what evidence led you there.

## Workflow

### 1. Intent — Is this necessary?

- State the goal in one sentence, in your own words. If you cannot, the artifact is underspecified — say so and stop.
- Ask: **Is there a simpler way?**
  - Delete/does-nothing (is the problem real and load-bearing?)
  - Use existing code (does this already exist?)
  - Smaller change (solves 90% of goal with 10% of risk?)
  - Different layer (config vs code, framework vs app, build vs runtime?)
- If a better alternative exists, name it BEFORE the line-by-line review.

### 2. Trace — Walk the actual code path

- For each behavior the change claims, trace end-to-end through real code — not just the lines in the diff.
- Include unchanged code on either side of the diff. Bugs hide at the seams.
- Entry point → call sites → branches taken → state mutated → exit/return/side effect.

### 3. Verify — Does it do what it claims?

- Does the traced code actually produce the behavior?
- What inputs/states would break it? (Edge cases, concurrent callers, error paths, partial failures, retries, empty/null/unicode/huge inputs)
- What does it silently change? (Performance, error semantics, observability, contracts)
- How is it tested? (Do tests exercise the traced path, or pass while skipping it?)

### 4. Report

Format per finding:

```text
[severity] file:line
Issue: ...
Impact: ...
Fix: ...
```

Severity:

- critical: data loss, secret leak, arbitrary command/path escape
- high: broken core workflow, ownership bypass
- medium: regression, flaky behavior
- low: polish, maintainability

Close with verdict: **ship / fix-then-ship / rework / reject** — with single biggest reason.

## Rules

- **No rubber-stamps.** "LGTM" is not an output. If nothing found, say what you traced.
- **Cite or it didn't happen.** Every claim needs specific path/file/line.
- **One simpler-alternative pass is MANDATORY.** Skip only if user says "don't question scope."
- **Distinguish claim from verification.** "The PR says X" and "I traced X and confirmed" are different.
- **No flattery, no hedging.** State the finding.
