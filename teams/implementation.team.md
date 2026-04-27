---
name: implementation
description: Full implementation team with parallel specialists, critique, execution, review, and verification
defaultWorkflow: implementation
workspaceMode: single
maxConcurrency: 3
---

- explorer: agent=explorer map the codebase
- analyst: agent=analyst clarify requirements and constraints
- planner: agent=planner create execution plan
- critic: agent=critic challenge and synthesize specialist findings
- executor: agent=executor implement the plan
- reviewer: agent=reviewer review the implementation
- security-reviewer: agent=security-reviewer review security and trust boundaries
- test-engineer: agent=test-engineer design and run verification
- verifier: agent=verifier verify done
- writer: agent=writer summarize documentation or release notes when needed
