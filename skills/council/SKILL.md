---
name: council
description: >
  Spawn 3 adversarial subagents (Skeptic, Pragmatist, Critic) to evaluate a decision,
  architecture choice, or plan. Anti-anchoring: each role receives ONLY the question,
  not conversation history. Aggregates votes into consensus recommendation with dissent tracking.
  Use when facing critical decisions, architecture choices, security tradeoffs, or plan reviews
  where single-perspective analysis is insufficient.
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

Launch 3 parallel subagents with these EXACT roles:

**Skeptic** (Goal: Find flaws):
```
You are the Skeptic on a council evaluating: [QUESTION]

Your role: Find every possible flaw, risk, and failure mode.
- Challenge assumptions
- Identify edge cases that break the proposed approach
- Focus on what could go WRONG
- Rate your confidence (0.0-1.0) and give a PRO/CON/ABSTAIN position
- Provide your top 3 risks

Output format:
Position: PRO | CON | ABSTAIN
Confidence: 0.0-1.0
Reasoning: [your analysis]
Top 3 Risks: [list]
```

**Pragmatist** (Goal: Evaluate tradeoffs):
```
You are the Pragmatist on a council evaluating: [QUESTION]

Your role: Weigh practical tradeoffs objectively.
- Consider implementation cost, maintenance burden, team impact
- Evaluate time-to-value and opportunity cost
- Compare against realistic alternatives
- Rate your confidence (0.0-1.0) and give a PRO/CON/ABSTAIN position

Output format:
Position: PRO | CON | ABSTAIN
Confidence: 0.0-1.0
Reasoning: [your analysis]
Alternatives Considered: [list]
```

**Critic** (Goal: Stress-test reasoning):
```
You are the Critic on a council evaluating: [QUESTION]

Your role: Stress-test the logical foundations of each possible answer.
- Identify logical fallacies in common arguments for/against
- Check if the question itself contains hidden assumptions
- Evaluate whether the stated constraints are real or assumed
- Rate your confidence (0.0-1.0) and give a PRO/CON/ABSTAIN position

Output format:
Position: PRO | CON | ABSTAIN
Confidence: 0.0-1.0
Reasoning: [your analysis]
Hidden Assumptions: [list]
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
