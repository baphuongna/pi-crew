# CONTEXT — pi-crew orientation map

> Purpose: fast orientation for anyone (human or agent) landing in this repo. Glossary first, then flagged quirks that bite. Companion to `AGENTS.md` (workflow rules) — this file is the "why is it like that" layer.

## Glossary

| Term | Meaning |
|---|---|
| **Run** | One execution of a team workflow; identified by `runId` (`team_<timestamp>_<hash>`). State under `.crew/state/runs/<runId>/` (project scope) or `~/.pi/agent/extensions/pi-crew/` (user scope, markerless cwd). |
| **Manifest** | `TeamRunManifest` — the run's single source of truth: goal, team, workflow, task graph, paths, status. Written atomically throughout the run. |
| **Team / Workflow** | Declarative resources (`teams/`, `workflows/` dirs): a team maps roles→agents; a workflow sequences steps (`id:role`). Both discovered from package + project + user scopes (project wins). |
| **Agent** | A role persona in `agents/*.md`: frontmatter contract (tools, model routing, context inheritance, routing metadata) + body (the child's system prompt when `systemPromptMode: replace`). |
| **Skill** | Guidance payload in `skills/*/SKILL.md` selected per-task (role defaults + agent/team/step adds + override with `*`/`!name` syntax). Injected into worker prompts. |
| **Broker** | The session-local crew broker: a Unix-socket server coordinating the main session and workers (steering, wait/ask handshakes, mailboxes). Handshake is versioned. |
| **Live agent** | A subagent running in-session (pane-visible) vs the default child-process worker (detached, budgeted). |
| **Surface mode** | Where workers render: tmux/herdr panes (MuxSurface) or headless. |
| **Detach** | Opening an agent view mid-run releases the foreground waiter; the run continues and its final report is delivered later via the detached-run registry (bounded retries). |
| **Deadletter** | Terminal bucket for tasks that exhausted attempts; recovery is explicit, never automatic re-run. |
| **waitState / ask** | A worker can park on a question (`ask`); the answer returns via a mailbox `kind:"response"` entry keyed by `questionId`. |
| **Task packet** | The structured per-task contract (requirements, acceptance, spec snapshots) rendered into worker prompts. |
| **stablePrefix / dynamicSuffix** | Worker prompt split: run-level shared prefix (byte-identical across same-role siblings → provider KV-cache hits) + per-task suffix (goal, skills, packet, identity). |
| **Bundle** | `dist/index.mjs` — single-file esbuild bundle loaded by default; `PI_CREW_USE_BUNDLE=0` forces strip-types source loading. Bundle staleness is CI-gated (`check-bundle-staleness.mjs`). |

## Flagged — known quirks that bite

1. **Broker SIGTERMs workers during long silent bash** — a worker running a >5–10 min command (e.g., full `npm test`) emits no LLM activity; the broker's responsiveness check can kill it mid-run. Workaround: split long suites or emit progress. (Postmortem: `postmortem-batch-1-sigterm.md` in the workspace.)
2. **`wait-request-broker.test.ts` needs >180s under load** — the per-file test-runner timeout (180s) is below its full-suite runtime; passes in isolation. Flaky in parallel runs, not a product bug.
3. **Live-session path is FROZEN** (ADR 2026-08-15) — `runtime.mode=live-session` diverges from child-process semantics by design (no worker-cap, single-model fallback). No new features there without revisiting the ADR.
4. **Agent frontmatter parser is line-based** (`utils/frontmatter.ts`) — folded YAML scalars (`key: >`) are NOT understood for agents/teams/workflows (skills use the real `yaml` package and are fine). Keep agent/teams/workflows frontmatter values single-line (quote values containing ": ").
5. **`dist/` is committed but gitignored-by-default** — after source changes affecting the bundle, rebuild (`npm run build:bundle`) and `git add -f dist/`; the staleness gate (incl. path-leak scan) runs in CI.
6. **Package skills resolve via `packageRoot()`** — never `import.meta.url` walk-ups (that broke in bundle mode; fixed 2026-09-11). Any new skill-dir resolution must use `packageRoot()`.

## Pointers

- Operating model + risk tiers: `AGENTS.md`, `CLAUDE.md`
- Decisions: `docs/decisions/` (notably `2026-08-15-runtime-convergence.md`)
- Security record: `SECURITY-ISSUES.md` (SEC-003: package-first skill search order)
