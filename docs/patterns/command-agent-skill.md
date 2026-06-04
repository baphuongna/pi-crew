# Command → Agent → Skill: 3-Tier Pattern

> **Origin**: `source/claude-code-best-practice/CLAUDE.md`
> **Applicable to**: pi-crew v0.5.25+

## The 3 Tiers

```
User invokes → [Command] → [Agent] → [Skill]
                entry       worker     reusable
                point       + tools    capability
```

### Tier 1: Command (Entry Point)
- Maps user intent to an agent
- Defined in workflow `.md` files as a step
- Example: `team action='run' team='review'`

### Tier 2: Agent (Specialized Worker)
- Has a system prompt, model, tools, skills, effort level
- Defined as `.md` file with YAML frontmatter in `agents/` directory
- Example:

```markdown
---
name: security-reviewer
description: Chief Security Officer who finds OWASP Top 10 threats
tools: read, bash, edit
model: claude-sonnet-4-20250514
effort: high
skills: safe-bash, security-review
maxTurns: 30
contextMode: fresh
---

You are a Chief Security Officer...
```

### Tier 3: Skill (Reusable Capability)
- A `SKILL.md` file with instructions + operating rules
- Injected into agent context at dispatch time
- Example: `skills/safe-bash/SKILL.md`

## How to Compose

1. **Define the skill** — Create `skills/my-skill/SKILL.md`
2. **Define the agent** — Create `agents/my-agent.md` referencing the skill
3. **Define the workflow** — Create `workflows/my-workflow.workflow.md` referencing the agent as a step

```yaml
# workflows/my-workflow.workflow.md
steps:
  - name: analyze
    agent: my-agent
    # The agent loads my-skill automatically
```

## Agent YAML Frontmatter Reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent identifier |
| `description` | string | One-line description for routing |
| `tools` | csv | Tools the agent can use |
| `model` | string | Model override |
| `skills` | csv | Skills to inject |
| `effort` | `low`/`medium`/`high` | Work effort level |
| `maxTurns` | number | Maximum conversation turns |
| `contextMode` | `fresh`/`fork` | Context inheritance |
| `loadMode` | `essential`/`lean` | Tool loading strategy |
| `thinking` | string | Thinking level override |
