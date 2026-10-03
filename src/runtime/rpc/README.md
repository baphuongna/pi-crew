# RPC worker transport — W7 (P2-3) EXPERIMENTAL PROTOTYPE

Opt-in, **not wired into live dispatch**. The production stdio child-pi path
(`child-pi.ts`) is untouched; `run-worker.ts` returns a structured
**not-implemented** result when the RPC transport is requested (see below).

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
  `run-worker.ts` seam. Currently produces the structured not-implemented
  result (honest prototype) rather than a live spawn.
- `PI_CREW_RPC_DIALOG_ANSWER=cancel|block` — GATE 2 policy (default `cancel`,
  invalid fails safe to `cancel`).

## Why the seam returns not-implemented instead of calling `runRpcWorker`

The task's honesty clause allowed exactly this: this lane may not live-spawn
pi (Round 2 already spent the live probes), so a live-wired seam would ship an
end-to-end path that NO test can validate — one env var away from silently
degrading real runs. `runRpcWorker` is complete and fake-stream unit tested
(prompt → `agent_settled` → orderly stop → `ChildPiRunResult` mapping, abort
via RPC `abort` command); flipping the seam is a one-line integration change
after a live-fire probe validates:

- the exact `--mode rpc` argv/env parity with `prepareSpawnContext`
  (print-mode argv assembly is stdio-specific),
- session/event stream shape assumptions (`message_end` assistant text →
  `rawFinalText`),
- the Round-2 remaining unknowns (`--approve` probe anomaly, rpc3).

## Files

- `frame-client.ts` — strict-LF JSONL frame client, pending-command map with
  per-command timeout, malformed-frame resilience (count + drop, never throw),
  orderly stop (stdin end → exit → SIGKILL fallback, kill-once guard).
- `ui-request-policy.ts` — the two design gates + counters.
- `rpc-worker.ts` — env resolvers (`resolveWorkerTransport`,
  `resolveDialogAnswerPolicy`) + `runRpcWorker` prototype runner.

## Production-ready? Honestly: NO.

Prototype-grade. Validated only against fake streams
(`test/unit/runtime/rpc/`). No live spawn has been attempted from this code.
