# pi-crew Subagent Architecture — Deep Audit (v2 Redesign Foundation)

> **ERRATUM (2026-08-17, review round 1 finding P2-16):** several file paths in this
> report were written with stale directory prefixes; claims are correct, paths are not.
> Corrected mapping: `src/runtime/child-pi.ts` → `src/runtime/child-pi/child-pi.ts` ·
> `src/runtime/global-worker-cap.ts` → `src/runtime/scheduling/global-worker-cap.ts` ·
> `src/runtime/recovery/stale-reconciler.ts` → `src/runtime/stale-reconciler.ts`
> (`src/runtime/recovery/` holds only crash-recovery) ·
> `src/runtime/adaptive-plan.ts` → `src/runtime/goal-workflow/adaptive-plan.ts` ·
> `src/extension/lifecycle-handlers.ts` → `src/extension/registration/lifecycle-handlers.ts` ·
> `src/extension/subagent-tools.ts` → `src/extension/registration/subagent-tools.ts` ·
> `src/runtime/subagent-manager-setup.ts` → `src/extension/registration/subagent-manager-setup.ts`.

**Run:** `team_20260816163952_f89275501e2c9e87` · **Repo:** `pi-crew` @ `fb3cad21` (main) · **Contract:** READ-ONLY audit; no source files modified.

**Sources.** Six read-only worker reports with file:line anchors, persisted under this artifacts root:
`results/01_discover.txt` (routing map), `02_explore-core.txt` (spawn/prompt/nesting), `03_explore-ui.txt` (UI), `04_explore-runtime.txt` (lifecycle/plan/budget), `05_explore-extensions.txt` (extension/registration + docs), `06_synthesize.txt` (cross-shard merge + discrepancy resolution). This document is the final consolidated report; per-shard depth lives in those files. Load-bearing claims were independently re-verified in source during finalization (see §7).

---

## 1. Per-Shard Findings (condensed; anchors at `fb3cad21`)

### S1 — Spawn & prompt

- **One spawn facade:** `runWorker` (`src/runtime/run-worker.ts:62-74`) wraps every `runChildPi` in the global worker semaphore (`max(2, cpus-2)`, `src/runtime/global-worker-cap.ts:26-47`); goal-judge exempt.
- **CLI args** (`src/runtime/model/pi-args.ts:266-358`): `--mode json -p`; optional `--no-session`; `--model <model[:thinking]>` (or bare `--thinking`); role tool policy via shared `resolveToolPolicy` (`src/agents/agent-config.ts:162-168`; planner read-only, verifier no edit/write — `src/runtime/role-tools.ts:23-114`); `agent.disableTools` → `--no-tools`; **always `--no-extensions` then `--extension <src/prompt/prompt-runtime.ts>` only** (`pi-args.ts:306-331`), with SEC-1 stripping project-sourced agent extensions unless `PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1` (`:323-332`); `--no-skills` unless `inheritSkills`, plus `--skill` per injected dir; system prompt → 0600 temp file (`--system-prompt`/`--append-system-prompt`); task inline ≤8000 chars else `@taskfile` (`TASK_ARG_LIMIT`, `pi-args.ts:19`).
- **No CLI identity flag:** impossible — Pi's strict parser rejects unknown flags; identity is `PI_CREW_KIND=subagent` env only (comment at `pi-args.ts:260-266`; read by zombie scanner from `/proc/<pid>/environ`).
- **Env contract** (`src/runtime/child-pi/child-pi-spawn.ts:32-63,185-210,262-337`): strict `BASE_ALLOWLIST` (system vars + `PI_CREW_DEPTH`) — provider keys **not** base-set; injected per-model via `buildScopedAllowList` (`src/utils/env-filter.ts:67`); secret scrub (`:116`); `assertOnlyControlEnvKeys` canary; on top: `PI_CREW_KIND=subagent`, `DEPTH=parent+1`, `MAX_DEPTH`, `ROLE`, `PARENT_PID` (parent-side only — pi binary never reads it), `STEERING_FILE`, `BROKER_{RUN_ID,TASK_ID}` always, `BROKER_{SOCKET,TOKEN}` heap-only when issued, scratchpad vars for eligible roles. `setsid`+`detached` POSIX spawn (`:170-171`).
- **Model chain** (`src/runtime/model/model-fallback.ts`): precedence `override > step > teamRole > agent > defaultSubagentModel (PI_CREW_MODEL > config) > parent` (`:613-737`, `:549-556`); any string containing `/` passes through **unvalidated** (`:282`) — the known oc-go/429 cascade; auto fallback tail quota-ordered (`:480-497`); spawn budget = `attemptModels × (maxAttempts+1)` (`src/runtime/task-runner/child-executor.ts:150-151`).
- **Prompt** (`src/runtime/task-runner/prompt-builder.ts:199-281`): cached stable prefix (run identity, READ-ONLY contract per role from `src/runtime/role-permission.ts:16-17`, mailbox channel, workspace tree, retrieval files, `knowledge.md` fragment) + dynamic suffix (goal, skills ≤1500 chars/skill & ≤6000 total — `src/runtime/skill-instructions.ts:47-63`, TaskPacket from `src/runtime/task-packet.ts`, `<dependency-context>` untrusted fence, task, handoff template).
- **Disable flags:** `executeWorkers=false` or `PI_CREW_EXECUTE_WORKERS=0` ⇒ scaffold mode, no processes (`src/runtime/model/runtime-resolver.ts:91-96`; warnings `src/extension/team-tool/run.ts:590-700`).

### S2 — Nesting feasibility: **blocked structurally, not by the depth cap**

- Child workers load **only** `prompt-runtime.ts` → **zero** `team`/`Agent`/`crew_agent` tools (`pi-args.ts:306-331`; comment `prompt-builder.ts:253-255`). A worker has no tool seam to spawn with.
- Depth guard is permissive: `DEFAULT_MAX_CREW_DEPTH = 2` (`pi-args.ts:20`), env clamp [1,10] (`:80-91`), enforced `depth >= maxDepth` at `runChildPi` (`src/runtime/child-pi.ts:253-259`). Under defaults a depth-1 worker may spawn one more level — if it had a way to spawn at all.
- Remaining gates if the extension were loaded in a child: broker root-session-only (`PI_CREW_KIND !== "subagent" && depth === 0`, `src/extension/lifecycle-handlers.ts:951-958`); read-only roles blocked (`role-permission.ts:49-63`); live-session runtime at depth>0 forced to child-process (`src/runtime/model/runtime-policy.ts:20-28`, ADR `docs/decisions/0003-depth-guard.md`); recursion an explicit non-goal (`docs/live-mailbox-runtime.md`).
- One live hole: a **user-sourced** agent (not project-sourced — SEC-1 only strips project/`project-pi`, `pi-args.ts:313-332`) declaring `extensions: [pi-crew]` would load the full extension inside a worker — untested; broker still no-op; run-lock/state contention risk. Bash-escape (`pi -p` by hand) bypasses depth accounting entirely.

### S3 — Lifecycle & reliability

- **Two agent worlds:** child-process `CrewAgentRecord`/`agents.json` (`src/runtime/crew-agent-records.ts:432,466`) vs live-session in-memory handles (`src/runtime/live-session/live-agent-manager.ts`) — no cross-linkage (`SubagentRecord` lacks `taskId`).
- **Isolation:** `workspaceMode:"single"` (shared cwd) default; worktree mode opt-in — `pi-crew/<runId>/<taskId>` branches, clean-leader assertion, seed overlay, rollback (`src/worktree/worktree-manager.ts:566,608,683-746`).
- **Termination:** SIGTERM→SIGKILL escalation (`src/runtime/child-pi/child-pi-constants.ts:24`; `child-pi-kill.ts`); wall-clock AbortController (`child-executor.ts:519-541`); turn limit `maxTurns + graceTurns` with soft-steer wrap-up then hard abort (`src/runtime/child-pi/child-pi-steering.ts:25-75`).
- **Heartbeats:** parent-side observers only; 1s throttle, disk-before-memory (`child-executor.ts:409-436`); gradient warn 30s / stale 60s / dead 300s (`heartbeat-gradient.ts:14-18`); deadletter reasons `max-retries | heartbeat-dead | manual` (`src/runtime/deadletter.ts`).
- **Crash recovery:** event-log byte-offset scan + stale reconciler; plan-approval-pending runs protected (`src/runtime/recovery/stale-reconciler.ts:44-47`); zombie detection reactive `/proc` sweep keyed on `PI_CREW_KIND=subagent` + dead `PI_CREW_PARENT_PID` (`src/runtime/process/zombie-scanner.ts:27-55`).
- **Steering:** `team action=steer` → `task.pendingSteers` (cap 100) **and** immediate append to `artifacts/steering/<taskId>.jsonl` → worker polls file every 500ms → `sendMessage(deliverAs:"steer")` at turn boundary (`src/prompt/prompt-runtime.ts:261-332`); broker push is the faster channel. Tool-level `steer_subagent`/`crew_agent_steer` are registered **stubs** — no `taskId` linkage on `SubagentRecord` (`src/extension/subagent-tools.ts:364-399`; ADR `docs/decisions/2026-08-14-agent-steer-tools-planned-not-implemented.md`).
- **`waiting` status is dead plumbing:** contract/events/respond/crash-recovery/UI all consume it, but **zero producers exist** — grep `status:"waiting"` over `pi-crew/src` = 0 matches (triple-verified by 02, 04, 06). Workers cannot ask questions mid-task.

### S4 — Plan & spec surfaces

- Three ephemeral representations, no Plan entity: (1) `orchestrate planPath` → one-shot markdown parse into tagged chains (`src/extension/plan-orchestrate.ts:14-77`); (2) `manifest.planApproval {required,status,planTaskId,planArtifactPath}` (`src/runtime/plan-approval.ts:38-66`) — the "plan" is the read-only task's **result text artifact**; gate at read-only→mutating boundary; approve/cancel via text op `team api op=approve-plan|cancel-plan`; (3) adaptive assess JSON `{phases}` flattened at injection, cap 12 tasks (`src/runtime/adaptive-plan.ts`).
- **`plan-execute` workflow is referenced only in schema docs — no workflow definition exists in src** (04 grep).
- `analysis.md` shared-handoff exists; TaskPacket is typed state (`src/state/types.ts:59-76`).
- **Specs:** no spec format, storage, or validation exists anywhere — "spec" appears only as skill vocabulary.
- **Missing for first-class plans:** versioning/revision, plan-item↔task linkage, per-item progress, re-plan/diff, UI query.

### S5 — UI surfaces

- **Widget** 3-source priority: liveAgents > RunSnapshotCache (TTL **1500ms**, `src/ui/run-snapshot-cache.ts:28`) > `agents.json`; max 3 agents/8 lines (`src/ui/widget/widget-renderer.ts:22-26,47-160`). Skill doc says 500ms — stale.
- **Powerbar** 3 segments (`src/ui/powerbar-publisher.ts`): active · progress % (the only real progress bar) · steps — but steps are **workflow-static** (`:137-178`), unaware of adaptive plans.
- **Dashboard** `/team-dashboard` 6 panes keys 1-6 (`src/ui/run-dashboard.ts`; `keybinding-map.ts:63-70`); progress pane is the plan-UI precursor (`dashboard-panes/progress-pane.ts:8-38`).
- ~30 slash commands, plain text; task graph renders as flat status list (`src/ui/task-display.ts:34-51`).
- **`manifest.planApproval` has 0 readers in `src/ui`** (03 grep) — approval invisible in every UI surface.

### S6 — Budget/limits + prior art

- `budgetTotal/warning/abort` fair-share enforcement (`src/runtime/budget-enforcement.ts:47-110`); `maxTurns`+`graceTurns`; **four uncoordinated concurrency layers**: config default 1024 (`src/config/handle-settings.ts:21`) × workflow hardCap 8 (`src/config/defaults.ts`) × global sem `max(2,cpus-2)` × hard-coded subagent cap 4 (`src/runtime/subagent-manager-setup.ts:27`); pendingSteers cap 100; ~40 capped collections total.
- 22 ADRs in `docs/decisions/`: nesting (0003), warm-pool (0008, unimplemented), steer-tools stub (2026-08-14), runtime convergence (2026-08-15). **No ADR exists for Plan objects, spec system, plan UI, or governed nesting.**

---

## 2. Architecture Diagram (current system, canonical)

```
USER ROOT pi SESSION (pi-crew extension loaded; PI_CREW_KIND unset; depth 0)
│
├─ registerPiTeams (src/extension/register.ts:51-113)
│  ├─ Tools: "team" (54 actions/5 domains, schema/team-tool-schema.ts:385-431)
│  │        "Agent"/"crew_agent" + result (single-agent runs, subagent-tools.ts:64)
│  │        "steer_subagent"/"crew_agent_steer"  ← STUBS (no taskId linkage)
│  ├─ ~30 slash commands (/teams /team-run /team-status /team-dashboard …)
│  ├─ UI: widget (liveAgents > snapshotCache[1500ms] > agents.json; 3 agents max)
│  │      powerbar (active | progress % | steps[workflow-static])
│  │      dashboard 6 panes (keys 1-6); planApproval: INVISIBLE (0 UI readers)
│  ├─ Broker: root-session gate only (KIND!=="subagent" && depth==0);
│  │          issues per-child heap-only socket+token
│  ├─ HeartbeatWatcher (gradient 30/60/300s → deadletter)   [parent-side only]
│  ├─ ZombieScanner (/proc: KIND=subagent + dead PARENT_PID) [parent-side only]
│  └─ session_start deferred: crash-recovery, stale-reconcile, orphan prune
│
└─ team run  state: .crew/state/runs/<id>/{manifest,tasks,events.jsonl,
              deadletter.jsonl, mailbox/, worktrees/}
             artifacts: .crew/artifacts/<id>/{results/,transcripts/,steering/,shared/}
   │
   ├─ plan gate: requirePlanApproval → manifest.planApproval{pending}
   │             → approve via TEXT cmd `team api op=approve-plan` (no UI surface)
   ├─ adaptive plan: assess JSON → phases flattened → injected tasks (cap 12)
   ├─ scheduler: task-graph + coalescing + budget drain + retries
   │   caps: sem max(2,cpus-2) × workflow hardCap 8 × spawn budget M×(retries+1)
   └─ per task → runWorker → runChildPi
        ├─ GATES (scattered): depth guard (default max 2, clamp 10 — permissive,
        │   NOT the real blocker) · role gate (read-only can't spawn) · broker root gate
        ├─ model chain: override>step>role>agent>default>parent + auto tail
        ├─ args: --mode json -p [--model M:t] [--tools/--exclude/--no-tools]
        │        --no-extensions --extension <prompt-runtime.ts>  ← NO CREW TOOLS
        │        [--no-skills --skill…] [--system-prompt 0600 file] task|@file
        └─ env: BASE_ALLOWLIST(+DEPTH) + scoped provider key
                + PI_CREW_{KIND=subagent, DEPTH+1, MAX_DEPTH, ROLE, PARENT_PID,
                  STEERING_FILE, BROKER_*, SCRATCHPAD*, ARTIFACTS_ROOT, …}
                          │ setsid+detached spawn
              ┌───────────▼──────────── CHILD pi WORKER ───────────────┐
              │ loads ONLY prompt-runtime.ts → 0 crew tools → cannot   │
              │ delegate (nesting blocked here first)                  │
              │ · steering: poll file 500ms + broker push → sendMessage│
              │ · max_tokens cap; ctx/skill strip; scratchpad (role-gated) │
              │ · stdout JSON events → parent-side heartbeat/progress  │
              │ · result text → dependency-context (untrusted fence)   │
              │ · NO self-report path; `waiting` has NO producer —     │
              │   workers cannot ask questions; final text = only out  │
              └─────────────────────────────────────────────────────────┘
```

---

## 3. Top-10 Limitations (ranked, for nesting / specs / plan objects / plan UI)

1. **No delegation seam inside workers.** `--no-extensions` + prompt-runtime-only means a subagent cannot spawn subagents (`pi-args.ts:306-331`); no CLI equivalent of the Agent tool; bash-escape bypasses depth accounting. Nesting needs an explicit child-side delegation contract, not extension absence.
2. **`waiting`/interactive-ask is dead plumbing.** Six consumer surfaces, zero producers (triple-verified). Workers cannot ask questions mid-task — the biggest half-built capability.
3. **No first-class Plan object.** Three ephemeral representations; no versioning, item↔task linkage, progress, re-plan, or diff.
4. **Plan approval invisible in every UI.** 0 `src/ui` reads of `manifest.planApproval`; approval is a text `team api` op discoverable only via event-log message (`plan-approval.ts:52-58`).
5. **No spec system.** TaskPacket static, hand-authored, never validated against outcomes; acceptance evidence is free text.
6. **Two-agent-worlds split.** `SubagentRecord` lacks `taskId` linkage → steer stub; subagent progress/budget invisible to team-run state; two overlapping delegation paths.
7. **Model fallback chain opaque and budget-multiplying.** Silent replacement surfaced only via `task.model_dropped`; unvalidated `provider/model` pass-through (`model-fallback.ts:282`) caused the known 429 cascade; auto tail × spawn budget multiplies worst-case cost.
8. **Observation parent-side only.** Heartbeats from parent observers; `PI_CREW_PARENT_PID` unread by pi binary; reactive zombie sweeping; no worker self-reporting channel.
9. **Single shared workspace by default.** Concurrent executors share cwd; worktree mode opt-in + clean-leader requirement; `serializeOnPathOverlap` off by default.
10. **UI data model has no plan/graph slice.** Task graph exists in state but renders flat; steps visualizer workflow-static; widget caps 3 agents; three cache TTLs (500/1500/100ms) risk incoherence.

---

## 4. Recommended Next Steps (sequenced)

**P0 — complete existing scaffolding (smallest risk, fastest value):**
1. **R1 · Unify agent identity:** add `taskId` linkage to `SubagentRecord`; single ownership map. *Closes ADR 2026-08-14; prerequisite for #2/#4.* AC: `steer_subagent` steers a live one-shot subagent; subagent usage appears in team status.
2. **R2 · Ship the `waiting` producer:** worker-side `ask` tool in prompt-runtime (like scratchpad) emitting `task.waiting` + mailbox question; `respond` already re-queues. AC: E2E — worker asks → run pauses → respond → resumes; crash-recovery resumes mid-question.
3. **R3 · Surface plan approval in UI:** widget badge, powerbar segment, dashboard approve/deny keys. AC: pending approval visible + approvable ≤2 keystrokes without reading the event log.

**P1 — new objects (needs ADRs first; none exist today):**
4. **R4 · First-class Plan object:** versioned schema `{id, version, revisionOf, phases[], items[{ref, taskIds[], status}]}` persisted per run; adaptive injection creates items instead of flattening; re-plan = new revision + diff. AC: revisions diffable; per-item progress queryable; approval gates reference plan id.
5. **R5 · Governed nesting v1:** write the ADR first; decide slim worker-SDK delegation tool (broker-relayed) vs depth-gated full extension; consolidate the 4 scattered gates into one spawn-permission surface; namespace artifacts/state per depth; child budget ≤ parent remaining; depth visible in UI. AC: depth-1 spawns depth-2 grandchild with namespaced artifacts, no broker creds, budget deducted; depth 3 blocked by default.
6. **R6 · Minimal spec system:** spec artifact (id + versioned requirements + acceptance criteria) referenced by TaskPacket; write-gate validator checks acceptance evidence against spec ids. Share R4's revision machinery.

**P2 — UI + transparency:**
7. **R7 · Plan/task-graph UI:** new `RunUiSnapshot` slice + `sliceSignatures.plans`; 7th dashboard pane (tree from `TaskGraphNode`, per-item progress); powerbar steps consume adaptive phases. Stay within existing cache/coalescer design.
8. **R8 · Model-routing transparency:** show resolved chain + worst-case spawn budget pre-run; loud warning on unvalidated `provider/model` pass-through; per-attempt model in transcript summaries.
9. **R9 · Worker self-reporting:** bounded worker→`PI_CREW_EVENTS_PATH` write channel for progress/liveness/questions; heartbeats become corroboration.
10. **R10 · Docs hygiene** (report-only; needs write-authorized task): `docs/commands-reference.md` lists 6 nonexistent commands & omits ~14 real ones; `skills/widget-rendering/SKILL.md` says 500ms TTL vs code 1500ms; schema docs reference phantom `plan-execute` workflow; dashboard keybinding doc predates pane keys 1-6/`V`.

---

## 5. Cross-Cutting Patterns (v2 design constraints)

- **P1 Gate scattering** — one policy enforced at ≥4 uncoordinated layers (nesting, trust); every new capability requires synchronized edits. Top structural cause of "impossible by construction" verdicts.
- **P2 Consumer-first scaffolding** — contracts/UI/events built ahead of engines (`waiting`, steer stubs, `plan-execute` docs). v2 often *completes* rather than *creates*.
- **P3 Text-artifact-as-state** — plans/analysis/knowledge flow as result text + prompt injection, not typed queryable state.
- **P4 Two parallel agent worlds** — child-process vs live-session; no cross-link.
- **P5 Parent-side-only observation** — workers are passive output streams.
- **P6 Layered caches** — 500/1500/100ms TTLs + render coalescing; each new data slice multiplies coherence cost.
- **P7 Env allowlist template** — BASE_ALLOWLIST + per-model key scoping + scrub + canary + heap-only broker tokens is reusable for nested credential passing.
- **P8 ADR discipline** — "planned, not implemented" ADRs mark exactly where v2 should resume.

## 6. Verification Evidence

- All file:line anchors captured at `fb3cad21` by shards 02–05; 06 cross-validated disputes.
- During final write (07), re-verified in source: `pi-args.ts:20` `DEFAULT_MAX_CREW_DEPTH = 2`; depth clamp [1,10] at `pi-args.ts:80-92`; `--no-extensions` + prompt-runtime-only at `pi-args.ts:306-331` incl. SEC-1 project-extension strip; `TASK_ARG_LIMIT = 8000`; `run-snapshot-cache.ts:28` `DEFAULT_TTL_MS = 1500`; no-CLI-identity-flag comment at `pi-args.ts:260-266`. All confirmed as stated.
- Negative claims (`waiting` zero producers; 0 `src/ui` planApproval readers; no `plan-execute` workflow definition; no plan/spec/nesting-UI ADRs) each verified by ≥2 independent greps by separate workers plus spot re-checks.

## 7. Risks & Caveats

- **Line-number drift:** anchors valid only at `fb3cad21`; any commit shifts them.
- **Bundle staleness:** live sessions load `dist/index.mjs` first; audit reflects `src/` — rebuild bundle before live-testing v2 changes (knowledge.md 2026-07-13 lesson).
- **Untested hole:** user-sourced agent with `extensions:[pi-crew]` loading the full extension in a worker — flagged by S2, never executed; treat as unverified.
- **Per-shard detail** remains in `results/01..05.txt`; this report condenses. Discrepancies resolved by 06: snapshot TTL 1500ms (03 correct); depth guard permissive vs nesting "blocked" (both true — blocker is tool-seam absence); `waiting` no-producer triple-confirmed.
