# Decision: Windows broker named-pipe permissions

**Date:** 2026-07-21  
**Status:** accepted (Phase 0)  
**Context:** Plan §Q3 of `reports/inter-pi-broker-impl-plan-2026-07-21.md`

## Context

The Phase 0 inter-pi broker uses a local-only socket transport: a Unix
domain socket on POSIX (`${XDG_RUNTIME_DIR:-/tmp}/pi-crew-<hash8>.sock`)
and a Windows named pipe (`\\.\pipe\pi-crew-broker-<hash8>`). On POSIX,
the runtime directory is mode `0700` and the socket is mode `0600`,
matching herdr's local-socket convention. Windows has no POSIX-equivalent
filesystem permission contract for named pipes; the closest the OS offers
is the `CreateNamedPipe` access-mask flags.

## Decision

We treat the **per-run random token** as the canonical authentication
boundary on every platform, and complement it on Windows with the named
pipe options Node exposes (`readableAll: false`, `writableAll: false`)
where supported by the underlying API. POSIX retains its stronger
0600/0700 contract as defense-in-depth.

## Rationale

1. The token is 128-bit-class randomness (`crypto.randomUUID()`), issued
   per-run by the parent's `CrewBroker.issueRunToken` and stored only in
   the parent's in-memory `Map<runId, token>` plus the child's env via
   the `PI_CREW_BROKER_TOKEN` control-namespace key. Without the token,
   a local attacker who happens to learn the pipe name cannot complete
   the hello handshake (the server returns a generic auth failure).
2. `readableAll:false` / `writableAll:false` restrict who can open the
   pipe handle beyond just the owner. On Windows these flags are honored
   by `net.createServer({ allowHalfOpen: false })` when set, giving us
   additional isolation even though we cannot enforce 0600 semantics.
3. The hello deadline (1s) and bounded reconnect budget (4 attempts)
   bound the impact of any successful probe.
4. The durable mailbox remains authoritative for messaging; the socket
   is a latency accelerator, not a record-of-truth. A compromised socket
   can degrade latency but not lose data.

## Residual risk

A local process that:
- knows the short pipe name (visible in the parent's process env / procfs),
- can open the pipe despite `readableAll:false` (e.g. by running as the
  same user, or via an OS-level bypass),

still has a connection-attempt surface. It cannot complete the handshake
without the token, and it cannot observe other runs' tokens (each run has
its own token, validated server-side against the parent's
`Map<runId, token>`). The failure code returned on bad-token is generic
("auth"), so the attacker cannot distinguish bad-token from bad-run-id.

## Mitigations not yet implemented (future work)

- ACL-tighten the Windows pipe via `process.getEffectiveUserInfo()` if
  Node's API stabilizes — currently experimental.
- Per-connection rate-limit (currently unbounded; would matter under
  active probing).
- Audit-log every auth failure with the caller's effective user (would
  help detect probing but requires a stable per-platform caller-id API).

## Acceptance criteria for this decision

- Document the residual risk (this file).
- Verify on Windows CI that `readableAll:false` / `writableAll:false`
  are honored by the supported Node matrix.
- Add a Phase 0 unit test confirming the server rejects a wrong-token
  hello with a generic `auth` error code (already covered by
  `crew-broker-handshake.test.ts`).
- Do not claim Windows has POSIX-equivalent `0600` protection in any
  user-facing docs.

## References

- Plan: `reports/inter-pi-broker-impl-plan-2026-07-21.md` §Q3.
- Spec: `reports/inter-pi-broker-spec-2026-07-21.md` §3.3.
- herdr analog: `source-refs/herdr/src/api/ipc.rs`.

## Phase 4 update (default-on flip)

When `broker.enabled` flipped from `false` to `true` (decision doc
`2026-07-22-broker-phase4-gated-on.md`), the broker became the default
on Linux + macOS. Windows users see the broker auto-disabled because
the broker requires a Unix-domain socket (or a Windows named pipe with
the `readableAll:false` / `writableAll:false` flags above). The
per-run random token remains the canonical authentication boundary
on every platform; this doc's residual risk analysis is unchanged
by the default flip.
