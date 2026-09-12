# Real-Test Report — 2026-09-12: Batch-1..10 branch live battery (Tier 1–12)

**Scope**: branch `fix/bundle-skill-resolution-and-skill-meta` @ `3d978969` (12 commits incl. the G17 fix landed mid-battery). Host session restarted 07:20 (PID 3611034) before the battery — bundle cold-load verified.

**Context**: first full run of the updated skill (Tier 12 added this session). Session owner = the agent under test (agent-inside-session caveat applies: could not restart own session mid-battery).

## Tier verdicts

| Tier | Verdict | Evidence |
|---|---|---|
| 1 test:critical | ✅ PASS | 102/102, 13.4s (post-G17-fix tree) |
| 2 3-path kill-switch | ✅ PASS | default 102/102 + `PI_CREW_BROKER=0` 102/102 + `=1` 102/102 |
| 3 typecheck+bundle+staleness | ✅ PASS | typecheck ok; bundle rebuilt 2× during battery (G17 fix); staleness incl. path-leak scan exit 0; final md5 `e3e921fba562395133b327b39b065753` |
| 4 bundle→session | ✅ PASS (process-level) | pi PID 3611034 lstart 07:20:39 > dist mtime 00:10; `team action='list'` renders 18 agents + routing When-NOT live. NOTE: the G17 settings fix landed AFTER session start → `settings get reliability.loopGuard` still answers "unknown key" in THIS session (correct stale-session behavior; next restart picks it up) |
| 5 tmux TUI probe | ✅ PASS | `/team-help` rendered full slash list; `\x1bOA` (app-cursor UP) changed screen state (diff=1) |
| 6 pty probe | ⏭️ SKIP | tmux available → Tier 5 covers; fallback only |
| 7 smoke team run | ✅ PASS | `team_20260912013556_7fba1bc1a90d6ce7` fast-fix 3/3, consistency=1, 255s (~2.4× under 600s ceiling); verifier consumed CACHED output (no re-run) + ran `tsc --noEmit` once |
| 8 md5 sync | ✅ PASS | disk md5 matches; single pi PID; lstart post-mtime |
| 9 feature battery | ✅ with **findings F1/F2/F4** | see below |
| 10 surface battery | ✅ 10a / ⏭️ 10b,10c | 10a tmux E2E **4/4 pass, 0 skipped** (dedicated tmux, ~100s). 10b/10c SKIP: host session not inside tmux/herdr (correct-by-design; `$TMUX` empty, no herdr pane) |
| 11 remediation battery | ✅ (spot) | 11b wc-gate exit 0 (max 1218 < 2000); 11j committed-hash OK; 11c–11i verified during Batch-1..9 gates (prior evidence, same tree minus G17 fix) |
| 12 resource contracts | ✅ PASS | 12a 1/1; 12b discovery 18/0/0 + strict YAML 18; 12c 16/16 rendered agent lines carry `useWhen=`, orchestrator visible (budget truncation by design — verifier/writer cut); 12d 39/39 |

## Tier 9 detail

**9a read-only (12 actions, all structured, zero errors)**: list (18 agents incl. orchestrator/librarian/oracle/designer/3 councillors, descriptions render When-NOT correctly) · settings get · health (183 runs scanned) · doctor zombies (0 subagents, 0 orphan panes, read-only) · recommend (routed small-fix → fast-fix, confidence high) · status/details=true · events (full lifecycle) · summary (cost/by-role) · get workflow implementation (10 roles) · explain (markdown render) · worktrees (none) · graph ("No graph found" for linear fast-fix — structured, Obs-2) · search (agent search works).

**9b spawn paths**:
- sync run ✅ (T7 run above; workers anchor the real commit `3d978969`)
- async run ✅ `team_20260912014042_a2e760ae3b9d8f02` 3/3 consistency=1 — explorer honored read-only denial list (deferred the write to executor: **Batch-4 agent bodies visibly working**)
- chain run ❌→**F1/F2** `team_20260912014448_a60429b96a4711ed` step-1 failed at 676s (see Findings)
- `Agent` direct ✅ `DIRECT_SUBAGENT_OK` — replied with the new EXEC_SUMMARY output contract block (Batch-4/8 contracts rendering in real workers)
- `crew_agent` background + `get_subagent_result` ✅ `CREW_AGENT_BG_OK`
- steer: delivered mid-run ✅ ("picked up at next turn boundary"); steer-after-complete → structured reject ✅; **uptake ⚠️ Obs-1** (single-90s-command worker finished without a subsequent LLM turn → steer never consumed — known boundary, not a failure of delivery)

**9b-W worker tools**: ask round-trip ❌→**F4** (async: worker "no broker connection" → fallback "proceed with best judgment" — run still completed 3/3); sync: park worked, delivery to parent didn't → **F1**. message notify — same F4 root cause ("Mailbox unavailable" in async workers). full-loadout ✅ (workers ran full sessions: bash/read/ask/tools all present).

**Post-run unauthorized-edit check**: `git status` tracked tree CLEAN after all runs ✅.

## Findings (ordered by severity)

### F4 — P0 for async coordination: detached workers lose ALL broker connectivity
- **Evidence**: both async runs' workers report "no broker connection" / "Mailbox unavailable"; ask falls back to "proceed with best judgment" (fallback itself works — no hang). Sync-run worker (chain) DID connect and park (`task.waiting` + `ask.requested` events fired).
- **Root cause (two legs)**: (1) `BACKGROUND_RUNNER_ENV_ALLOWLIST` (`src/runtime/async-runner.ts:169`) omits `PI_CREW_BROKER_*` — the detached runner process never receives the broker address; (2) the broker issuer (`setActiveBrokerIssuer`) is registered by the EXTENSION lifecycle controller — the detached runner process has no extension lifecycle, so even with env it mints nothing for its workers.
- **Why the quick fix is blocked**: `PI_CREW_BROKER_TOKEN` is secret-suffixed → `sanitizeEnvSecrets` allowlist validation REJECTS it by design (and a `PI_CREW_BROKER_*` glob is `isDangerousGlob`). The env route is deliberately closed.
- **Fix direction (architectural)**: pass run-scoped broker spawn credentials through the async spawn payload / run state (0600 file under `.crew/state/runs/<runId>/`, same trust domain), and have the detached runner register a static issuer serving those creds to its workers (respecting the depth-cap containment AC). Same lesson-class as f0a41a16 (mux vars stripped → async surface dead) but needs the payload route, not the allowlist route.
- **Blast radius**: every async run (the default for long tasks, `autonomous.preferAsyncForLongTasks=true`) loses ask/message/mailbox/steer coordination silently (fallback masks it).

### F1 — P1: sync team call is NOT released when a task parks on `ask`
- **Evidence**: chain run — worker parked 01:46:01 (`task.waiting`, question + 3 options persisted); my sync `team` tool call stayed BLOCKED until the worker was killed; question never surfaced to the LLM; run failed at step 1. The parent is the only one who can answer, and it is suspended inside the call.
- **Fix direction**: on park, release the foreground waiter with the question (mirror the detach mechanism: return "run waiting for your answer — `team action='respond'`"), or surface via the coordination bridge + re-wait.

### F2 — P1: ask deadline == response timeout; no deadline sweeper
- **Evidence**: `task.waiting` deadline-in-600s at 01:46:01 → `worker.response_timeout` "No output for 600000ms" at 01:56:01 — the watchdog killed the parked worker AT the deadline; no `wait.resolve` wake, no sweeper in the broker (`grep sweep/expired` → none).
- **Fix direction**: default ask clamp must be < RESPONSE_TIMEOUT_MS (e.g. 480s) so the worker wakes with "no answer → proceed" BEFORE the watchdog fires; add a broker-side deadline sweeper as belt-and-braces.

### F3 — P2, FIXED during this battery (commit `3d978969`)
G17-class settings drift: `reliability.loopGuard` (+4 pre-existing boolean siblings) missing from TypeBox schema / KNOWN_KEYS / both EFFECTIVE_DEFAULTS; 7 stale comments named the wrong path `runtime.reliability.*`. Fixed + `reliability-settings-parity.test.ts` guard (3 tests) + overlay entries.

### Observations (no action)
- **Obs-1**: steering uptake needs a subsequent LLM turn; a worker whose entire run is one long command completes without consuming the steer (delivery itself is fine).
- **Obs-2**: `team action='graph'` returns "No graph found" for linear workflows — structured, not an error.

## Artifacts
- Runs: `team_20260912013556` (T7 ✅), `team_20260912014042` (async ✅), `team_20260912014448` (chain ❌ F1/F2 evidence), `team_20260912015943` (ask-probe ✅-with-F4)
- tmux: `/tmp/sock` server cleaned up after probes
- This report: `docs/real-test/reports/real-test-2026-09-12-batch10-live-battery.md`

## Verdict
**Tiers 1–8, 10a, 11, 12: PASS with evidence above. Tier 9: PASS for every path EXCEPT the ask round-trip leg, which is broken by F4 (async, systemic) and F1 (sync).** The battery did exactly what it exists for: three real defects found (one fixed live), zero false-green on the new Tier 12.

---

## Fix session appendix (same day, commits 88988971 → ad614070)

| Finding | Fix | Verification |
|---|---|---|
| F1 sync park-release | `RunWaitResult.waiting` + broker `resolveRunPromise` push + run.ts WAITING branch (question + respond/wait recovery commands) | **Unit-proven**: wait-request-broker "pushes the question to a registered sync foreground waiter" (22/22). Live tool-level proof pending a sync worker that actually asks (3 probe attempts inconclusive: 2× probe-LLM mangled the chain param, 1× explorer deferred without asking — nondeterminism, not a fix failure) |
| F2 deadline race | server default 600→480 (request-parsers) **and** client default 600→480 (ASK_TIMEOUT_SEC_DEFAULT — the ask tool always sent an explicit value, so the first fix alone changed nothing; caught by the live probe's "deadline in 600s") | pins updated (wait-request-broker + ask-tool-lifecycle); both suites green |
| F4 async broker creds | v1 (per-run token) → caught live: waitAuthError rejects bare-runId tokens for wait.* (ADR-0 item 6) → **v2: per-task COMPOUND tokens pre-minted at dispatch, {v:2,...,tasks:{id:token}} on stdin** (token never touches disk — heap→pipe→heap; env route stays closed by design) | **LIVE-PROVEN**: async run team_20260912043817 — executor connected through the handshake and delivered a full structured ask (`ask.requested` event, 5 options). Handshake round-trip pinned by unit test (v1 shape rejected) |
| F5 (found during fix) request hangs on half-dead sockets | per-request RPC timeout (default 15s; ask passes deadline+5s) + new BrokerErrorCode `request-timeout`; cleared on settle + close | 2 new client tests (lost-frame → typed fallback; happy path unaffected); critical now 104/104 |
| F3 settings drift | already fixed during battery (3d978969) | parity guard test |

**Follow-ups opened by the fix session** (not regressions — pre-existing gaps surfaced by deeper probing):
1. Root cause of response-frame loss on half-dead handshake sockets (explorer `code=close` + executor silent loss in the same run) — needs a reproduction; F5 makes it non-fatal.
2. Expired-ask reconciliation: dispatch-batch requeue flips the task, but a parked worker only wakes via its own ask timeout — with F5 the worst case is now deadline+5s; a runner-side reconciliation of live-but-parked workers is the cleaner end-state.
3. Dynamic-workflow async runs still creds-less (tasks planned inside the runner can't be pre-minted) — needs a broker-side mint RPC.
4. The stuck run (team_20260912043817) was cancelled after evidence capture; worker was killed with it.
