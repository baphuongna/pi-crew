---
name: default
description: Plan the goal into concrete tasks, execute them in parallel phases, verify
topology: complex-dag
adaptive: true
---

## assess
role: planner
output: adaptive-plan.json

Plan the concrete task list for: {goal}

You are the orchestration planner. Inspect the repository enough to break the goal into specific, executable tasks; do not use a fixed template. Small tasks may need one executor plus one verifier; broader tasks may need parallel explorers, executors, and a verification phase.

Return a concise rationale, then include exactly one JSON block between these markers:

ADAPTIVE_PLAN_JSON_START
{
  "phases": [
    {
      "name": "short-phase-name",
      "tasks": [
        {
          "role": "explorer|executor|verifier",
          "title": "short task title",
          "task": "specific autonomous task prompt for this subagent"
        }
      ]
    }
  ]
}
ADAPTIVE_PLAN_JSON_END

Rules:
- **MAXIMIZE PARALLELISM**: Put independent tasks in the SAME phase so they run concurrently. Never create sequential phases when tasks are independent.
- Task titles name the concrete piece of work — they become the task list the user watches.
- Choose the smallest effective number of tasks per phase; a simple goal may have 1-2 phases with 1-2 tasks.
- End implementation plans with a verification phase (`verifier` role): run FAST targeted checks only (e.g. the affected test files), never the full suite.
- Tasks within the same phase run in parallel; phases run sequentially.
- Do not include more than 12 tasks per phase; split or summarize oversized plans instead.
