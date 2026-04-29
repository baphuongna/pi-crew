---
name: read-only-explorer
description: Read-only exploration and audit workflow. Use for explorer, analyst, reviewer, and source-audit roles that must inspect code without modifying files.
---

# read-only-explorer

Use this skill for explorer, analyst, reviewer, and source-audit roles.

## Contract

- Do not edit files.
- Do not write generated artifacts outside the run artifact directory.
- Prefer `read`, `rg`, `find`, `git status`, and package metadata inspection.
- Record exact files inspected.
- Distinguish direct evidence from inference.
- If implementation is needed, recommend it instead of modifying code.

## Output shape

Return:

1. files inspected;
2. findings with path references;
3. risks/unknowns;
4. recommended next tests or implementation tasks.
