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
> See also: [SECURITY-ISSUES.md](docs/bugs/SECURITY-ISSUES.md),
> [docs/dynamic-workflows.md](docs/dynamic-workflows.md#security-model-important)
> (trust model), and the [Known limitations](#known-limitations) section below.

**Coordinate AI agent teams inside [Pi](https://github.com/nicekate/pi-coding-agent).**

pi-crew is a Pi extension that orchestrates autonomous multi-agent workflows — research, implementation, review, testing, and more — with durable state, parallel execution, worktree isolation, and safe defaults.

```text
npm: pi-crew
repo: https://github.com/baphuongna/pi-crew
```



## Features

- **Workflow topology advisory** (v0.9.15) — before each run, pi-crew classifies the workflow's shape (`single` / `sequential` / `concurrent` / `complex-dag`) and prints an **advisory note** with measured cost evidence (e.g. "3-step sequential: measured 5.7× slower than 3 raw Agent calls — proceeding anyway"). Never blocks — the agent decides. Tool description and prompt-snippet carry the same guidance up-front, so agents know the trade-off before calling. New files: `src/workflows/topology-analyzer.ts`, `src/workflows/preflight-validator.ts`. See [Workflow topology advisory](#workflow-topology-advisory) below.
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
- **Inter-pi broker** (v0.9.47, default-on) — a Unix-domain-socket message bus that lets concurrently-running Pi sessions pass messages, steering notes, and task-status events to each other. **On by default** on Linux + macOS; auto-disabled on native Windows (no unix socket). Three independent kill switches: `broker.enabled: false` (config), `PI_CREW_BROKER=0` (env, always wins), Windows auto-disable. See [docs/decisions/2026-07-22-broker-phase4-gated-on.md](docs/decisions/2026-07-22-broker-phase4-gated-on.md).
- **`test:critical` + `real-test-pi-crew` skill** (v0.9.47) — a curated 14-file / 97-test subset (`npm run test:critical`, ~20s) for fast in-loop verification, plus a bundled skill distilling the full 8-tier end-to-end verification discipline (unit → 3-path kill-switch proof → typecheck/bundle → live TUI probing → smoke team run). Prevents the verifier-worker hang that full `npm test` (>4 min) caused against the 300s worker timeout.
- **Provider extensions in subagents** (v0.9.57) — pi-crew spawns child-pi workers with `--no-extensions` (security posture), which made extension-registered providers (e.g. `pi-commandcode-provider`) unresolvable inside subagents. pi-crew now **auto-discovers provider packages** from `~/.pi/agent/settings.json` `packages` (npm: specs) and loads them via `--extension` in every builtin/user subagent — so **all provider models work in subagents**. An explicit `runtime.agentExtensions: string[]` config is an optional extra allowlist on top of auto-discovery. **SEC-1 preserved:** project/project-pi agents never receive these (env-gate unchanged).

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

---

## Workflow topology advisory

Before every `team action='run'`, pi-crew classifies the workflow shape and prints an informational note. **It never blocks** — agents decide whether to proceed, refactor, or override.

### How it works

```text
team action='run', workflow='fast-fix', goal='...'
  ↓
pi-crew analyzes topology: 3-step sequential
  ↓
⚠️  [team-tool.preflight] WARN: 3-step sequential chain: measured 5.7× slower
    and 1.9× costlier than 3 raw Agent calls (Run #3 in .crew/state/runs/).
    Proceeding anyway.
  ↓
Workflow runs to completion. Agent sees the note, decides for next time.
```

### Topology → advisory level

| Topology | When | Level | What pi-crew prints |
|---|---|---|---|
| `single` | 1 step, no concurrency | `warn` | "raw Agent tool would be ~30× faster and ~5× cheaper. Proceeding anyway." |
| `sequential` (2-3 steps) | Linear chain, no fan-out | `warn` | "measured 5.7× slower than raw Agent calls. Proceeding anyway." |
| `sequential` (4+ steps) | Linear chain, longer | `warn` | "audit trail may justify pi-crew overhead. Proceeding anyway." |
| `concurrent` | ≥3 truly parallel agents (parallelGroup) | `note` | "✅ Validated use case: N-way parallel fan-out. pi-crew's parallelism wins." |
| `complex-dag` | 4+ steps with data dependencies | `note` | "✅ Validated use case: complex DAG with adaptive plan." |
| `dynamic` | `.dwf.ts` script | `info` | "Runtime decides topology." |

### When to prefer raw `Agent` over `team`

Use the raw `Agent` tool when:
- You have a single task or quick question (1-step)
- You have 2–3 sequential independent steps (no DAG branching, no concurrency)

Use `team` when:
- You have ≥3 agents running TRULY CONCURRENTLY (`parallelGroup`)
- You have a COMPLEX DAG (4+ steps with data dependencies, branching)
- You need an audit trail, team coordination, or worktree isolation that justifies pi-crew's overhead

### How agents learn the rule

The guidance is available in three places agents see:

1. **`team` tool description** — the LLM reads this when considering whether to call the tool. Includes an explicit "ℹ️ ADVISORY NOTE (preflight, never blocks)" section.
2. **`team` prompt snippet** — rendered in agent context when the tool is relevant. Single-line summary of the rule.
3. **`.crew/knowledge.md` CONVENTIONS section** — always injected into every worker session's context. Contains the full 4-question self-check.

### How to silence the advisory

The advisory is **informational only** — there is no `force:true` flag needed (the run proceeds regardless). If you want to silence the `console.warn` output for cleaner logs, set `PI_CREW_QUIET_PREFLIGHT=1` in your environment.

### Implementation

- `src/workflows/topology-analyzer.ts` — pure classifier (parses workflow YAML, builds DAG, detects parallelGroups)
- `src/workflows/preflight-validator.ts` — returns `{level: info|note|warn, message, suggestion}` (never throws)
- Integration: `src/extension/team-tool/run.ts` (extension layer, prints advisory) + `src/runtime/team-runner.ts` (defense-in-depth, also logs)

### Tests

- `test/unit/topology-analyzer.test.ts` — 13 cases (each topology + edge cases)
- `test/unit/preflight-validator.test.ts` — 11 cases (each level + advisory contract)


- `test/functional/pi-crew-live.test.ts` + `test/functional/pi-crew-live-broad.test.ts` — 16 live integration tests run against the **real pi binary + real LLM provider** (verified after v0.9.42 audit, ~26 commits). Use these when you want to confirm end-to-end behavior, not just unit-level invariants.

## Recent changes

### v0.9.57 (in progress): post-reorg repo-layout consolidation + provider-extension auto-discovery

- **Source reorg finalised (~90 commits)**: `src/` is now cluster-organised — `src/runtime/` (15 subdirs + ~77 flat files) and `src/state/` (3 subdirs + 12 root files), with the other top-level dirs (`extension/`, `ui/`, `config/`, `utils/`, `agents/`, …) cluster-honed too. See [Repository layout](#repository-layout) and the cluster maps [`src/runtime/README.md`](src/runtime/README.md) / [`src/state/README.md`](src/state/README.md).
- **Tests mirrored into subdirs**: 566 flat `.test.ts` files now live in 35 leaf subdirectories mirroring `src/` (`test/unit/runtime/`, `test/unit/state/`, `test/unit/extension/`, …). 151 cross-cutting tests (`round*`, `v0*`, `package-*`, errors, i18n, bundle-*) stay at `test/unit/` root by design. See [`test/unit/README.md`](test/unit/README.md).
- **Recursive-glob test-runner fix**: `scripts/test-runner.mjs` now expands `**` globs itself — Node v22's `--test` only expands single-level `*`, so subdir tests (e.g. `test/unit/security/`) were **invisible** to `npm test` before.
- **Docs consolidated**: 47 flat docs at `docs/` root → 20 living docs kept at root, 27 historical moved to `docs/archive/` (flat); 11 stray root `.md` files moved to `docs/archive/` + `docs/bugs/`. New [`docs/README.md`](docs/README.md) indexes the living docs + subdirs.
- **Provider extensions in subagents** (see [Features](#features)): auto-discovery of provider packages from `~/.pi/agent/settings.json` `packages` (npm: specs) + explicit `runtime.agentExtensions` allowlist. Implementation: `src/runtime/model/provider-extensions.ts` + merge in `src/agents/discover-agents.ts`. SEC-1 preserved (project/project-pi agents never receive these).
- See [CHANGELOG.md](CHANGELOG.md) for the full reorg + feature log.

### v0.9.47 (2026-07-22): Inter-pi broker Phase 4 (default-on) + verifier-hang fix + verification skill

- **Broker default-on**: `broker.enabled` flipped `false` → `true` on Linux + macOS. The inter-pi broker lets concurrent Pi sessions exchange messages, steering notes, and task-status events over a Unix-domain socket. Three kill switches remain: config `broker.enabled: false`, env `PI_CREW_BROKER=0` (always wins), Windows auto-disable.
- **Verifier-hang fix**: `npm run test:critical` — a curated 14-file / 97-test subset (~20s) replaces full `npm test` (>4 min) in verifier prompts. The full suite was exceeding the 300s `RESPONSE_TIMEOUT_MS`, killing workers with exit 143. Both plan-templates and all 4 workflow verifier prompts now specify the fast command.
- **`real-test-pi-crew` skill** (659 lines): distills the 8-tier verification discipline used to ship this release (critical tests → 3-path kill-switch proof → typecheck/bundle → bundle md5 sync → live TUI probing via tmux/pty → smoke team run). Bundled `scripts/pty_probe.py`.
- **Postinstall skill-collision fix**: v0.9.47's `copySkills()` (which mirrored skills to `~/.pi/agent/skills/`) caused 31 "collision" warnings — Pi already discovers skills natively from the npm package. v0.9.48 removes `copySkills()` and adds a safe byte-identical cleanup (`cleanupStaleSkillCopies()`) that clears the stale copies on upgrade. User-customized skills are preserved.
- See [CHANGELOG.md](CHANGELOG.md) §0.9.47 and [docs/decisions/2026-07-22-broker-phase4-gated-on.md](docs/decisions/2026-07-22-broker-phase4-gated-on.md).

### v0.9.45 – v0.9.46 (2026-07-20): security + perf remediation, UI stability

- **Custom agent roles default to read-only (FIND-12, breaking):**
  `permissionForRole()` returns `"read_only"` for unknown roles (was
  permissive `"workspace_write"`). Write-capable roles are now an explicit
  allowlist (`WRITE_ROLES`). See `CHANGELOG.md` for the migration.
- **Mailbox / snapshot-cache / scan perf:** delivery cache + async append
  (FIND-01/02), `listActive` TTL + mtime-sort strict limit (FIND-03/04),
  byte-bounded event-log tail-read (FIND-05).
- **Heartbeat race (FIND-06):** in-flight guard + drain + terminal-safety +
  late-save repair in the coalesced task group.
- **UI flicker eliminated:** the render path no longer hard-deletes snapshot
  entries, so the crew widget / powerbar / live sidebar stay stable (no more
  "(loading…)" flashing every ~160ms).
- **Emoji width-overflow crash fixed for good:** `visibleWidth` delegates to
  pi-tui's own measure, so agent-output emoji can never exceed terminal width.
- **Background-subagent notifications coalesce:** N near-simultaneous
  completions now produce ONE consolidated wake-up instead of N drips.

### v0.9.42 – v0.9.44: 4-wave audit + flaky-CI fixes

A 4-wave audit + fix pass was completed (see `docs/archive/UPGRADE_REVIEW.md` for the full 647-line report and `CHANGELOG.md` for the diff):

- **−481 KB** bundle size (externalized `acorn` + fixed `@sinclair/typebox` name).
- **−31.1%** in `child-pi.ts` (1842 → 1270 lines via 6 decomposition steps).
- **~30 bug fixes** across security, correctness, budget enforcement, worker cap, observability, and worktree isolation.
- **Lock re-entrance guard** via `AsyncLocalStorage` (H-1) — fixes a root-cause mutual-exclusion violation.
- **Task-level metrics now functional** (OBS-NEW-1/2) — `crew.task.{count,duration_ms,tokens_total}` were always zero; now emit on every run completion.
- **Live-test-only bugs found** (mock tests had passed): token usage not captured (nested `obj.message.usage`), child-pi spawning wrong binary (`argv1` trust heuristic), worktree mode blocked by own `.gitignore`.

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

A comprehensive reference of every config key. 🔒 marks keys that are
**sensitive** — project config (`.crew/config.json`) cannot set them; they are
silently ignored with a warning unless set in **user config**
(`~/.pi/agent/pi-crew.json`). Cross-referenced against `src/config/types.ts`
(`PiTeamsConfig`), `src/config/defaults.ts`, and the project-override sanitizer
in `src/config/config.ts`.

For machine-readable validation, see [schema.json](schema.json).

#### Top-level

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `asyncByDefault` 🔒 | `boolean` | `false` | Detach every `run` by default (survives session switches). |
| `executeWorkers` 🔒 | `boolean` | `true` | Spawn worker agents. `false` = dry-run planning only. |
| `notifierIntervalMs` | `number` | `5000` | How often the completion notifier polls. |
| `requireCleanWorktreeLeader` 🔒 | `boolean` | _(unset)_ | Require a clean git repo before starting a worktree-mode run. |
| `ignoreMethod` | `"gitignore" \| "exclude"` | _(unset)_ | How run artifacts are ignored by git. |

#### `autonomous.*` — Delegation & magic keywords

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `autonomous.profile` 🔒 | `manual \| suggested \| assisted \| aggressive` | `suggested` | How much the agent self-delegates to crew runs. |
| `autonomous.enabled` 🔒 | `boolean` | `true` | Master switch for autonomous delegation. |
| `autonomous.injectPolicy` 🔒 | `boolean` | `true` | Inject the delegation policy into prompts. |
| `autonomous.preferAsyncForLongTasks` 🔒 | `boolean` | `false` | Auto-detach runs expected to be long. |
| `autonomous.allowWorktreeSuggestion` 🔒 | `boolean` | `true` | Suggest worktree isolation for mutating goals. |
| `autonomous.magicKeywords` | `Record<string, string[]>` | _(unset)_ | Trigger words mapped to team/workflow hints. |

#### `limits.*` — Scheduling ceilings

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `limits.maxConcurrentWorkers` | `number` | workflow-dependent¹ | Hard cap on parallel workers. Ceiling 1024. |
| `limits.allowUnboundedConcurrency` | `boolean` | `false` | Permit unbounded fan-out (dangerous). |
| `limits.maxTaskDepth` | `number` | `100` | Max nesting depth of the task graph. |
| `limits.maxChildrenPerTask` | `number` | `1000` | Max children a single task may spawn. |
| `limits.maxRunMinutes` | `number` | `1440` | Wall-clock cap for a run (24 h). |
| `limits.maxRetriesPerTask` | `number` | `100` | Max automatic retries per task. |
| `limits.maxTasksPerRun` | `number` | `10000` | Max tasks allowed in a single run. |
| `limits.heartbeatStaleMs` | `number` | `86400000` | Heartbeat staleness threshold (24 h). |
| `limits.serializeOnPathOverlap` | `boolean` | `false` | Skip ready tasks whose `step.output` overlaps an in-flight task. |

¹ Per workflow: `parallelResearch` 4, `research` 3, `implementation` 4, `review` 3, `default` 3 (fallback 2).

#### `runtime.*` — Worker execution

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `runtime.mode` 🔒 | `auto \| scaffold \| child-process \| live-session` | `auto` | How workers are spawned. |
| `runtime.preferLiveSession` 🔒 | `boolean` | _(unset)_ | Prefer in-process live-session workers. |
| `runtime.allowChildProcessFallback` 🔒 | `boolean` | _(unset)_ | Fall back to child-process if live-session unavailable. |
| `runtime.maxTurns` | `number` | `10000` | Max agent turns per task. |
| `runtime.graceTurns` | `number` | `5` | Extra turns allowed after a stop signal. |
| `runtime.taskTimeoutMs` | `number` | `0` | Per-task wall-clock timeout (0 = none). |
| `runtime.inheritContext` 🔒 | `boolean` | `true` | Inherit parent context into workers. |
| `runtime.promptMode` | `replace \| append` | `replace` | How the task prompt is applied. |
| `runtime.groupJoin` | `off \| group \| smart` | `smart` | How grouped task results are joined. |
| `runtime.groupJoinAckTimeoutMs` | `number` | `86400000` | Timeout for group-join acknowledgements. |
| `runtime.requirePlanApproval` 🔒² | `boolean` | `false` | Pause for plan approval before mutating tasks. |
| `runtime.completionMutationGuard` | `off \| warn \| fail` | `warn` | Guard against tasks mutating outside plan approval. |
| `runtime.effectivenessGuard` | `off \| warn \| block \| fail` | `off` | Pre-flight topology validator enforcement mode. |
| `runtime.isolationPolicy` 🔒 | `{ isolatedRoles?, defaultRuntime? }` | _(unset)_ | Per-role runtime selection for crash isolation. |
| `runtime.excludeContextBash` | `boolean` | `false` | Exclude certain bash results from worker context. |
| `runtime.agentExtensions` | `string[]` | _(unset)_ | Extra extension paths (file paths or npm entry points) loaded in **every** child-pi worker on top of auto-discovered provider packages (see [Features](#features)). Optional allowlist — auto-discovery already loads provider packages from `~/.pi/agent/settings.json` `packages`. Project/project-pi agents never receive these (SEC-1). |

² `requirePlanApproval` is sensitive only when set to `false` in project config
(the sanitizer blocks *disabling* the gate from untrusted project config).

#### `control.*` — Needs-attention gating

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `control.enabled` | `boolean` | _(unset)_ | Enable the needs-attention controller. |
| `control.needsAttentionAfterMs` | `number` | _(unset)_ | Threshold before flagging a run as needing attention. |

#### `worktree.*` — Git worktree isolation

> Worktree **mode** is chosen at run time via `workspaceMode: "worktree"`, not
> in config. These keys configure how a worktree is set up.

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `worktree.setupHook` 🔒 | `string` | _(unset)_ | Shell command run after worktree creation. |
| `worktree.setupHookTimeoutMs` | `number` | _(unset)_ | Timeout for the setup hook. |
| `worktree.linkNodeModules` | `boolean` | `false` | Symlink `node_modules` into the worktree. |
| `worktree.seedPaths` | `string[]` | _(unset)_ | Extra paths to copy/symlink into the worktree. |

#### `goalWrap.*` — Goal-completion workflows

A per-workflow map (`Record<workflowName, GoalWrapWorkflowConfig>`) that applies
the `goal` action's completion-guarantee loop to builtin workflows.

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `goalWrap.<name>.enabled` | `boolean` | _(unset)_ | Enable goal-wrap for this workflow. |
| `goalWrap.<name>.maxTurns` | `number` (1–50) | _(unset)_ | Max iterations of the goal loop. |
| `goalWrap.<name>.evaluatorModel` | `string` | _(unset)_ | Model used by the LLM judge. |
| `goalWrap.<name>.verification.commands` | `string[]` | _(unset)_ | Commands run to verify completion. |
| `goalWrap.<name>.budgetTotal` | `number` | _(unset)_ | Token budget for the goal loop. |
| `goalWrap.<name>.budgetUnlimited` | `boolean` | _(unset)_ | Skip the token budget. |

#### `agents.*` — Agent overrides

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `agents.disableBuiltins` 🔒 | `boolean` | `false` | Hide built-in agents. |
| `agents.overrides` 🔒 | `Record<name, AgentOverride>` | _(unset)_ | Per-agent `model`, `fallbackModels`, `thinking`, `tools`, `skills`, `disabled`. |

#### `tools.*` — Tool behaviour

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `tools.enableClaudeStyleAliases` | `boolean` | _(unset)_ | Accept Claude-style tool aliases. |
| `tools.enableSteer` 🔒 | `boolean` | _(unset)_ | Enable the `steer` action. |
| `tools.terminateOnForeground` 🔒 | `boolean` | _(unset)_ | Terminate background runs when foreground starts. |

#### `telemetry.*`

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `telemetry.enabled` | `boolean` | `false` | Collect anonymous usage telemetry. |

#### `policy.*` — Capability gating

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `policy.requireIntentForDestructiveActions` | `boolean` | _(unset)_ | Require explicit intent for deletes/forgets. |
| `policy.disabledCapabilities` | `string[]` | _(unset)_ | Disable named capabilities. |

#### `notifications.*`

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `notifications.enabled` | `boolean` | `false` | Enable run-completion notifications. |
| `notifications.severityFilter` | `Severity[]` | `[warning, error, critical]` | Which severities to surface. |
| `notifications.dedupWindowMs` | `number` | `30000` | De-duplicate notifications within this window. |
| `notifications.batchWindowMs` | `number` | `0` | Batch notifications for this long before emitting. |
| `notifications.quietHours` | `string` | _(unset)_ | Quiet-hours schedule (e.g. `"22:00-08:00"`). |
| `notifications.sinkRetentionDays` | `number` | `7` | How long notification sinks retain data. |

#### `observability.*`

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `observability.enabled` | `boolean` | _(unset)_ | Enable the periodic observability poller. |
| `observability.pollIntervalMs` | `number` | _(unset)_ | Polling interval. |
| `observability.metricRetentionDays` | `number` | _(unset)_ | How long metrics are retained. |

#### `reliability.*` — Retry, recovery & validation

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `reliability.autoRetry` | `boolean` | `false` | Auto-retry failed tasks. |
| `reliability.retryPolicy.maxAttempts` | `number` | _(unset)_ | Max retry attempts. |
| `reliability.retryPolicy.backoffMs` | `number` | _(unset)_ | Base backoff between retries. |
| `reliability.retryPolicy.jitterRatio` | `number` | _(unset)_ | Jitter fraction (0–1). |
| `reliability.retryPolicy.exponentialFactor` | `number` | _(unset)_ | Exponential backoff multiplier. |
| `reliability.retryPolicy.retryableErrors` | `string[]` | _(unset)_ | Error substrings considered retryable. |
| `reliability.retryPolicy.maxTotalSpawns` | `number` | `0` | Flat per-task spawn budget (0 = auto). |
| `reliability.autoRecover` | `boolean` | `false` | Auto-recover stuck/orphaned runs. |
| `reliability.deadletterThreshold` | `number` | _(unset)_ | Attempts before a task is dead-lettered. |
| `reliability.autoRepairIntervalMs` | `number` | `60000` | Periodic stale-run repair interval (0 = off). |
| `reliability.cleanupOrphanedTempDirs` | `boolean` | `true` | Remove orphaned `/tmp/pi-crew-*` dirs. |
| `reliability.forcePreflight` | `boolean` | `false` | Bypass the topology validator (audit-logged). |
| `reliability.ambientStatusInjection` | `boolean` | `true` | Inject ambient crew-status note on every LLM call. |
| `reliability.perWriteValidation` | `boolean` | `true` | Validate `write`/`edit` results (JSON v1). |
| `reliability.scopeModels` | `boolean` | `false` | Enforce subagent models stay within the allowlist. |

#### `otlp.*` — OpenTelemetry export

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `otlp.enabled` | `boolean` | _(unset)_ | Enable OTLP trace/metric export. |
| `otlp.endpoint` 🔒 | `string` | _(unset)_ | OTLP collector endpoint. |
| `otlp.headers` 🔒 | `Record<string, string>` | _(unset)_ | Auth headers sent to the collector. |
| `otlp.intervalMs` | `number` | _(unset)_ | Export flush interval. |

#### `ui.*` — Dashboard & widget

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `ui.widgetPlacement` | `aboveEditor \| belowEditor` | `aboveEditor` | Where the status widget renders. |
| `ui.widgetMaxLines` | `number` | `8` | Max lines shown by the widget. |
| `ui.powerbar` | `boolean` | `true` | Show the power bar. |
| `ui.dashboardPlacement` | `center \| right` | `center` | Dashboard screen position. |
| `ui.dashboardWidth` | `number` | `72` | Dashboard column width. |
| `ui.dashboardLiveRefreshMs` | `number` | `1000` | Dashboard live-refresh interval. |
| `ui.autoOpenDashboard` | `boolean` | `false` | Auto-open the dashboard. |
| `ui.autoOpenDashboardForForegroundRuns` | `boolean` | `false` | Auto-open only for foreground runs. |
| `ui.autoCloseDashboardMs` | `number` | _(unset)_ | Auto-close the dashboard after this long. |
| `ui.showModel` | `boolean` | `true` | Show model names in the UI. |
| `ui.showTokens` | `boolean` | `true` | Show token counts. |
| `ui.showTools` | `boolean` | `true` | Show tool activity. |
| `ui.transcriptTailBytes` | `number` | `1048576` | Bytes of transcript tail kept. |
| `ui.mascotStyle` | `cat \| armin` | `cat` | Mascot character. |
| `ui.mascotEffect` | `random \| none \| …` | `random` | Mascot animation effect. |

#### `broker.*` — Inter-Pi broker

> Default is **ON** since v0.9.47 (Linux + macOS). Disable via
> `broker.enabled: false`, env `PI_CREW_BROKER=0`, or auto-off on Windows.

| Key path | Type | Default | Description |
|----------|------|---------|-------------|
| `broker.enabled` | `boolean` | `true` | Master switch for the local socket broker. |
| `broker.pathHashLen` | `number` (4–32) | `8` | SHA-256 prefix length in the socket filename. |
| `broker.maxFrameBytes` | `number` (1024–1048576) | `262144` | Max NDJSON frame size (256 KiB). |
| `broker.outboundQueueCap` | `number` (32–4096) | `256` | Per-connection outbound queue cap. |

> ⚠️ **Trust boundary**: 🔒 keys are blocked from project config — set them in
> **user config** only. The project config sanitizer silently drops them with a
> warning so untrusted repos cannot escalate privileges or redirect telemetry.

📖 Interactive config UI: [docs/commands-reference.md#team-settings--config-management](docs/commands-reference.md) · machine-readable: [schema.json](schema.json)

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
| `PI_CREW_BROKER=0` | **Disable the inter-pi broker entirely** (always wins over config). Use to opt out of cross-session messaging. |
| `PI_CREW_BROKER=1` | Explicitly enable the broker (redundant under the v0.9.47 default-on; useful for overriding a config `broker.enabled: false`). |
| `PI_CREW_BROKER_DIAG_UI=1` | Make the run-dashboard `handleInput` emit a `[PI-CREW-DIAG]` line to stderr per keystroke — for TUI keybinding probes. |
| `PI_CREW_USE_BUNDLE=1` | Force-load via bundled `dist/index.mjs` (~19% faster cold-start than strip-types). Default: bundle (since v0.9.17). Set `PI_CREW_USE_BUNDLE=0` to force strip-types fallback. Requires `npm run build:bundle` to have produced `dist/`. |
| `PI_CREW_EXECUTE_WORKERS=0` | Disable child workers (scaffold mode) |
| `PI_TEAMS_EXECUTE_WORKERS=0` | Legacy disable flag |
| `PI_TEAMS_MOCK_CHILD_PI=success` | Mock child worker for testing |
| `PI_TEAMS_PI_BIN=<path>` | Explicit Pi CLI path |
| `PI_TEAMS_HOME=<path>` | Override home for tests |

---

## Development

### Auto-rebuild bundle on edit

For active development on the bundle, run the watcher in a separate terminal:

```bash
npm run watch:bundle
```

This watches `src/` + `index.bundle.ts` and rebuilds `dist/index.mjs` after a 300ms debounce. Zero added dependencies (uses native `node:fs.watch` with per-directory watchers).

```bash
npm run watch:bundle             # watch + auto-rebuild
npm run watch:bundle --debounce 500  # custom debounce
node scripts/watch-bundle.mjs --once  # build once and exit (CI prep)
```

The watcher is the dev-loop companion to `check:bundle-staleness` (CI gate) — together they eliminate the "edit src/foo.ts, forget to rebuild, run stale bundle" failure mode.

```bash
cd pi-crew
npm install          # dependencies
npm test             # unit + integration tests (~6,500 tests)
npm run test:critical # fast subset: 97 broker/UI tests in ~20s
npm run typecheck    # tsc --noEmit
npm run ci           # full CI-equivalent check
npm pack --dry-run   # package verification
```

Stats: **476 source files** (112K lines) · **762 test files** (717 unit + 34 integration + 5 smoke + 3 functional + 2 platform + 1 manual) · **CI: Ubuntu ✅ macOS ✅ Windows ✅**

---

## Repository layout

After the v0.9.x reorg (~90 commits) the repo is cluster-organised so related
files live together — source, tests, and docs mirror each other.

```
src/                         # ~476 TS files
├── runtime/                 # team-run execution machinery — 15 subdirs + ~77 flat files
├── state/                   # persistent state layer — 3 subdirs + 12 root files
├── extension/               # Pi extension surface (register, team-tool, ui glue)
├── ui/                      # TUI, dashboard, overlays
├── config/ · utils/ · agents/ · workflows/ · …   # supporting clusters
test/
└── unit/                    # mirrors src/ — 35 leaf subdirs + 151 cross-cutting tests at root
    ├── runtime/ · state/ · extension/ · ui/ · config/ · …
docs/                        # living docs at root; history in docs/archive/
```

- **`src/`** — each top-level dir has a cluster map; the two largest are
  [`src/runtime/README.md`](src/runtime/README.md) (15 subdirs: child-pi,
  broker, live-session, recovery, scheduling, verification, model, output,
  heartbeat, process, goal-workflow, compaction, task-runner, custom-tools,
  errors) and [`src/state/README.md`](src/state/README.md) (event-log,
  stores, coordination).
- **`test/unit/`** — mirrors `src/` 1:1; cross-cutting tests (`round*`,
  `v0*`, `package-*`, errors, i18n, bundle-*) stay at the root by design.
  See [`test/unit/README.md`](test/unit/README.md).
- **`docs/`** — 20 living docs at the root; 27 historical docs moved to
  `docs/archive/`. See [`docs/README.md`](docs/README.md).

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
| [docs/README.md](docs/README.md) | Index of all docs/ (living + subdirs) |
| [src/runtime/README.md](src/runtime/README.md) | Runtime source cluster map (15 subdirs) |
| [src/state/README.md](src/state/README.md) | State source cluster map (3 subdirs) |
| [test/unit/README.md](test/unit/README.md) | Unit-test cluster map (mirrors src/) |
| [docs/archive/next-upgrade-roadmap.md](docs/archive/next-upgrade-roadmap.md) | Future upgrade roadmap |
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
  see [CHANGELOG.md](CHANGELOG.md) § v0.9.0 "Phase 1.5 #3").
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
