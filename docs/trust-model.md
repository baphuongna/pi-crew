# pi-crew Trust Model (single source of truth)

**Document version:** 1.5 (2026-11-01 — adds hướng A broker-signed respond
delivery: ADR Option 3 challenge-response + one-shot force, and updates the
residual gap statuses it moved)
**Date:** 2026-09-10 (v1.0) / 2026-10-18 (v1.1) / 2026-10-19 (v1.2) /
2026-10-31 (v1.3) / 2026-10-31 (v1.4) / 2026-11-01 (v1.5)
**Owner:** solo maintainer (delegated to upgrade program M6/WI-6.1)
**Supersedes:** trust-model content previously distributed across
`docs/bugs/SECURITY-ISSUES.md` (v3.0, last updated 2026-06-03) and
inline ADR comments.

This file is the authoritative trust-model document for pi-crew.
Other trust-model references should cite this file by path, not
duplicate.

## Trust boundaries

pi-crew operates across 4 distinct trust boundaries:

1. **Root session / orchestrator** — the pi session that owns the
   broker. Trusted: can issue tokens, can steer, can msg.send.
   User-scope mutations (config-user / settings-user+theme /
   autonomy / create-user / update-user / schedule / goal+force)
   are root-gated since Wave-3 (2026-10-17): worker-origin calls are
   denied with "root-session required"; reads and project scope
   stay open.
2. **Worker (child pi process)** — spawned by the orchestrator via
   `child-pi`. Trusted: has a valid token; CANNOT spawn its own
   grandchildren without delegate.request (gated).
3. **Guest (scratchpad cell)** — in-process vm.Script in the worker;
   can run user-supplied JS with a namespace.
4. **DWF (project-defined workflow)** — TS file in the project root
   `.dwf.ts`. Trusted only with explicit `PI_CREW_TRUST_PROJECT_DWF=1`.
   **The gate is PROJECT-source only**: builtin workflows and user-scope
   workflows (`~/.pi/agent/extensions/pi-crew/workflows/`) run without the
   gate (`dynamic-workflow-runner.ts:189`; see the DWF row below).

Each boundary has a documented FAIL-CLOSED/FAIL-OPEN default and a
known list of accepted risks.

## Open trust-model issues (WI-6.1 acceptance)

### F.1 + F.2 — SHIPPED

- F.1 — `crew.limits.unbounded_total` metric: wired at
  `src/observability/event-to-metric.ts:46`.
- F.2 — cardinality-eviction gauge: wired at
  `src/observability/metrics-primitives.ts:57-67`,
  `crew.metrics.cardinality_evicted`.

### E.2 — `v8.deserialize` unauth (NOT YET ASSIGNED)

| Field | Value |
|---|---|
| File:Line | `src/runtime/scratchpad/guest.ts:33` |
| Severity | HIGH (per docs/bugs/SECURITY-ISSUES.md history) |
| Owner | solo maintainer |
| Target version | v0.12.0 (M7 milestone — gated M1–M4 green) |
| Mitigation pending | guest.ts:439 (deserialize(buffer)) — verify input is from a trusted source. Current code: deserialize is only called on cells returned by the worker via the protocol pipe (FD 3 with nonce). The nonce auth mitigates the unauth concern. |
| Action | Document the mitigation in this trust-model doc (carried). NO code change in M6 window. |

Mitigation detail: the protocol pipe is bound to an end with a 256-bit
nonce. The nonce is set as `NONCE_ENV` in the child env, removed
immediately after the child process forks, and used to authenticate
incoming protocol frames on the FD-3 read loop. `v8.deserialize` is
only ever called on a frame whose first 8 bytes pass the nonce
check (`guest.ts:418` bounce-back path). The unauth concern from
E.2 (research G23) was theoretical; the production wire-up has
nonce-bounded authentication.

**Verdict**: E.2 = ACCEPTED RISK (not a vulnerability in current code
path). Target v0.12.0 in case the nonce auth surface expands.

### SEC-008 — EPERM Lock Stealing (ACCEPTED RISK, formally closed)

| Field | Value |
|---|---|
| File:Line | `src/state/coordination/locks.ts:49-67` (EPERM branch) |
| Severity | LOW (per docs/bugs/SECURITY-ISSUES.md §SEC-008) |
| Owner | solo maintainer |
| Target version | N/A — accepted risk; will not change |
| Mitigation | `docs/archive/ROADMAP-2026-Q3.md` R1-5 documented `limits.strictLockOwnership` opt-in gate. Default OFF; explicitly opt in via config. |

**Verdict**: SEC-008 = ACCEPTED. The deny path treats EPERM as
"not alive" because blocking indefinitely on a different-user holder
is worse than steal-on-EPERM. The opt-in gate exists for users who
want strict semantics; default OFF remains.

## Per-boundary trust summary

| Boundary | Trust baseline | Failure mode | Mitigation |
|---|---|---|---|
| Root session | full | crash → broker shutdown | broker stop() is idempotent |
| Worker | token (compound key) | revoke token | revokeTaskToken() + post-hello re-check on secret-hash |
| Guest | nonce + FD-3 protocol | EPERM/SIGTERM | guest exits 0 on EPIPE, host checks nonce every frame |
| DWF (**project** source only) | `PI_CREW_TRUST_PROJECT_DWF=1` (literal `1`; the gate compares `!== "1"` — `true` FAILS, see `dynamic-workflow-runner.ts:189`) | deny | `dwf.trust_denied` event emitted on rejection |
| DWF (builtin + user source) | **trusted, ungated** — no env var required | arbitrary code execution if the file is hostile | none enforced; authoring hygiene only |

### Cold-verifier isolation is PROMPT-ONLY (R47-4, documented residual)

`cold-verifier` is advertised as an *independent* check, but its independence
is a **prompt directive, not a mechanical boundary**:

- It is a **WRITE role** (`src/runtime/role-permission.ts:18` `WRITE_ROLES`)
  with `bash`, so it can run arbitrary host commands.
- It **shares the cwd and the run artifact directory** with the work it is
  verifying, and `inheritProjectContext: true` means it reads the same
  worker-editable `AGENTS.md` / `CLAUDE.md` / `.crew/knowledge.md` context
  (`agents/cold-verifier.md`).
- The deterministic verify-gate runs only for `role === "verifier"`
  (`src/runtime/task-runner.ts:162`); `cold-verifier` has **no**
  mechanical fence at all.

Consequence: a cold-verifier is a *fresh perspective*, not a tamper-proof one.
Treat it as advisory unless the surrounding workspace is trusted.

### Observability / telemetry census (R48, documented residual)

When the metric sink or OTLP export is active (`config.telemetry.enabled !== false`
— i.e. **default ON**; see `src/extension/registration/observability.ts:109`),
metric labels and exported attributes can carry **goal text, run/task ids, and
filesystem paths off the host** to whatever OTLP endpoint is configured. This is
intended behaviour, not a bug, but it is a **privacy-relevant egress path**:
set `telemetry.enabled: false` (or leave `otlp.enabled` unset) on repositories
whose goal text is sensitive. See `docs/troubleshooting.md` for the doctor
false-negative catalogue (disk-full / state perms / orphan processes / broken
`node_modules` are NOT detected).

### Root-session gate is env-derived, not containment (documented clarification)

The Wave-3 root-session gate ("root-session required") on user-scope
mutations decides "is this the root session" from the runtime environment —
the same environment a worker's `bash` tool can re-invoke mutations from.
It is a consistency fence against accidental/normal worker flows, NOT a
containment boundary: any worker with shell access can bypass it by design.
Actual OS-level containment for headless child-pi workers is the bubblewrap
sandbox — `PI_CREW_SANDBOX` (Linux, **opt-in**, fail-closed: unsupported
value / non-Linux / missing bwrap binary / net=off+broker all throw BEFORE
any spawn, never silently un-sandboxed), which does not mount `~/.pi`
(`auth.json`!), `~/.ssh`, or any other host path. See
`src/runtime/child-pi/sandbox.ts` and the `PI_CREW_SANDBOX` entry in
`src/config/env-vars.ts` (previously the only documentation of this layer).
When workers run un-sandboxed with shell access, treat the root-session
gate as bypassable.

### Untracked harness sits outside every verify-gate binding (S-1 residual + shared-cwd backstop)

The verify-gate's dispatch-pinned bindings (treeOid / cleanTree / memo key)
bind TRACKED content only; gitignored files in the gate cwd are invisible to
all of them. Two modes, one closed and one accepted:

- **Shared-cwd (closed 2026-10-31, deep-review S-1):** the gate ran its
  checks in the same cwd a WRITE-role executor had just written to, so a
  tampered gitignored harness (e.g. a node_modules shim) graded its own
  gate and skipped the LLM verifier. Backstop: when host-owned task records
  show any write-role task EXECUTED in the gate cwd, the deterministic skip
  is refused and the LLM verifier is force-spawned (reason
  `"shared-cwd-untracked-harness"`; `applySharedCwdHarnessGuard` in
  `src/runtime/verification/verify-gate.ts`, applied to fresh AND memoized
  PASS verdicts). Closing hardenings (same 2026-10-31 closing set): the
  guard's role lookup normalizes underscore→hyphen exactly like the
  tool-granting layer (`test_engineer` IS write-capable — the un-normalized
  lookup misclassified it read_only and left the guard inert); a record cwd
  that is a realpath'd ANCESTOR of the gate cwd counts as sharing (worker
  writes are not OS-scoped to the task cwd); and a guard-refused PASS is
  never memoized — a later run whose taskRecords happen to be absent/empty
  must never replay an uncertifiable PASS as a skip (the memo/cross-run
  residual this closes; what remains is only the forgery class below).
  Residual inside the backstop: a worker forging its own
  tasks.json record (role/status) evades it — state-store integrity is a
  separate lane.
- **Worktree mode + `worktree.linkNodeModules: true` (accepted):** the
  linked leader `node_modules` is host-managed but gitignored — its shims
  execute in the worktree's gate outside every binding. Trust assumption:
  worktree executors write only inside their own worktree (their
  uncommitted work is separately guarded by the W2 dependency probes) and
  the leader `node_modules` is host-controlled. See the TRUST ASSUMPTION
  comment at the `linkNodeModules` gate in `src/worktree/worktree-manager.ts`
  (`prepareTaskWorkspace`).

### Worker-spawn path residuals (S-4 follow-ups, accepted + documented 2026-10-31)

- **win32 fallback residual:** on Windows, a bare-`pi` PATH hit that is a
  PATHEXT target (`pi.cmd`) cannot be exec'd by `spawn()` without a shell,
  so pi-crew keeps the legacy bare `"pi"` command there — and `spawn()`'s
  own CreateProcess resolution (which also probes the CURRENT DIRECTORY)
  sits OUTSIDE the `isWithinAllowedPrefixes` validation. Mitigated by
  spawning validated hits explicitly wherever `resolvePiCliScript()` /
  `resolvePathFallbackCommand()` can; the full win32 resolution fix is
  deferred. Hardened the same day: a found-and-prefix-valid hit whose
  realpath probe fails for a non-prefix reason (transient EACCES / TOCTOU /
  symlink loop) now THROWS (skip-and-diagnose) instead of degrading to the
  unvalidated bare-`pi` fallback (`validatePathResolvedPi`,
  `src/runtime/pi-spawn.ts`).
- **`~/.pi/agent/{bin,install}` prefixes are same-uid worker-writable:**
  the Pi-managed installer layout sits in the USER-HOME trust class — same
  as `~/.npm-global/bin` and `~/.local/bin`, which a same-uid process can
  also rewrite. A same-uid process that can write those prefixes can
  already replace any of the user's PATH shims, so this is an accepted
  residual of the Pi-installer layout, not a new boundary. Deliberately NOT
  extended to all of `~/.pi/agent` (`extensions/`, `cache/` never become
  auto-executable prefixes).

### Coordination-row sender binding (w1a) + dispatcher key distribution (FINDING B)

The durable coordination channels (mailbox JSONL, steering JSONL) are
same-uid writable by design. w1a (SEC-2026-11) binds every row's writer
with a per-process Ed25519 keypair: the PRIVATE key is heap-only in the
writer process; delivery readers (`parseMailboxFile`, the steering poll)
drop rows whose signature fails against the resolvable verify-key set —
unsigned/foreign-signed rows are noise, fail-closed.

**FINDING B (2026-10-31) — dispatcher key distribution.** Legitimate rows
are written by MORE processes than the worker's spawner: in async runs the
LEADER session writes `respond` rows (`respond.ts`) and steering
fs-fallback lines (`team-tool.ts`) while the DETACHED RUNNER spawns the
workers — the single spawner-key env (`PI_CREW_MAILBOX_VERIFY_KEY`) could
never verify those rows, so every leader-signed row dropped as noise and
`ask` polls timed out (the 480s hang). The fix distributes PUBLIC keys:

- The dispatching session stamps its public key on the manifest at run
  creation (`TeamRunManifest.dispatcherVerifyKey`, via
  `ensureCoordinationPublicVerifyKey()`; team-tool run/parallel dispatch,
  inherited by goal-loop turn manifests).
- `child-executor` threads it into every worker spawn;
  `child-pi-spawn` merges it into the child's
  `PI_CREW_MAILBOX_VERIFY_KEYS` env (comma-separated public-key SET,
  deduped with the inherited set for same-run grandchildren; never relays
  across runs — the relay-match guard keys on the broker run id).
- The resolver (`resolveCoordinationVerifyKeys`) merges + dedupes
  [plural env, singular env, in-process keypair] — no source shadows
  another (the pre-fix early-return made an env key HIDE the writer's own
  keypair, so a writer carrying a child env key dropped its own rows).

Why public-only is safe: possession of a public key cannot forge a row
(keys are Ed25519 — the private halves never leave their writer heaps,
never touch env or disk). Widening a child's verify set only widens which
legitimately-SIGNED rows it accepts; the forgery threat (a malicious
worker appending rows) is unaffected — its rows remain unsigned or signed
by a key no reader holds.

**Residual gap status after hướng A** (same-uid threat model; see the
hướng A section below for the mechanism that moved these):

- **Leader restart mid-run — STILL OPEN:** the restarted session's
  keypair is neither the broker's construct-time CR binding nor any key
  the parked workers hold → the CR precheck fails → the local fallback
  row is dropped (asks degrade to timeout, then best-judgment proceed —
  pre-fix behavior). Closing it needs a dispatcher key re-bind/rotation
  flow (follow-up, out of the hướng A wave).
- **Foreign-session force respond — CLOSED (`respond.force`):** a
  foreign same-uid session reaches the run's broker socket (derivable
  from the manifest sessionId) and force-answers a LIVE park; the row
  is broker-signed, so it verifies in the worker — the delivery hướng C
  could never make. The residual inside the closure is the force
  forge-channel itself (documented below).
- **Scheduled / no-leader runs — CLOSED for async dispatch:** the
  scheduler host spawns the run through the async runner, so its own
  key is the one threaded into the broker's CR binding — a still-alive
  scheduler host can `respond.append` with no session token (it holds
  its private key). Once the dispatcher process dies, no one holds that
  private key — `respond.force` remains the (credential-less) path.
  Runs dispatched before hướng A keep hướng C behavior.
- **Pre-FINDING-B manifests — unchanged:** no dispatcherVerifyKey → the
  CR precheck fails → local signed append only (hướng C at best) until
  re-dispatch.

### Hướng A — broker-signed respond delivery (ADR Option 3, 2026-11-01)

Hướng C distributes keys; hướng A moves the WRITE. Every gap above is a
responder that is NOT the dispatch process — its locally signed rows can
never be inside the workers' verify-key set. The observation that closes
the class: the CrewBroker is EMBEDDED in the process that spawns the
workers in BOTH dispatch modes (sync: the leader session hosts the broker
and spawns; async: the detached runner hosts the broker and spawns —
`lifecycle-handlers.ts` `getOrStartBroker`, socket =
`getBrokerSocketPath(sessionId)`), so the broker host's heap keypair IS
the worker's spawner keypair. A row appended BY THE BROKER verifies in
every worker's w1a delivery gate with zero new key distribution.

The auth problem solved first: a broker append method must not become a
forgery primitive (a malicious worker must not be able to make the
broker append response rows for parked siblings). Rejected designs, all
failing the same-uid threat model: an orchestrator token in the
manifest/run-dir (worker-readable state — the worker would sign anything
through the broker, bypassing w1a entirely), an fs spool the runner
signs on behalf of (worker-writable — forged answers for parked
siblings), and an updatable manifest.dispatcherVerifyKey (the manifest
file is unauthenticated).

**ADR — Option 3 (challenge-response + one-shot force).** No single
mechanism closes all three gap classes: CR keeps w1a airtight where the
responder is the dispatcher (a worker holds only PUBLIC material and
can never sign the nonce); force closes the human/foreign cases under
the existing `force:true` human-responsibility philosophy.

- **`respond.append` (challenge-response).** The broker binds the
  DISPATCHER's public verify key HEAP-ONLY at construct
  (`CrewBrokerOptions.dispatcherVerifyKey`; async dispatch threads the
  spawner's key over the detached runner's stdin start-options into
  `dispatcher-key-registry.ts`; a root dispatcher host binds its own
  key — never the manifest file, never env). `respond.challenge` issues
  a 32-byte single-use nonce bound to (connection, runId) — burned on
  the FIRST append attempt regardless of outcome, rate-bounded
  16/connection; the 30s TTL is an upper bound only (the broker's 1s
  hello deadline kills un-authed connections anyway — no re-arm path).
  `respond.append` verifies an Ed25519 signature over
  `respondAppendSignInput` (`request-parsers.ts` — the frozen export:
  `nonce ∥ canonical` with no separator and no runId; run binding rides
  the runId-bound nonce record; client signers MUST use the export,
  never re-implement) against the bound public key, then the BROKER
  appends the row itself (`from:"leader"`, `kind:"response"`,
  questionId-tagged) — signed with the broker host's keypair, so it
  verifies in every worker. Worker-token connections are rejected
  outright (role derives from token type — defense-in-depth; the real
  bound is the private key they cannot hold).
- **`respond.force` (one-shot live park).** Token-less by design: the
  gates are the park itself (a fresh task reload inside a bounded
  busy-retry run lock must find `status:"waiting"` with the exact
  `waiting.questionId`), exactly-one per question (durable
  `requestId = questionId` dedup + heap fast-fail), row
  `from:"leader-forced"` + `data.tag:"forced"` + the
  `respond.broker_append` audit event carrying the broker socket
  identity. The append runs OUTSIDE the run lock (lock-ordering safety;
  exactly-once comes from the idempotent append, not from holding the
  lock).
- **Both paths are PRE-hello broker methods** — the responders they
  exist for hold no broker token. The respond-side seam
  (`respond-delivery.ts` `deliverResponseRow`, wired into
  `handleRespond`'s ALIVE path) is broker-FIRST: it only attempts CR
  when this process IS the dispatcher (`manifest.dispatcherVerifyKey
  === getMailboxVerifyKeyPublic()`), runs the whole challenge→append
  exchange on one short-lived connection, and falls back to the local
  signed append (hướng C behavior, semantics unchanged) + a warn log on
  ANY failure. Rows are staged inside the run lock but delivered after
  it releases — the broker handler takes its own run lock, so the RPC
  window must never sit under `withRunLockSync`. `requestId =
  questionId` keeps delivery exactly-once across broker + local
  fallback + concurrent responds (a lost ack frame dedupes against the
  broker's own row).

**Residuals accepted with hướng A** (documented, not fixed):

- **(i) Leader restart mid-run** — see the gap status above; needs a
  re-bind/rotation flow (follow-up wave).
- **(ii) Broker restart mid-run:** the restarted broker process mints
  a new heap keypair and loses the dispatcher binding — rows it
  appends no longer match any key the workers hold (same class as
  leader restart; one re-bind flow would cover both).
- **(iii) Force forge-channel:** a same-uid process that never hellos
  (including a malicious worker withholding its token — the
  worker-token reject is defense-in-depth only) CAN force-answer
  exactly ONE live park per question. Accepted consciously: bounded by
  the live-park gate, one-shot, tagged `leader-forced` (downstream can
  fence on it) and audited — the same human-responsibility tradeoff as
  `force:true`.
- **(iv) CR closes the no-leader gap only while the dispatcher process
  lives:** the scheduler-host path works because the still-alive
  scheduler holds its own private key; once it dies, `respond.force`
  is the only remaining path (one live park at a time).
## Cross-references

- `docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md` (HMAC = REMOVED 2026-08-12 — corrected claim §7)
- `docs/bugs/SECURITY-ISSUES.md` (preserved for SEC-001 through SEC-007 history)
- `docs/decisions/2026-08-10-dwf-isolated-vm-sandbox.md` (DWF sandbox spike → M6/WI-6.2)
- `src/observability/event-to-metric.ts:46` (F.1 metric)
- `src/observability/metrics-primitives.ts:57-67` (F.2 gauge)
- `src/runtime/scratchpad/guest.ts:33` (E.2 v8.deserialize, mitigated)
- `src/state/coordination/locks.ts:49-67` (SEC-008 EPERM branch, accepted)
- `src/runtime/child-pi/sandbox.ts` + `src/config/env-vars.ts` `PI_CREW_SANDBOX` (bwrap OS-boundary containment — the real backstop behind the env-derived root-session gate)
- `src/runtime/verification/verify-gate.ts` (`applySharedCwdHarnessGuard` — shared-cwd untracked-harness forced verifier spawn)
- `src/runtime/pi-spawn.ts` (`validatePathResolvedPi` — see the worker-spawn path residuals above)
- `src/worktree/worktree-manager.ts` (`worktree.linkNodeModules` trust assumption — see the S-1 residual above)
- `src/runtime/broker/protocol/broker-respond.ts` + `src/runtime/broker/protocol/request-parsers.ts` (hướng A respond.* handlers + the frozen CR sign-input contract — see the hướng A section above)
- `src/extension/team-tool/respond-delivery.ts` (`deliverResponseRow` — broker-first respond delivery with hướng C fallback)
- `src/runtime/broker/dispatcher-key-registry.ts` (heap-only dispatcher key binding for respond.append CR)
