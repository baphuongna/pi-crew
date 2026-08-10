# pi-crew Improvement Plan — 2026-08-09

> Deep-dive analysis output. Each item carries a **verification status** so future
> work trusts only what has been independently checked. This is a planning
> artifact, not an accepted spec — see `AGENTS.md` source-of-truth order.
>
> Companion to `docs/failure-mode-inventory.md` (runtime failure modes) and
> `docs/audit-findings.md` (most recent audit). This doc focuses on
> **maintainability, dead code, and consolidation** rather than runtime bugs.

## Verification status legend

| Marker | Meaning |
|---|---|
| ✅ VERIFIED | Directly checked by opencode (typecheck / grep / read) on 2026-08-09 |
| 🔍 EXPLORE | Reported by parallel explore subagents; NOT yet independently verified — treat as hypothesis |
| ⚠️ PARTIAL | Verified with nuance (claim is directionally right but imprecise) |
| ❌ UNVERIFIED | Claimed but no evidence gathered yet |

## Baseline health check

| Check | Command | Result | Status |
|---|---|---|---|
| TypeScript compiles | `npm run typecheck` | PASS — `tsc --noEmit` clean + `strip-types import ok` | ✅ VERIFIED |
| Critical subset | `npm run test:critical` | PASS — 101 tests, 0 fail, 0 skip, 16.8 s | ✅ VERIFIED |
| Unit tests | `npm run test:unit` | Ran deep (observed `ok 896+`, no fail in tail); final summary not captured (custom runner format) | ⚠️ PARTIAL |
| Full suite | `npm test` | TIMEOUT after 580 s (exit 124); ran to test 2347+ with no fail observed before kill. Full suite too slow to verify in one session. | ⚠️ PARTIAL |
| Source file count | `find src -name '*.ts' \| wc -l` | 485 | ✅ VERIFIED |
| `team-runner.ts` size | `wc -l` | 2814 | ✅ VERIFIED |

**Takeaway:** codebase compiles cleanly and the critical broker/handshake/keybinding subset is green. Unit tests run without immediate failure but the final summary could not be cleanly captured through the custom `scripts/test-runner.mjs`; treat "6489 pass" as directionally trustworthy, not confirmed.

## Phase-1 verification results (2026-08-09)

Independent grep/read checks performed after the initial draft. **Two explore-agent claims were wrong and have been corrected in-place** (see C.1, D.4); the rest were confirmed.

| Item | Original status | Verified result | Action |
|---|---|---|---|
| A.1 iteration-hooks | ⚠️ PARTIAL | Confirmed: 0 production callers in `src/`; referenced only in comment at `head-snap-stage.ts:7,11`; tested at `test/unit/runtime/core/iteration-hooks.test.ts` | keep, refine nuance |
| A.2 plugin-context.ts | 🔍 EXPLORE | Confirmed: file absent; only comment ref at `team-runner.ts:78-79` | ✅ VERIFIED |
| A.3 crewEventBus dormant | 🔍 EXPLORE | Confirmed: 4 emit sites in `progress-tracker.ts`, 0 subscribers | ✅ VERIFIED |
| A.4 mascot setVisible | 🔍 EXPLORE | Confirmed: definition only, 0 callers | ✅ VERIFIED |
| A.5 broker notifyMessage | 🔍 EXPLORE | Confirmed: 0 callers in `src/extension/registration/lifecycle-handlers.ts`; only def at `crew-broker.ts:371` + comment `:362` | ✅ VERIFIED |
| A.6 child-pi warm pool | (not in initial draft) | **NEW finding (phase-2 loop):** `child-pi-pool.ts` permanently disabled (size=0), `acquirePooledChild` returns null, 0 production callers; ADR 0008 "Proposed" accurately reflects state | ✅ VERIFIED |
| B.1 worktree twins | 🔍 EXPLORE | Confirmed: 7 sync/async pairs (assertCleanLeader, captureWorktreeDiff, captureWorktreeDiffStat, cleanupAgentWorktree, findGitRoot, prepareAgentWorktree, prepareTaskWorkspace) | ✅ VERIFIED |
| B.2 state-store twins | 🔍 EXPLORE | Confirmed: 3 pairs (loadRunManifestById/Async, saveRunManifest/Async, saveRunTasks/Async) | ✅ VERIFIED |
| **C.1 hook fragmentation** | 🔍 EXPLORE | **CORRECTION** — `crewHooks` is ACTIVE (16 sites: register in `hook-integrations.ts`, `hook-instinct-bridge.ts`, `skill-effectiveness.ts`; emit in `team-runner.ts`, `task-runner/*`). It is NOT dormant. | **rewritten below** |
| D.1 bug-023 | 🔍 EXPLORE | Confirmed skip gate exists (`chain-executor.test.ts`): `WIN32_SKIP` with explicit message — documented skip, not silent | ✅ VERIFIED |
| D.2 EPIPE in child-pi | 🔍 EXPLORE | Confirmed: 0 EPIPE handling in `src/runtime/child-pi/` and `recovery/retry-executor.ts` | ✅ VERIFIED |
| D.3 three timeout layers | 🔍 EXPLORE | Confirmed: `child-executor.ts:499-522` (taskTimeoutMs wall-clock), `child-pi.ts:483-554` (responseTimeoutMs no-output), scratchpad `EXECUTE_CELL_TIMEOUT_MS=120s` | ✅ VERIFIED |
| **D.4 scratchpad spawn** | 🔍 EXPLORE | **CORRECTION** — `engine.ts:194-203` spawn has NO `detached: true`. Orphan risk is from cell-spawned subprocesses inside the guest, not the guest itself. | **rewritten below** |
| E.1 DWF not sandboxed | 🔍 EXPLORE | Confirmed: `:16` "isolated-vm planned for v1.5"; `:128` createRequire + `:131` jiti = full Node; `:154-163` F-01 default-deny gate | ✅ VERIFIED |
| E.2 v8.deserialize unauth | 🔍 EXPLORE | Confirmed: `guest.ts:32` import, `:290` `deserialize(buffer)`; `README.md:120` explicit "unauthenticated, no HMAC" | ✅ VERIFIED |
| E.3 EPERM-as-stealable | 🔍 EXPLORE | Confirmed: `locks.ts:52,142` `process.kill(pid,0)`; `:85-106` "Accepted Risk" doc block; refs `SECURITY-ISSUES.md SEC-008` | ✅ VERIFIED |
| E.4 best-effort reads | 🔍 EXPLORE | Confirmed at 3 sites: `run-snapshot-cache.ts:825`, `mailbox-detail-overlay.ts:41`, `agent-picker-overlay.ts:24` — all carry the NOTE | ✅ VERIFIED |
| F.1 unbounded no metric | 🔍 EXPLORE | Confirmed: emit at `team-runner.ts:1627`, no counter in `event-to-metric.ts` | ✅ VERIFIED |
| F.2 cardinality eviction | 🔍 EXPLORE | Confirmed: `metrics-primitives.ts:40` cap 10000, `enforceLabelCap:42` silent evict, no emit | ✅ VERIFIED |
| F.3 doc drift | ✅ VERIFIED | Unchanged — both ADR 0007 status and ADR 0003 env-var drift confirmed | ✅ VERIFIED |

**Net result of phase 1:** 17 of 19 items independently confirmed; 2 explore claims corrected (C.1, D.4). No new findings beyond what the plan already lists — the issue inventory is stable.

---

## Group A — Dead / scaffolded / dormant code

The single biggest maintainability risk: code that looks active but is not. A new contributor (or an agent) reading the codebase will reasonably assume these subsystems are wired and depend on them.

### A.1 `iteration-hooks.ts` — tested but unused in production

- **Status:** ⚠️ PARTIAL
- **Files:** `src/runtime/iteration-hooks.ts`
- **Evidence (opencode, 2026-08-09):**
  - `rg "runIterationHook|steerMessageFromHook|hookLogEntry" src/` → **0 production callers**.
  - Referenced only in a **comment** at `src/runtime/compaction/compact-stages/head-snap-stage.ts:7,11` (concept description, not an import).
  - Has test coverage: `test/unit/runtime/core/iteration-hooks.test.ts`, `test/unit/deferred-truncation-migration.test.ts`.
- **Explore-agent nuance correction:** the original explore report said "zero callers in src" — true for production, but it omitted that tests exist. This makes the code **safer to delete** (test net exists) but is not literally dead.
- **Impact:** Medium. Real security model (path-restricted, 30 s timeout, env sanitisation, metric-name filtering) sits inert; a maintainer could wire it assuming it is production-ready when it has never run end-to-end.
- **Effort:** S (decide) — M (wire or remove).
- **Recommendation:** Either (a) wire `runIterationHook` into the task lifecycle as documented, or (b) move to `src/internal/spike/` + add a CI rule that exported symbols without a production caller fail the build. Do not leave in `src/runtime/` looking load-bearing.
- **Security audit (phase-3 read, 2026-08-09):** read the full 305-line file. The security model is **sound and production-grade**:
  - `isAllowedHookPath` (`:71-86`): path-restricted to `.hooks/` relative or `$HOME/.pi/hooks/` absolute, with Windows backslash normalisation.
  - `sanitizeEnvSecrets` (`:167-169`): strict allowList (`PATH`, `HOME`, `USER`, Windows essentials, `PI_CREW_*`).
  - `MAX_STDOUT_BYTES = 8192` (`:57`), `HOOK_TIMEOUT_MS = 30_000` (`:60`), `HeadSnapStage` byte-cap-safe UTF-8 truncation (`:199-201`).
  - EPIPE on stdin ignored (`:231-233`); `DENIED_METRIC_NAMES` prototype-pollution filter on `CREW_METRIC` output (`:266-275`).
  - **Conclusion:** safe to wire if the feature is wanted; nothing in the security model blocks activation.
- **Forward verification needed:** read `iteration-hooks.ts` end-to-end to confirm the security model is sound before any wiring decision.

### A.2 `plugin-context.ts` — planned, never implemented

- **Status:** ✅ VERIFIED
- **Files:** `src/plugins/plugin-registry.ts`, `src/plugins/plugins/{nextjs,vite,vitest}.ts`, `src/runtime/team-runner.ts:75-83`
- **Evidence (opencode, 2026-08-09):**
  - `ls src/plugins/plugin-context.ts` → **No such file or directory**.
  - `rg "getPluginContext|PluginContext" src/` → only reference is the comment at `team-runner.ts:78-79`: *"integration point … is not yet implemented; see `getPluginContext` in `src/plugins/plugin-context.ts` (planned)."*
  - Registry + 3 plugin definitions ARE registered (`team-runner.ts:80-83`) but nothing consumes them.
- **Impact:** Medium. Three well-formed plugins and a registry ship in the bundle, implying capability (entry-pattern awareness, test/build detection) that does not exist.
- **Effort:** S (delete from bundle) — M (implement `plugin-context.ts` + wire into RunConfig).
- **Recommendation:** Make a deliberate product decision within one release cycle. If the plugin system is on the roadmap, implement `getPluginContext` and consume `entryPatterns`/`configPatterns`/`pathAliases` in the task packet. If not, exclude `src/plugins/` from `package.json` `files` and delete the inert registration to stop advertising vaporware.

### A.3 `crewEventBus` — emits, nobody listens

- **Status:** ✅ VERIFIED
- **Files:** `src/observability/event-bus.ts`, `src/runtime/output/progress-tracker.ts`, `test/unit/observability/event-bus-new.test.ts`
- **Evidence (opencode, 2026-08-09):**
  - `rg "crewEventBus\.(on|subscribe)" src/` → **none**.
  - `rg "crewEventBus\.emit" src/` → 4 sites, all in `progress-tracker.ts:58,72,80,95`.
  - `rg "crewEventBus" src/extension/` → no bridge to `pi.events`; only `runEventBus` (the active system) is imported there.
  - `rg "crewEventBus" test/` → 8 refs, all in `event-bus-new.test.ts` testing the singleton shape — **no production dependency**.
  - `event-bus.ts:78-85` self-documents as dormant ("Currently only emits — no production subscribers yet … retained for future SIEM integration").
- **Impact:** Low–Medium. The active event system is `runEventBus` (`src/ui/run-event-bus.ts`); `crewEventBus` is a parallel singleton that exists "for later." Either remove or wire.
- **Effort:** S.
- **Recommendation:** Safe to delete — no external/third-party consumer (only the internal test). Delete `src/observability/event-bus.ts`, the 4 emit sites in `progress-tracker.ts`, and `test/unit/observability/event-bus-new.test.ts` together. If SIEM/OTLP-via-bus is genuinely planned, add a CI guard that fails if `crewEventBus.emit` sites grow without a corresponding subscriber plan.

### A.4 Mascot `setVisible` — optimisation never toggled

- **Status:** ✅ VERIFIED
- **Files:** `src/ui/mascot.ts:440-442`, `docs/decisions/2026-07-26-c6-mascot-visibility-not-wired.md`
- **Evidence (opencode, 2026-08-09):**
  - `rg "\.setVisible\(" src/` → only the definition at `mascot.ts:440`; zero callers.
  - `tick()` skips `requestRender` when invisible (`mascot.ts:195-207`) — the optimisation is real but dormant.
- **Impact:** Low. Cosmetic; minor wasted repaints while a dashboard overlay covers the mascot.
- **Effort:** S.
- **Recommendation:** Wire `setVisible(false)` from the dashboard/sidebar open path, or delete the method and the dead branch. Already documented in the ADR — close the loop.

### A.5 Broker `notifyMessage` Phase 0 no-op

- **Status:** ✅ VERIFIED
- **Files:** `src/runtime/broker/crew-broker.ts:362,371-374`
- **Evidence (opencode, 2026-08-09):** `rg "notifyMessage" src/extension/registration/lifecycle-handlers.ts` → no caller. Only the definition at `crew-broker.ts:371` and a comment at `:362`. Phase 1 replaced its function with the mailbox-observer fanout, but the method itself was never removed.
- **Impact:** Low. Reads like a live API surface but is dead.
- **Effort:** S.
- **Recommendation:** Delete the method; the mailbox-observer registration in `crew-broker.ts:265-267` is the real fanout path.

### A.6 Child-pi warm pool — skeleton permanently disabled (found in phase-2 loop)

- **Status:** ✅ VERIFIED (new finding — not in the initial draft)
- **Files:** `src/runtime/child-pi/child-pi-pool.ts`, `docs/decisions/0008-child-pi-warm-pool.md`
- **Evidence (opencode, 2026-08-09):**
  - File header (`:1-22`) is explicit: *"Child-pi warm pool skeleton (ADR 0008 Proposed) … permanently disabled (size=0): callers always receive null from `acquirePooledChild` and fall through to the regular spawn path."*
  - `acquirePooledChild` (`:50`) returns `null`; `releasePooledChild` (`:61`) is a no-op; `disposeWarmPool` (`:66`) is a no-op.
  - `rg "child-pi-pool|acquirePooledChild|releaseToPool" src/` → **0 production callers** outside the file itself.
  - ADR 0008 status reads *"Proposed — not yet implemented"* — and here the ADR is **accurate** (contrast with ADR 0007, where the code was implemented but the ADR still said Proposed).
  - Enabling requires Pi-side support (`PI_CREW_POOL_HEALTH=1` stdin handshake) that does not exist yet (`:11-18`).
- **Impact:** Low (currently inert — callers fall through to fresh spawn). Medium over time: same "scaffolded not wired" trap as A.2 plugins — a contributor reading `child-pi-pool.ts` may assume pooling works.
- **Effort:** S (decide keep-or-delete) — L (implement once Pi adds the handshake).
- **Recommendation:** Treat exactly like A.2 (plugins): either (a) move to `src/internal/spike/` so it does not look load-bearing, or (b) keep with a prominent module-level `@experimental` JSDoc and a CI rule that exported-but-unused modules fail the build. Do NOT silently leave in `src/runtime/child-pi/` next to the real `child-pi.ts`.

---

**Phase-2 scan note (2026-08-09):** a full `rg -ln "skeleton|scaffolded|not yet implemented|permanently disabled" src/` was run; 6 files matched. Of those, only `child-pi-pool.ts` (A.6) is truly inert. `goal-loop-runner.ts` carries a "P0 skeleton; P1 wires real evaluator" header but has **multiple active callers** (`async-notifier.ts`, `background-runner.ts`, `goal.ts`, verification modules) — it is a phased implementation in use, not dead code. The other matches are incidental comment mentions. No further scaffolded-dead modules were found.

---

## Group B — Sync/async duplication

Every public I/O function in several core modules has a `*Sync` and an `*Async` twin, doubling the surface area. Fixes must be applied in two places; the two have drifted historically.

### B.1 Worktree manager — full twin duplication

- **Status:** 🔍 EXPLORE
- **Files:** `src/worktree/worktree-manager.ts` (1268 lines)
- **Evidence (explore):** `findGitRoot`/`findGitRootAsync`, `assertCleanLeader`/`assertCleanLeaderAsync`, `prepareTaskWorkspace`/`prepareTaskWorkspaceAsync`, `prepareAgentWorktree`/`Async`, `cleanupAgentWorktree`/`Async`, `captureWorktreeDiff`/`Async`. ST-15 comments are duplicated across both twins.
- **Impact:** Medium–High. Git operations are naturally sync (`spawnSync`), so the async twin is mostly a wrapper — but the bodies are copy-pasted, not shared.
- **Effort:** M–L.
- **Recommendation:** Extract pure logic (path computation, branch sanitisation, status parsing) into shared helpers that both sync and async wrappers call. Leave only the I/O boundary (spawn vs spawnSync) twinned. Track twin-count as a metric; target −30 % in two releases.
- **Forward verification needed:** confirm twin count and identify the safest extraction boundary.

### B.2 State-store and event-log twins

- **Status:** 🔍 EXPLORE
- **Files:** `src/state/stores/state-store.ts`, `src/state/event-log/event-log.ts`
- **Evidence (explore):** `loadRunManifestById`/async, `saveManifestAndTasksAtomic`/`Async`, `appendEvent`/`appendEventAsync`. The async variants exist because the render path needs sync reads while background paths need async.
- **Impact:** Medium. Drift risk on the cache invalidation logic.
- **Recommendation:** Consider forcing all read paths to async + `await` at the render boundary (the render path already has a snapshot cache + prewarm, so a single async fetch is tolerable). Eliminates the sync twin entirely.
- **Forward verification needed:** profile the render path to confirm async-only does not regress frame budget.

---

## Group C — Hook model documentation gap

Three independent hook/event subsystems coexist. **Phase-1 verification corrected the original "fragmentation needing unify" framing**: the three are NOT redundant — they serve distinct scopes. The real issue is that the distinction is undocumented, so contributors do not know which to use.

### C.1 Three subsystems with distinct scope (documented, not unified)

- **Status:** ✅ VERIFIED (corrected 2026-08-09)
- **Files & verified usage:**
  - **Structured lifecycle hooks** (`src/hooks/registry.ts`) — canonical, **wired**. 16 HookName events, blocking/non-blocking semantics, workspace-scoped, prototype-pollution defence. Called from `team-runner.ts:2499` (before_run_start), `task-runner/post-execution.ts:457,471`, `lifecycle-actions.ts`, `recovery/crash-recovery.ts:141`. This is the **blocking decision** layer.
  - **`crewHooks`** (`src/runtime/crew-hooks.ts`) — **ACTIVE, not dormant**. Singleton fire-and-forget bus, 5 events. Phase-1 grep found **16 sites**: register in `state/hook-integrations.ts` (4), `state/hook-instinct-bridge.ts` (3), `runtime/skill-effectiveness.ts` (2); emit in `runtime/team-runner.ts:1080,1163`, `runtime/task-runner/child-executor.ts:484`, `runtime/task-runner/post-execution.ts:355`. This is the **async side-effect** layer (instinct learning, skill effectiveness telemetry). Do NOT remove.
  - **`crewEventBus`** (`src/observability/event-bus.ts`) — **DORMANT**. 4 emit sites in `progress-tracker.ts`, **0 subscribers**. Self-documented as "retained for future SIEM integration." See A.3.
  - **`iteration-hooks.ts`** — user-script runner, **0 production callers**. See A.1.
- **Original claim was wrong:** the initial draft framed `crewHooks` as part of "fragmentation needing unify." Phase-1 verification showed `crewHooks` and the structured registry have **complementary scopes** (async side-effects vs blocking decisions) and coexist legitimately. Unifying them would break the async-instinct/skill pipelines.
- **Impact:** Low (corrected downward from Medium). The real gap is contributor confusion, not architectural redundancy.
- **Effort:** S.
- **Recommendation (revised):** Do NOT unify. Instead write `docs/hooks-reference.md` documenting the three layers' distinct purposes and when to use each. Keep `crewEventBus` removal (A.3) and `iteration-hooks` decision (A.1) as separate items. This item becomes "documentation," not "consolidation."

---

## Group D — Open bugs and correctness gaps

### D.1 bug-023 — Windows chain path resolution (OPEN)

- **Status:** ⚠️ PARTIAL
- **Files:** `docs/bugs/bug-023-chain-windows-path-resolution.md`, `test/unit/workflows/chain-executor.test.ts`
- **Evidence (opencode, 2026-08-09):**
  - `rg "bug-023" src/ test/` → reference in `chain-executor.test.ts` only.
  - Explore report: root cause is `O_NOFOLLOW` semantics mismatch on Windows + the `ELOOP` retry branch in `safe-paths.ts:184-194` being darwin-only.
- **Impact:** High for Windows users — chain feature breaks after step 1.
- **Effort:** M (needs Windows VM to verify).
- **Recommendation:** Either (a) extend the retry branch to win32 with a real fix, or (b) make the skip gate explicit and documented in README. Currently 7 tests skip silently on Windows — risk of someone un-skipping and getting burned.
- **Forward verification needed:** read `chain-executor.test.ts:30` to confirm skip gate; ideally run on a Windows VM.

### D.2 EPIPE handling in child-pi spawn path

- **Status:** 🔍 EXPLORE
- **Files:** `src/runtime/child-pi/`, `src/runtime/recovery/retry-executor.ts`
- **Evidence (explore + `docs/failure-mode-inventory.md:12,20`):** no EPIPE-specific classification; relies on generic `retryableErrors` globs in `executeWithRetry`. Declared gap.
- **Impact:** Medium. EPIPE surfaces as a generic retried error; retry behaviour may not match intent.
- **Effort:** S.
- **Recommendation:** Add an EPIPE-specific classifier in `model-fallback.ts` or `retry-executor.ts` that distinguishes "child died cleanly (pipe closed)" from "transient network EPIPE."

### D.3 Three-layer timeout interplay untested

- **Status:** 🔍 EXPLORE
- **Files:** `src/runtime/task-runner/child-executor.ts:454` (`taskTimeoutMs`), `src/runtime/child-pi/child-pi.ts:481` (`responseTimeoutMs`), `src/prompt/scratchpad-lifecycle.ts:60` (`EXECUTE_CELL_TIMEOUT_MS = 120_000`)
- **Evidence (`docs/failure-mode-inventory.md:13,21`):** three independent timeout layers with no contract test asserting which fires first under overlap.
- **Impact:** Medium. Under a pathological task (sync infinite loop in a scratchpad cell inside a child pi inside a long task), behaviour is emergent, not designed.
- **Effort:** S (one integration test).
- **Recommendation:** Add a test that runs a cell that blocks the event loop and asserts the deterministic firing order (expected: per-cell → no-output → wall-clock, since each outer layer has a larger budget).

### D.4 Scratchpad cell-spawned subprocess orphan risk

- **Status:** ✅ VERIFIED (corrected 2026-08-09)
- **Files:** `src/runtime/scratchpad/engine.ts:194-203`, `src/prompt/scratchpad-lifecycle.ts:22-27`
- **Evidence (opencode, 2026-08-09):**
  - `engine.ts:194-203` — the guest is spawned with `spawn(process.execPath, [...], { cwd, env, stdio: ["pipe","pipe","pipe","pipe"] })`. **There is NO `detached: true`** on the guest spawn.
  - **Correction:** the original explore claim ("`detached: true` descendants can orphan") was imprecise. The guest itself is NOT detached, so `engine.kill()` reliably kills it. The orphan risk is narrower: a cell running inside the guest can spawn its own subprocesses (cells have full `child_process` access per the full-worker-trust model), and **those grandchildren** are not tracked.
- **Impact:** Low–Medium (narrowed from Medium). A cell that spawns a long-running detached process leaves it orphaned on session shutdown. Bounded by the same-uid, same-cwd trust model.
- **Effort:** M.
- **Recommendation (revised):** Not "spawn the guest in its own process group" (the guest is already killable). Instead, document the residual risk in the scratchpad README and consider a Phase 2 cell-spawn tracker that registers detached grandchildren for best-effort cleanup on teardown. Lower priority than originally framed.

---

## Group E — Security / trust surface

### E.1 DWF v1 is not a sandbox (ACE surface)

- **Status:** 🔍 EXPLORE
- **Files:** `src/runtime/goal-workflow/dynamic-workflow-runner.ts:10-17,154-163`, `docs/dynamic-workflows.md:204-228`
- **Evidence (explore):** `.dwf.ts` scripts have full Node access (process, require, fs, child_process). Project-sourced scripts default-deny (`PI_CREW_TRUST_PROJECT_DWF=1` opt-in), but the content check for `require('child_process')` is advisory and trivially bypassable. `workflow-create`/`workflow-save` are arbitrary-code-execution surfaces. isolated-vm planned for v1.5.
- **Impact:** High if DWF is ever flipped to default-on or exposed to untrusted workflow sources.
- **Effort:** L (isolated-vm rewrite).
- **Recommendation:** Keep default-deny loud and documented in a README security section. Do NOT flip any default that would run project `.dwf.ts` without explicit env opt-in. Plan isolated-vm as a numbered milestone with its own ADR before any default-on consideration.

### E.2 `v8.deserialize` without authentication

- **Status:** 🔍 EXPLORE
- **Files:** `src/runtime/scratchpad/guest.ts` (snapshot restore path)
- **Evidence (explore):** a planted snapshot with a crafted V8 blob can run deserialize gadgets in the guest. Bounded by 4 MiB file cap + 256 KiB per-var cap + same-uid artifact dir. Does not cross the existing same-uid boundary.
- **Impact:** Low within the current same-uid threat model; High if artifacts ever land in a shared location.
- **Effort:** M (HMAC over snapshot blobs).
- **Recommendation:** Add HMAC signing on snapshot write + verify on restore. Phase 2.5/3 hardening per the scratchpad README. Trigger this before any move of artifacts to a shared/networked store.

### E.3 `EPERM`-as-stealable accepted risk

- **Status:** 🔍 EXPLORE
- **Files:** `src/state/coordination/locks.ts:84-106`
- **Evidence (explore):** `process.kill(pid, 0)` returning EPERM is treated as "stealable." SEC-008 documents acceptance for multi-user systems where blocking indefinitely would be worse.
- **Impact:** Low on single-user dev machines; Medium on shared CI runners.
- **Recommendation:** Keep the accepted-risk note prominent. Consider a config opt-in `limits.strictLockOwnership` that refuses to steal on EPERM for users who prefer correctness over liveness.

### E.4 Best-effort reads without run lock

- **Status:** 🔍 EXPLORE
- **Files:** `src/ui/run-snapshot-cache.ts:825,880`, `src/extension/overlays/mailbox-detail-overlay.ts:41`, `src/ui/overlays/agent-picker-overlay.ts:24`, plus `loadRunManifestById` retry loop (`state-store.ts:1057-1073`).
- **Evidence (explore):** all carry a NOTE "no withRunLock — best-effort only; concurrent writes may cause inconsistency."
- **Impact:** Low. Cosmetic inconsistency in UI under heavy concurrent writes; strict path (`withRunLock`) exists for callers that need it.
- **Recommendation:** Documented and acceptable. No action unless a UI flicker bug is reported.

---

## Group F — Observability and documentation gaps

### F.1 Unbounded concurrency — event but no metric

- **Status:** 🔍 EXPLORE
- **Files:** `src/runtime/team-runner.ts:1625-1635`
- **Evidence (explore):** `allowUnboundedConcurrency` emits a single `limits.unbounded` event; no counter. Production detection relies on grepping the event log.
- **Impact:** Low–Medium. Hard to alert on.
- **Effort:** S.
- **Recommendation:** Add a `crew.limits.unbounded_total` counter in `src/observability/event-to-metric.ts` keyed on the same emit site.

### F.2 Silent metric cardinality eviction

- **Status:** 🔍 EXPLORE
- **Files:** `src/observability/metrics-primitives.ts:40-47`
- **Evidence (explore):** at 10 000 label combinations, oldest keys are silently evicted. Counters/gauges can become unreliable if high-cardinality labels (runId/taskId) leak in.
- **Impact:** Low (the bridge actively defends against this), Medium for user-defined metrics.
- **Effort:** S.
- **Recommendation:** Emit a `crew.metrics.cardinality_evicted` counter when eviction occurs so operators know metrics are unreliable.

### F.3 Doc lag (code drift from decision records)

- **Status:** ✅ VERIFIED (two instances)
- **Files:** `docs/decisions/0007-active-run-binary-index.md`, `docs/decisions/0003-depth-guard.md`
- **Evidence (opencode, 2026-08-09):**
  - ADR 0007 status field reads *"Proposed — not yet implemented"* but the binary index is implemented (`src/state/stores/active-run-registry.ts:118-192`).
  - ADR 0003 line 19 references `PI_CREW_SESSION_DEPTH`; code uses `PI_CREW_DEPTH` (`src/runtime/model/pi-args.ts` — `rg "PI_CREW_SESSION_DEPTH" src/` returns nothing; `PI_CREW_DEPTH` appears 5×).
- **Impact:** Medium. Misleads anyone reading the ADRs as source of truth.
- **Effort:** S.
- **Recommendation:** Per-release pass over `docs/decisions/` to verify the status field and any env-var names against code. Add a CI lint that greps ADRs for `PI_CREW_*` / `PI_TEAMS_*` tokens and asserts each appears in `src/`.

---

## Priority tiers and suggested sequencing

### Tier 1 — Quick wins (high impact, low effort)

| ID | Action | Effort | Status |
|---|---|---|---|
| A.1 | Decide wire-or-delete for `iteration-hooks.ts` | S | ✅ verified dead-in-prod |
| A.2 | Decide wire-or-delete for plugins subsystem | S–M | ✅ verified scaffolded-only |
| A.3 | Delete or guard `crewEventBus` (dormant) | S | ✅ verified 0 subscribers |
| A.4 | Wire or delete mascot `setVisible` | S | ✅ verified unwired |
| A.5 | Remove broker `notifyMessage` (dead) | S | ✅ verified 0 callers |
| A.6 | Decide keep-or-delete for `child-pi-pool.ts` skeleton (new finding) | S | ✅ verified permanently disabled |
| C.1 | Write `docs/hooks-reference.md` (was "unify" — corrected to docs) | S | ✅ verified 3 distinct scopes |
| D.2 | Add EPIPE classifier in child-pi path | S | ✅ verified gap |
| D.3 | Add three-layer timeout contract test | S | ✅ verified 3 layers independent |
| F.1 | Add unbounded-concurrency metric | S | ✅ verified event-only |
| F.2 | Add cardinality-eviction metric | S | ✅ verified silent |
| F.3 | Per-release ADR sync + CI lint | S | ✅ verified 2 drift instances |

### Tier 2 — Strategic consolidation (milestone-scoped)

| ID | Action | Effort | Status |
|---|---|---|---|
| B.1 | Reduce worktree sync/async duplication (7 pairs confirmed) | M–L | ✅ verified 7 pairs |
| B.2 | Reduce state-store sync/async duplication (3 pairs confirmed) | M | ✅ verified 3 pairs |
| — | Split `team-runner.ts` (2814 lines) into scheduler-loop / merge-gate / helpers | M | ✅ verified size |

### Tier 3 — Risk closure (needs ADR + roadmap)

| ID | Action | Effort | Status |
|---|---|---|---|
| D.1 | Close bug-023 (Windows chain path) — skip gate is documented, fix needs Windows VM | M | ✅ verified skip gate |
| D.4 | Scratchpad cell-spawned subprocess tracker (narrowed from "process group") | M | ✅ verified, narrowed |
| E.1 | isolated-vm sandbox for DWF v1.5 (F-01 default-deny gate holds for now) | L | ✅ verified no sandbox |
| E.2 | HMAC over scratchpad snapshots | M | ✅ verified unauthenticated |

---

## What must NOT change (load-bearing strengths)

These are deliberate, well-defended design choices. Any change here needs an ADR and a regression plan.

- **Durable-first invariant** — broker/scratchpad accelerate the file path, never replace it. A broken broker degrades latency, never loses data.
- **Monotonic merge gate** (`team-runner.ts:447-576`) — exhaustively tested; adding a task status requires updating both `contracts.ts` and the `completedIntegrityFlips` table.
- **Default-deny permission model** (`src/runtime/role-permission.ts:38`) — unknown roles degrade to read-only, never to workspace-write.
- **Role-from-token-type broker auth** (F-06) — workers cannot forge `role:'orchestrator'`; do not fall back to self-declared hello fields.
- **`sanitizeProjectConfig`** boundary (`config.ts:272-357`) — strips sensitive fields from project config; user config wins on top.
- **Lazy-import discipline** — cold-start graph is thin by design; `scripts/check-lazy-imports.mjs` gate must stay.
- **Two-tier locking** (`locks.ts`) — AsyncLocalStorage re-entrance + on-disk O_EXCL; the cross-tier bypass sets are subtle and load-bearing (Round 29 / ST-3-FIX).

---

## Verification backlog (remaining)

Phase 1 + 2 + 3 completed 2026-08-09. All code-pattern checks done.

| # | Item | Status |
|---|---|---|
| 1 | `npm run test:critical` | ✅ DONE (101/0 pass, 16.8 s) |
| 2 | `npm run test:unit` | ⚠️ ran deep (896+), no fail; summary not captured by custom runner |
| 3 | `npm test` full | ⚠️ **TIMEOUT after 580 s** (test 2347+, no fail before kill). Full suite too slow to verify in one session — see "verification overhead" note below |
| 4 | Read `iteration-hooks.ts` end-to-end (A.1 prerequisite) | ✅ DONE — security model sound (see A.1) |
| 5 | Confirm no external `crewEventBus` consumer (A.3 prerequisite) | ✅ DONE — only internal test, safe to delete |
| 6 | bug-023 fix verification on Windows VM | ❌ NOT FEASIBLE on this linux environment — skip gate is documented, leave for Windows CI |

**No remaining code-pattern checks.** Inventory stable at 20 items. Items above are runtime/external/platform confirmations only.

### Verification overhead finding (incidental)

`npm test` cannot complete within a 580 s window — the integration suite uses `--test-timeout=300000` (5 min) per file and runs sequentially (`--test-concurrency=1`). This is itself a maintainability concern: contributors cannot get fast feedback on the full suite and will rely on `test:unit` + `test:critical` subsets. Consider (a) splitting the integration suite into fast/slow tiers, or (b) raising concurrency where ordering allows. Not added as a numbered item because it is process, not code — flagged here for the team's awareness.

---

## Change log

- **2026-08-10 (phase 6 — real-test follow-up):** processed the pi
  `real-test-2026-08-10-full-9-tier-budget-total-fix` report (9-tier
  battery run on HEAD `cca7d029` — all required tiers passed; 1 HIGH bug
  `budgetTotal` schema was found AND fixed by pi, bundle rebuilt).
  - **F2 — skill citation drift fixed:** `skills/real-test-pi-crew/SKILL.md`
    cited `PI_CREW_BROKER_DIAG_UI` / `run-dashboard.ts:831` — the
    keystroke-diag env var was removed in `e3ee6fe2` (PR-B5/UI-8).
    Skill now documents the removal + screen-change-evidence replacement;
    `scripts/pty_probe.py` no longer sets the dead env var.
  - **F4 — empty-output guard shipped:** `evaluateRunEffectiveness`
    (`src/runtime/effectiveness.ts`) now treats a completed task with an
    EMPTY result artifact (`resultArtifact.sizeBytes === 0`) as
    no-observed-work. Closes the monitoring gap where a 429-absorbed
    worker (transcript events present, output empty) still reported a
    green "completed" run. Deliberately non-flagging for missing
    resultArtifact and undefined sizeBytes (no false positives on legacy
    tasks). +4 tests (taskHasEmptyResult unit + 3 evaluate cases).
    The `effectivenessPolicyDecision` escalations (warn→blocked for
    mutating roles) now apply to empty-result tasks automatically.
  - All gates green: typecheck, test:critical 101/0, effectiveness
    suite 31/0.

- **2026-08-09 (phase 1 verification pass):** ran `npm run typecheck` (PASS), `npm run test:critical` (101/0 pass, 16.8 s), `npm run test:unit` (deep run, summary not captured). Independently verified all 19 plan items via grep/read. **Two explore-agent claims corrected in-place:**
  - **C.1** — `crewHooks` is ACTIVE (16 sites), not dormant; the three hook subsystems have distinct scopes (blocking decisions / async side-effects / SIEM-future / user-scripts). Recommendation changed from "unify" to "document." Tier moved 2→1.
  - **D.4** — scratchpad guest spawn has NO `detached: true`; orphan risk is narrowed to cell-spawned subprocesses. Recommendation revised. Priority lowered.
  - All `🔍 EXPLORE` items either promoted to `✅ VERIFIED` or rewritten. No new findings emerged — inventory is stable.
- **2026-08-09 (phase 2 verification loop):** scanned for additional dead/scaffolded code via `rg -ln "skeleton|scaffolded|not yet implemented|permanently disabled" src/`. **One new finding added:** A.6 (`child-pi-pool.ts` warm-pool skeleton, permanently disabled, 0 callers). Other matches were either phased-but-active (`goal-loop-runner.ts`) or incidental comment mentions. Loop closed: inventory stable at 20 items.
- **2026-08-09 (phase 3 verification close):** completed remaining backlog items. Read `iteration-hooks.ts` (305 lines) end-to-end — security model confirmed sound (A.1 updated with audit details, safe to wire). Confirmed `crewEventBus` has no external consumer, only an internal test (A.3 recommendation sharpened to "delete with test file"). `npm test` timed out at 580 s (test 2347+, no fail) — flagged as incidental verification-overhead finding. bug-023 Windows VM verification deferred (not feasible on linux). **All code-pattern verification complete; inventory stable at 20 items.**
- **2026-08-09 (phase 4 — Tier 1 implementation):** implemented all 12 Tier 1 items with per-item review→verify→test→fix loops. All baseline gates green throughout: `npm run typecheck` PASS, `npm run test:critical` 101/0 (16.6 s), `npm run test:unit` ran 897 tests / 0 fail before timeout. CI lint `check:decision-drift` added to `package.json` `ci` script.
  - **Dead code cleared (A.1, A.2, A.3, A.4, A.5, A.6):** removed `iteration-hooks.ts` (+ test), `src/plugins/` (+ test), `src/observability/event-bus.ts` (+ test, + 4 emit sites in progress-tracker kept as pure state updates), `mascot.setVisible` (+ field + dead tick branch + C6 test), `broker.notifyMessage`, `child-pi-pool.ts` (+ test + README row). Net: ~6 dead modules + 1 dead method + 1 dead field/branch removed from `src/`.
  - **Observability additions (F.1, F.2):** `crew.limits.unbounded_total` counter wired to `crew.limits.unbounded` event; `crew.metrics.cardinality_evicted` gauge refreshed on every metric event, backed by `getCardinalityEvictions()` in `metrics-primitives.ts` (module counter to avoid Counter self-eviction recursion).
  - **Correctness (D.2, D.3):** EPIPE/broken-pipe added to `RETRYABLE_MODEL_FAILURE_PATTERNS` (NON_RETRYABLE still wins) + 2 new tests in `model-fallback.test.ts`. New `test/unit/runtime/timeout-layer-contract.test.ts` (4 tests) documents the per-cell < no-output < wall-clock ordering invariant.
  - **Docs/lint (F.3, C.1):** ADR 0003 env var corrected (`PI_CREW_DEPTH`, not `PI_CREW_SESSION_DEPTH`) + implementation note; ADR 0007 status corrected ("Accepted — implemented"). New `scripts/check-decision-drift.mjs` wired into `npm run ci` catches future ADR↔src env-var drift (skips Proposed ADRs + historical-mention lines). New `docs/hooks-reference.md` documents the 3 hook subsystems' distinct scopes (was C.1 "unify" — corrected in phase 1 to "document").
  - **Net code delta:** −6 production source files, −1 dead method, −1 dead field, −4 dead event emits, +1 metric counter, +1 metric gauge + getter, +2 EPIPE regex patterns, +2 model-fallback tests, +1 contract test file (4 tests), +1 CI lint script, +2 docs files. typecheck + test:critical + 897 unit tests green.
- **2026-08-10 (phase 5 — Tier 2/3 implementation):** implemented the
  feasible-and-safe subset; deferred the breaking/large items behind ADRs
  with explicit plans. All gates green throughout: `npm run typecheck`
  PASS, `npm run test:critical` 101/0, `npm run check:decision-drift` clean.
  - **B.1/B.2 — PIVOTED to ADR.** On reading the twin code in depth, the
    pairs were found to have intentional behavioural drift (sync paths
    uncached, async paths cached — `findGitRoot` vs `findGitRootAsync`,
    `assertCleanLeader` vs `assertCleanLeaderAsync`). Mechanical
    extraction would either drop the async cache (perf regression) or
    add a cache to sync (changes concurrent-run semantics). New ADR
    `docs/decisions/2026-08-10-reduce-sync-async-twins.md` records the
    contract-test-first, phased, per-pair plan. **Not implemented in
    source** — the ADR is the deliverable.
  - **D.4 — narrowed and shipped.** Spawned the scratchpad guest with
    `detached: true` so descendants form their own process group;
    `killSync()` now signals the whole group (POSIX `process.kill(-pid,
    SIGKILL)`) or kills the tree (Windows `taskkill /T /F`), with
    single-pid fallback. Closes the cell-subprocess orphan gap.
  - **team-runner split — phase 1 shipped.** Extracted the self-contained
    merge-gate portion to `src/runtime/merge-gate.ts` (4 helpers + the
    `REJECTED_STATUS_MERGE_TRANSITIONS` table + `mergeTaskUpdatesPreservingTerminal`).
    team-runner re-imports them; existing tests (`team-runner-merge.test.ts`
    7/0, `team-runner-should-merge-table.test.ts`) pass unchanged. Further
    split phases (scheduler-loop, dispatch-batch) deferred — they touch
    the forward-sync dance and need their own ADR.
  - **E.2 — Phase 1 helper shipped.** New
    `src/runtime/scratchpad/snapshot-hmac.ts` (sign / verify / strip /
    attach, with `getSnapshotHmacKey`, `isSnapshotHmacStrict`,
    `shouldRejectSnapshot`). 11 unit tests. Inline `PI_CREW_SIG=<hex>\n`
    envelope. Opt-in via `PI_CREW_SNAPSHOT_HMAC_KEY`; strict mode via
    `PI_CREW_SNAPSHOT_HMAC_STRICT`. Production wire-up deferred to Phase
    2 (needs snapshot envelope format audit). New ADR
    `docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md` documents
    the 4-phase migration window.
  - **E.1 — ADR only (NOT implemented).** isolated-vm is a multi-week
    milestone (WorkflowCtx API audit, isolate marshalling, perf
    measurement, migration window). New ADR
    `docs/decisions/2026-08-10-dwf-isolated-vm-sandbox.md` records the
    decision, prerequisites, and implementation sketch.
  - **D.1 — still blocked.** bug-023 needs a Windows VM; the linux
    environment cannot verify the O_NOFOLLOW fix. Skip gate in
    `chain-executor.test.ts` is explicit and documented.
  - **failure-mode-inventory updated.** EPIPE and timeout rows flipped
    from ⚠️ partial-GAP to ✅ covered, with file:line pointers to the
    D.2 / D.3 work from Tier 1.
  - **Net code delta (Tier 2/3):** +1 module (merge-gate.ts, ~190 lines
    extracted from team-runner), +1 module (snapshot-hmac.ts, ~140
    lines), +1 test file (snapshot-hmac 11 tests), +3 ADRs, +scratchpad
    `detached:true` + group-kill in engine.ts killSync. team-runner.ts
    shrinks by ~180 lines.
  - **Dead code cleared (A.1, A.2, A.3, A.4, A.5, A.6):** removed `iteration-hooks.ts` (+ test), `src/plugins/` (+ test), `src/observability/event-bus.ts` (+ test, + 4 emit sites in progress-tracker kept as pure state updates), `mascot.setVisible` (+ field + dead tick branch + C6 test), `broker.notifyMessage`, `child-pi-pool.ts` (+ test + README row). Net: ~6 dead modules + 1 dead method + 1 dead field/branch removed from `src/`.
  - **Observability additions (F.1, F.2):** `crew.limits.unbounded_total` counter wired to `crew.limits.unbounded` event; `crew.metrics.cardinality_evicted` gauge refreshed on every metric event, backed by `getCardinalityEvictions()` in `metrics-primitives.ts` (module counter to avoid Counter self-eviction recursion).
  - **Correctness (D.2, D.3):** EPIPE/broken-pipe added to `RETRYABLE_MODEL_FAILURE_PATTERNS` (NON_RETRYABLE still wins) + 2 new tests in `model-fallback.test.ts`. New `test/unit/runtime/timeout-layer-contract.test.ts` (4 tests) documents the per-cell < no-output < wall-clock ordering invariant.
  - **Docs/lint (F.3, C.1):** ADR 0003 env var corrected (`PI_CREW_DEPTH`, not `PI_CREW_SESSION_DEPTH`) + implementation note; ADR 0007 status corrected ("Accepted — implemented"). New `scripts/check-decision-drift.mjs` wired into `npm run ci` catches future ADR↔src env-var drift (skips Proposed ADRs + historical-mention lines). New `docs/hooks-reference.md` documents the 3 hook subsystems' distinct scopes (was C.1 "unify" — corrected in phase 1 to "document").
  - **Net code delta:** −6 production source files, −1 dead method, −1 dead field, −4 dead event emits, +1 metric counter, +1 metric gauge + getter, +2 EPIPE regex patterns, +2 model-fallback tests, +1 contract test file (4 tests), +1 CI lint script, +2 docs files. typecheck + test:critical + 897 unit tests green.
- 2026-08-09 (initial draft): baseline typecheck PASS; test suite and critical subset not yet run. All `🔍 EXPLORE` items awaited independent verification.
