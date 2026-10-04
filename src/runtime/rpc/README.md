# RPC worker transport — W7 (P2-3) EXPERIMENTAL

Opt-in behind `PI_CREW_WORKER_TRANSPORT=rpc`. **WIRED at the run-worker seam as
of 2026-10-04** (integration phase, lane D6) after the live-fire probe below —
previously the seam returned a structured not-implemented result. The
production stdio child-pi path (`child-pi.ts`) is untouched for the default
transport; the rpc path carries a REDUCED input (see Limitations).

## What this is

A JSONL frame client that speaks the pi SDK's RPC mode protocol
(`pi --mode rpc`) on stdin/stdout, implementing the two Round-2 design gates
the adoption review (§R2.5) proved are mandatory for any RPC transport:

1. **`extension_ui_request` drain policy** (`ui-request-policy.ts`) —
   fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
   `set_editor_text`) are counted per method and dropped. Round-2 live
   evidence: 15 of the first 16 records a worker emits belong to this family.
2. **Dialog auto-answer policy** (`cancel` | `block`) — dialog methods
   (`select`/`confirm`/`input`/`editor`) park a server-side promise that NEVER
   resolves if unanswered (ask-over-RPC deadlock, R2.5). `cancel` (default)
   answers the universal safe answer `{type:"extension_ui_response", id,
   cancelled:true}` (select/input → undefined, confirm → false). `block`
   leaves it pending on purpose (debug). **There is no auto-confirm mode —
   deliberate security decision.** An unattended transport must never say
   "yes" for the user.

Counters (fake-stream asserted): `uiRequestsDrained`, `drainedByMethod`,
`dialogsCancelled`, `dialogsBlocked`, `malformedFrames`, `responsesMatched`,
`responsesUnmatched`.

## Deviation from "use SDK RpcClient" — recorded, evidence-based

The task's original phrasing said "transport dùng SDK RpcClient/runRpcMode".
The verified recon packet (adaptive-07) proved `RpcClient` unusable for this
prototype and the leader routed the packet through; deviation accepted per
packet §C:

1. **No public API to answer `extension_ui_request`** — `send`/`process` are
   private; non-response records go to event listeners only. Gate 2 would
   require bracket-accessing private members.
2. **Version skew** — `RpcClient.start()` spawns `node <cliPath ?? "dist/cli.js">`
   cwd-relative, NOT the host pi binary the stdio transport resolves
   (`getPiSpawnCommand` / `PI_TEAMS_PI_BIN`).
3. **Not injectable** — the W7 test requirement ("fake RPC stream, no real
   spawn") is impossible against `RpcClient`.

`runRpcMode` is a server-side embed API — inapplicable (pi-crew is a spawner,
not an embedder).

So: **own strict-LF frame loop over the SDK's exported protocol TYPES**
(`RpcCommand` / `RpcResponse` / `RpcExtensionUIRequest` /
`RpcExtensionUIResponse` — all imported from `@earendil-works/pi-coding-agent`).
The framing rule follows the SDK's own `modes/rpc/jsonl.d.ts` spec: split on
`\n` ONLY. **Node readline is unsafe here** — it also splits on U+2028/U+2029,
which are legal inside JSON strings. `serializeJsonLine` /
`attachJsonlLineReader` are not exported top-level, hence the ~15-line
hand-rolled splitter.

## Config & env

- `runtime.workerTransport: "stdio" (default) | "rpc"` — declared in
  `src/schema/config-schema.ts` + `src/config/types.ts`. **Config→seam plumbing
  is NOT wired yet** (needs a `parseRuntimeConfig` line in
  `config-validation.ts`, which is outside this lane's file ownership);
  the live gate is env `PI_CREW_WORKER_TRANSPORT` (`runWorker` has no config
  access — packet §A).
- `PI_CREW_WORKER_TRANSPORT=rpc` — selects the transport at the
  `run-worker.ts` seam. WIRED 2026-10-04: calls `runRpcWorker` for real
  (worker-cap slot semantics identical to stdio; early transport failure →
  one structured-warn fallback to the stdio path inside the same slot).
- `PI_CREW_RPC_DIALOG_ANSWER=cancel|block` — GATE 2 policy (default `cancel`,
  invalid fails safe to `cancel`).

## Why the seam was not wired before 2026-10-04

The original lane was not allowed to live-spawn pi, so a live-wired seam would
have shipped an end-to-end path that NO test could validate — one env var away
from silently degrading real runs. The integration phase (this lane) ran the
live-fire probe FIRST and only then flipped the seam.

## Live-fire probe 2026-10-04 — GREEN → seam wired

Probe setup: real `pi --mode rpc --no-session` spawned by the unmodified
frame-client default spawner (`getPiSpawnCommand`), scripts importing directly
from `src/runtime/rpc/` via `node --experimental-strip-types`, PI_CREW_* /
PI_TEAMS_* env scrubbed, isolated cwd `/tmp/rpc-lf/`, `timeout -k 5 120` per
run. Raw artifacts (kept on disk): `/tmp/rpc-lf/probe1{,b}.{log,stdout.txt,stderr.txt}`
(probe1b = default settings model), `probe2.*` (dialog), `probe3.*` (steer).

| # | Item | Result |
|---|------|--------|
| a | `extension_ui_request` drain (GATE 1 live) | **24 drained** on probe1b (`setStatus`×20, `setWidget`×3, `notify`×1 — pi-crew widget keys visible in raw frames); 0 malformed, 0 unmatched responses |
| b | prompt round-trip | ack **24 ms**, `agent_settled` **4.2 s**, `rawFinalText="OK"`, child exit **0**, orderly stdin-end shutdown |
| c | dialog (confirm) | **executed** (not skipped): a `-e` mini extension opened a real `confirm` → policy `cancel` answered `extension_ui_response {cancelled:true}` → `ui.confirm` resolved `false` → the model literally echoed `"false"`; settled 1.7 s, **no deadlock**, `dialogsCancelled=1` |
| d | steer mid-turn | `steer` at t+1.6 s → response RTT **53 ms**, disposition **`"queued"`**, final assistant text honored (`"STOP"`), settled 6.5 s, exit 0 |

First run (probe1) used `--thinking off` against a reasoning-only model
(`chiase/deepseek-v4.1-flash`, thinkingLevelMap has only `max`) → the assistant
message came back `content: []` with usage 0. Not a frame-client defect — the
turn still completed and settled — but a live argv caveat: **do not pass
`--thinking off` to reasoning-only models**; the wired seam passes the model
raw and never emits `--thinking`.

### Limitations of the wired rpc path (honest list)

- Input mapping is the minimal prototype surface: `cwd`/`task`/`model`/`signal`.
  Agent config, system-prompt files, skills, transcript path, steering file,
  lifecycle/stdout callbacks, `maxTurns`/`graceTurns` remain **stdio-only**.
- The model string is passed RAW (`--model <model>`), no `applyThinkingSuffix`
  composition — thinking level comes from the settings default.
- Workers are ephemeral (`--no-session`): no deterministic session identity
  (`--session-id`/`--session-dir`, W2 crash recovery) for rpc yet. Attaching a
  worker to the cwd project's default session would pollute the user's session.
- `runtime.workerTransport` config key is still NOT plumbed to the seam
  (needs a `parseRuntimeConfig` line in `config-validation.ts`, outside the
  lane's ownership); the env var is the only live gate.
- Early-failure fallback: only a result with `error` set, NO `rawFinalText`,
  and NOT aborted is retried on stdio (double-execution guard,
  `isEarlyRpcTransportFailure` in run-worker.ts).

## Files

- `frame-client.ts` — strict-LF JSONL frame client, pending-command map with
  per-command timeout, malformed-frame resilience (count + drop, never throw),
  orderly stop (stdin end → exit → SIGKILL fallback, kill-once guard).
- `ui-request-policy.ts` — the two design gates + counters.
- `rpc-worker.ts` — env resolvers (`resolveWorkerTransport`,
  `resolveDialogAnswerPolicy`), the live-fire argv builder
  (`buildRpcWorkerArgv`) + the `runRpcWorker` runner the seam calls.

## Production-ready? Honestly: NOT for general agent configs.

Live-fire validated for the probe scenarios above (small prompt, one confirm
dialog, one steer, plain model, default extensions). The stdio transport
remains the default and the only complete path (agent config, system prompts,
skills, session identity, retries semantics). Do not enable
`PI_CREW_WORKER_TRANSPORT=rpc` outside experiments until the Limitations
list above shrinks.
