---
name: fast-fix
observability: true
description: Small team for quick bug fixes
defaultWorkflow: fast-fix
workspaceMode: single
maxConcurrency: 1
---

- explorer: agent=explorer find the relevant files
- executor: agent=executor make the fix
- verifier: agent=verifier verify the fix
