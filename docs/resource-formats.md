# pi-crew Resource Formats

## Agent files

Location:

```text
agents/{name}.md
~/.pi/agent/agents/{name}.md
.pi/agents/{name}.md
```

Format:

```md
---
name: executor
description: Implement planned code changes
model: claude-sonnet-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
tools: read, grep, find, ls, bash, edit, write
extensions: /path/to/extension.ts
skills: safe-bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
triggers: auth, tests
useWhen: multi-file implementation with tests
avoidWhen: one-line typo
cost: cheap
category: implementation
---

System prompt body.
```

Optional routing metadata fields:

| Field | Meaning |
| --- | --- |
| `triggers` | Comma-separated terms that should route work to this agent/team |
| `useWhen` | Comma-separated natural-language use cases |
| `avoidWhen` | Comma-separated cases where the agent/team should not be used |
| `cost` | `free`, `cheap`, or `expensive` hint for autonomous routing |
| `category` | Free-form grouping such as `frontend`, `security`, `docs` |

## Team files

Location:

```text
teams/{name}.team.md                            # builtin (in this package)
~/.pi/agent/teams/{name}.team.md                # user-global (shared with pi-mono)
.crew/teams/{name}.team.md                      # project (new layout)
.pi/teams/teams/{name}.team.md                  # project (legacy layout when .pi/ exists)
```

Format:

```md
---
name: implementation
description: Full implementation team
defaultWorkflow: implementation
workspaceMode: single
maxConcurrency: 3
triggers: implementation, refactor
useWhen: multi-file implementation
cost: cheap
category: implementation
---

- explorer: agent=explorer map the codebase
- planner: agent=planner create plan
- executor: agent=executor implement
- verifier: agent=verifier verify
```

Role line:

```text
- {role-name}: agent={agent-name} optional description
```

## Workflow files

Location:

```text
workflows/{name}.workflow.md
~/.pi/agent/workflows/{name}.workflow.md
.pi/workflows/{name}.workflow.md
```

Format:

```md
---
name: default
description: Explore, plan, execute, verify
---

## explore
role: explorer

Explore for: {goal}

## plan
role: planner
dependsOn: explore
output: plan.md

Create a plan for: {goal}
```

Step fields:

| Field | Meaning |
| --- | --- |
| `role` | Team role to run |
| `dependsOn` | Comma-separated step IDs |
| `parallelGroup` | Optional grouping metadata |
| `output` | Output file name or `false` |
| `reads` | Comma-separated read files or `false` |
| `model` | Step model override |
| `skills` | Comma-separated skills or `false` |
| `progress` | `true`/`false` |
| `worktree` | `true`/`false` metadata |
| `verify` | `true`/`false` verification marker |

Avoid using level-2 headings (`##`) inside task bodies because they delimit workflow steps.
