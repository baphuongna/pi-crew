---
name: council
description: >
  Spawn 3 adversarial subagents (Skeptic, Pragmatist, Critic) to evaluate a decision,
  architecture choice, or plan. Anti-anchoring: each role receives ONLY the question,
  not conversation history. Aggregates votes into consensus recommendation with dissent tracking.
  Use when facing critical decisions, architecture choices, security tradeoffs, or plan reviews
  where single-perspective analysis is insufficient. When NOT to use: trivial choices where consensus adds no value; time-critical decisions that can't afford 3 parallel reviews.
origin: ECC/skills/council
---

# Council Pattern — Adversarial Multi-Perspective Decision Making

## When to Use

- Evaluating architecture decisions with significant tradeoffs
- Reviewing security-sensitive design choices
- Validating implementation plans before execution
- Resolving ambiguity where multiple valid approaches exist
- Deciding whether to build, buy, or extend

## Prerequisites

- A clearly formulated question or decision to evaluate
- Sufficient context about the system for meaningful analysis

## Operating Rules

1. You MUST spawn exactly 3 subagents with isolated context (fresh, not forked)
2. Each subagent receives ONLY the question — NO conversation history (anti-anchoring)
3. You MUST NOT influence any subagent's analysis direction
4. You MUST record all 3 votes before forming consensus
5. You MUST include dissent in the final recommendation

## Workflow

### Step 1: Formulate the Question

Write a clear, neutral question that includes:
- The decision to be made
- Relevant constraints (performance, security, timeline)
- Available options (if known)
- What "success" looks like

DO NOT bias the question toward any particular answer.

### Step 2: Spawn 3 Council Members

Launch 3 parallel subagents, one per seat, using the councillor agents:

- **Skeptic** (finds flaws) → `subagent_type='councillor-skeptic'`
- **Pragmatist** (weighs tradeoffs) → `subagent_type='councillor-pragmatist'`
- **Critic** (stress-tests reasoning) → `subagent_type='councillor-critic'`

Each subagent's prompt is EXACTLY the question text from Step 1 — nothing else, no context preamble, no your-opinion-matters framing.

The seat perspective, output contract (Position/Confidence/Reasoning + seat-specific field), and anti-anchoring are baked into the agent files. The councillor agents carry `inheritProjectContext: false`, so isolation is STRUCTURAL (enforced at spawn), not merely instructed — do not wrap the question with your own framing or history.

All three seats return the shared vote block:

```
Position: PRO | CON | ABSTAIN
Confidence: 0.0-1.0
Reasoning: <analysis>
<Seat-specific field: Top 3 Risks | Alternatives Considered | Hidden Assumptions>
```

### Step 3: Aggregate Votes

Collect all 3 responses. Compute consensus:

| Vote Pattern | Consensus Level | Action |
|---|---|---|
| 3 PRO | **Strong accept** | Proceed with high confidence |
| 2 PRO, 1 CON | **Weak accept** | Proceed, but address CON dissent |
| 2 PRO, 1 ABSTAIN | **Accept with uncertainty** | Proceed, investigate ABSTAIN concerns |
| 1 PRO, 1 CON, 1 ABSTAIN | **No consensus** | Reformulate question or gather more data |
| 2 CON, 1 PRO | **Weak reject** | Do not proceed; explore alternatives |
| 3 CON | **Strong reject** | Reject; fundamentally rethink approach |

### Step 4: Output Recommendation

```markdown
## Council Decision: [Question Summary]

### Votes
| Role | Position | Confidence |
|------|----------|------------|
| Skeptic | PRO/CON/ABSTAIN | 0.X |
| Pragmatist | PRO/CON/ABSTAIN | 0.X |
| Critic | PRO/CON/ABSTAIN | 0.X |

### Consensus: [STRONG ACCEPT | WEAK ACCEPT | NO CONSENSUS | WEAK REJECT | STRONG REJECT]

### Recommendation
[One-paragraph synthesis]

### Key Insights
- [Best point from Skeptic]
- [Best point from Pragmatist]
- [Best point from Critic]

### Dissent
[Summary of any dissenting opinions and why they were overruled or remain unresolved]

### Action Items
- [ ] [Specific next step 1]
- [ ] [Specific next step 2]
```

## Anti-Patterns

- DO NOT spawn fewer than 3 roles
- DO NOT share one subagent's analysis with another (contamination)
- DO NOT phrase the question to favor a specific outcome
- DO NOT override the council's consensus without documented justification
- DO NOT use council for trivial decisions (wastes resources)

## Enforcement — Council Gate

Before finalizing a council result, verify:

- [ ] All 3 roles spawned with isolated (fresh) context
- [ ] Each role received ONLY the question, no prior conversation
- [ ] All 3 votes recorded with confidence scores
- [ ] Consensus level computed from vote pattern
- [ ] Dissent explicitly documented (not hidden)
- [ ] Recommendation includes actionable next steps

## Budget

This skill applies a 3-attempt budget: 1 initial + max 2 re-attempts.

Stamp every invocation:

```
attempt X of 3 (Y attempts remaining)
```

An attempt is one full council round (3 adversarial agents → aggregate → consensus). Re-attempt when votes deadlock or dissent reveals information the first round missed.

Re-attempts only when the previous attempt materially changes the decision or risk. Do NOT spend a re-attempt on mechanical changes or already-resolved findings. When exhausted, escalate to the user with options (accept risk / change scope / exceptional budget).
