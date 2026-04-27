---
name: implementation
description: Adaptive implementation workflow where a planner agent decides the subagent fanout
---

## assess
role: planner
output: adaptive-plan.json

Assess this task and decide how many subagents are actually needed for: {goal}

You are the orchestration planner. Inspect the repository enough to choose an efficient crew; do not use a fixed template. Small/simple tasks may need one executor plus one verifier. Risky or broad tasks may need parallel explorers, specialists, implementers, reviewers, security reviewers, or test engineers.

Return a concise rationale, then include exactly one JSON block between these markers:

ADAPTIVE_PLAN_JSON_START
{
  "phases": [
    {
      "name": "short-phase-name",
      "tasks": [
        {
          "role": "explorer|analyst|planner|critic|executor|reviewer|security-reviewer|test-engineer|verifier|writer",
          "title": "short task title",
          "task": "specific autonomous task prompt for this subagent"
        }
      ]
    }
  ]
}
ADAPTIVE_PLAN_JSON_END

Rules:
- Choose the smallest effective number of subagents.
- Use parallel tasks in the same phase only when their work is independent.
- Later phases depend on all tasks in the previous phase.
- Include verification/review tasks when implementation is requested.
- Do not include more than 12 total subagents unless the user explicitly asks for a large crew.
