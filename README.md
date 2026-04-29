# pi-crew

`pi-crew` is a Pi extension/package for coordinated AI teams: autonomous routing, manual slash-command controls, durable run state, artifacts, async/background execution, optional worktree isolation, resource management, validation, import/export, dashboard helpers, and safe API interop.

NPM package:

```text
pi-crew
```

GitHub repository:

```text
https://github.com/baphuongna/pi-crew
```

## Status

`pi-crew` is published on npm and implemented with safe execution defaults and product-oriented foundations.

Current highlights:

- one main Pi tool: `team`
- autonomous delegation policy injection before agent start
- metadata-aware `recommend` action for routing, decomposition, fanout hints, async/worktree suggestions
- configurable autonomy profiles: `manual`, `suggested`, `assisted`, `aggressive`
- builtin agents, teams, and workflows
- user/project/builtin resource discovery with priority `builtin < user < project`
- resource format support for routing metadata: `triggers`, `useWhen`, `avoidWhen`, `cost`, `category`
- durable run state: manifest, tasks, events, artifacts, imports/exports
- foreground workflow scheduler
- detached async/background runner
- stale async PID detection
- active run summary and async completion notifications in Pi sessions
- real child Pi worker execution by default, with explicit scaffold/dry-run opt-out
- child Pi JSON output parsing for final text, usage, and event counts
- retryable model fallback attempts per task
- aggregate usage totals in status/summary
- progress, summary, prompt, result, log, diff, patch, export artifacts
- task packets, verification/green-contract evidence, policy decision artifacts, and task graph metadata
- opt-in git worktree isolation per task
- worktree branch mismatch detection
- dirty worktree preservation unless `force` is explicitly set
- cancel/resume lifecycle operations
- forget/prune cleanup operations with explicit confirmation
- export/import portable run bundles
- resource create/update/delete with backups, dry-run, reference checks, and optional reference updates
- resource validation and doctor checks
- project initialization for `.pi` layout and `.gitignore`
- config show/update with user/project scope and nested unset support
- safe API interop for manifest/task/event/heartbeat/claim/mailbox operations
- run-level and task-level mailbox files with validation/repair support
- `/team-manager` interactive helper
- `/team-dashboard` custom TUI overlay with progress preview, action shortcuts, and reload
- `parallel-research` team/workflow for dynamic `Source/pi-*` fanout and parallel shard exploration
- package polish: `schema.json`, TypeScript semantic check, strip-types import smoke, cross-platform CI workflow, dry-run package verification

## Install

From npm:

```bash
pi install npm:pi-crew
```

From the workspace root for local development:

```bash
pi install ./pi-crew
```

Optional config bootstrap after npm install:

```bash
pi-crew
```

Optional config bootstrap from a local clone:

```bash
node ./pi-crew/install.mjs
```

Local verification from this package:

```bash
cd pi-crew
npm run ci
```

## Runtime safety model

By default, `run` launches each crew task as a separate child Pi process. This matches the subagent model from `pi-subagents`: the parent session orchestrates while worker sessions execute independently and stream durable output back to run state.

Use scaffold/dry-run mode only when you explicitly want prompts/artifacts without launching workers:

```json
{
  "runtime": { "mode": "scaffold" }
}
```

or disable workers globally:

```json
{
  "executeWorkers": false
}
```

Worktree mode is opt-in:

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Implement feature X",
  "workspaceMode": "worktree"
}
```

By default, worktree mode requires a clean leader repository. Dirty task worktrees are preserved unless cleanup is called with `force: true`.

## Config

User config path:

```text
~/.pi/agent/extensions/pi-crew/config.json
```

Project config path:

```text
.crew/config.json            # default (new projects)
.pi/teams/config.json        # legacy (when the repo already has .pi/)
```

The project root is auto-detected by walking up from the current directory and stopping at any of: `.git`, `.pi`, `.crew`, `.hg`, `.svn`, `.factory`, `.omc`, or any common manifest file (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `composer.json`, `build.gradle[.kts]`). If the project already has a `.pi/` directory, pi-crew reuses it under `.pi/teams/` to avoid creating a parallel layout; otherwise it uses `.crew/`.

Config merge priority:

```text
user < project
```

Supported config:

```json
{
  "asyncByDefault": false,
  "executeWorkers": true,
  "notifierIntervalMs": 5000,
  "requireCleanWorktreeLeader": true,
  "autonomous": {
    "profile": "suggested",
    "enabled": true,
    "injectPolicy": true,
    "preferAsyncForLongTasks": false,
    "allowWorktreeSuggestion": true,
    "magicKeywords": {
      "review": ["review", "audit", "inspect"]
    }
  },
  "limits": {
    "maxConcurrentWorkers": 3,
    "maxTaskDepth": 2,
    "maxChildrenPerTask": 5,
    "maxRunMinutes": 60,
    "maxRetriesPerTask": 1,
    "heartbeatStaleMs": 60000
  },
  "ui": {
    "widgetPlacement": "aboveEditor",
    "widgetMaxLines": 8,
    "powerbar": true,
    "dashboardPlacement": "right",
    "dashboardWidth": 56,
    "dashboardLiveRefreshMs": 1000,
    "autoOpenDashboard": false,
    "autoOpenDashboardForForegroundRuns": true,
    "showModel": true,
    "showTokens": true,
    "showTools": true
  }
}
```

Safety notes:

- Foreground child-process runs continue in the Pi extension process and return control to chat immediately, so large workflows do not block the interactive session. They are interrupted on session shutdown. Use `async: true` only for intentionally detached runs that may survive the current session.

UI notes:

- `widgetPlacement`/`widgetMaxLines` keep the persistent active-run widget compact.
- `dashboardPlacement: "right"` is the default for `/team-dashboard`; automatic overlay opening is opt-in because Pi custom overlays can be modal/focus-capturing in some terminals.
- `autoOpenDashboard`/`autoOpenDashboardForForegroundRuns` control whether the live sidebar opens automatically.
- `dashboardLiveRefreshMs` controls the live sidebar refresh cadence.
- `showModel`, `showTokens`, and `showTools` show worker model attempts, token usage, and tool activity in dashboard agent rows.

Show config:

```text
/team-config
```

Update user config:

```text
/team-config asyncByDefault=true notifierIntervalMs=5000
```

Update project config:

```text
/team-config autonomous.profile=assisted autonomous.preferAsyncForLongTasks=true --project
```

Unset/delete nested config keys:

```text
/team-config --unset=autonomous.preferAsyncForLongTasks --project
/team-config autonomous.preferAsyncForLongTasks=unset --project
/team-config autonomous.preferAsyncForLongTasks=null --project
```

Config schema is exported as:

```text
./schema.json
```

## Main tool

The extension registers one main tool:

```text
team
```

Use it for complex multi-file work, planning, implementation, tests, reviews, security audits, research, async/background runs, and worktree-isolated execution.

When unsure which team/workflow to choose, call:

```json
{
  "action": "recommend",
  "goal": "Refactor auth flow and add tests"
}
```

## Tool actions

Supported actions:

| Action | Purpose |
|---|---|
| `list` | List discovered teams, agents, workflows, and recent runs |
| `get` | Inspect a named agent/team/workflow |
| `recommend` | Suggest team/workflow/action plus decomposition and fanout hints |
| `run` | Create a run and execute the workflow scheduler |
| `plan` | Validate and preview workflow execution without running tasks |
| `status` | Read durable run status |
| `summary` | Read/write run summary artifact |
| `events` | Read run event log |
| `artifacts` | List run artifacts |
| `worktrees` | List run worktree metadata |
| `cancel` | Cancel queued/running work |
| `resume` | Re-queue failed/cancelled/skipped/running tasks |
| `cleanup` | Clean run worktrees; dirty worktrees are preserved unless forced |
| `forget` | Delete run state/artifacts after `confirm: true` |
| `prune` | Delete old finished runs after `confirm: true` |
| `export` | Export a portable run bundle |
| `import` | Import a run bundle into local imports |
| `imports` | List imported run bundles |
| `create` | Create agent/team/workflow in user/project scope |
| `update` | Update agent/team/workflow with backup |
| `delete` | Delete agent/team/workflow with `confirm: true` and backup |
| `validate` | Validate agents, teams, workflows, references, and model hints |
| `doctor` | Check local readiness and optionally run child Pi smoke check |
| `config` | Show/update config |
| `init` | Create project `.pi` layout and update `.gitignore` |
| `autonomy` | Show/update autonomous delegation settings |
| `api` | Safe interop for run/task/event/heartbeat/claim/mailbox state |
| `help` | Show help text |

## Example tool calls

Run a default team safely:

```json
{
  "action": "run",
  "team": "default",
  "goal": "Investigate failing tests and propose a fix"
}
```

Run async:

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Implement the user settings screen",
  "async": true
}
```

Run with worktrees:

```json
{
  "action": "run",
  "team": "implementation",
  "workflow": "implementation",
  "goal": "Add API endpoint and tests",
  "workspaceMode": "worktree"
}
```

Inspect a run:

```json
{
  "action": "status",
  "runId": "team_..."
}
```

Create a routed agent:

```json
{
  "action": "create",
  "resource": "agent",
  "config": {
    "scope": "project",
    "name": "api-reviewer",
    "description": "Reviews backend API changes",
    "systemPrompt": "You review backend API changes for correctness and compatibility.",
    "triggers": ["api", "endpoint", "contract"],
    "useWhen": ["backend API change", "OpenAPI contract update"],
    "avoidWhen": ["documentation-only edits"],
    "cost": "cheap",
    "category": "backend"
  }
}
```

## Slash commands

Manual slash commands are ops/debug controls. Autonomous tool use via policy/recommendation is the primary agent-driven path.

```text
/teams
/team-run [--team=name] [--workflow=name] [--async] [--worktree] <goal>
/team-cancel <runId>
/team-status <runId>
/team-summary <runId>
/team-resume <runId>
/team-events <runId>
/team-artifacts <runId>
/team-worktrees <runId>
/team-cleanup <runId> [--force]
/team-forget <runId> --confirm [--force]
/team-prune --keep=20 --confirm
/team-export <runId>
/team-import <path-to-run-export.json> [--user]
/team-imports
/team-api <runId> <operation> [key=value]
/team-manager
/team-dashboard
/team-init [--copy-builtins] [--overwrite]
/team-config [key=value] [--unset=key.path] [--project]
/team-autonomy [status|on|off|manual|suggested|assisted|aggressive] [--prefer-async] [--no-worktree-suggest]
/team-validate
/team-help
/team-doctor
```

### `/team-api` examples

```text
/team-api team_... read-manifest
/team-api team_... list-tasks
/team-api team_... read-task taskId=task_...
/team-api team_... read-events
/team-api team_... read-heartbeat taskId=task_...
/team-api team_... write-heartbeat taskId=task_... alive=true
/team-api team_... claim-task taskId=task_... owner=worker-1
/team-api team_... release-task-claim taskId=task_... owner=worker-1 token=...
/team-api team_... transition-task-status taskId=task_... owner=worker-1 token=... status=running
/team-api team_... send-message direction=outbox to=worker body="please check this"
/team-api team_... send-message taskId=task_... direction=inbox to=worker body="task scoped message"
/team-api team_... read-mailbox direction=outbox
/team-api team_... read-mailbox taskId=task_... direction=inbox
/team-api team_... ack-message messageId=msg_...
/team-api team_... read-delivery
/team-api team_... validate-mailbox repair=true
```

## Dashboard

Open:

```text
/team-dashboard
```

Shortcuts:

```text
↑/↓ or j/k  select run
r           reload run list
p           toggle short/long progress preview
Enter or s  show status
a           list artifacts
u           show summary
i           API read-manifest
q or Esc    close
```

## Manager

Open:

```text
/team-manager
```

Current flows:

- list resources/runs
- run a team
- show run status
- cleanup run worktrees
- create routed agent/team resources
- update routed agent/team resources
- doctor

## Resource paths

Builtin package resources:

```text
agents/*.md
teams/*.team.md
workflows/*.workflow.md
```

User resources:

```text
~/.pi/agent/agents/*.md
~/.pi/agent/teams/*.team.md
~/.pi/agent/workflows/*.workflow.md
```

Project resources (new default layout):

```text
.crew/agents/*.md
.crew/teams/*.team.md
.crew/workflows/*.workflow.md
```

Legacy layout (when `.pi/` already exists in the repo):

```text
.pi/teams/agents/*.md
.pi/teams/teams/*.team.md
.pi/teams/workflows/*.workflow.md
```

Discovery priority:

```text
builtin < user < project
```

## Resource metadata

Agents and teams may include optional routing metadata in frontmatter:

```yaml
---
name: api-reviewer
description: Reviews API changes
triggers: api, endpoint, contract
useWhen: backend API changes, OpenAPI changes
avoidWhen: docs-only edits
cost: cheap
category: backend
---
```

These fields guide autonomous policy injection and `recommend` routing.

## Builtin resources

Builtin agents include roles such as:

```text
analyst
critic
executor
explorer
planner
reviewer
security-reviewer
test-engineer
verifier
writer
```

Builtin teams include:

```text
default
fast-fix
implementation
research
review
```

Builtin workflows include:

```text
default
fast-fix
implementation
research
review
```

## State layout

Project-local state is preferred when the cwd is inside a recognised project (any of the markers listed in the Config section above). Otherwise pi-crew falls back to user-global state.

The project state root (`<crewRoot>` below) resolves to:

```text
<repoRoot>/.crew/             # default, used for new projects
<repoRoot>/.pi/teams/         # legacy reuse when .pi/ already exists
```

Typical project-local state (`<crewRoot>` is one of the two paths above):

```text
<crewRoot>/state/runs/{runId}/manifest.json
<crewRoot>/state/runs/{runId}/tasks.json
<crewRoot>/state/runs/{runId}/events.jsonl
<crewRoot>/artifacts/{runId}/...
<crewRoot>/worktrees/{runId}/{taskId}
<crewRoot>/imports/{runId}/run-export.json
```

Mailbox state:

```text
<crewRoot>/state/runs/{runId}/mailbox/inbox.jsonl
<crewRoot>/state/runs/{runId}/mailbox/outbox.jsonl
<crewRoot>/state/runs/{runId}/mailbox/delivery.json
<crewRoot>/state/runs/{runId}/mailbox/tasks/{taskId}/inbox.jsonl
<crewRoot>/state/runs/{runId}/mailbox/tasks/{taskId}/outbox.jsonl
```

User-global fallback (shared with other Pi tools):

```text
~/.pi/agent/extensions/pi-crew/state/runs/...
~/.pi/agent/extensions/pi-crew/artifacts/...
~/.pi/agent/extensions/pi-crew/imports/...
```

## Project initialization

Initialize project-local layout:

```text
/team-init
```

Optionally copy builtin resources:

```text
/team-init --copy-builtins
/team-init --copy-builtins --overwrite
```

Created directories (new projects):

```text
.crew/agents/
.crew/teams/
.crew/workflows/
.crew/imports/
```

If the project already has `.pi/`, the legacy layout is initialised instead:

```text
.pi/teams/agents/
.pi/teams/teams/
.pi/teams/workflows/
.pi/teams/imports/
```

`.gitignore` entries are written for whichever layout is active, e.g.:

```text
# new layout
.crew/state/
.crew/artifacts/
.crew/worktrees/
.crew/imports/

# legacy layout
.pi/teams/state/
.pi/teams/artifacts/
.pi/teams/worktrees/
.pi/teams/imports/
```

## Import/export

Export writes:

```text
{artifactsRoot}/export/run-export.json
{artifactsRoot}/export/run-export.md
```

Import stores bundles under (new layout):

```text
.crew/imports/{runId}/run-export.json
.crew/imports/{runId}/README.md
```

or under the legacy layout when `.pi/` already exists:

```text
.pi/teams/imports/{runId}/run-export.json
.pi/teams/imports/{runId}/README.md
```

or user-global imports with `--user`:

```text
~/.pi/agent/extensions/pi-crew/imports/{runId}/run-export.json
~/.pi/agent/extensions/pi-crew/imports/{runId}/README.md
```

## Doctor and validation

Validate resources:

```text
/team-validate
```

Doctor:

```text
/team-doctor
```

Doctor checks include:

- cwd
- platform/architecture/Node.js version
- `pi --version`
- `git --version`
- writable state paths
- config parse
- discovery counts
- resource validation
- current model/provider when available
- model/fallback hints

Optional child Pi smoke check is explicit only:

```json
{
  "action": "doctor",
  "config": {
    "smokeChildPi": true
  }
}
```

## Environment variables

```text
PI_CREW_EXECUTE_WORKERS=0       disable child workers and use scaffold/dry-run mode
PI_TEAMS_EXECUTE_WORKERS=0      legacy disable flag
PI_TEAMS_MOCK_CHILD_PI=success   test/mock child worker success
PI_TEAMS_MOCK_CHILD_PI=json-success
PI_TEAMS_MOCK_CHILD_PI=retryable-failure
PI_TEAMS_INHERIT_PROJECT_CONTEXT control child prompt context inheritance
PI_TEAMS_INHERIT_SKILLS          control skill inheritance
PI_TEAMS_HOME                    override home path for tests/config/state
PI_TEAMS_PI_BIN                  optional explicit Pi CLI script/shim path for doctor/child workers
```

## Development

Install dependencies:

```bash
cd pi-crew
npm install
```

Run tests:

```bash
npm test
```

Typecheck and smoke import:

```bash
npm run typecheck
```

Full local CI-equivalent check:

```bash
npm run ci
```

GitHub CI runs the same typecheck/test/pack checks on:

```text
ubuntu-latest
windows-latest
macos-latest
```

Package dry-run only:

```bash
npm pack --dry-run
```

## Documentation

Package docs:

```text
pi-crew/docs/architecture.md
pi-crew/docs/usage.md
pi-crew/docs/resource-formats.md
pi-crew/docs/live-mailbox-runtime.md
pi-crew/docs/publishing.md
```

Historical workspace-level design/progress docs may exist in the original development workspace under `docs/pi-crew-*`, but package-maintained docs live under `pi-crew/docs/`.

## Local Pi smoke

A local Pi smoke test requires an installed Pi CLI and a real Pi environment:

```bash
cd pi-crew
npm run smoke:pi
```

Then in Pi:

```text
/team-doctor
/team-validate
/team-autonomy status
```

## Acknowledgements

`pi-crew` builds on ideas and selected MIT-licensed implementation patterns from `pi-subagents` and `oh-my-claudecode`.

It also draws conceptual inspiration from `oh-my-openagent`; no `oh-my-openagent` source code is copied unless separately documented and license-compatible.
