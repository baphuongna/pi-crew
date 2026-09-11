---
name: secure-agent-orchestration-review
description: >
  Use when reviewing delegation, skill loading, tool access, worker prompts, artifacts, runtime config, state, ownership, or subprocess execution.
  When NOT to use: pure code quality issues without security implications (use multi-perspective-review); single-file fixes (use scrutinize).

origin: pi-crew
triggers:
  - "review delegation"
  - "check skill security"
  - "audit prompts"
  - "security review"
  - "orchestration audit"


---
# secure-agent-orchestration-review

Core principle: every delegated worker crosses trust boundaries. Safe orchestration requires contained paths, explicit ownership, scoped tools, non-invasive defaults, and prompt-injection resistance.

Distilled from detailed reads of security notice, insecure-defaults, sharp-edges, differential-review, guardrail, and skill quality patterns.

## Trust Boundaries

Review:

- parent session ↔ child Pi worker;
- user prompt ↔ generated task packet;
- project skills ↔ package skills;
- global config ↔ project config;
- artifacts/logs ↔ future prompts/UI;
- mailbox/respond/steer/cancel ↔ session ownership;
- external skills/docs ↔ prompt injection/tool poisoning;
- runtime env/CLI args ↔ provider/model behavior.

## Must-Check Findings

- Unsafe defaults: scaffold mode unexpectedly enabled, dangerous limits, missing depth guards, overbroad tools.
- Path containment: cwd override escape, symlink traversal, unsafe skill names, absolute path leakage.
- Prompt injection: untrusted output treated as instruction, skill metadata overtrusted, missing precedence text.
- Secrets: env/config/log/artifact/diagnostic leakage.
- Destructive commands: delete/prune/reset/force push without explicit confirmation.
- Ownership races: authorization checked outside lock, stale task/manifest written after re-read.
- Supply chain: external skill content imported without review, unknown tool requirements, hidden commands.

## Secure Defaults for pi-crew

- Real execution should be explicit and disable-able, but generated config must not accidentally block normal workflows.
- Project overrides should be contained to the project root.
- Missing/invalid config should fall back safely.
- Skills should be loaded by safe name and source-labeled without absolute path disclosure.
- Worker prompts should state instruction precedence and treat artifacts as data.

## Enforcement — Secure Agent Orchestration Review Gate

**Before reporting security findings, verify:**

- [ ] All trust boundaries examined (parent↔child, user↔task packet, project↔package skills, etc.)
- [ ] Must-check findings covered: unsafe defaults, path containment, prompt injection, secrets, destructive commands, ownership races, supply chain
- [ ] Finding format complete: severity, path/symbol, scenario, fix, verification
- [ ] Must-fix security issues separated from hardening suggestions
- [ ] Verification commands provided for each finding

If ANY answer is NO → Stop. Complete security review before reporting.

## Finding Format

Include severity, path/symbol, scenario, fix, and verification. Separate must-fix security issues from hardening suggestions.

## Anti-Patterns

- **Don't** skip checking for unsafe defaults in configuration
- **Don't** trust agent output without verifying path containment
- **Don't** skip prompt injection checks when processing user input
- **Don't** skip secrets detection in environment and config files
- **Don't** skip checking for ownership race conditions in concurrent operations
