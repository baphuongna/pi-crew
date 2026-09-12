---
name: delegation-patterns
description: >
  Subagent/team delegation workflow.
  When NOT to use: pure read-only investigation (use read-only-explorer); pre-planning analysis (use scrutinize).

origin: pi-crew
triggers:
  - "delegate this"
  - "split this task"
  - "parallelize"
  - "dispatch workers"
  - "assign to team"
---
# delegation-patterns

Use this skill when deciding how to delegate work.

## Source patterns distilled

- pi-subagents: foreground/background/parallel/chain execution, fork/fresh context, worktree isolation, result watcher
- pi-crew: `src/extension/team-tool/run.ts`, `src/runtime/team-runner.ts`, `src/runtime/task-graph-scheduler.ts`, builtin `teams/*.team.md`, `workflows/*.workflow.md`
- Existing pi-crew skill: `task-packet`

## Rules

- Delegate when tasks span multiple files/subsystems, need planning/review/verification, or can be independently researched.
- Do not parallelize edits to the same file, symbol, migration path, manifest/lockfile, or generated schema unless explicitly sequenced.
- Use read-only explorer/reviewer roles for source audit; implementation workers should receive narrow task packets.
- For async/background work, provide concrete objective, scope, constraints, outputs, and verification. Do not spin in wait loops; retrieve results when notified or when needed.
- For chain-style work, pass dependency outputs forward explicitly and require downstream workers to read upstream artifacts first.
- Use worktree isolation for risky parallel code-changing tasks when repository cleanliness and merge plan allow it.
- Require workers to report blockers and smallest recoverable next action rather than making broad assumptions.

## Escalation Matrix (from SOC operations)

Define severity tiers and escalation paths for team tasks:

```yaml
escalation:
  tiers:
    - level: P1
      name: Critical
      sla_response: 15m
      sla_resolution: 1h
      owner: lead
      notify: [manager, stakeholders]
      criteria: [data_loss, security_breach, complete_outage, customer_facing]
    - level: P2
      name: High
      sla_response: 1h
      sla_resolution: 4h
      owner: senior_dev
      notify: [lead]
      criteria: [partial_outage, significant_bug, regression]
    - level: P3
      name: Medium
      sla_response: 4h
      sla_resolution: 24h
      owner: mid_dev
      notify: [team]
      criteria: [minor_bug, feature_break, ux_issue]
    - level: P4
      name: Low
      sla_response: 24h
      sla_resolution: 1w
      owner: junior_dev
      notify: []
      criteria: [enhancement, low_priority, tech_debt]
  escalation_path: [P4 → P3 → P2 → P1]
  override_conditions: [security, data_loss, customer_facing]
```

### Escalation Rules

1. **Escalate up** when: task exceeds SLA, blocker unresolved, scope change required
2. **Override** for: security incidents (skip P4/P3), data loss (immediate P1)
3. **Notify** at each tier: owner first, then notify list
4. **Document** every escalation with reason and timestamp

## Task packet checklist

- objective
- scope/paths
- allowed edits vs read-only areas
- constraints and project rules
- dependencies/input artifacts
- expected output artifacts
- acceptance criteria
- verification commands
- escalation conditions
- severity/tier (P1-P4)
- response SLA

## Enforcement — Delegation Patterns Gate

**Before delegating work to workers, verify:**

- [ ] Task packet is complete (objective, scope, constraints, verification, escalation)
- [ ] File ownership is explicit (no two workers touch the same file)
- [ ] Parallel tasks have independent/s disjoint file scope
- [ ] Async workers have concrete objectives with notification paths (not polling loops)
- [ ] Severity/tier (P1-P4) and SLA assigned

If ANY answer is NO → Stop. Complete the task packet before dispatching.

## Anti-patterns

- Sending broad "fix everything" prompts to multiple editors in one workspace.
- Waiting for async workers by sleeping/polling when result notifications exist.
- Letting review workers modify files.
- Claiming completion without durable artifacts or verification evidence.

## Verification

For orchestration changes:

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/team-recommendation.test.ts test/unit/task-output-context-security.test.ts test/integration/phase3-runtime.test.ts
npm test
```

## Budget

This skill applies a 3-attempt budget: 1 initial + max 2 re-attempts.

Stamp every invocation:

```
attempt X of 3 (Y attempts remaining)
```

An attempt is one delegation decision (choose agent/team → dispatch → collect). Re-attempt when the delegation target fails or returns unusable output.

Re-attempts only when the previous attempt materially changes the decision or risk. Do NOT spend a re-attempt on mechanical changes or already-resolved findings. When exhausted, escalate to the user with options (accept risk / change scope / exceptional budget).
