---
name: task-packet
description: Structured worker task-packet template. Use when creating or executing worker tasks that need clear objective, scope, constraints, outputs, acceptance criteria, and verification.
---

# task-packet

Use this skill when creating or executing a worker task.

## Required sections

Each task should clarify:

- objective;
- scope and paths;
- constraints and permissions;
- dependencies and expected inputs;
- expected outputs/artifacts;
- acceptance criteria;
- verification commands;
- escalation conditions.

## Worker behavior

- Read dependency outputs before starting dependent work.
- Keep outputs concise and artifact-oriented.
- Do not claim completion until required artifacts and status are durable.
- If blocked, report the blocker and the smallest recoverable next action.
