# Verification + Gap-Finding Round — AUDIT-2026-08-03.md

**Date:** 2026-08-03 (same day as source audit)
**HEAD:** e9bb3aca, v0.9.57
**Method:** Skill `iterative-audit`, round type = **verification of prior audit doc against source** (skill rule: "Never trust audit docs — ~30% are false positives or already fixed"). 4 parallel read-only auditors (security / runtime+locks / state / perf).
**Baseline doc:** `docs/AUDIT-2026-08-03.md`

---

## Round Results (enforcement gate)

| Metric | Value |
|---|---|
| Findings verified from source | 25 |
| Confirmed-still-open | 21 |
| Already-fixed (false positive in doc) | 1 (PERF-4) |
| Harm/severity overstated | 1 (RT-NEW-2) + 1 understated (STATE-8) |
| Proposed fix WRONG (would regress) | 1 (LOCK-1) |
| Proposed fix infeasible as written | 1 (STATE-3 reconstruction) |
| **NEW issues found** | **14** (3 Medium+, 11 Low) |
| Doc inaccuracy rate | 5/25 = 20% (consistent with skill's "~30%" rule) |

**Decision:** verification round complete (read-only, per user request "review"). Fix sprints NOT executed in this round — these belong to subsequent implementation rounds.

---

## META-FINDINGS — where the audit doc is wrong/missed (read these first)

### M1. LOCK-1 proposed fix is WRONG and would introduce a regression 🔴

The audit says: *"Use `releaseLock` (token-matched) in `withRunLock`/`withRunLockSync` finally blocks."*

**This is unsafe.** `locks.ts:610-612,637-638` has a deliberate-design comment: within the same process, `withRunLock` re-acquire uses a **fresh random UUID** each time. `releaseLock(token)` compares the passed token against the token currently *stored in the file*. After a same-process re-acquire (steal of own-pid lock), the stored token ≠ the finally's token → `releaseLock` no-ops → **lock file leaks forever** → next acquire EEXIST-fails. This is exactly the CI flake the current `releaseOwnLock` was written to fix.

**Correct fix** = PID-guarded release, mirroring the pattern `event-log.ts:188-196` already uses correctly:
```ts
const holderPid = readLockPid(filePath);
if (holderPid !== undefined && holderPid !== process.pid) return; // stolen by another process — don't touch
fs.rmSync(filePath, { force: true });
```
This preserves same-process re-acquire (pid matches → delete) while protecting cross-process locks (pid differs → skip). The `_token` param becomes unnecessary.

### M2. RT-NEW-2 "permanent work loss" claim is FALSE; harm overstated; under-counted

- `handleResume` (`team-tool.ts:410-419`) **does re-queue `"skipped"` tasks** on resume. So no permanent loss — actual harm is **wasted compute** (re-run) + **state inconsistency** (completed-in-flight tasks marked skipped, artifacts orphaned).
- Severity: Medium is right, but the *rationale* changes.
- The doc also **under-counted** the anti-pattern: there are **4** return sites that skip drain-and-merge, not 1: `enforceRunBudget` (:2129), inline cancel-during-exec (:2588), inline adaptive-plan-missing (:2597), inline plan-approval-cancelled (:2615). Plus `cancelRunFromSignal` (:1227) is a 5th variant. Only `enforceRunBudget` causes real data loss; the cancel paths are arguably acceptable.

### M3. PERF-4 is ALREADY-FIXED (false positive)

The sync `prepareTaskWorkspace` (`worktree-manager.ts:697`) has **zero production callers**. The real path uses `prepareTaskWorkspaceAsync` (:864) → `execFileAsync`, called from `pre-execution.ts:103`. The sync version + sync `git()` helpers are dead code. Action = optional cleanup, not perf.

### M4. STATE-8 under-rated: P3 → it's silent DATA LOSS

`worktree-manager.ts:606-609` strips outer git-quotes but not octal escapes (`\303\251` → `é`). `core.quotePath` appears **nowhere** in `src/`. A file like `café.txt` is skipped from the pre-clean snapshot → `git clean -fd` destroys it permanently. The snapshot is the only recovery path. **Elevate to Medium.** Fix: `-c core.quotePath=false` on the `git status` (:770 and async twin :930).

### M5. STATE-3 fix as proposed is infeasible

`run.created` event payload (`state-store.ts:333`) only carries `{team, workflow}` — NOT manifest fields (agents, config, cwd, stateRoot, eventsPath...). `event-reconstructor.ts` reconstructs **tasks only**; no `reconstructManifest` exists. Events-based reconstruction of a full manifest would be lossy. **Correct fix = quarantine + clear error** (run shows "corrupt" not "missing"), mirror `loadTasksWithRecovery`'s quarantine half only.

### M6. PERF-2 impact understated by doc

The doc implies base #1 (`fileURLToPath(import.meta.url)`) might short-circuit before `execSync("npm root -g")`. It does NOT — `peerDepResolutionBases()` (`peer-dep.ts:105`) **eagerly evaluates all 5 bases including the execSync** before returning the array. So the ~200ms execSync fires on every cold start of the main extension regardless of install layout. Fix = make `resolveNpmGlobalRoot()` lazy (only call when earlier bases fail).

---

## VERIFIED FINDINGS (per-finding verdicts)

### Security

| ID | Verdict | Severity | Key evidence |
|---|---|---|---|
| VULN-1 | CONFIRMED-STILL-OPEN | CRITICAL | `config.ts:281-290` strip list lacks `agentExtensions`; `discover-agents.ts:516,524-527`; `pi-args.ts:321-325`. End-to-end RCE via `.crew/config.json` → builtin agents. The `324fb5b7` feature guards (isUntrustedProject, env-gate) only cover project/project-pi agents, NOT builtin. |
| VULN-2 | CONFIRMED-STILL-OPEN | Medium | `knowledge-injection.ts:415-417` wraps content; `sanitizeAgentSystemPrompt` (`:299`) does NOT strip `</untrusted-project-data>` (grep = 2 occurrences, both the wrapper tags). |
| VULN-3 | PARTIAL | Low-Med | `run-projection.ts:67-68`; `untrusted_data` grep = 0. BUT `sanitizeTaskText` is materially weaker than `sanitizeAgentSystemPrompt` (missing HTML-comment, codeblock, eval, YAML-role, exfil stripping) → real injection gap. |
| DI-1 | CONFIRMED-STILL-OPEN | Low | `run-import.ts:55,61` — no size check + double read + double parse. |
| DI-2 | PARTIAL | Low | `redaction.ts:221-233,271-288` — missing `sk-ant-`/`sk-proj-` value patterns (key-name redaction covers env vars; free-text gaps). |
| DI-3 | CONFIRMED-STILL-OPEN | Low | `skill-instructions.ts:157-164` — trust text only mentions `project:`; `project-pi`/`project-agents` get no distrust framing. |
| DI-4 | CONFIRMED-STILL-OPEN | Low (by design) | `intent-policy.ts:34` — cleanup bypass; likely intentional (non-forced cleanup = stale-only). |

### Runtime + Locks

| ID | Verdict | Severity | Key evidence / fix note |
|---|---|---|---|
| RT-NEW-1 | CONFIRMED-STILL-OPEN | P1 | `config.ts:710` uses `runtimeMaxTurns`(10_000) as ms ceiling; `parseWithSchema` returns undefined silently (`:559-563`). Fix: dedicated `taskTimeoutMsMax` ceiling + warn-on-drop. |
| RT-NEW-2 | PARTIAL | Medium | Divergence real; "permanent loss" FALSE (see M2). 4-5 return sites, not 1. Fix = shared `terminaliseRunWithDrain` helper from `handleFailedTask`. |
| RT-NEW-3 | CONFIRMED-STILL-OPEN | Med-High | `background-runner.ts:119-128` writes `async.failed` for all 18 signals incl. SIGWINCH/SIGPIPE; handler has no exit/abort (`:504`). `async-notifier.ts:31,87` permanently skips dead-detect. Fix: non-terminal event type for benign signals. |
| LOCK-1 | CONFIRMED but fix WRONG | P1 | `releaseOwnLock` (`locks.ts:252-265`) unconditional. **Use PID-guarded release, NOT token-match** (see M1). Reference impl: `event-log.ts:188-196`. |
| LOCK-2 | CONFIRMED-STILL-OPEN | P1 | `team-tool.ts:299` wraps `executeTeamRun` in `withRunLock`; `defaults.ts:51` staleMs=30s. **Fix option (c) safest**: remove outer lock, keep only for recovery+reset (mirrors `handleRun`). |

### State / Durability

| ID | Verdict | Severity | Key evidence / fix note |
|---|---|---|---|
| STATE-3 | CONFIRMED-STILL-OPEN | Medium | `readJsonFile` (`atomic-write.ts:974-992`); `loadRunManifestById` (`state-store.ts:1052`) no recovery. **Fix = quarantine+error only** (see M5). |
| STATE-5 | CONFIRMED-STILL-OPEN | P2 | `readEvents` (`event-log.ts:1380-1391`); best cursor candidates: `async-notifier.ts:90`, `team-tool/run.ts:113`, `status.ts:67`. |
| STATE-7 | CONFIRMED (cosmetic) | P3 | `atomicWriteFileAsync` (`:721-722,737`) hardcodes 0o600; zero callers pass mode. |
| STATE-8 | CONFIRMED → ELEVATE | **Medium** | `worktree-manager.ts:606-609,770`; no `core.quotePath` anywhere. Data loss (see M4). |
| STATE-9 | CONFIRMED-STILL-OPEN | P3 | `artifact-store.ts:210-216`; hash on in-memory `content` directly. |
| STATE-10 | CONFIRMED-STILL-OPEN | P3 | `mailbox.ts:238-242` non-atomic; benign for empty file but TOCTOU. |

### Performance

| ID | Verdict | Severity | Expected win | Fix |
|---|---|---|---|---|
| PERF-1 | CONFIRMED | High | 50-150ms cold start | Lazy `import("cli-highlight")` cached on first call. |
| PERF-2 | CONFIRMED (understated) | High | ~200ms cold start | Make `resolveNpmGlobalRoot()` lazy (see M6). |
| PERF-3 | CONFIRMED | Medium | 280→70 syscalls/cache miss | Hoist `discoverProviderExtensionPaths()` out of 4 `applyAgentOverrides`. |
| PERF-4 | **ALREADY-FIXED** | — | 0 (dead code) | Optional: delete sync `prepareTaskWorkspace` + sync `git()` helpers. |
| PERF-5 | CONFIRMED | Low | diagnostics | Skip warmup in bundle mode (false `completed:true`). |
| PERF-6 | CONFIRMED | Medium | ~30-40% tasks.json size | `compact?: boolean` in `AtomicWriteOptions`. |
| PERF-7 | CONFIRMED | Medium | ~22→2 syscalls | mtime-compare src vs dst dir. |

---

## NEW FINDINGS (the doc missed these)

### Medium+ (worth prioritizing)

| ID | Area | Finding | Evidence |
|---|---|---|---|
| NEW-S1 | Security | **`PI_CREW_*` wildcard glob leaks potential secrets to hook scripts.** `env-filter.ts:94-100` exempts ALL `PI_CREW_*` keys from secret scrutiny ("no secrets live here"). A key like `PI_CREW_OPENAI_API_KEY` is forwarded to user-authored post-check/hook scripts (`post-checks.ts:100` allowlist) with full process access. | `utils/env-filter.ts:98-100`, `runtime/verification/post-checks.ts:100` |
| NEW-R1 | State | **`stale-reconciler.ts` uses bare `JSON.parse`, bypassing recovery.** Crash-recovery path: if `manifest.json`/`tasks.json` corrupt → SyntaxError → `catch{continue}` → run silently skipped, never reconciled, stuck forever. The worst place to bypass recovery. | `runtime/stale-reconciler.ts:498-500,613,639` |
| NEW-R2 | State | **`health-monitor.ts` `readRunTasks` bypasses `loadTasksWithRecovery`.** Corrupt `tasks.json` → returns `[]` → stuck/crashed workers invisible → false "healthy" report. | `extension/team-tool/health-monitor.ts:64-69` |
| NEW-P1 | Perf | **`packageRoot()` uncached — statSync+readFileSync storm.** 10+ call sites incl. **module-load time** (`pi-args.ts:18` top-level const). 20-40 syscalls + 10-20 JSON.parse per startup. | `utils/paths.ts:6-27` |
| NEW-P2 | Perf | **`userPiRoot()` uncached — `lstatSync` every call.** 15+ sites incl. module-load (`orphan-worker-registry.ts:159`). Amplified by PERF-3 (4x per cache miss). | `utils/paths.ts:41-60` |
| NEW-P3 | Perf | **`loadConfig()` does 4 `statSync` even on cache HIT.** 40+ call sites, hot during active runs (5-10x/sec → 20-40 wasted syscalls/sec). | `config/config.ts:1144-1150`, `readCacheMtimes:137` — **RESOLVED: D-DECLINED** (2026-08-04): every optimization that skips the per-call mtime check breaks the deliberate `config-cache.test.ts` contract (mtime change within TTL must re-parse immediately — the invalidate-on-write guarantee requested in the original perf brief). Benefit is tiny (~5-20µs/call, already mitigated by the F16 quick-win cache + `invalidateConfigCache` + `updateConfig`-auto-invalidate). Kept as-is by product decision.

### Low

| ID | Finding | Evidence |
|---|---|---|
| NEW-S3 | `sanitizeTaskText` missing 5 passes vs `sanitizeAgentSystemPrompt` (HTML comment, codeblock, eval, YAML-role, exfil). Mailbox body uses the weak one. | `runtime/task-packet.ts:26-51` vs `discover-agents.ts:313-383` |
| NEW-R3 | `subagent-manager.ts` non-atomic `writeFileSync` → crash leaves partial JSON → record lost on load. | `runtime/subagent-manager.ts:83-86` |
| NEW-R4 | `mailbox.ts` delivery-state read swallows corrupt JSON → messages appear undelivered → **re-delivery**. | `state/coordination/mailbox.ts:462-481` |
| NEW-R5 | `gitignore-manager.ts` non-atomic read-modify-write of user-visible `.gitignore` + TOCTOU. | `state/gitignore-manager.ts:44` |
| NEW-P4 | Redundant `existsSync`+`readFileSync` pairs (TOCTOU + wasted syscall) across `run-cache.ts:120`, `model-fallback.ts:84-85`, `completion-guard.ts:97`, `markers.ts:144`. | — |
| NEW-P5 | `skills/validate.ts:27` eager `import yaml` (~200KB) at module load; rarely needed. | `skills/validate.ts:27` |
| NEW-RN1 | `signalLog` message falsely says "exiting" for benign signals (diagnostic accuracy). | `background-runner.ts:127` |

---

## REVISED ACTION PLAN (corrected for meta-findings)

### Sprint 1 — Critical + P1 (corrected)
1. **VULN-1** (S): add `agentExtensions` to `sanitizeProjectConfig` strip list + test. *(unchanged)*
2. **RT-NEW-1** (S): dedicated `taskTimeoutMsMax` ceiling + warn-on-drop. *(unchanged)*
3. **LOCK-1** (M): **PID-guarded release** (NOT token-match) — mirror `event-log.ts:188-196`. *(corrected)*
4. **LOCK-2** (M): remove `withRunLock` around `executeTeamRun`; keep for recovery+reset only. *(option c)*
5. **NEW-S1** (S): add `isSecretKey` secondary filter for `PI_CREW_*` glob-matched keys.

### Sprint 2 — Medium correctness + security + state-recovery
6. **RT-NEW-3** (S): non-terminal event type for benign signals.
7. **VULN-2** (S): strip `</?untrusted-project-data>` from content (or random fence delimiter).
8. **VULN-3 / NEW-S3** (S): upgrade mailbox body to `sanitizeAgentSystemPrompt` + `<untrusted_data>` framing.
9. **STATE-3** (M): quarantine + clear error for corrupt manifest (NO reconstruction).
10. **STATE-8** (S, **elevated**): `-c core.quotePath=false` on git status (`:770,:930`).
11. **RT-NEW-2** (M): shared `terminaliseRunWithDrain` helper; apply to `enforceRunBudget` (+ optionally 4 other return sites).
12. **NEW-R1 + NEW-R2** (S each): migrate stale-reconciler + health-monitor to `loadRunManifestById`/`loadTasksWithRecovery`.

### Sprint 3 — Performance (re-ordered by ROI/risk)
13. **PERF-2** (S, highest ROI ~200ms): lazy `resolveNpmGlobalRoot()`.
14. **NEW-P1 + NEW-P2** (S each, trivial): memoize `packageRoot()`/`userPiRoot()`.
15. **PERF-1** (S): lazy `cli-highlight`.
16. **PERF-3** (S): hoist `discoverProviderExtensionPaths()`.
17. **NEW-P3** (S): ~~trust TTL in `loadConfig` (skip mtime re-check within window)~~ — **DECLINED (D)** by product decision: would break the deliberate config-change-detection contract (`config-cache.test.ts`), benefit ~5-20µs/call is negligible vs. risk.
18. **PERF-6** (S): compact JSON for machine-only state.
19. **PERF-7** (S): mtime-skip in `deployBundledThemes`.
20. **PERF-4** (S, cleanup only): delete dead sync worktree code.

### Sprint 4 — Cleanup + defense-in-depth
21. **DI-1** (S): size limit + single-read in run-import.
22. **DI-2** (S): add `sk-ant-`/`sk-proj-` redaction patterns.
23. **DI-3** (S): extend skill trust text to all project-adjacent sources.
24. **STATE-9, STATE-10** (S each): hash-on-memory; atomic mailbox create.
25. **NEW-R3/R4/R5, NEW-P4/P5** (S each): atomic writes; TOCTOU fixes; lazy yaml.
26. **PERF-5** (S): skip warmup in bundle mode.

---

## Enforcement Gate Checklist (skill)

- [x] Round focus defined: **verification + gap-finding** (single coherent round type, not a mega-fix round)
- [x] Every finding has verified `file:line` (read actual source by 4 auditors)
- [x] False positives filtered (PERF-4 already-fixed; RT-NEW-2 overstated; LOCK-1 fix wrong; STATE-3 fix infeasible; STATE-8 under-rated)
- [x] Severity assigned/re-assessed using CRITICAL/HIGH/MEDIUM/LOW
- [x] Plan doc created (this file) with phases + file:line evidence
- [N/A] Typecheck/tests — **not applicable**: this round is read-only review per user request; no code changed. Implementation rounds will re-run the gate.
- [x] Round results recorded (table above)
- [x] Decision logged: **verification round DONE**; stop here pending user direction on which sprint(s) to implement.

## Continue/Stop

**Stop this round** (review complete). Next decision point: whether to execute Sprint 1 (the 4 P1/CRITICAL fixes), which the skill would treat as an implementation round with its own gate (typecheck + tests + commit).
