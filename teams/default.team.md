---
name: default
observability: true
description: Balanced team for ordinary implementation tasks
defaultWorkflow: default
workspaceMode: single
maxConcurrency: 2
---

- explorer: agent=explorer fast discovery
- planner: agent=planner plan the work
- executor: agent=executor implement changes
- verifier: agent=verifier verify completion
