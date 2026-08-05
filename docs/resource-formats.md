# pi-crew Resource Formats

## Agent files

Location:

```text
agents/{name}.md                                # builtin (in this package)
~/.pi/agent/agents/{name}.md                    # user-global
.crew/agents/{name}.md                          # project (new layout)
.pi/teams/agents/{name}.md                      # project (legacy layout when .pi/ exists)
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
- {role-name}: agent={agent-name} [model={provider/model}] [fallbackModels={a,b}] [thinking={level}] [skills={a,b}|false] [maxConcurrency={n}] optional description
```

- `model` — primary model for this role (e.g. `openai/gpt-5`, `anthropic/claude-sonnet-4-5`)
- `fallbackModels` — comma-separated fallback models tried in order when the primary fails (e.g. `fallbackModels=openai/gpt-5-mini,anthropic/claude-haiku-4-5`)
- `thinking` — thinking level override for this role (`high`, `medium`, `low`, `off`)
- `skills` — additional skills to inject, or `false` to disable role-default skills
- `maxConcurrency` — max parallel tasks for this role

## Workflow files

Location:

```text
workflows/{name}.workflow.md                    # builtin (in this package)
~/.pi/agent/workflows/{name}.workflow.md        # user-global
.crew/workflows/{name}.workflow.md              # project (new layout)
.pi/teams/workflows/{name}.workflow.md          # project (legacy layout when .pi/ exists)
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

Each step starts with `## step-id` followed by recognized step metadata such as `role:` before the blank line. Level-2 headings inside task bodies are preserved unless they look like a step section with recognized metadata; use `###` or lower for maximum compatibility.
