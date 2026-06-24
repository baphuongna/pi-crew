# Fix Plan — HB-003a: `ctx.agent({disableTools:true})` returns `exit null`

> **Status:** PROPOSED (planning only — not yet implemented)
> **Discovered:** 2026-06-24 real-world smoke testing (see `CHANGELOG.md` "Known issues")
> **Severity:** medium (blocks the `disableTools:true` verdict-judge pattern; workaround exists)
> **Owner:** TBD
> **Related:** HB-004 (smoke-test harness), commits `c55d3e2` + `ab481e6` (sibling bugs already fixed)

## 1. Problem statement (confirmed evidence)

`ctx.agent({disableTools: true})` (and the equivalent direct `runChildPi({agent:{disableTools:true}})`)
returns `exitCode: null` (process killed by signal) instead of `0`, **only when the
calling process exits promptly after the promise resolves.** If the caller stays alive
~10s after `runChildPi` resolves, `exitCode` comes back `0` correctly.

### Repro matrix (all verified 2026-06-24)

| Scenario | disableTools | Caller keep-alive | Result |
|---|---|---|---|
| `pi --no-tools ...` standalone | yes | n/a | ✅ exit 0, correct answer |
| `runChildPi` + keep-alive 10s | yes | yes | ✅ exitCode=0, finalDrain=true |
| `runChildPi` + exit immediately | yes | no | ❌ exitCode=null |
| `runChildPi` (has tools) | no | either | ✅ exitCode=0 |
| DWF `ctx.agent({disableTools:true})` | yes | (workflow) | ❌ exit null |

### What the lifecycle events show (failing case)

```
spawned → exit(code=null) → close(code=null)
```

**Notably ABSENT:** `final_drain`, `hard_kill`, `response_timeout` lifecycle events.
So the signal did NOT come from `child-pi.ts`'s own timers. `stdout` *does* contain
the model's answer — pi produced output, then died via signal.

## 2. Root-cause hypotheses (to confirm in Phase 0)

### ✅ PHASE 0 COMPLETE — root cause confirmed (2026-06-24)

**Root cause: erroneous steer-backpressure kill at `child-pi.ts:716-726`** (NOT the
final-drain race hypothesised in H1).

When `maxTurns` is reached on a `turn_end` event, the code injects a "wrap up"
steer by writing to `child.stdin`. Node's `writable.write()` returns `false` when
the internal buffer is above the high-water mark (normal backpressure) OR when
the stream is draining. The current code treats **any** `false` return as a
fatal injection failure and calls `killProcessTree(child.pid, child)` → SIGTERM.

This fires deterministically for the `ctx.agent({maxTurns:1, disableTools:true})`
pattern (and the smoke-test repro): with `--no-tools`, pi finishes in exactly one
real turn, so `turn_end` arrives the instant the answer is ready; pi has nothing
more to read from stdin, the write returns `false`, and the worker is killed mid-
answer. The answer IS in stdout, but exit comes back `null` (SIGTERM).

**Repro confirmed via Phase-0 instrumentation** (`PI_TEAMS_DEBUG=1`):
```
[pi-crew:child-pi.kill-process-tree-invoked] pid=783270 called from:
    at killProcessTree (src/runtime/child-pi.ts:102:23)
    at Object.onJsonEvent (src/runtime/child-pi.ts:731:11)   ← steer-backpressure kill
```
maxTurns=1 × 5 runs: 3/5 exit=null (flaky, depends on OS buffer state).
maxTurns=5 × 5 runs: 5/5 exit=0 (soft limit not hit on turn 1).

**The `disableTools` correlation was a red herring** — the real trigger is
`maxTurns:1` (the smoke workflow happened to combine both). Any single-turn
agent call hitting `maxTurns` on its first `turn_end` can reproduce this.

### Original hypotheses (kept for the audit trail)

The killer was initially unidentified because the `signal` arg of the `exit`
event was discarded. The leading hypotheses, in priority order:

- **H1 (DISPROVEN): final-drain timer race.** Instrumentation showed
  `forcedFinalDrain=false` on failing runs — the final-drain timer was armed but
  never fired. The SIGTERM came from elsewhere.
- **H2 (DISPROVEN): pi self-terminates via signal.** stdout contains the answer;
  the kill-process-tree caller stack points squarely at the steer-injection path.
- **H3 (already ruled out): external signal / parent-guard.** `startParentGuard`
  is never invoked in `src/`; abort would set `cancelled:true` (it stayed false).

## 3. Phased plan

### Phase 0 — Diagnostic (READ-ONLY, no behavior change)  [~0.5 day]

Goal: identify the exact signal and the code path that sent it. **No fix yet.**

1. **Capture the signal.** In `child.on("exit", (code, signal) => ...)`, add `signal`
   to the `exitStatus` record and to the `exit` lifecycle event payload. Also capture
   `forcedFinalDrain`, `hardKilled`, `finalDrainTimer` truthiness, and a timestamp
   relative to spawn. This is the single highest-value change — it turns the bug from
   "exit null, cause unknown" into "exit null via SIGTERM at T+Xms while timer armed".
2. **Add a focused repro workflow** `.crew/workflows/debug/dwf-disabletools.dwf.ts`
   already exists — extend it to log `exitStatus` (signal, forcedFinalDrain, timing).
   Re-run until the captured data distinguishes H1 vs H2.
3. **Confirm H1 with a log-only check:** temporarily log the wall-clock time of
   `forcedFinalDrain = true` vs the `exit` event. If `exit` precedes the assignment,
   H1 is confirmed.
4. **Exit Phase 0** with a written finding (append to this file's §2): which signal,
   which path, deterministic repro steps.

**Deliverable:** amended §2 with the confirmed root cause; no commit to `main`
beyond the read-only instrumentation (kept behind a debug flag or reverted).

### Phase 1 — Fix  [~0.5 day]

**Confirmed fix: stop killing the worker on a normal backpressure `write() === false`.**

At `child-pi.ts:723-726`:
```ts
const writeSucceeded = child.stdin.write(steerPayload);
if (!writeSucceeded) {
  logInternalError("child-pi.steer-backpressure", ...);
  steerInjectionFailed = true;
  killProcessTree(child.pid, child);   // ← BUG: backpressure is not fatal
}
```

`Writable.write()` returning `false` is **normal backpressure** — Node buffers the
write and emits `'drain'` later. It does NOT mean the write failed. Killing the
worker on it destroys a perfectly good answer (stdout already has it). The
original intent was to handle a genuinely unwritable stdin (the `else` branch at
line 727 logs `steer-not-writable` and ALSO kills — that one is more defensible
but still too aggressive).

**Proposed change:** keep the steer-injection best-effort. On `write() === false`,
simply wait for `'drain'` (or do nothing — the soft-limit steer is advisory). If
the worker ignores it and runs past `maxTurns + graceTurns`, the existing hard-
abort at line 735 (`turnCount >= maxTurns + graceTurns`) already terminates it.

```ts
const writeSucceeded = child.stdin.write(steerPayload);
if (!writeSucceeded) {
  // Backpressure: Node buffered the write and will flush on 'drain'. This is
  // NOT a failure — do NOT kill the worker. The steer is advisory; if the worker
  // keeps running, the hard-abort at maxTurns + graceTurns (line ~735) handles it.
  logInternalError("child-pi.steer-backpressure", new Error("stdin write returned false (normal backpressure); steer buffered, worker NOT killed"), `pid=${child.pid}`);
}
```

Keep the `else` branch (stdin not writable at all) as-is for now, but downgrade
it too in a follow-up — a closed stdin after the worker is done is also not fatal.

**Verification gate:** the repro matrix in §1 must go all-green with `exitCode=0`
and the answer present in stdout, run **10× consecutively** (the bug is flaky at
~60%, so a single pass is insufficient). No regression in the existing
`test/unit/child-pi-*.test.ts` suites (5 files, ~85 tests). Add a unit test that
fakes a `child.stdin` whose `write()` returns `false` and asserts the worker is
NOT killed and the buffered write eventually flushes.

### Phase 2 — Regression prevention (HB-004)  [~1 day]

Land the smoke-test harness proposed in `HB-004` so this class of bug is caught by
CI, not only by live runs. Gate behind `PI_CREW_SMOKE=1` (token cost). Minimum:
one workflow per feature family that actually shells out to real `pi`
(`agent` plain, `agent`+schema, `agent`+disableTools, `pipeline`, `phase`/`log`).
Add a CI job (manual-dispatch workflow) that runs the smoke suite on
ubuntu/windows/macos × Node 22.

## 4. Files touched (estimate)

| Phase | File | Change |
|---|---|---|
| 0 | `src/runtime/child-pi.ts` | capture `signal` + timing in `exit`/`exitStatus` (log-only) |
| 0 | `.crew/workflows/debug/dwf-disabletools.dwf.ts` | extend logging |
| 1 | `src/runtime/child-pi.ts` | Fix A: `finalDrainArmed` + close-handler override |
| 1 | `test/unit/child-pi-*.test.ts` | add race-simulation unit test (fake child emitting exit before forcedFinalDrain) |
| 2 | `test/smoke/*.dwf.ts` (new) | HB-004 harness |
| 2 | `.github/workflows/smoke.yml` (new) | manual-dispatch smoke CI |
| 1 | `CHANGELOG.md`, `docs/troubleshooting.md` | move "Known issues" entry to "Fixed"; remove workaround note |

## 5. Test plan

- **Phase 0:** before/after instrumentation output showing the captured signal.
- **Phase 1 unit:** a unit test that injects a fake child process whose `exit`
  fires with `code=null` *before* the timer callback runs, asserting `finalExitCode === 0`
  and that stdout content is preserved. This is the regression guard for the race.
- **Phase 1 real-binary (manual):** re-run the §1 repro matrix; all rows ✅.
- **Phase 1 regression:** `npm run test:unit` + `npm run test:integration` green;
  typecheck + lazy-imports clean; TABS.
- **Phase 2 CI:** smoke workflow green on all 3 OSes.

## 6. Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| Fix A hides a *real* crash as a clean exit | medium | Telemetry log (`final-drain-zero-exit` style) on the override; only override when stdout is non-empty AND finalDrain timer was armed. Never override `responseTimeoutHit` or `abortRequested` paths. |
| Race fix changes behavior for the common (has-tools) path | low | The `finalDrainArmed` condition only adds to the existing `forcedFinalDrain` branch; has-tools path already sets `forcedFinalDrain=true` normally. Unit test covers both. |
| Cross-platform signal differences (Windows has no signals) | medium | Windows already uses `taskkill`/`undefined` signal semantics; Fix A keys off `exitCode === null` which is platform-consistent for signal/force-kill death. Verify on Windows CI. |
| Phase 0 instrumentation itself changes timing | low | Keep it log-only; use monotonic `performance.now()`; revert before merge if it perturbs the race. |

## 7. Out of scope

- P2-2 VM sandbox / isolated-vm (separate, v1.5).
- Refactoring the 919-line `child-pi.ts` (tempting but out of scope; surgical fix only).
- Changing the final-drain timeout constants (`FINAL_DRAIN_MS=5s`, `HARD_KILL_MS=3s`).
- The `runKind:'goal-loop'` foreground-dispatch note from smoke testing (separate item).

## 8. Open questions for Phase 0 — ANSWERED (2026-06-24)

All three resolved by the Phase-0 root-cause finding (steer-backpressure kill,
NOT the final-drain race). Kept for the audit trail.

1. **ANSWERED: not the final-drain timer.** The keep-alive case returned `exitCode=0`
   by coincidence — the SIGTERM came from `killProcessTree` on the steer-injection
   path (`child-pi.ts:731`), not the final-drain timer (`forcedFinalDrain=false`
   on failing runs). Keep-alive merely changed the OS-buffer state so the stdin
   `write()` happened to return `true`. Red herring.
2. **ANSWERED: yes — the steer-injection path (`child-pi.ts:716-726`).** Stack
   capture under `PI_TEAMS_DEBUG=1` proved `killProcessTree` was invoked from
   `onJsonEvent` on a `turn_end` where `maxTurns` was reached and `stdin.write()`
   returned `false` (normal backpressure, mis-treated as fatal).
3. **ANSWERED: no extension self-termination.** The kill stack is entirely
   inside `child-pi.ts`; the prompt-runtime extension is not on the stack.

---

**Recommendation:** execute Phase 0 first (cheap, read-only, removes all guesswork),
then pick Fix A or B based on the finding. Do NOT implement Phase 1 blind — the bug
is in core runtime and a wrong fix could mask real crashes across every agent call.
