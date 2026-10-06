# Pi-crew Deep Review — delta 18bc35ae..af462d7b (DR round) — 2026-10-05

- **Date:** 2026-10-06 (run date; file name per task packet). **Run:** `team_20261006033020_ffef34aada6696e2`
  (parallel-research: discovery → 4 explorer shards → synthesis → this document).
- **Scope:** The 25-commit delta `18bc35ae..af462d7b` on `main` (52 files, +2676/−729). This is a NEW
  review round on top of the R3 baseline ([pi-1.0.0-deep-learn-r3-2026-10-03.md](pi-1.0.0-deep-learn-r3-2026-10-03.md)),
  which already audited the pre-delta code — baseline findings are **not** re-audited here, only delta-checked (§4.2).
  Packet focus: (1) the delta itself; (2) new-wave areas — session-recovery/hermetic workers, the RPC worker-transport
  seam (e2728f68, env-gated), handoff budget trim, foreground-run completion after the GH#62 fix (62c9ed0d), the
  lifecycle dead-code removal (af462d7b); (3) test debt (three recent CI-red rounds were stale tests); (4) whether the
  flagged lingering risks (R3-5/R3-8/R3-13/R3-14, QW#4, issues #9/#10) got better or worse.
- **Checkout state:** target `af462d7b`; actual HEAD `7caf408e` = target + one dist-only rebuild commit (src tree
  identical) [S — 4/4 shards independently]. The writer lane has no shell; git-level claims inherit shard provenance.
- **Inputs:** pi-crew `src/` + `test/` at HEAD (read-only), shard git log/diffstat, upstream artifacts
  `.crew/artifacts/team_20261006033020_ffef34aada6696e2/results/{01..06}_*.txt`.

## Provenance legend

- **[W]** — verified directly by the writer (07_write, this session): read the cited file/range and confirmed the claim.
  Line anchors may be ±2 (writer read ranges, not line-numbered dumps).
- **[A]** — re-verified by the analyst (06_synthesize) via grep/read against pi-crew `src/`.
- **[S]** — shard evidence (02 core / 03 UI / 04 runtime / 05 extensions), each self-verified with file:line; not
  re-opened by the writer unless also marked [W].

Effort: S < half-day, M = days. Severity: HIGH / MEDIUM / MINOR / LOW. "Gate" = what must be true for the bug to fire.

## Coverage — read this first

Claims below are scoped to what was actually dispatched and finished. The packet's four focus areas were covered;
four follow-up checks were **not** run and are listed as gaps, not findings.

| Area | Status | Notes |
|---|---|---|
| Delta verification (25 commits / 52 files / +2676/−729) | ✅ [S 4/4] | `git log/diff --stat 18bc35ae..af462d7b -- ':!dist'`; HEAD = target + dist-only. |
| RPC worker-transport seam + config gap | ✅ (02/04/05 + [W]) | run-worker.ts, rpc/*, config trio read by shards; writer re-read the load-bearing ranges (§3). |
| Foreground-run completion / GH#62 / lifecycle cleanup | ✅ (02/03/05 + [W]) | Controller, context-builder guard, lifecycle.ts read; render-loop verbatim check by shards. |
| Session-recovery / hermetic / spawn flags | ✅ (02/04 + [W]) | per-flag idempotency verified in source; mixed-identity edge flagged (DR8). |
| Handoff budget trim | ✅ (05 + [A] + [W]) | Budget fn, wiring, config, env registry all located — verdict SAFE (§4.1). |
| UI wave (OSC-8, CURSOR_MARKER, renames) | ✅ (03 + [W]) | Two findings (DR3, DR4) + clean verdicts. |
| Lingering risks delta-check (R3-5/8/13/14, QW#4, #9, #10) | ✅ (02/04/05 + [W]) | None touched by the delta; one possibly aggravated (§4.2). |
| **Gap — stale-assertion sweep** | ❌ not run | Target list produced (§5.2) but no test files re-executed/re-audited in this round. |
| **Gap — R3-14 color-debt inventory** | ❌ not run | New UI surface (+57 widget-renderer.ts) not color-audited. |
| **Gap — host matrix for DR3** | ❌ not run | Whether pi-tui <1.0.0 hosts exist in practice (severity mitigant) unverified. |
| **Gap — abort-deadline caller audit for DR1** | ❌ not run | Analyst grepped `src/runtime` for turn-timeouts (none on the runWorker path [A]); an exhaustive per-caller abort-deadline audit was not done. |

---

## 1. Executive matrix

| ID | Finding | Severity | Gate | Effort | Fix sketch |
|----|---------|----------|------|--------|------------|
| DR1 | RPC settle-hang: child crash after prompt-ack never resolves `settledPromise` → the worker-cap slot is held forever | **HIGH** (env-gated: `PI_CREW_WORKER_TRANSPORT=rpc`) | env | S–M | Race `settledPromise` with `client.exited()` + configurable `turnTimeoutMs`; map to the early-failure result shape; add a crash-before-settle test |
| DR2 | `runtime.workerTransport` config key is parsed+validated but dead (seam reads env only) + 3 stale "not-implemented" doc blocks | MEDIUM | config | S | Plumb config→seam or reject at validation; rewrite the stale comments — **leader decision D1** |
| DR3 | `CURSOR_MARKER` imported as a named ESM binding from a `*`-ranged peer — module-load failure on older pi-tui hosts; contradicts R3-9's own defensive pattern | MEDIUM | host matrix | S | Namespace import + typeof guard (mirror `widget-renderer.ts` `tuiHyperlink`) |
| DR4 | `consumeAnsi` has no APC branch → the APC-riding `CURSOR_MARKER` is counted as ~6 visible columns by truncate/wrap | MINOR | always | S | Add an `ESC _ … BEL` branch next to the OSC one + width test |
| DR5 | RPC early-failure predicate allows double execution when the transport fails after agent start but before first assistant text | LOW-MED | env | S | Track "agent started"; started-but-unsettled → surface error, never retry |
| DR6 | `isOwnerSessionCurrent` fails open when `ownerSessionId === undefined` (undocumented compat trade-off); stale-session failures log as "context disposed" | LOW | always | S | Document the trade-off at the guard; distinct log label |
| DR7 | Working-message clear is unconditional and not keyed by runId — safe only under the untested single-active-foreground-run invariant | LOW | always | S | Pin the invariant with a test, or key the clear |
| DR8 | Mixed session identity when a builder forwards a partial `--session-id` ≠ ctx.sessionId (own `--session-dir` still added) | LOW | caller-dependent | S | Warn + prefer ctx on mismatch; audit `deriveSessionPaths` callers |

---

## 2. Finding details

### DR1 — RPC settle-hang holds the worker slot forever (HIGH, env-gated)

**Problem.** `runRpcWorker` awaits `settledPromise` (rpc-worker.ts:156-165 [W]), which is resolved by exactly two
things: the `agent_settled` event (onEvent, rpc-worker.ts:~128-137 [W]) or the abort branch's `.finally()`
(rpc-worker.ts:139-154 [W]). If the child process crashes **after the prompt command was ACKed but before
`agent_settled`**, nothing resolves the promise: `frame-client.ts` wires stdout end/close to `finalizeStream()`,
which only calls `failPending(...)` — rejecting *pending commands* (frame-client.ts:~243-260 [W]) — and the prompt's
pending entry was already resolved by its ACK. `client.exited()` exists but is called **after** the await
(rpc-worker.ts:~168 [W]). There is no turn timeout on this path: the analyst grepped `src/runtime` for
`timeoutMs|deadline` — every hit belongs to another path (delegate `timeoutSec`→abort, broker client, rg,
verification, herdr); only the abort signal rescues a hung RPC worker [A].

**Impact.** The hang runs inside `withWorkerSlot(runRpcPath, signal)` (run-worker.ts:118-130 [W]), so the global
worker-cap slot is held indefinitely → pool starvation, not just one stuck task. `isEarlyRpcTransportFailure` never
fires (no result is ever returned). Blast radius today is bounded by the env gate (`PI_CREW_WORKER_TRANSPORT=rpc`,
experimental; argv maps only cwd/task/model — no agent cfg, system-prompt files, skills, transcripts, session
identity: rpc-worker.ts:47-66 [W] + `src/runtime/rpc/README.md` [S]) — but this is exactly the bug class that a
"default-on" promotion would turn into a permanent slot leak.

**Test gap.** `test/unit/runtime/run-worker-rpc-seam.test.ts` covers the happy path, pre-abort short-circuit, and the
`isEarlyRpcTransportFailure` truth table [W] — no scripted crash-before-settle case.

**Proposed fix (S–M).**
1. `await Promise.race([settledPromise, client.exited().then(() => { throw ... })])` — exit-before-settle with
   `tracking.settled === false` constructs a result with `error: "rpc transport: exited before agent_settled"` and no
   `rawFinalText`, which the existing early-failure predicate already classifies as retry-safe → the stdio fallback
   engages and the slot is released.
2. Add a configurable `turnTimeoutMs` (default ~10 min) as the belt-and-suspenders bound for a live-but-silent child;
   map the timeout to the same early-failure shape (respecting the double-execution guard, DR5).
3. New seam test: fake server ACKs the prompt, emits no `agent_settled`, exits — assert fallback ran and the cap was
   released (the suite already has a "slot released" follow-up-call idiom to copy).

### DR2 — `runtime.workerTransport` config key is dead + 3 stale doc blocks (MEDIUM)

**Problem.** The config trio declares and validates the key: `schema/config-schema.ts:139-145` (stale comment:
"currently the run-worker seam returns a structured not-implemented result instead of spawning"), `config/types.ts:129-134`
(same stale text), `config/config-validation.ts:390-396` (emits it, under an F19-1 comment requiring exactly that) — all
[W]. But the seam ignores it: `resolveWorkerTransport()` reads only the env var
(`rpc-worker.ts:~67-76` [W], self-documented: "runWorker has no config access — packet §A"), and
`env-vars.ts:458-461` repeats the stale not-implemented text [W]. So a user setting `runtime.workerTransport: "rpc"`
gets a silently-ignored value, and three doc blocks describe a state that ended at e2728f68.

**Impact.** Silent config no-op (user believes they enabled RPC; stdio runs) + maintainer doc drift. Same failure
family as the test debt: declared surface vs actual behavior drifting apart after a wave lands.

**Proposed fix — leader decision D1.** Either (a) plumb it: thread the resolved config down to the `runWorker` seam
(env still wins as override — the repo's established precedence), effort S–M since runWorker's callers already carry
`runtimeConfig`; or (b) reject `workerTransport` at validation with "experimental — env-gated only
(PI_CREW_WORKER_TRANSPORT)" until plumbed, effort S. Either way rewrite the three stale blocks (schema, types,
env-vars) in the same commit. Note the F19-1 comment's rule ("every key declared MUST be emitted here or the key is
dead") is necessary but not sufficient — emission without a consumer is still dead; worth one line in that comment.

### DR3 — `CURSOR_MARKER` named import vs `*`-ranged peer (MEDIUM)

**Problem.** `mailbox-compose-overlay.ts:26` and `settings-overlay.ts:7` do
`import { CURSOR_MARKER } from "@earendil-works/pi-tui"` [W], while `package.json:136` declares that peer as `"*"`
[W] (devDeps pin `^1.0.0`, package.json:152 [W]). A named ESM import binds at module load: a host whose pi-tui
predates the export fails the **entire extension load**, not just the IME feature. The repo's own R3-9 work solved
the identical problem defensively — `widget-renderer.ts:~109-118` resolves `hyperlink` through a namespace import +
typeof check with an explicit rationale comment ("the peer range is `*`, so a host running a pi-tui build without
the export must still render the plain dock instead of failing the namespace import") [W]. R3-6 (the CURSOR_MARKER
adoption) contradicts that pattern.

**Impact.** Extension fails to load on older pi-tui hosts. Mitigant (unverified — coverage gap): whether such hosts
exist in practice. Severity stays MEDIUM because the failure mode is total (module load) and the fix is cheap.

**Proposed fix (S).** Mirror the `tuiHyperlink` pattern: `import * as piTui`, resolve `CURSOR_MARKER` via
typeof-string check, fall back to a local constant (the marker is a short APC string; a local fallback preserves IME
behavior on new hosts and degrades to plain rendering on old ones).

### DR4 — `consumeAnsi` lacks an APC branch (MINOR)

**Problem.** `visual.ts:60-100` `consumeAnsi` handles CSI (`ESC [`) and — since R3-9 — OSC (`ESC ] … BEL/ST`)
[W]. It has no APC branch (`ESC _ … BEL`), which is the family `CURSOR_MARKER` rides [S — pi-tui format claim].
A `return 0` for `ESC _` makes `truncateToWidth`/`wrapHard` treat the marker's bytes as ordinary printable text
(~6 phantom columns) [W for the branch logic; width arithmetic follows from it].

**Impact.** Settings-overlay input rows flow through `padToWidth`→`truncateToWidth` (settings-overlay.ts:~416 with
marker sites at 602-612, 736-742 [S]); a near-full-width row can mis-measure and slice the marker mid-sequence →
raw escape bytes leak to the terminal or the fake cursor disappears. Mailbox-compose is safe by construction (marker
appended after truncate) [S].

**Proposed fix (S).** Add the APC branch next to the OSC loop (same BEL/ST terminators, same control-char
fallback), plus one width test with a marker-bearing string.

### DR5 — RPC fallback double-execution window (LOW-MED)

**Problem.** `isEarlyRpcTransportFailure` (run-worker.ts:73-79 [W]) retries on stdio whenever
`error !== undefined && rawFinalText === undefined && !aborted`. If the transport fails **after** the agent started
(first `message_start`) but **before** any assistant text was emitted, `rawFinalText` is still undefined → the task
re-runs on stdio. The predicate's docstring scopes it to "before any agent output / the turn never started"
(run-worker.ts:62-72 [W]) — the window between agent start and first text is not covered by that intent.

**Impact.** Side-effecting tasks (bash writes, file edits) can execute twice. Narrow window, env-gated, and the
guard's stated philosophy ("double-executing a task that already produced work is worse than surfacing the
transport error") argues the window should be closed the same way.

**Proposed fix (S).** Track "agent started" in `SettleTracking` (set on the first session event after prompt ACK);
treat started-but-unsettled failures as non-retryable (surface the error). Composes with DR1's fix — both consume
the same tracking struct.

### DR6 — `isOwnerSessionCurrent` fails open on undefined session id (LOW)

**Problem.** context-builder.ts:92-94 [W]:

```ts
isOwnerSessionCurrent: (gen, oid) => {
	const currentSid = ctx.currentCtx?.sessionManager?.getSessionId?.();
	return !ctx.cleanedUp && (oid === undefined || oid === currentSid) && (gen === undefined || gen === ctx.sessionGeneration);
},
```

When the host provides no `sessionManager` (or `getSessionId` returns undefined), the session-id comparison is
skipped entirely and only `cleanedUp` + the generation guard remain. This is the deliberate GH#62 compat trade-off
(`ownerSessionId = extensionCtx.sessionManager?.getSessionId?.()` — optional chaining, foreground-run-controller.ts:~101 [W]),
but it is not documented at the guard. Related nit: the failure branch labels stale-session failures
"… context disposed" (foreground-run-controller.ts:~145 [W]) — for a session that merely changed, the label misleads
debugging.

**Impact.** On hosts without sessionManager, a run started in session A can complete its reporting half in session B
(same generation). Accepted for compat; the gap is documentation + a misleading log label.

**Proposed fix (S).** One comment at the guard naming the trade-off; change the log suffix to distinguish
"owner session no longer current" from "context disposed".

### DR7 — Unconditional working-message clear, not keyed by runId (LOW)

**Problem.** The GH#62 finally-block clears the UI unconditionally
(foreground-run-controller.ts:~163-172 [W]: try `hasUI` → `setWorkingIndicator(extensionCtx)` +
`extensionCtx.ui.setWorkingMessage()`), and `setWorkingIndicator(ctx)` with no options forwards `undefined` to the
host (pi-ui-compat.ts:48-51 [W]) — host-side clear, with no runId key anywhere in the compat layer.

**Impact.** Safe iff at most one foreground run is active per session at a time (the earlier run's finally would
otherwise blank a newer run's spinner/message). That invariant is real today [S — controller map keyed by
runId/Symbol exists precisely to allow overlap] but untested; nothing pins it.

**Proposed fix (S).** Cheapest: a test pinning the invariant (start run A with runId, start run B, finish A → assert
B's working message survives, or explicitly assert and document the accepted clobber). Only key the clear through
the host API if Pi ever offers a keyed variant.

### DR8 — Mixed session identity on partial forwarded `--session-id` (LOW)

**Problem.** `appendWorkerSessionArgs` (session-recovery.ts:110-137 [W]) fills in each missing flag independently —
correct for the battery bug it fixed (ad663aa2) — but a builder that forwards `--session-id <otherValue>` keeps that
value while pi-crew adds its own `--session-dir`: the worker resumes session A's identity but writes artifacts to
pi-crew's dir for B. No in-tree caller forwarding a mismatched id was verified (shard 04 flagged; unresolved).

**Impact.** Latent: crash recovery would read a split identity. Requires a caller pattern not confirmed to exist.

**Proposed fix (S).** When a forwarded `--session-id` value differs from `ctx.sessionId`, log a warn and prefer ctx
(or refuse). Audit `deriveSessionPaths` call sites once to close the question.

---

## 3. Verification evidence

### 3.1 Writer spot-checks (07_write, this session)

Sampled the load-bearing claims; **all confirmed** (ranges read, anchors ±2):

1. rpc-worker.ts (full) — `settledPromise` resolved only by `agent_settled` or abort-branch; `client.exited()` after
   the await; `resolveWorkerTransport` env-only with the "no config access" note (DR1, DR2).
2. run-worker.ts (full) — early-failure predicate semantics; env-gated seam; `withWorkerSlot(runRpcPath, signal)`
   wrap; stdio fallback inside the same slot (DR1, DR5).
3. frame-client.ts:195-264 — stdout end/close → `finalizeStream` → `failPending` (pending commands only) (DR1).
4. context-builder.ts:80-109 — the fails-open guard verbatim (DR6).
5. foreground-run-controller.ts:85-174 — GH#62 guard + unconditional clear + "context disposed" label (DR6, DR7).
6. pi-ui-compat.ts:35-64 — `setWorkingIndicator(ctx, options?)` forwards `undefined` (DR7).
7. config trio + env-vars — `workerTransport` parsed/emitted; all three stale "not-implemented" blocks present (DR2).
8. mailbox-compose-overlay.ts:26 / settings-overlay.ts:7 / package.json:132-137,152-153 — named import vs peer `*` (DR3).
9. widget-renderer.ts:106-123 — the defensive `tuiHyperlink` pattern with its rationale comment (DR3 contrast).
10. visual.ts:55-109 — CSI+OSC branches only, no APC (DR4).
11. session-recovery.ts:103-142 — per-flag fill logic (DR8); pre-execution.ts:150-169 — handoff budget wiring (§4.1).
12. team-tool/run.ts:1-24 — `_typeCheck … null as never` hack at 12-13 + lazy wrapper (QW#4, §4.2);
    lifecycle.ts:1-30 — removal NOTE documenting the af462d7b dead-code deletion (§4.1).

### 3.2 Analyst cross-checks (06_synthesize)

- Resolved 4 cross-shard UNCERTAINs by direct read: fails-open guard (DR6), handoff-budget location/wiring (§4.1),
  `setWorkingIndicator` clear semantics (DR7), and **no turn-timeout anywhere on the runWorker path** (grep
  `timeoutMs|deadline` across `src/runtime` — all hits on other paths; abort-signal is the only rescue channel) (DR1).
- Multi-shard consensus (≥3/4): delta stats, HEAD state, RPC env-only, GH#62 sound, lifecycle cleanup clean,
  lingering risks untouched.

---

## 4. Verdict tables

### 4.1 Verified SAFE in this delta

| Area | Commit | Verdict + evidence |
|---|---|---|
| Foreground-run completion fix (GH#62) | 62c9ed0d | Sound. Identity-free `isOwnerSessionCurrent` guard for the reporting half; unconditional UI clear in try/catch by design (disposed ctx ⇒ host already reset). Residuals filed as DR6/DR7, not blockers. [W controller+guard; 242-line pinning suite `foreground-run-completion.test.ts` [S]] |
| render-loop.ts extraction (QW#2) | 3ab2d3b6 | Verbatim move; pure helpers exported and test-pinned (`lifecycle-health-filter`, `preload-idle-render`); `buildFrame` uses the `manifestCache.list(20)` API the stale fake lacked. [S 02/03] |
| lifecycle.ts dead-code removal | af462d7b | Clean: 0 callers of the removed pair; in-file NOTE documents the rationale; the remaining direct identity check (lifecycle-handlers.ts:342) compares the same `session_start` ctx object — safe by construction. [W lifecycle.ts; S 03/05] |
| Handoff budget trim | (pre-delta src + d7923d38 test alignment) | Complete config plumbing — the counter-example to DR2: `applyHandoffBudget` (task-output-context.ts:551-736 [A]; default 1800, ceiling 1M, env `PI_CREW_HANDOFF_BUDGET_TOKENS`), wired at pre-execution.ts:155-162 [W], config at config-validation.ts:334-385 [A] + env registry [A]. Leader-text override passes through unbudgeted, as documented. |
| Session per-flag idempotency | ad663aa2 | Correct for its battery bug; both argv arrays mirrored; deriveSessionPaths fail-closed. Edge filed as DR8. [W] |
| OSC-8 dock link (R3-9) | 401cebf9 | Degrades cleanly both ways (no artifactsRoot → plain; no `hyperlink` export → plain). [W renderer; S 03] |
| QW#5 renames | 2fe53dae | Zero output change. Nit: a 4th same-name formatDuration helper remains at team-onboard.ts:83 [S]. |
| Zombie foreign scan (R3-16) | (delta +175) | WARN-only by design; exact-value marker match (avoids claude-code values); never kills foreign processes. [S 02/04] |
| Skill dedupe (R3-23) | (delta) | `advertisedByHost` gated to index-mode; rollback `PI_CREW_PROMPT_SKILLS=full` intact. [S 02/04] |

### 4.2 Outstanding risks — unchanged by this delta (delta-checked, not re-audited)

| ID | Risk | Status after delta |
|---|---|---|
| R3-5 | Hardcoded crew shortcuts / no `KeybindingsManager` | Untouched (no delta file). [S] |
| R3-8 | `streamSimple` host-side LLM path | Untouched (0 uses). [S] |
| R3-13 | `importFromJsonl` true-resume | Untouched; session-recovery wave (DR8's area) did not adopt it. [S] |
| R3-14 | `theme.style()` semantic tokens (~0 uses vs ~179 hand-composed sites) | Untouched — and the UI wave **added** hand-written surface (+57 widget-renderer.ts), so the debt likely grew. Inventory not run (gap). [S] |
| QW#4 | lazyProxy wrappers + `_typeCheck = null as never` hack | Still present — `team-tool/run.ts:12-13` [W]; wrapper pattern team-tool.ts:~30-53 [W]; 2026-10-01 review evidence still accurate. [S 04/05] |
| #9 | RSS heap-profiling | Not in delta; only heartbeat `heapUsedMb`/`rssMb` (background-runner.ts:104-105 [S]). |
| #10 | CrewBroker split | Not in delta; `crew-broker.ts` now 1,908 lines (client 713) — split progress: modules extracted around it, main file still growing. [S] |

---

## 5. Test debt & CI-red recurrence

### 5.1 Root cause is process, not (only) more stale assertions

The three recent CI-red rounds decompose into three classes, all *tests stale vs code* [S 02]:
literal-count assertions (`task-handoff-template.test.ts` "4→5 subsections", d7923d38), platform assumptions
(win32 file URL → `pathToFileURL`, db70cc82), and fakes drifting from the real interface (a `Map` lacking `.list`
vs the real cache, 3ed0067e). But the **root cause is the release gate running `test:critical` only** — d7923d38's
own message records this. Until the gate broadens, a 4th round is a matter of time (leader decision D3).

### 5.2 Remaining sweep targets (identified, NOT executed this round)

`dependency-tee.test.ts` (+26 in delta), `crew-widget.test.ts`, `overlays-rail.test.ts` (+40),
`widget-schedules-line` / `widget-truncate` — each pins internals of refactored files; check before the next release.
Plus one **new** real gap found by this review: the RPC seam suite has no crash-before-settle case (DR1 §2).

---

## 6. Common threads

1. **Env-first, config-later seams create plumbing debt + doc drift** (DR2) — the same declared-vs-actual drift
   family as the test debt; the F19-1 comment checks emission but nothing checks consumption.
2. **Experimental seams wired without lifecycle guards** (DR1, DR5) — the seam handles the happy path and the
   pre-abort path carefully, but not exit-races or turn bounds; live-fire probes prove the protocol, not the
   failure modes.
3. **Fails-open guards are compat trade-offs that nobody wrote down** (DR6, DR8) — the code is deliberate; the
   missing artifact is the comment/test that keeps the next reader from "fixing" or tripping over it.
4. **Compat patterns applied inconsistently at the same boundary** (DR3 vs R3-9) — one commit defends the `*`
   peer range, the next binds a named import to it.

---

## 7. Leader decisions requested

- **D1 (DR2):** `runtime.workerTransport` — plumb config→seam (env wins as override) vs reject-at-validation until
  plumbed. Either is fine; do not leave the silent no-op.
- **D2 (DR1):** schedule the settle-hang fix **before** any promotion of the RPC transport out from behind the env
  gate (the fix is small: race `exited()` + `turnTimeoutMs` + one test; DR5 composes with it).
- **D3 (§5.1):** broaden the release gate (full suite, or at minimum the touched-area suite) to stop the CI-red
  recurrence; consider a lint/test that flags config keys parsed-but-unread.
- **D4 (DR3/DR4):** default proposal — apply the defensive resolution + APC branch as one small UI-hygiene commit;
  no controversy expected, listed only because DR3's severity depends on the unverified host matrix.

---

*Written by 07_write from the 06_synthesize unified finding set (merge of shards 02/03/04/05; discovery by 01).
Writer spot-checks: 12/12 confirmed (§3.1). No other pi-crew files modified; nothing committed (per task packet
commit policy). Coverage gaps that keep this document honest: §0 gap table.*
