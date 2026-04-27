# Changelog

## 0.1.20

- Reworked the implementation workflow into an adaptive planner-led orchestration flow that decides the number, roles, and phases of subagents from the task instead of using a fixed fanout template.
- Added dynamic adaptive task injection, persisted adaptive task metadata, and resume reconstruction for planner-selected subagent steps.
- Block implementation runs when the planner does not produce a valid adaptive plan, including missing/unreadable planner artifacts and malformed/oversized plans.
- Added tests for adaptive plan parsing, dynamic batch fanout, invalid-plan blocking, writer-role support, and adaptive resume recovery.
- Hardened subagent/runtime fixes from post-0.1.19 review: env-isolated depth tests, foreground failure status updates, generic tool conflict aliases, and max_turns propagation.

## 0.1.19

- Added Claude-style `Agent`, `get_subagent_result`, and `steer_subagent` tools backed by pi-crew's durable worker runtime, plus conflict-safe `crew_agent`, `crew_agent_result`, and `crew_agent_steer` aliases.
- Added a durable subagent manager with background queueing, completion notifications, result joins, session-bound cleanup, and direct single-agent runs via `team run agent=...`.
- Disabled risky auto-opening of the right sidebar by default, added foreground completion notifications, and reduced duplicate widget/sidebar UI.
- Added progress coalescing and workflow concurrency helpers to keep foreground sessions responsive during busy worker output.
- Fixed live-session runs being classified as scaffold when workers are enabled and hardened session switch/shutdown cleanup for foreground child processes.

## 0.1.18

- Added a built-in `parallel-research` team/workflow for map-reduce style source audits with dynamic `Source/pi-*` fanout and parallel explorer shards.
- Made the live right sidebar the default foreground UI: active foreground runs auto-open a top-right live sidebar when the terminal is wide enough.
- Added live sidebar sections for active agents, waiting tasks, completed agents, task graph, model, tool, and token/usage details.
- Stopped materializing queued dependency tasks as child-process agents; status now separates active agents, waiting tasks, and completed agents.
- Added workflow-aware default concurrency so research/parallel-research can use ready parallel work instead of always running one worker.
- Dropped user/system prompt messages from child event persistence to avoid prompt/context leakage in agent event logs.
- Tightened child event compaction with separate assistant/tool input/tool result caps and improved powerbar active/waiting/model/token summaries.

## 0.1.17

- Fixed terminal/completed workers being incorrectly escalated as stale heartbeat blockers after all tasks completed.
- Cleaned child-process result extraction so result artifacts prefer final assistant output and no longer include worker prompt/context.
- Made `/team-dashboard` visibly render as a top-right sidebar by default with explicit right-sidebar title text.
- Added per-subagent model and usage fields to agent records, status output, and dashboard fallbacks so model/token totals stay visible while and after workers run.

## 0.1.16

- Added right-side `/team-dashboard` placement with model, token, and tool detail rows for subagents.
- Added UI config for dashboard placement/width and model/token/tool visibility.
- Foreground child-process runs now continue without blocking the interactive chat and remain tied to session shutdown.
- Child-process observability now drops noisy `message_update`/encrypted thinking deltas and stores compact events to prevent massive JSONL/output logs from freezing sessions.
- Cancel now syncs agent records and writes a foreground interrupt request so queued/running agents stop appearing stale.

## 0.1.15

- Child-process model selection now uses Pi-configured/available models and auto-discovers provider/model entries from Pi settings/models config.
- Added configured-model fallback chains for worker runs instead of forcing builtin provider hints.
- Fixed skipped task agent records so they no longer appear queued.

## 0.1.0

- Initial scaffold for `pi-crew`.
- Added Pi package manifest, extension entry, minimal team tool, slash commands, builtin resources, and documentation placeholders.
