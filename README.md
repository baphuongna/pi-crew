# pi-crew

> ## ⚠️ IMPORTANT — Read before using
>
> **pi-crew is a sub-agent orchestration layer that was developed almost entirely
> by AI, for the author's own workflow.** It is **not** a hardened, audited
> product. Here's the honest framing:
>
> - **AI-generated code, limited human review.** The vast majority of pi-crew
>   was written and iterated on by autonomous AI agents. While every change
>   goes through static review + runtime tests, I (the author) have not
>   line-by-line verified everything. There will be bugs, edge cases, and
>   behaviors I haven't anticipated.
> - **It can spawn processes, run shell commands, and write files on your
>   behalf.** Dynamic workflows (`.dwf.ts`) and goal loops run with the same
>   privileges as your Pi session — treat any `.dwf.ts` like `node script.js`
>   you downloaded from the internet.
> - **Built for *my* needs, not yours.** This scratches a personal itch. It
>   likely won't fit every workflow, team setup, or risk tolerance — and
>   that's fine.
>
> **If that sounds too risky, don't use it** — no hard feelings.
>
> **If you still want to use it**, the safest path is to **fork it, read the
>   parts you'll touch, and adapt it to your own setup.** If you find a bug,
>   a footgun, or a sharp edge, please open an issue or send a note — your
>   feedback is genuinely appreciated. Thanks. ✌️
>
> See also: [SECURITY-ISSUES.md](SECURITY-ISSUES.md),
> [docs/dynamic-workflows.md](docs/dynamic-workflows.md#security-model-important)
> (trust model), and the [Known limitations](#known-limitations) section below.

**Coordinate AI agent teams inside [Pi](https://github.com/nicekate/pi-coding-agent).**

pi-crew is a Pi extension that orchestrates autonomous multi-agent workflows — research, implementation, review, testing, and more — with durable state, parallel execution, worktree isolation, and safe defaults.

```text
npm: pi-crew
repo: https://github.com/baphuongna/pi-crew
```

**v0.9.4 / v0.9.5 / v0.9.8 / v0.9.9**: See [CHANGELOG.md](CHANGELOG.md).

### Highlights (v0.6.4 → v0.9.9)

A long arc of **trust, cliff-resilience, and robustness** work. Principle: *build
trust and cliff-resilience, stay lean, delete before adding.*

#### v0.9.5 — fix "team run hangs forever at 25%" (2026-06-23)
Two coupled runtime bugs caused recurring "run stuck at 25% (1/4)" failures
across 4+ consecutive review/fast-fix runs. The combined symptom: scheduler
appears to stop responding right after the first task (explorer) finishes, no
progress to task 2, and `team action='status'` returns "Run not found" with
**no diagnostic trail** to investigate. Manual `kill` of the parent `pi`
process was the only workaround.

- **🩹 Bug X (proximate cause)** — `purgeStaleActiveRunIndex`
  (`src/runtime/crash-recovery.ts`) destroyed a run's `stateRoot` based on a
  **frozen** `entry.updatedAt` (set once at registration, never refreshed).
  Any long-running legitimate async run (≥5 min) whose worker had exited
  lost its entire durable state. `saveRunTasks()` then silently no-op'd on
  the missing dir, and the workflow could never advance. Fix: corroborate
  liveness via the on-disk `manifest.updatedAt` AND the team-level
  `heartbeat.json`; keep `stateRoot` on cancel so runs stay queryable and
  resumable.
- **🩹 Bug Y (root cause — why the scheduler died in the first place)** —
  `src/runtime/background-runner.ts` redirected only `console.log` /
  `console.error` to the log file. The first post-detach `console.debug`
  call from `team-runner.ts:242` (inside `mergeTaskUpdatesPreservingTerminal`
  → "Skipping stale merge") hit the disconnected stdout pipe → unhandled
  `EPIPE` → process exit. Prior investigators concluded (incorrectly) that
  the cause was a native crash, because diagnostic `[DIAG]` handlers never
  fired on the EPIPE. Fix: extend the console redirect to `console.debug` /
  `console.warn`, and wrap `fs.writeSync` in try-catch so any log-write
  failure can never crash the scheduler.
- **🧪 Regression coverage** — 7 new tests: 3 in
  `test/unit/crash-recovery-purge-liveness.test.ts` (fresh-manifest-kept,
  orphan-cancelled-preserved, fresh-heartbeat-kept) + 4 in
  `test/unit/background-runner-console-redirect.test.ts` (drift-detector
  pattern that exercises undefined / valid / EBADF / post-toggle logFd).
- **📖 See [CHANGELOG.md](CHANGELOG.md) for full details**, including
  why prior attempts to diagnose the hang kept destroying the only
  evidence (Bug X nuked the stateRoot before anyone could read the EPIPE
  crash in Bug Y).

> **Recovering a stuck run from v0.9.4 or earlier:** the `stateRoot` for
> those runs is already gone. Re-dispatch the workflow — new runs are
> fully protected.

#### v0.9.4 — macOS CI fixture (2026-06-23)
- **🧪 BSD-vs-GNU grep fix** — benchmark test fixtures used
  `grep --help` (exits 0 on GNU/Linux, exits 2 on BSD/macOS). Switched
  the exit-0 fixture to `echo ok`; the not-in-allowlist fixture is now
  `ls`. CI matrix is now green on all 3 OSes.
- **📌 Process note** — this release re-commits to: **tag/publish ONLY
  after the full OS matrix CI is green.** v0.9.3 was published mid-CI-run
  (the macOS job hadn't finished); the package itself was correct (the
  broken file is test-only and not shipped), but the repo CI went red.
  v0.9.4 restores green CI. v0.9.5 follows the same discipline.

#### v0.9.0 — goal loops + dynamic workflows (2026-06-18)
Two new features, both modeled on Claude Code, built on a shared `runKind`
background-dispatch discriminator.

- **🎯 Autonomous goal loops** — `team action='goal'` runs a self-directed
  multi-turn loop: a **worker** does a turn, a separate **LLM judge**
  (capability-locked, no tools) evaluates the transcript + verification against
  the objective, and on "not-achieved" the reason is fed into the next turn's
  prompt. Stops on `achieved` / `maxTurns` / budget / `BLOCKED:` / user `stop`.
  See [docs/goals.md](docs/goals.md).
- **📜 Dynamic workflows (`.dwf.ts`)** — author orchestration as a TypeScript
  script (JS loops/branch/cross-review) instead of a static step list. Runs in
  the background, spawns subagents via `ctx.agent()`/`ctx.fanOut()`, holds
  intermediate results in JS variables, and only `ctx.setResult()` reaches the
  main context. `workflow-create`/`-delete` are ACE-gated (`confirm:true`,
  user-confirmed). See [docs/dynamic-workflows.md](docs/dynamic-workflows.md).
- **🛡️ Goal-wrap** (RFC v0.5 vision) — apply the goal completion-guarantee to
  existing builtin workflows (`implementation`, `fast-fix`, `default`) via
  per-workflow `.crew/config.json` toggle. Single-step workflows goal-wrap
  end-to-end; multi-step workflows auto-downgrade to a normal team-run because
  they crash non-deterministically under the V8/libuv event-loop (see [Known
  limitations](#known-limitations)).
- **🔐 Phase 1 integrity hardening** (P1a–P1g) — verification bookend snapshots,
  anti-oscillation (`stuck` non-terminal + resumable), budget enforcement
  (required or explicit opt-out), nonce-token feedback sanitization, secret
  redaction at artifact-write (O(n) fix), global worker cap + workspace lock
  (O_EXCL, startTime-safe). B2 confused-deputy (auto-detecting verification
  commands) refused — user must declare verification explicitly.
- **🧪 Phase 1.5 fast-follow** — opt-in mitigation toggles for residual risks:
  `PI_CREW_VERIFICATION_SANITIZE_ENV=1` (strip provider secrets from the
  verification subprocess), `PI_CREW_VERIFICATION_WORKTREE=1` (run verification
  in a pristine git worktree at the T_snap commit SHA),
  `PI_CREW_BG_REPORT_ON_FATAL=1` (V8 diagnostic report on fatal).
- **🐛 TDZ fix** (Phase 1.5 #4) — live `team action='run' workflow='<dynamic>'`
  was failing with a misleading "must export a default async function" error.
  Root cause was a Temporal Dead Zone race in `team-tool/run.ts` when loaded via
  the full Pi extension pipeline (`index.ts → … → run.ts`). Fixed by
  `let`→`var` on the latch + lazy dynamic imports at call sites.

#### v0.8.x — hardening & reliability (2026-06-17)
- **🛠️ Split-scope install fix (v0.8.11)** — `team` runs no longer crash with
  `Cannot find module '@earendil-works/pi-coding-agent'` when pi-crew and pi
  live in separate node_modules trees (the default for `pi install`). New
  `src/runtime/peer-dep.ts` resolves the ESM-only peer dep across 6 strategies.
- **🔄 Model fallback on transient 5xx (v0.8.11)** — a hard-down provider
  (`500 api_error "unknown error"`) now triggers the configured fallback
  model instead of aborting the run. `isRetryableModelFailure` extended.
- **🧊 Cold-start race eliminated (v0.8.6 → v0.8.10)** — under tsx, concurrent
  subagent spawns raced module instantiation (`existsSync` / `CREW_README` /
  `effectiveRunConfig` / `validateWorkflowForTeam`). Fixed graph-wide: warm at
  registration + gate at spawn boundaries + per-site latches. 6/6 repro clean.
- **🔒 Cross-project leak fixed (v0.8.8)** — ambient status / compaction no
  longer bleed foreign-project runs into the current session. Cwd-scope
  barrier (`isInProjectScope`), version-independent.
- **🩺 Doctor runtime-warmup status (v0.8.7)** — `team doctor` shows whether
  the module-graph warmup fired.
- **🔍 Cold-verifier agent (v0.8.4)** — adversarial cross-check that re-derives
  claims WITHOUT trusting prior analysis, catching confirmation bias.
- **⚡ Per-write validator (v0.8.5)** — zero-cost `JSON.parse` on every
  `write`/`edit`, appends a `🔴` blocker on malformed files.
- **🎨 Terminal status (v0.8.3)** — tab title + Ghostty native progress bar.
- **🧠 Skill confidence revived (v0.8.2)** — `adjustConfidence()` was dead
  code; the effectiveness system now actually learns.
- **🔧 Tool-restriction unification (v0.8.0)** — single `resolveToolPolicy`
  across both spawn paths.
- **🎯 F6/F1 interop granularity (v0.7.9)** — 7 skill roots, `.pi/agents/`
  tier, tool wildcards, `excludeExtensions` denylist.

#### v0.7.0 — Phase 0 + Phase 1 roadmap
- **🛡️ Compaction resilience (O10)** — in-flight runs survive auto-compact.
- **💰 Cost visibility (O1)** — per-role token + cost attribution.
- **✋ Plan-level HITL (O5)** — `requirePlanApproval` gates any workflow.
- **🧠 Cross-run memory (O4)** — `.crew/knowledge.md` injected every run.
- **🎯 Single-agent cliff hedge** — `team plan singleAgent=true`.

---

## Features

- **One Pi tool** — `team` handles routing, planning, execution, review, and cleanup
- **Autonomous delegation** — policy injection decides when/how to delegate based on task complexity
- **needs_attention status** — tasks that complete without calling `submit_result` get `needs_attention` (terminal) instead of `completed`; allows retry/re-run without blocking downstream phases
- **Real child Pi workers** — each task spawns a separate Pi process by default; scaffold/dry-run opt-out
- **Adaptive planning** — implementation workflow lets a planner agent decide subagent fanout
- **Parallel execution** — tasks in the same phase run concurrently with configurable concurrency
- **Durable state** — manifest, tasks, events, artifacts all persisted to disk
- **Async/background runs** — detached runs survive session switches with completion notifications
- **Worktree isolation** — opt-in git worktrees per task for safe parallel edits
- **Rich UI** — live widget, dashboard, progress tracking, model/token display
- **Observability** — metrics registry, Prometheus/OTLP exporters, heartbeat watching, deadletter queue
- **Resource management** — create/update/delete agents, teams, workflows with validation
- **Import/export** — portable run bundles for sharing and archiving
- **Adaptive plan fanout** — single `assess` step lets a planner pick the smallest effective crew
- **Adaptive workflows** — `implementation`, `review`, `parallel-research`, `research` workflows ship in `workflows/`
- **Hardened secrets** — linear-time detection covers PEM keys, Authorization headers, Bearer tokens, and `key=value` patterns
- **Scheduled runs** — `schedule`/`scheduled` actions with cron, interval, and one-shot support; spawned runs tracked and auto-cancelled on job removal
- **Plugin system** — framework-aware context injection (Next.js, Vite, Vitest) via plugin registry
- **Health scoring** — penalty-based run health with time-series snapshots
- **Autonomous goal loops** (P0/P1) — `team action='goal'` runs an autonomous multi-turn loop: a worker does a turn, a separate LLM judge evaluates the transcript+evidence against the goal, and on "not-achieved" the reason is fed into the next turn's prompt. Stops on achieved / maxTurns / budget / blocked. Claude-Code-style `/goal`. See `docs/goals.md`.
- **Dynamic workflows** (P2/P3) — author orchestration as a `.dwf.ts` script (JS loops/branch/cross-review) instead of a static step list. The script runs in the background, calls subagents via `ctx.agent()`/`ctx.fanOut()`, holds intermediate results in JS variables, and only `ctx.setResult()` reaches the main context. `ctx.phase()` marks logical phases; **round-14** adds `ctx.log()` (durable `dwf.log` events), `ctx.budget` (per-workflow token budget that auto-rejects `ctx.agent()` when exhausted), and `ctx.args<T>()` (typed workflow arguments). TypeScript IntelliSense is available via `import type { WorkflowCtx } from "pi-crew/workflow"`. `workflow-create`/`-delete`/`-save` require `confirm:true` at the tool-call layer (the only gate — a malicious agent that passes `confirm:true` programmatically bypasses it; this is postinstall-equivalent trust, not a human-in-the-loop dialog). See `docs/dynamic-workflows.md`.
- **Strict SKILL.md validation** (L3, v0.9.8) — skills with malformed frontmatter (missing/malformed `name`/`description`, type mismatches) now **fail-fast at discovery** with visible diagnostics, instead of silently producing broken behavior at runtime. HYBRID policy: HARD on required fields, SOFT (warn) on unknown props for forward-compat. Surfaced via `buildSkillValidationDiagnostics()`.
- **Durable event replay** (L1, v0.9.8) — `RunEventBus.onWithReplay()` catches up a re-subscribing dashboard/overlay with events it missed during transient absence (toggle, reconnect), replaying from the durable JSONL log with seq-based dedup. No information loss even if the live subscriber was briefly gone.
- **Lossless-by-default output handling** (L4, v0.9.8) — worker output thresholds sized from measured data (100% of real outputs fit without compaction); when compaction is unavoidable it keeps head+tail (preserves closing code fences/headings) instead of head-only truncation. No more `[pi-crew compacted N chars]` markers eating the end of a worker's result.

---

## Install

```bash
pi install npm:pi-crew
```

Local development:

```bash
pi install ./pi-crew
```

Post-install config bootstrap:

```bash
pi-crew          # after npm install
node ./pi-crew/install.mjs   # from local clone
```

> **Split-scope install note (v0.8.11+):** pi installs extensions under
> `~/.pi/agent/npm/node_modules/<ext>/`, separate from pi's own
> node_modules tree (nvm / `%APPDATA%\npm` / Volta / fnm). Since v0.8.11
> pi-crew resolves the `@earendil-works/pi-coding-agent` peer dep robustly
> across these layouts — no symlink/NODE_PATH workaround needed. If you ever
> do hit `Cannot find module '@earendil-works/pi-coding-agent'`, set
> `PI_CREW_PEER_DEP_DIR=<path to the pi-coding-agent package dir>` as a
> one-line workaround (or install pi-crew in pi's own scope:
> `npm install -g @earendil-works/pi-crew`).

### Uninstall

`pi uninstall npm:pi-crew` removes the package, but pi doesn't fire an
extension uninstall hook, so several things pi-crew created are left behind.
Reverse them explicitly with `team action=cleanup`. There are **two scopes**:

> **v0.8.14+**: `team action=init` **no longer injects a guidance block into
> AGENTS.md** (it was redundant — the `team` tool self-describes via its tool
> registration, so the agent learns pi-crew's commands from there, not AGENTS.md).
> The cleanup steps below still work for removing blocks injected by **older
> versions** (<0.8.14).

#### Project scope (reverse `team action=init`)

```bash
# 1. (Optional) Preview what would be removed, without writing:
team action=cleanup dryRun=true

# 2. Remove the AGENTS.md guidance block only (.crew/ preserved):
team action=cleanup

# 3. Remove BOTH the guidance block AND the .crew/ state directory (force):
team action=cleanup force=true
```

The guidance block is wrapped in `<!-- PI-CREW:GUIDANCE:START -->` /
`<!-- PI-CREW:GUIDANCE:END -->` markers, so cleanup removes **only** that
block — your own AGENTS.md content is never touched. The `.crew/` directory
is removed **only** with `force=true` (it's irreversible).

#### User scope (remove user-level state `pi uninstall` leaves behind)

```bash
# 4. Preview + remove pi-crew user-scope junk:
team action=cleanup scope=user dryRun=true   # preview
team action=cleanup scope=user               # remove ~/.pi/agent/extensions/pi-crew/
                                              #   + pi-crew smoke-test *.bak files

# 5. (Optional) Also remove the global config (holds your settings):
team action=cleanup scope=user force=true    # also removes ~/.pi/agent/pi-crew.json
```

This removes the pi-crew state dir (`~/.pi/agent/extensions/pi-crew/`, which
holds run artifacts + state), the global config (with `force=true`), and the
`*.md.bak-<timestamp>` smoke-test backup files pi-crew's own tests may leave in
`~/.pi/agent/agents/`. **Your authored agent files (`*.md`) are never touched**
— pi-crew can't tell which were user-created vs test-copied, so only the
clearly-pi-crew `.bak-*` backups are removed.

#### Final step

```bash
# 6. Remove the package itself:
pi uninstall npm:pi-crew
```


---

## Quick Start

### 1. Initialize project

```text
/team-init
```

### 2. Run a team

```text
/team-run Investigate failing tests and propose a fix
```

Or via tool call:

```json
{
  "action": "run",
  "team": "default",
  "goal": "Investigate failing tests and propose a fix"
}
```

### 3. Check status

```text
/team-status <runId>
/team-dashboard
```

### 4. Get a recommendation

When unsure which team/workflow fits:

```json
{
  "action": "recommend",
  "goal": "Refactor auth flow and add tests"
}
```

---

## Builtin Teams

| Team | Workflow | Purpose |
|------|----------|----------|
| `default` | explore → plan → execute → verify | Balanced, general-purpose |
| `fast-fix` | explore → execute → verify | Quick bug fixes |
| `implementation` | Adaptive planner decides fanout | Multi-file implementation |
| `review` | explore → code-review → security-review → verify | Code review + security audit |
| `research` | explore → analyze → write | Research and documentation |
| `parallel-research` | Parallel shards → synthesize → write | Multi-source research |

## Builtin Agents

```
analyst  ·  critic  ·  executor  ·  explorer  ·  planner  ·  reviewer
security-reviewer  ·  test-engineer  ·  verifier  ·  writer
```

---

## Runtime Modes

pi-crew supports multiple runtime modes for task execution:

| Mode | Description |
|------|-------------|
| `auto` (default) | Uses `child-process` unless overridden by config |
| `child-process` | Spawns real `pi` child processes — each task runs in isolation |
| `scaffold` | Dry-run mode — renders prompts and persists artifacts without executing |
| `live-session` (experimental) | In-process session execution within the parent Pi |

```json
// Use scaffold mode (no real workers, just prompts)
{ "action": "run", "team": "default", "goal": "...", "runtime": { "mode": "scaffold" } }

// Disable workers globally
{ "executeWorkers": false }
```

## Async Runs

Async runs are **detached** from the session — they survive session switches and reloads. Pi-crew notifies when complete.

```json
{ "action": "run", "team": "default", "goal": "...", "async": true }
```

```text
/team-run --async Investigate failing tests
```

Background runs use `node --import jiti-register.mjs` for TypeScript support. See [docs/runtime-flow.md](docs/runtime-flow.md) for details.

## Worktree Isolation

Worktree mode creates an **isolated git worktree per task** — safe for parallel edits to the same branch.

```json
{
  "action": "run",
  "team": "implementation",
  "goal": "Refactor auth",
  "workspaceMode": "worktree"
}
```

```text
/team-run --worktree Refactor auth
```

Requirements:
- Git repository (cwd must be inside a git repo)
- Clean working tree (no uncommitted changes in the leader worktree)
  - Can be disabled via config: `requireCleanWorktreeLeader: false`
- Worktrees auto-cleanup on run completion/cancel

If preconditions are not met, a friendly error message is returned instead of crashing.

---

## Configuration

### Config Paths

| Scope | Path |
|-------|------|
| User (primary) | `~/.pi/agent/pi-crew.json` |
| User (legacy, still read for migration) | `~/.pi/agent/extensions/pi-crew/config.json` |
| Project (crewRoot) | `.crew/config.json` (or `.pi/teams/config.json` legacy) |
| Project (alt) | `.pi/pi-crew.json` |

### Quick Config

```text
/team-config                           # view all settings
/team-config runtime.mode=scaffold    # set a key (--project for project scope)
/team-config --unset=runtime.mode     # reset a key to default
/team-config --project runtime.mode   # project-scoped view
/team-settings path                   # show config file path
```

### Key Settings

| Section | Keys | Default |
|---------|------|---------|
| **Runtime** | `mode`: `auto` \| `child-process` \| `scaffold` \| `live-session` | `auto` |
| | `maxTurns`, `graceTurns`, `groupJoin`, `requirePlanApproval` | various |
| **Concurrency** | `limits.maxConcurrentWorkers` | workflow-dependent |
| | `limits.maxTaskDepth`, `limits.maxChildrenPerTask` | 2, 5 |
| **Async** | `asyncByDefault` | `false` |
| | `runtime.groupJoin`: `off` \| `group` \| `smart` | `smart` |
| **Autonomy** | `profile`: `manual` \| `suggested` \| `assisted` \| `aggressive` | `suggested` |
| | `autonomous.injectPolicy`, `preferAsyncForLongTasks` | true, false |
| **UI** | `widgetPlacement`, `dashboardPlacement` | compact widget |
| | `showModel`, `showTokens` | display controls |
| **Reliability** | `autoRetry`, `autoRecover`, `deadletterThreshold` | opt-in |
| **Observability** | `observability.enabled`, `observability.pollIntervalMs`, `otlp.enabled`/`otlp.endpoint` | opt-in |
| **Worktree** | `worktree.setupHook`, `worktree.linkNodeModules`, `worktree.seedPaths` (mode is set via `workspaceMode: "worktree"` at run time) | disabled by default |

> ⚠️ **Trust boundary**: project config cannot override sensitive execution controls (workers, runtime mode, autonomy, agent overrides). Set those in **user config** only.

📖 Full config reference: [docs/commands-reference.md#team-settings--config-management](docs/commands-reference.md) and [schema.json](schema.json)

---

## Reliability & Trust

### Compaction resilience

pi-crew survives Pi's context compaction. When the context is compacted (auto or manual), in-flight crew runs are detected and a **resume directive** is injected into the post-compaction context, so tasks continue instead of stalling. You'll see a notification like:

```
Context compacted. 1 pi-crew run(s) still in-flight — use team status to continue.
```

**Durable event replay** (v0.9.8, L1): even if a dashboard/overlay is briefly gone during compaction or a reconnect, `RunEventBus.onWithReplay()` catches it up with the events it missed, replaying from the durable JSONL log with seq-based dedup — no information loss. (The dashboard wires this up per-run; the primitive is available for any subscriber.)

**Lossless-by-default worker output** (v0.9.8, L4): output-handling thresholds are sized from measured real data (100% of real worker outputs fit without any compaction). When compaction *is* unavoidable, it keeps head+tail instead of head-only truncation, so closing code fences and headings survive — no more `[pi-crew compacted N chars]` markers eating the end of a result.

### Plan-level human-in-the-loop (HITL)

Set `runtime.requirePlanApproval = true` to gate **any workflow** at the plan→execute boundary. After the read-only (planning) phases complete, the run pauses for explicit approval before mutating tasks run:

```
team api op=approve-plan runId=<runId>   # approve → execute
  team api op=cancel-plan runId=<runId>    # cancel
```

This is plan-level (not per-step) — per-step gates would kill the parallelism that's pi-crew's point.

### Cross-run memory (`.crew/knowledge.md`)

Create `.crew/knowledge.md` in your project root with durable learnings (code style, test commands, common pitfalls, past refactors). It's auto-read (up to 16KB) and injected into **every** agent's system prompt — the main session and each crew worker. pi-crew gets better the longer you use it.

```markdown
# Project Knowledge
- Tests: run with `npm test` (not jest directly)
- Style: tabs, not spaces
- Auth refactor (2026-06): split auth.ts into session.ts + api.ts
```

### Cost visibility

Every `team summary <runId>` includes a per-role cost report:

```
═══ Cost Report ═══
Tokens: 134k (in 112k, out 5.7k, cache-write 16k)
Cost: $0.7700 across 18 turn(s)
By role:
  executor (2 tasks): $0.6100 — 79%, 98k tok, 13 turns
  reviewer (1 task): $0.1100 — 14%, 23k tok, 3 turns
```

### Single-agent mode (cliff hedge)

Any workflow can run single-agent instead of multi-agent — composing all phases into one sequential prompt:

```
team plan team=default workflow=default goal="..." singleAgent=true
```

This is pi-crew's cliff-resilient mode: the workflow definitions, phase structure, and artifact contracts survive even if a single large-context model outperforms multi-agent teams.

---

## Tool Actions

```json
// Execute workflow (foreground or async)
{ "action": "run", "team": "default", "goal": "..." }
{ "action": "run", "team": "default", "goal": "...", "async": true }

// Monitor & control
{ "action": "status", "runId": "team_..." }
{ "action": "summary", "runId": "team_..." }
{ "action": "events", "runId": "team_..." }
{ "action": "artifacts", "runId": "team_..." }
{ "action": "cancel", "runId": "team_..." }
{ "action": "resume", "runId": "team_..." }
{ "action": "retry", "runId": "team_..." }
{ "action": "steer", "runId": "team_...", "taskId": "01_explore", "message": "Focus on src/ only" }
{ "action": "respond", "runId": "team_...", "message": "Answer" }
{ "action": "wait", "runId": "team_..." }

// Discovery
{ "action": "list" }
{ "action": "get", "resource": "team", "team": "default" }
{ "action": "get", "resource": "agent", "agent": "explorer" }
{ "action": "get", "resource": "workflow", "workflow": "review" }
{ "action": "recommend", "goal": "Refactor auth flow" }
{ "action": "search", "goal": "heartbeat detection" }

// Resource management
{ "action": "create", "resource": "agent", "config": { "name": "api-reviewer", ... } }
{ "action": "update", "resource": "team", "name": "backend", "config": { ... } }
{ "action": "delete", "resource": "workflow", "name": "quick-review" }
{ "action": "validate" }

// Run maintenance
{ "action": "cleanup", "runId": "team_..." }
{ "action": "forget", "runId": "team_...", "confirm": true }
{ "action": "prune", "olderThanDays": 7, "confirm": true }
{ "action": "export", "runId": "team_..." }
{ "action": "import", "path": "/path/to/bundle.tar.gz" }

// Environment & configuration
{ "action": "doctor", "config": { "smokeChildPi": true } }
{ "action": "config" }
{ "action": "init", "config": { "copyBuiltins": true } }
{ "action": "autonomy", "profile": "assisted" }

// Advanced
{ "action": "api", "runId": "team_...", "config": { "operation": "read-manifest" } }
{ "action": "plan", "team": "default", "goal": "..." }
{ "action": "orchestrate", "planPath": "plan.md", "team": "implementation", "goal": "..." }
{ "action": "parallel", "config": { "tasks": [{"goal": "...", "agent": "explorer"}] } }
{ "action": "worktrees", "runId": "team_..." }
{ "action": "graph", "runId": "team_..." }
{ "action": "explain", "runId": "team_..." }
{ "action": "health" }
{ "action": "doctor" }
{ "action": "cache" }
{ "action": "invalidate", "runId": "team_..." }

// Scheduled runs
{ "action": "schedule", "team": "fast-fix", "goal": "Run tests", "cron": "0 9 * * MON" }
{ "action": "schedule", "team": "default", "goal": "...", "interval": 3600000 }
{ "action": "schedule", "team": "research", "goal": "...", "once": "+10m" }
{ "action": "scheduled" }

// Diagnostics & settings
{ "action": "config" }
{ "action": "settings" }
{ "action": "autonomy" }
{ "action": "anchor" }
{ "action": "onboard" }
{ "action": "auto-summarize" }
```

📖 Full actions reference (40+ actions): [docs/actions-reference.md](docs/actions-reference.md)

---

## Slash Commands

```text
/team-run [--team=X] [--async] [--worktree] <goal>
/team-status <runId>
/team-dashboard
/team-doctor
/team-init [--copy-builtins]
/team-config [key=value]
/team-autonomy [status|on|off|suggested|assisted]
```

📖 Full commands reference: [docs/commands-reference.md](docs/commands-reference.md)

---

## Resource Discovery

Agents, teams, and workflows are discovered from three layers:

```
builtin (package)  <  user (~/.pi/agent/)  <  project (.crew/ or .pi/teams/)
```

Project resources can add new names but **cannot shadow** builtin/user resources.

### Resource Paths

| Type | Builtin | User | Project |
|------|---------|------|---------|
| Agent | `agents/*.md` | `~/.pi/agent/agents/*.md` | `.crew/agents/*.md` |
| Team | `teams/*.team.md` | `~/.pi/agent/teams/*.team.md` | `.crew/teams/*.team.md` |
| Workflow | `workflows/*.workflow.md` | `~/.pi/agent/workflows/*.workflow.md` | `.crew/workflows/*.workflow.md` |

### Custom Resources with Routing Metadata

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
Your system prompt here.
```

📖 Full resource formats: [docs/resource-formats.md](docs/resource-formats.md)

---

## State Layout

```
<crewRoot>/                          # .crew/ (new) or .pi/teams/ (legacy)
├── state/runs/{runId}/
│   ├── manifest.json                # run metadata
│   ├── tasks.json                   # task graph + status
│   ├── events.jsonl                 # append-only events
│   └── agents/{taskId}/status.json  # per-agent state
├── artifacts/{runId}/
│   ├── goal.md
│   ├── prompts/{taskId}.md
│   ├── results/{taskId}.txt
│   ├── logs/{taskId}.log
│   └── summary.md
├── worktrees/{runId}/{taskId}/
└── imports/{runId}/run-export.json
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_CREW_EXECUTE_WORKERS=0` | Disable child workers (scaffold mode) |
| `PI_TEAMS_EXECUTE_WORKERS=0` | Legacy disable flag |
| `PI_TEAMS_MOCK_CHILD_PI=success` | Mock child worker for testing |
| `PI_TEAMS_PI_BIN=<path>` | Explicit Pi CLI path |
| `PI_TEAMS_HOME=<path>` | Override home for tests |

---

## Development

```bash
cd pi-crew
npm install          # dependencies
npm test             # unit + integration tests (~4,800 tests)
npm run typecheck    # tsc --noEmit
npm run ci           # full CI-equivalent check
npm pack --dry-run   # package verification
```

Stats: **366 source files** (70K lines) · **506 test files** (66K lines) · **4,792 tests, 0 failures** · **CI: Ubuntu ✅ macOS ✅ Windows ✅**

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/actions-reference.md](docs/actions-reference.md) | Full tool actions + examples |
| [docs/commands-reference.md](docs/commands-reference.md) | Slash commands + `/team-api` |
| [docs/resource-formats.md](docs/resource-formats.md) | Agent/team/workflow file formats |
| [docs/usage.md](docs/usage.md) | Usage patterns + config examples |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common errors, recovery, and error-code reference (E001–E012) |
| [docs/architecture.md](docs/architecture.md) | Internal architecture + run flow |
| [docs/runtime-flow.md](docs/runtime-flow.md) | Runtime execution details |
| [docs/goals.md](docs/goals.md) | **v0.9.0** Autonomous goal loops (`team action='goal'`) |
| [docs/dynamic-workflows.md](docs/dynamic-workflows.md) | **v0.9.0** `.dwf.ts` script runtime + trust model |
| [docs/live-mailbox-runtime.md](docs/live-mailbox-runtime.md) | Mailbox + live-session runtime |
| [docs/publishing.md](docs/publishing.md) | Release & publish process |
| [docs/next-upgrade-roadmap.md](docs/next-upgrade-roadmap.md) | Future upgrade roadmap |
| [schema.json](schema.json) | Config JSON schema |

Research docs (not in package): [`docs/pi-crew-research/`](https://github.com/baphuongna/pi-crew/tree/main/docs) — audits, deep research, distillation notes.

---

## Known limitations

This is AI-developed software built for a personal workflow. These are the
sharp edges I'm aware of — there are almost certainly others I'm not.

- **Multi-step goal-wrap crashes non-deterministically.** Goal-wrapping
  multi-step builtin workflows (`fast-fix`, `default`) can hit a V8/libuv
  event-loop race that kills the background process with no signal, no core,
  and no V8 diagnostic report (8 investigation attempts: gdb, strace, perf,
  `--report-on-fatalerror`, sync-fs workarounds, worker-thread atomic writer —
  see `research-findings/goal-workflow/17-PHASE1.5-CRASH-INVESTIGATION-RFC.md`).
  **Mitigation:** multi-step workflows silently auto-downgrade to a normal
  team-run (no goal-wrap layer); single-step workflows (`implementation`)
  goal-wrap end-to-end.
- **`.dwf.ts` scripts are NOT sandboxed in v1.** The `WorkflowCtx` is
  `Object.freeze()`d, but the script runs in plain module scope with full
  `require`/`import`/`process` access (postinstall-equivalent trust).
  `isolated-vm` (real V8 isolate) is planned for a future release. Only place
  `.dwf.ts` files you have reviewed. See
  [docs/dynamic-workflows.md#security-model-important](docs/dynamic-workflows.md#security-model-important).
- **Editor/agent file caching.** After editing a loaded pi-crew source file,
  restart the Pi session for changes to take effect (jiti in-memory cache).
  Editing a `.dwf.ts` in place while a run is mid-flight can serve a stale
  module body; rename the file or restart Pi to force a fresh load.
- **Verification integrity is best-effort against adversarial workers.** The
  bookend snapshot (P1a) and git-worktree sandbox (Phase 1.5 #2, opt-in)
  raise the bar, but a worker in the same process can still tamper with files
  outside the snapshot window. Full isolation requires the planned sandbox.
- **Single maintainer + AI review.** Every change ships after 2+ consecutive
  clean static-review rounds + runtime tests, but there's no independent human
  audit. Fork and read before trusting anything that touches your data.

If you hit any of these — or a new one — please
[open an issue](https://github.com/baphuongna/pi-crew/issues).

---

## Acknowledgements

`pi-crew` builds on ideas and selected MIT-licensed implementation patterns from `pi-subagents` and `oh-my-claudecode`, with conceptual inspiration from `oh-my-openagent`.
