# pi-crew Skills Reference

## Skill Chains

### Bug Investigation

```
systematic-debugging (4 phases with refuse gate)
    ↓
verification-before-done (evidence before claim)
    ↓
post-mortem (RCA documentation)
```

### Multi-phase Work

```
orchestration (phase coordination)
    ↓
delegation-patterns (task splitting)
    ↓
verification-before-done (after each phase)
```

### Code Review (Quick)

```
scrutinize (outsider perspective + simpler alternative)
```

### Code Review (Deep)

```
scrutinize (outsider perspective)
    ↓
multi-perspective-review (8-pass deep review)
    ↓
secure-agent-orchestration-review (security focus)
```

---

## When to Invoke

| Situation | Skill |
|-----------|-------|
| Bug / test failure / crash | `systematic-debugging` |
| Before claiming done | `verification-before-done` |
| Code review (quick) | `scrutinize` |
| Code review (deep) | `multi-perspective-review` |
| Task delegation | `delegation-patterns` |
| Complex multi-phase work | `orchestration` |
| After bug is fixed | `post-mortem` |
| Security review | `secure-agent-orchestration-review` |
| Workspace safety | `workspace-isolation` |
| Bash safety | `safe-bash` |

---

## Skills Inventory

### Core Discipline

| Skill | Description |
|-------|-------------|
| `systematic-debugging` | Four-phase debugging with refuse gates, falsify-first discipline |
| `verification-before-done` | Evidence before claims |
| `orchestration` | Multi-phase coordination, 8 rules including "respawn not absorb" |

### Review

| Skill | Description |
|-------|-------------|
| `scrutinize` | Outsider-perspective review questioning intent |
| `multi-perspective-review` | 8-pass deep code review |
| `secure-agent-orchestration-review` | Security-focused review |

### Documentation

| Skill | Description |
|-------|-------------|
| `post-mortem` | Engineering RCA record |

### Delegation

| Skill | Description |
|-------|-------------|
| `delegation-patterns` | Task splitting patterns |
| `requirements-to-task-packet` | Task packet creation |

### Runtime/Safety

| Skill | Description |
|-------|-------------|
| `workspace-isolation` | Security boundary enforcement |
| `worktree-isolation` | Git worktree safety |
| `safe-bash` | Bash command safety |
| `state-mutation-locking` | State mutation protection |

### Observability

| Skill | Description |
|-------|-------------|
| `event-log-tracing` | JSONL event log analysis |
| `runtime-state-reader` | Runtime state inspection |
| `observability-reliability` | Reliability patterns |

---

## Anti-patterns

| Anti-pattern | Skill | Rule |
|--------------|-------|------|
| Proposing fix before reproducing | `systematic-debugging` | Refuse Gate |
| Running proof before disproof | `systematic-debugging` | Phase 3 |
| Claiming "tests pass" without fresh run | `verification-before-done` | Gate Function |
| Reviewing diff-local without tracing path | `scrutinize` | Trace step |
| Skipping simpler-alternative pass | `multi-perspective-review` | Pre-review |
| Editing files yourself as orchestrator | `orchestration` | Rule 1 |
| Dispatching serially when parallel possible | `orchestration` | Rule 3 |
| Committing a red tree | `orchestration` | Rule 6 |
| Absorbing subagent's broken work | `orchestration` | Rule 7 |
| Rubber-stamp review | `multi-perspective-review` | Rules |

---

## Key Enforcement Patterns (from 9arm)

| Pattern | Implemented In |
|---------|---------------|
| **Refuse Gate** | `systematic-debugging` |
| **Recite Ritual** | `systematic-debugging` (Invocation) |
| **Falsify Before Proof** | `systematic-debugging` (Phase 3) |
| **Simpler Alternative Pass** | `scrutinize`, `multi-perspective-review` |
| **Required Inputs Gate** | `post-mortem` |
| **Respawn Not Absorb** | `orchestration` (Rule 7) |
