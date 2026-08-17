# pi-crew Subagent v2 — Implementation Plan

**Status:** v1.0 — derived from design rev 2.1 (`subagent-v2-design.md` @ `75cf294d`, CONVERGED after 3 review rounds, 30 findings closed)
**Date:** 2026-08-17 · **Base branch:** `main` @ `75cf294d` (v0.10.0+docs)
**Companion docs:** audit (`2026-08-16-subagent-v2-audit.md`, erratum header), design §12 decisions (5 opens — defaults assumed below, flagged ⚑ where user override possible)

---

## 0. Ground rules (BINDING — every WP obeys)

### 0.1 Process discipline
- **Branching:** one branch per release train: `v2/p0`, `v2/r4-plan`, `v2/r5-nesting`, `v2/r6-spec`, `v2/p2-ui`. Each merges to `main` via PR after gates. Never long-lived shared branches.
- **Gates per merge:** `npm run test:critical` (101+ must stay green, env-scrubbed) → full `npm test` (3-OS CI green on the PR HEAD commit — wait for the matrix, never merge on pending) → `npm run typecheck` → `npm run lint` + `npm run format:check` (biome).
- **Gate verification MUST use explicit exit codes** (`echo "tc=$?"`) — `| tail` swallows non-zero exits (hit 3× in v0.10.0 cycle).
- **Env hygiene before test:critical:** scrub `PI_CREW_*` (knowledge.md 2026-08-15 gotcha).
- **Bundle discipline:** after ANY merge to main that changes `src/`, run `npm run build:bundle`, commit `dist/` with `git add -f dist/`, THEN live-test. Source edits are invisible to running Pi sessions until bundle + cold-start (knowledge.md 2026-07-13 lesson).
- **ADR-first is absolute for P1:** R4/R5/R6 code PRs are REJECTED by review gate if their ADR is not merged first. R2 requires its mini-ADR merged before its code PR.
- **Load-flake protocol:** if a full-suite failure looks load-induced (broker socket/RT-NEW-2 family), re-run the single file standalone ×3 before investigating; document in commit message if confirmed flake.

### 0.2 Coding conventions
- TABS for indentation; biome format on save-equivalent; no `--no-verify`.
- New capped collections must declare cap + FIFO/evict policy (matches v0.10.0 hygiene wave).
- All new cross-process writes go through existing lock discipline: `withRunLockSync` + fresh reload inside the lock (bug-028 lesson; `respond.ts:42-43` pattern).
- Every behavior change ships with a regression test that FAILS on pre-fix code (verified via `git stash` when feasible — bug-028 standard).
- No `throw` inside `finally` (biome noUnsafeFinally — use best-effort-log pattern from `resume-cancel.test.ts`).

### 0.3 Known-pitfall register (from v0.10.0 cycle — do not repeat)
| Pitfall | Mitigation |
|---|---|
| `npm test` full suite inside a worker turn >300s kills executor | Workers run scoped suites/file paths only; leader runs full suite |
| macOS CI ENOTEMPTY teardown race | Use the retry-rmSync + best-effort-log helper pattern (`resume-cancel.test.ts` rev 8197f054) in every new test that spawns workers |
| Wrong state root when testing team-run from repo cwd | Runs live under the LAUNCHING cwd's `.crew/`; probe disk at the right root |
| phantom dead-worker alerts from stale in-memory snapshots | Expected pre-restart; verify disk manifest+deadletter, never "fix" memory by hand |
| `PI_CREW_USE_BUNDLE=0` needed for fresh-source live probes | Set at extension load time only (new Pi process) |

---

## 1. Release train

| Train | Contents | Version | Exit gate |
|---|---|---|---|
| T1 | P0: R1 + R2 + R3 | **0.11.0** | full CI matrix + real-test battery B1 (below) |
| T2 | ADR-plan + R4 | 0.12.0 | CI + B2 (plan object battery) |
| T3 | ADR-nesting + R5 | 0.13.0 | CI + B3 (nesting battery, security-weighted) |
| T4 | ADR-spec + R6 | 0.14.0 | CI + B4 (spec battery) |
| T5 | P2: R7 + R8 + R9 + R10 | 0.15.0 | CI + B5 (full 9-tier real-test re-run) |

Each train: feature branch → PR → review gate (team `review`: reviewer + security-reviewer for R5/R6, cold-verifier pass) → CI green on HEAD → merge (merge commit) → version bump + CHANGELOG + bundle commit → tag + publish.

⚑ Design §12 decisions assumed: (1) R1+R3 approved now, R2 after mini-ADR; (2) ADR order Plan→Nesting→Spec; (3) maxDepth stays 2; (4) spec gate non-strict default; (5) pane 7 behind `PI_CREW_PLAN_UI=1`. Any user override changes only the flagged items below.

---

## 2. Phase 0 — T1 (v0.11.0)

### WP-1 · R1 Unified agent identity (H6) — ADR-less, back-compat
**Goal:** one ownership map; `steer_subagent`/`crew_agent_steer` become real.
**Files (anchors at 75cf294d):**
- `src/runtime/subagent-manager.ts:28+` — `SubagentRecord` gains `taskId?: string`, `depth: number` (`runId?` exists at :31). Old records: render as today; steer returns existing "not linked" message (back-compat AC).
- `src/extension/registration/subagent-tools.ts:143-163` (Agent→`handleTeamTool(action:"run")` route) — set `taskId`/`depth` at spawn; `:364-399` — replace the two stub handlers with real resolve→append `artifacts/steering/<taskId>.jsonl` (same writer util as `team steer`; scoped to records owned by current session).
- Ownership map: new `src/state/stores/ownership-map.ts` — `task ⇄ subagentId ⇄ pid ⇄ artifacts dir`, written by both spawn paths (one-shot + team-run child executor at dispatch), read by widget/status/steer only.
**Steps:** 1) schema fields + types 2) spawn-path writers (2 call-sites) 3) ownership-map store + run-lock writes 4) real steer handlers 5) widget/status attribution reads.
**Tests (new):** `test/unit/extension/core/subagent-steer-live.test.ts` (dispatch one-shot → steer mid-run → delivered at turn boundary, mock-worker pattern from `resume-cancel.test.ts`), `ownership-map.test.ts` (back-compat: record without taskId → "not linked" message, no throw).
**ACs (from design §4):** steer live one-shot delivers at next turn boundary; `team status` attributes subagent usage to task; ADR 2026-08-14 status updated to CLOSED in its header. **Negative:** steer on unlinked record → structured message (no throw); record without new fields → status renders as today.

### WP-2 · R2 Waiting producer / `ask` (H5) — mini-ADR required first
**ADR-0 (mini):** `docs/decisions/2026-08-17-waiting-producer.md` — records: park contract (`task.waiting` + `manifest.waitState`, NO manifest.status flip), `isIntentionalWait` TTL extension (default 24h), schema additions list (`task.waiting`, `manifest.waitState`), respond write discipline, task-scoped-token requirement for `wait.*`, option-(b) mailbox self-poll rationale.
**Files:**
- `src/prompt/prompt-runtime.ts` — register `ask({question, options?, timeoutSec?=600})` tool, dormant-until-env pattern (`PI_CREW_ASK_ENABLED`, set only when broker/mailbox available — `scratchpad-lifecycle.ts:642-647` precedent). Tool loop: poll `<stateRoot>/mailbox` stream (`state/coordination/mailbox.ts:105` — run-level dir, per-task streams) every 500ms for `kind:"response", questionId`; return answer as tool result; timeout → return `"[ask timed out — continue with best judgment]"`. Scaffold mode (`executeWorkers=false`) → immediate structured notice (no hang).
- `src/runtime/broker/crew-broker.ts` — add `wait.request`/`wait.resolve` methods: auth = task-scoped (compound-key) token ONLY — `crew-broker-tokens.ts` registry gains match-kind API (compound vs bare-`runId` fallback); fallback matches REJECTED for `wait.*` with migrate-hint; enforce `to === conn.taskId` (escalate-anti-pattern ban); add `"waiting"` to `waitStatus.validStatuses` (:1003).
- `src/extension/team-tool/respond.ts` — liveness discriminator: heartbeat last-beat <60s (gradient `stale` window) or live in-memory handle ⇒ ALIVE: write mailbox response under `withRunLockSync`+fresh-reload (:42-43 pattern), leave task `waiting` (parked tool picks up, flips `waiting→running` via its terminal report). DEAD: re-queue + inject answer into next dispatch prompt (mailbox history). Exactly-one-dispatch guard.
- `src/runtime/stale-reconciler.ts:45-47` — `isPlanApprovalPending` → `isIntentionalWait` (adds `waitState.askedAt` within TTL). `:243,277-282` — waiting-with-valid-waitState NOT cancelled; TTL-expired still cancelled (leak guard).
- `src/runtime/recovery/crash-recovery.ts:117,255-259,277,311` — preserve `task.waiting` fields through restore (verify field survives; add if dropped).
- Scheduler tick — check `task.waiting.deadline` (persisted): expiry → if worker alive, surfaced as the tool's timeout result; if dead, re-queue with injected note. Both outcomes append `events.jsonl`.
**Steps:** 1) ADR-0 merge 2) schema fields + types (+types tests) 3) token match-kind API + broker methods 4) prompt-runtime ask tool 5) park writes (broker handler → task+manifest under run lock) 6) respond discriminator + dual path 7) reconciler/crash-recovery changes 8) scheduler deadline check.
**Tests (new):** `wait-request-broker.test.ts` (auth: compound token ✓ / legacy fallback ✗ / cross-task `to` ✗), `ask-tool-lifecycle.test.ts` (mock worker asks → parked; respond live → same process resumes — assert pid unchanged; timeout; scaffold no-hang), `stale-reconciler-waiting.test.ts` (valid waitState protected; TTL-expired cancelled), `respond-discriminator.test.ts` (alive→mailbox path, dead→requeue+inject; NEVER both — double-dispatch negative AC).
**ACs (design §3):** ask → `waitState` present, manifest stays `running`, run stays registered/visible; respond answers → SAME worker process receives answer as tool result; kill -9 mid-question → next session_start does NOT cancel (within TTL) → respond → exactly one dispatch; timeout in-tool; scaffold no-hang.

### WP-3 · R3 Approval surfaces in existing UI (H4-subset) — ADR-less
**Goal:** `manifest.planApproval` pending visible + decidable ≤2 keystrokes (today: 0 readers in `src/ui`).
**Files:**
- `src/ui/widget/widget-renderer.ts` — pending badge `⚠ plan:RUNID` (fits 3-agent/8-line budget; badge line replaces spinner while parked-on-approval).
- `src/ui/run-dashboard.ts` + `dashboard-panes/progress-pane.ts:8-38` — approval banner + keys `A`pprove/`D`eny (extend `keybinding-map.ts:63-70`); dispatches existing text ops (`team api op=approve-plan|cancel-plan` — `extension/team-tool/api/plan-approval.ts` — NO new backend needed).
- `src/ui/powerbar-publisher.ts` — segment shows `plan:pending` while `planApproval.status==="pending"`.
**Steps:** 1) read `manifest.planApproval` in run-snapshot assembly (add to existing slice — NOT a new slice) 2) widget badge 3) dashboard banner+keys 4) powerbar segment.
**Tests (new):** `ui-approval-surfaces.test.ts` (renderer given pending manifest → badge/banner present; `A` key invokes approve path (mock ctx); approved → banner clears).
**ACs:** pending visible in widget+dashboard; approve/deny ≤2 keystrokes without event-log reading; existing panes regress-zero (all current UI tests stay green).

### T1 exit — real-test battery B1 (run `real-test-pi-crew` skill, full 9 tiers + extras)
Extra cases beyond the standard tiers: (a) live ask→respond E2E in 2-session tmux (session-2 spawns long task whose worker calls ask; session-1 responds; assert same-pid resume); (b) crash-recovery ask restore (kill -9 session-2 parent mid-question; restart; stale-reconciler keeps waiting; respond → single dispatch); (c) steer_subagent live on one-shot; (d) approval A/D keys live; (e) legacy-token `wait.*` rejection message. Report to `docs/real-test/reports/real-test-<date>-v0.11.0.md`, honest NOT-run section mandatory.

---

## 3. Phase 1 — T2/T3/T4 (ADR-first, one object per train)

### ADR-4 + WP-4 · R4 Plan object (H3) → v0.12.0
**ADR-4:** `docs/decisions/2026-08-17-plan-object.md` — schema (PlanRecord §5), migration policy (dual-read, manifest field never dropped), single-writer rule (scheduler maintains `items[].taskIds` inside run lock), re-plan semantics (new revision + soft-cancel dropped-item tasks via wrap-up steer grace `child-pi/child-pi-steering.ts:25-75`), per-phase cap replacing adaptive cap-12.
**Files:**
- NEW `src/state/stores/plan-store.ts` — `state/runs/<id>/plans/plans.json`, atomic write, run-locked, revision list; migration dual-read helper (manifest fallback).
- `src/state/types.ts` — PlanRecord types (+ manifest pointer preserved `:230`).
- `src/runtime/goal-workflow/adaptive-plan.ts:43` — assess → phases/items (cap moves per-phase; injection creates items, scheduler expands item→tasks).
- `src/extension/plan-orchestrate.ts:14-77` — tagged-chain parse → PlanRecord producer.
- `src/runtime/plan-approval.ts:26-66` + `extension/team-tool/api/plan-approval.ts` — dual-read migration; approval writes both (manifest pointer + plan record `approval{planVersion}`).
- `src/runtime/team-runner.ts:808,1055` + `stale-reconciler.ts:46` — reader migration (plan-record-first, manifest-fallback; invariant preserved).
- NEW `src/extension/team-tool/plan.ts` — `team action='plan'`: `get [--rev]` / `list` / `diff a b` / `approve|reject`.
**Steps:** 1) ADR-4 merge 2) types + store (+ migration helper) 3) three producers 4) reader migration (5 sites, verified in review round 1) 5) scheduler linkage + re-plan soft-cancel 6) `team plan` action + schema registration 7) deprecation notes.
**Tests (new):** `plan-store.test.ts` (revision append, atomicity, lock), `plan-producers.test.ts` (orchestrate parse → items; adaptive phases; planner tagged contract), `plan-migration.test.ts` (**negative AC: pre-v2 run with planApproval pending stays protected post-upgrade**), `plan-diff.test.ts`, `plan-action.test.ts` (get/list/diff/approve + auth), integration: re-plan mid-run drops item → in-flight task soft-cancelled.
**ACs (design §5):** revision diff queryable; per-item progress = derived linked task statuses; approval references plan id+version; adaptive runs keep working via items; migration negative AC.

### ADR-5 + WP-5 · R5 Governed nesting (H1) → v0.13.0 — security-weighted review
**ADR-5:** `docs/decisions/2026-08-17-governed-nesting.md` — pins (design §7 + NEW-6): (i) grandchild spawn = direct `runChildPi` call-site bypassing global sem (`cap:false` MAJ#3 precedent, `scheduling/global-worker-cap.ts:14-19`) + separate nested-slot budget `max(1, floor(globalSem/2))`, fail-fast never queue; (ii) issuer depth gate ≤1 (`registration/lifecycle-handlers.ts:1024-1036` call-site); (iii) task-scoped tokens mandatory for `delegate`; (iv) schema additions `task.depth`, `allocation{}`; (v) workspace: serialize-on-overlap default for executor-class delegate; (vi) alternative (full extension in child) rejected + revisit conditions.
**Files:**
- NEW `src/runtime/spawn-policy.ts` — THE single gate: depth (`depthOverride` from parent task record, never env/self-report — fixes P0-2), role (executor-class only), nested-budget slots, parent-allocation sufficiency, model catalog validation (kills `model-fallback.ts:282` passthrough on this surface), trust. Fail-fast policy messages, all logged `events.jsonl`.
- `src/runtime/child-pi/child-pi.ts` — spawn seam for depthOverride env (`PI_CREW_DEPTH` explicit; existing env guard stays as bash-escape backstop :253-257); issuer call-site depth gate (:277-285).
- NEW nested-slot semaphore `src/runtime/scheduling/nested-slots.ts` (cap + fail-fast acquire, NO queue).
- `src/prompt/prompt-runtime.ts` — `delegate({description, prompt, role?, model?, maxTurns?, budgetTokens?, timeoutSec?=900})` tool (executor-class gated): broker `delegate` request → immediate `{grandchildTaskRef}`; then option-(b) self-poll of parent-task mailbox stream for fenced result; timeout → in-tool notice.
- `src/runtime/broker/crew-broker.ts` — `delegate` method: compound-token auth + `to === conn.taskId`; handler = root-side spawner (namespaced artifacts `artifacts/<runId>/<parentTaskId>/nested/<subId>/`), heartbeat observer + deadletter registration for grandchild (dead reason `delegate-timeout`), budget reserve + roll-up.
- `src/state/types.ts` — `task.depth`, `task.allocation{tokensGranted, tokensSpent}` (NEW fields, ADR-listed).
- `src/runtime/budget-enforcement.ts` — reads per-task allocation (aggregate detector unchanged); roll-up writer single-owner under run lock.
- `src/runtime/model/pi-args.ts:306-331` — depth>0 extension ALLOWLIST (only `PROMPT_RUNTIME_EXTENSION_PATH`, all sources — closes SEC-1 hole per P1-10).
**Steps:** 1) ADR-5 merge 2) spawn-policy + nested-slots (+ unit tests incl. deadlock negative: 4-core box, 2 concurrent delegates complete; budget exhausted → immediate reject, never queue) 3) depthOverride + issuer gate 4) broker delegate + grandchild lifecycle 5) allocation accounting + roll-up 6) prompt-runtime tool 7) extension allowlist 8) serialize-on-overlap wiring.
**Tests (new):** `spawn-policy.test.ts` (each gate dimension × fail-fast message; depth-3 blocked default; maxDepth config raise → depth-3 works), `nested-slots-deadlock.test.ts` (2 delegates on sem-2 box complete; exhaustion rejects immediately), `delegate-broker.test.ts` (auth matrix incl. legacy-token ✗ cross-task `to` ✗), `delegate-e2e.test.ts` (depth-1 delegates → depth-2 grandchild: namespaced artifacts, budget deducted+visible in parent task usage, **no `PI_CREW_BROKER_*` in grandchild env**, heartbeat+deadletter registered), `model-validation.test.ts` (invalid `provider/model` rejected at admission), socket-close resilience (kill broker socket mid-grandchild → parent still gets result via durable mailbox).
**ACs (design §7):** all of the above + read-only roles' delegate rejected + timeout soft-cancel. **Security gate:** WP-5 PR requires security-reviewer sign-off (team `review` with security role) + cold-verifier.

### ADR-6 + WP-6 · R6 Spec system (H2) → v0.14.0
**ADR-6:** `docs/decisions/2026-08-17-spec-system.md` — SpecRecord/Snapshot schema (design §6), strict-mode policy (⚑ non-strict default, opt-in per workflow), **sandbox parameters** (concrete values: env = BASE_ALLOWLIST-minus-credentials; cwd = run workspace root; `ulimit -v 262144` KB + `ulimit -t 30`s; wall-clock 60s SIGKILL escalation; `unshare -n` Linux/best-effort macOS; digest file per run), `idempotent` flag semantics, reject-start rule, revision machinery shared with PlanRecord.
**Files:**
- NEW `src/state/stores/spec-store.ts` — workspace-level `state/specs/<id>.json` + SpecSnapshot freeze at dispatch.
- `src/state/types.ts:59-76` — TaskPacket gains `specRefs[]` (+ snapshot embed).
- NEW `src/runtime/task-runner/spec-evidence.ts` — footer parser (mechanical must-coverage) + strict-mode machine-check executor (hardened subprocess per ADR-6).
- `src/runtime/task-runner/post-execution.ts:289+` — write-gate hook: non-strict → coverage-check + `unverified` badge on missing/fabricated; strict → machine-check digests; reject-start when strict workflow lacks verifier task.
- `src/runtime/task-runner/prompt-builder.ts` — SPEC contract section in executor prompt (footer format, ids from snapshot).
- Verifier role receives SpecSnapshot + evidence footer (read-only posture; advisory signal).
- Skills: `requirements-to-task-packet` upgraded to author SpecRecord+TaskPacket pair (postinstall copy refresh).
**Steps:** 1) ADR-6 merge 2) store + freeze 3) footer parser + write-gate wiring (non-strict first) 4) strict executor + sandbox 5) prompt contract 6) verifier wiring 7) skill upgrade.
**Tests (new):** `spec-store.test.ts`, `spec-footer-parser.test.ts` (valid/missing/unknown-id/fabricated), `spec-strict-sandbox.test.ts` (network-blocked command fails closed; timeout kills; env has NO provider keys — assert via /proc or captured env; digest mismatch fails), **negative ACs:** non-idempotent must in strict mode → falls back coverage-only+`unverified`; spec-less tasks unaffected (regression guard: full critical suite green).
**ACs (design §6):** strict task cannot pass write-gate without must-coverage machine-checked evidence; fabricated evidence fails digest; verifier sees frozen snapshot ids; warn-only default (⚑).

---

## 4. Phase 2 — T5 (v0.15.0)

### WP-7 · R7 Plan UI (H4) — flag `PI_CREW_PLAN_UI=1` ⚑
**Files:** `src/ui/run-snapshot-cache.ts:28,650+` — new slice `plans` + `sliceSignatures.plans` (inside existing cache+coalescer; NO new cache layer); `src/ui/run-dashboard.ts` — pane 7 "Plan" (tree phase→item→tasks w/ status + depth badge; `A`/`D` when pending; `V` diff multi-revision); `src/ui/powerbar-publisher.ts:137-178` — steps consume plan phases (fallback workflow steps); `keybinding-map.ts` — pane key + `V`.
**Tests:** `plan-ui-slice.test.ts` (signature changes on plan write; TTL within existing budget), `pane7-render.test.ts` (tree from TaskGraphNode + PlanRecord; approval keys; diff view), widget degrade (**negative AC:** >3 agents → summary line, no data loss), flag-off → zero new renders.
### WP-8 · R8 Model-routing transparency
Pre-run summary: resolved chain + worst-case spawn budget (`attemptModels × (maxAttempts+1)` — `child-executor.ts:150-151`); loud warning on unvalidated `provider/model` passthrough (`model-fallback.ts:282`) for all NON-delegate surfaces (delegate surface already gated in WP-5); per-attempt model in transcript summaries. Tests: `model-budget-summary.test.ts`, warning emission on passthrough.
### WP-9 · R9 Worker self-reporting
Bounded worker→`PI_CREW_EVENTS_PATH` append channel (rate-limited, schema-tagged `worker.*` events); heartbeats stay corroboration. FIFO cap on channel buffer. Tests: `worker-events-channel.test.ts` (cap, rate-limit, crash mid-append → recoverable trailing partial line).
### WP-10 · R10 Docs hygiene
`docs/commands-reference.md` phantom-list fix (6 nonexistent commands removed, ~14 real added); `skills/widget-rendering/SKILL.md` TTL 500→1500ms; phantom `plan-execute` workflow refs resolved (either implement thin alias workflow or remove from docs — **implement alias**, one file, since schema docs reference it); dashboard keybinding doc update post-WP-7.

---

## 5. Test matrix (summary)

| Level | Scope | Gate |
|---|---|---|
| Unit (new files above) | per-WP list | every PR |
| `test:critical` | 101+ growing | every PR (env-scrubbed) |
| Full suite | 6700+ growing | CI 3-OS on PR HEAD |
| Integration (new) | `delegate-e2e`, `ask-tool-lifecycle`, plan re-plan mid-run | T1/T2/T3 PRs |
| Real-test battery | B1..B5 per train (9-tier skill + extras §2/§3) | train exit |
| Security review | WP-5, WP-6 (+ WP-2 token surface) | PR merge gate |
| Cold-verifier | every train (independent re-check, no chained trust) | train exit |

## 6. Risk register & rollback

| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| R2 park semantics regress scheduler | med | isIntentionalWait is additive; TTL leak-guard; negative tests | revert WP-2 commits; manifest fields ignored by old code |
| R5 deadlock recurrence | med | nested-slots fail-fast (no queue) + deadlock test; MAJ#3 precedent | spawn-policy `enabled:false` config kill-switch |
| Broker method abuse | low | compound-token auth + `to===conn.taskId` + security review | method allowlist flag off |
| Plan migration breaks old runs | low | dual-read + never-dropped field + negative AC | readers fall back to manifest (default path unchanged) |
| Strict sandbox escapes | low | env-strip + cwd-pin + ulimit + no-network + idempotent flag | strict stays opt-in; disable per workflow |
| UI slice coherence cost | low | one slice, existing coalescer, flag ⚑ | `PI_CREW_PLAN_UI=0` |
| Bundle staleness confusion | certain-if-forgotten | §0.1 bundle discipline + B-batteries run on rebuilt bundle | n/a |
| Train slips | med | trains are independent (R4→R5 edge is the only hard dep); P2 items re-orderable freely | re-sequence |

## 7. Task-packet convention for team delegation
Each WP = 1+ team runs (`team action='run'`, team `implementation` or `fast-fix`): packet = this WP section verbatim + files-owned list + "report intended changed files BEFORE editing" + overlap→pause rule. **File ownership map:** WP-1 owns `subagent-manager.ts`, `registration/subagent-tools.ts`, ownership-map store; WP-2 owns `prompt-runtime.ts`, `crew-broker.ts` (method registry section), `respond.ts`, `stale-reconciler.ts`, `crash-recovery.ts`, scheduler-tick; WP-3 owns `src/ui/*` (renderer/powerbar/dashboard/keybinding); WP-4 owns plan-store/types/adaptive/plan-orchestrate/plan-approval/api; WP-5 owns spawn-policy/nested-slots/child-pi seam/broker delegate handler/pi-args allowlist/budget; WP-6 owns spec-store/post-execution/prompt-builder spec section. Cross-WP shared files (`types.ts`, `crew-broker.ts`) — ONE WP per train touches them (trains sequential; no parallel WP within a file).

## 8. Definition of Done (per train)
1. All WP ACs (+ negatives) demonstrated by test evidence linked in PR.
2. CI 3-OS green on merge-commit HEAD (not just branch HEAD).
3. Real-test battery Bx report committed, honest NOT-run section.
4. ADR(s) merged before code PRs (P1 trains).
5. CHANGELOG + version bump + bundle rebuilt & committed.
6. Cold-verifier pass recorded.
7. Knowledge.md updated with durable lessons.
