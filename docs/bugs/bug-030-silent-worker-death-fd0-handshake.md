# RCA: Silent Worker Death (v0.11.46/0.11.47) — fd0 Handshake Race

**Date:** 2026-10-27 (introduced) · 2026-10-28 (root-caused, closed)
**Severity:** Critical (all gate-ON headless workers died silently; secret leak on one race ordering)
**Status:** CLOSED — v0.11.49 (fd3 transport), v0.11.50 (DEFAULT-ON flip)
**Owner:** pi-crew lead session (2026-10-28 review → cold-verify → fix wave)
**Affects:** every brokered headless JSON child-pi worker spawned with `PI_CREW_BROKER_STDIN=1`
**Commits:** introduce `eed005b3` (46) / `68788df4` (47) · mitigate `d55632d0`+`840900b3` (48, opt-in OFF) ·
root-cause fix `0977ff1b` (fd3) · dead-wire repair `38d5ed58` (FIX-1) · seam `fd87297c` · flip `6890f19f` (0.11.50)

---

## 1. Summary

The v0.11.46 LOW-1 feature moved the inter-pi broker token out of the child env and onto the
child's **stdin (fd0)**. But a spawned `pi` binary treats piped fd0 as **prompt content** — so the
handshake raced pi's own stdin reader three ways: worst case the token JSON got merged into the
worker's prompt (**secret leak**), common case the worker **exited 0 silently with zero stdout**.
Fixed by moving the handshake to a **dedicated fd3 pipe** (stdio entry 4) so fd0 is never touched;
the route is DEFAULT-ON since v0.11.50 (`PI_CREW_BROKER_STDIN=0` opts out).

## 2. Symptom

Observed on real dispatches (2026-10-27, versions 0.11.46/0.11.47):

- Worker process exits **code 0** after **~1s**.
- **0 bytes stdout** (expected: 100KB+ of session/agent JSONL events).
- No stderr, no events.jsonl output, no error anywhere — the task just never produces work.
- Rate: **5/5 (100%)** of gate-ON headless spawns on pi@1.0.4.
- One variant left `[t7-nonce]`-adjacent JSON fragments inside the worker's *prompt transcript*
  (the leak shape, reproduced live; see §6).

## 3. Root Cause

`pi@1.0.4` `dist/main.js:52-65` — `readPipedStdin()` consumes **ALL piped stdin as PROMPT CONTENT**
in every mode except `--mode=rpc`. pi-crew's v0.11.46 handshake wrote one JSON line to the child's
**fd0** and read it back with a `pause()`d reader. Three race orderings:

1. **Leak:** pi's `readPipedStdin` drains the handshake JSON first → the token line becomes part of
   the prompt → leaked into the transcript AND the worker runs with garbage prompt content.
2. **Creds-less silence:** stream `end` fires before the worker reader attaches → reader sees EOF,
   gets no payload → worker proceeds without broker creds (task silently no-ops).
3. **Deadlock → self-exit 0:** the worker-side reader calls `pause()` on fd0 before draining EOF;
   pi's boot `await readPipedStdin()` never resolves → pi times out and **exits 0 on its own**
   (strace initially misread this as a parent-delivered SIGTERM; it is self-initiated), with
   `takeOverStdout` buffering leaving stdout at ~0 bytes — the exact incident signature.

The bug is **not** in the handshake framing (writer/reader format was correct); it is the
**choice of channel**: fd0 is owned by pi's prompt pipeline, not available to extensions.

## 4. Why It Produced the Symptom

`child-pi-spawn.ts` composed a 4-entry stdio table where **fd0 was the handshake pipe** for the
headless JSON branch. Worker bootstrap (`crew-broker-child.ts: startChildBrokerClientAsync`) read
fd0 for the payload. Every gate-ON spawn therefore had TWO readers on one pipe: pi's own
`readPipedStdin` (mandatory, at boot, every mode but rpc) and the extension reader — a
last-reader-wins race. Ordering 3 (most common on Linux) kills pi at boot → exit 0, stdout buffered
to nothing → "silent death". Ordering 1 is worse than death: the credential meant to leave the
process boundary via env **re-entered via the prompt** — the exact secret LOW-1 tried to protect.

## 5. Fix

**`0977ff1b` (v0.11.49):** handshake moved to a **dedicated fd3 pipe** — stdio entry 4
`["ignore","pipe","pipe","pipe"]`; fd0 returns to `"ignore"` (pre-0.11.46 shape, so pi's stdin
reader can never see extension traffic). Reader: `readFirstLineFromFd(BROKER_HANDSHAKE_FD=3)`
in `src/runtime/broker/stdin-handshake.ts` (bounded, missing-fd → `undefined`, never throws).
Detached runner (node process, not pi) keeps fd0 — no race there.

**`38d5ed58` (FIX-1, same release):** the dead-wire repair found by cold-verified review — the
opt-in flag never reached the child (ambient env stripped, registry kind wrong), so even gate-ON
spawns were creds-less NOOPs. Flag reclassified `child-write`, spawner re-writes
`PI_CREW_BROKER_STDIN="1"` into `built.env`; token written to `built.env` for the RPC/surface
branches (their only credential source; also disarms their fallback), stripped from FINAL env only
on the headless-JSON compose — there alone the token rides fd3.

**`6890f19f` (v0.11.50):** both gates flipped `=== "1"` → `!== "0"` — **DEFAULT-ON**, exact `"0"`
opts out (runtime kill-switch / bit-for-bit rollback). FIX-1's `"1"` write stays: pins the child
route and keeps default-ON parents compatible with pre-flip workers.

**Contract (durable):** fd0 is NEVER a sideband channel for an extension spawning the pi binary —
use stdio entry 4+ (fd3).

## 6. How It Was Found

- **Repro:** gate-ON spawn of real pi@1.0.4 headless worker → 5/5 silent exit-0 (~1s, 0B). This
  made it deterministic.
- **Leak proof:** live transcript of a racing spawn contained the handshake JSON (`v":2` fragment)
  inside the prompt content — ordering 1 demonstrated, not just theorized.
- **Hypotheses rejected:** parent SIGTERM (strace showed `exit_group(0)` self-initiated — the
  earlier strace read was wrong); pipe backpressure; worker-side exception (none logged anywhere);
  env-strip of the flag (real, but a *second*, independent bug — the dead wire, FIX-1).
- **Single confirming experiment:** spawn pi@1.0.4 with an arbitrary JSON line piped to fd0 in
  default mode → observe the line arrive as prompt content (consumed by `readPipedStdin`, source
  `dist/main.js:52-65`). Same spawn post-fix (fd3) → 2/2 alive, 106–110KB stdout, zero leak.
- Cold-verification (3 adversarial agents, bare claims) refuted zero substance and downgraded 2
  findings — worth noting the chained verifier had confirmation-biased one claim the cold check
  refuted via type defs.

## 7. Why It Slipped Through

- **Unit seams were structurally blind:** every handshake unit test injected the
  `readHandshakeLine` seam — the real fd reader never ran against a real pi process. The bug lived
  precisely in the seam's shadow (real fd mechanics vs a mock).
- **The live battery (T7) was not yet a hard gate** at 0.11.46/47 ship time; the
  `pre-publish-battery.mjs` HARD-GATE (commit `85de1893`) landed *as a consequence* of this
  incident, then T7 gained nonce binding (no wrong-run judging) and stdout/stderr capture.
- **Version-skew assumption:** the feature was developed believing fd0 semantics matched the
  detached-runner path (a node process where fd0 is private). Nobody re-validated the contract
  for the pi binary.
- The v0.11.48 mitigation (route opt-in, default OFF) was correct risk management but kept the
  broken channel — it took the root-cause pass to find the channel itself was wrong.

## 8. Validation

- Original repro: **5/5 silent death → 2/2 alive** post-fix (106–110KB stdout, ~3.2s, no leak).
- `test/integration/broker-stdin-reader-liveworker.test.ts` — 3 live pins, real pi binary:
  default+fd3 payload → alive + no leak; explicit `1`+fd3 → alive + no leak; old-parent skew
  (gate unset, no fd3 pipe) → bounded missing-fd read → creds-less **alive**.
- Battery (real fast-fix dispatch through real pi): ALL GREEN repeatedly, incl. soak **×3
  consecutive** on the 0.11.50 flip commit (140s/101s/108s) — every T7 now dispatches through the
  DEFAULT fd3 route.
- Unit matrix re-pinned for DEFAULT-ON semantics (gate resolution incl. garbage values, spawn
  compose, reader arm/disarm, FIX-1 env matrix). CI matrix 3-OS × Node 22+24 green on both tags.
- Not separately validated: non-Linux fd3 mechanics under `--mode=rpc` (explicitly skipped by
  design — rpc argv never arms the reader); win32 fd-mechanics unit tests are skipped by platform
  contract.

## 9. Action Items

- [x] Regression tests at the REAL seam (live pi, real fd3) — `broker-stdin-reader-liveworker.test.ts`
  (was: nothing ran the real reader; now 3 pins). Owner: pi-crew lead.
- [x] CI/publish gap closed: battery HARD-GATE `scripts/pre-publish-battery.mjs` wired into
  pre-push + `prepublishOnly` (T1/T3/T11j always; T7 auto on src/runtime|prompt|config|…|scripts
  diff). "Gate KHÔNG CHẠY = KHÔNG PUBLISH." Owner: pi-crew lead, commit `85de1893`.
- [x] T7 judge hardened: nonce binding + non-terminal=FAIL + stdout/stderr capture (`38d5ed58`).
- [x] Contract documented: fd0-never-private in `skills/real-test-pi-crew/SKILL.md` (2026-10-28-b/c
  update blocks) + this RCA. Owner: pi-crew lead.
- [x] `maxTasksPerRun` admission cap at manifest creation (found during the same review wave,
  `fd87297c`).
- [x] Cold-verify standard for important verdicts (chained verifier confirmed a claim the cold
  check refuted) — recorded in workspace knowledge.
- [x] Backlog DONE (`debd814b`, 2026-10-29): `waitForPreGateEvent` (classifier-pre-gate)
  now throws on timeout with diagnostics — the silently-returning poll surfaced as an unrelated
  CI flake during the 0.11.50 release ([pg-10]); CI matrix green on the fix commit.
