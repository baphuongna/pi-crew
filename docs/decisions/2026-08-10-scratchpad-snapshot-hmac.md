# ADR: Scratchpad snapshot HMAC (E.2)

**Date:** 2026-08-10

## Status

**SUPERSEDED / REVERTED (2026-08-12)** — the Phase 1 helper module
`src/runtime/scratchpad/snapshot-hmac.ts` and its 11 unit tests were
**deleted**. Rationale (decision P3 of `docs/rlm-fixes-implementation-plan.md`,
grounded in `docs/rlm-deep-review-2026-08-12.md` §5.2E):

1. **The mitigated threat is double-conditional.** v8.deserialize-gadget
   tampering only materializes when (a) scratchpad has real adoption (today:
   0 cells across 83+ runs) AND (b) snapshots move to a shared/networked/
   group-writable store (today: same-uid dev-machine — the ADR's own Phase 4
   gate). Neither condition holds.
2. **Hardening a 0-adoption surface is premature.** The whole scratchpad
   feature is itself at risk of removal (decision gate §3.3 of the deep review:
   "Still ~0 cells AND task-shape precondition met → remove feature"). Wiring
   HMAC (ROADMAP R1-4) into a feature that may be deleted is wasted work.
3. **Not clean to wire.** Phase 2 wire-up is blocked on 3 unresolved design
   questions (writeArtifact redaction vs inline prefix; raw-bytes vs envelope;
   cap application). Per the deep review §5.2E: "nếu không clean → delete".
4. **Fully re-addable.** This ADR records every design decision (raw bytes,
   bare-payload cap, inline `PI_CREW_SIG=` prefix, 3-phase migration). If both
   conditions ever hold, re-implement from this spec.

**Original (Phase 1, shipped 2026-08-10) status below — retained as the design
spec for any future re-introduction.**

---

Accepted (Phase 1 helper + tests shipped 2026-08-10; production
wire-up deferred to a follow-up that audits the snapshot envelope format).

## Context

`src/runtime/scratchpad/guest.ts:290` calls `v8.deserialize(buffer)` on
restore content with no integrity check. The scratchpad README
(`README.md:120`) declares the gap: "v8.deserialize of restore content is
unauthenticated (no HMAC). Bounded by 4 MiB file cap + 256 KiB per-var cap
+ same-uid artifact dir."

The same-uid boundary holds for the current single-user dev-machine
deployment. It breaks the moment scratchpad snapshots ever land in a
shared, networked, or group-writable store — an attacker with write
access to the snapshot path can craft a V8 blob that runs deserialize
gadgets inside the guest (which holds provider keys and the broker
token). HMAC over the snapshot bytes is the standard mitigation.

## Decision

Add an opt-in HMAC layer with a three-phase migration window. The helper
module `src/runtime/scratchpad/snapshot-hmac.ts` (shipped 2026-08-10)
exposes the primitives; the wire-up into the write/read paths is phased.

### Phase 1 (shipped 2026-08-10) — helper + tests, opt-in disabled by default

- `getSnapshotHmacKey()` reads `PI_CREW_SNAPSHOT_HMAC_KEY`. Unset → HMAC
  fully off (snapshots unsigned, behaviour unchanged).
- When set, the key must be ≥ 32 bytes (hex or utf8). Shorter keys throw
  to prevent trivial brute-force.
- `attachSnapshotSignature()` / `verifySnapshotPayload()` /
  `stripSnapshotSignature()` implement the inline `PI_CREW_SIG=<hex>\n`
  envelope so a single read yields both signature and payload.
- `shouldRejectSnapshot()` centralises the strict-vs-migration decision
  so callers stay simple.
- 11 unit tests in `test/unit/runtime/scratchpad/snapshot-hmac.test.ts`
  cover the round-trip, tamper detection, length-mismatch
  short-circuit, unsigned-in-strict-mode rejection, and key validation.

### Phase 2 (follow-up, gated on snapshot format audit) — wire read/write

Wire the helper into the actual snapshot write path
(`src/prompt/scratchpad-lifecycle.ts` snapshot debounce → writeArtifact)
and read path (`src/runtime/scratchpad/engine.ts:575-598` O_NOFOLLOW +
fstatSync read). The audit must answer:

1. Does `writeArtifact`'s redaction transform survive an inline
   signature prefix, or does the prefix need to live in artifact
   metadata instead?
2. Is the HMAC computed over the raw V8 bytes or over the base64
   envelope? (Decision: raw bytes — that is what `v8.deserialize` will
   consume.)
3. Does the snapshot size cap (`SNAPSHOT_MAX_BYTES = 4 MiB`) apply to
   the signed envelope or to the bare payload? (Decision: bare
   payload — the prefix is ~70 bytes and should not eat into the cap.)

Phase 2 ships in strict-mode-off (the migration default): unsigned
payloads are accepted with a warning so existing snapshots remain
readable. `PI_CREW_SNAPSHOT_HMAC_STRICT=1` opts into rejection.

### Phase 3 (after one release of Phase 2 stable) — strict default

Flip the strict default to on for users who have set the key. Unsigned
snapshots are rejected. Users who never set the key keep the Phase 0
behaviour — HMAC remains opt-in.

### Phase 4 (only if snapshots move to a shared store) — required

If scratchpad snapshots ever move to a shared/networked/group-writable
location, the key becomes required and unsigned snapshots are always
rejected. This is a breaking change that needs its own release-note
callout.

## Alternatives considered

1. **HMAC over a sidecar `.hmac` file.** Rejected: requires coordinating
   two atomic writes through `writeArtifact`, which is not the current
   contract. The inline prefix keeps everything in one blob.
2. **Encrypt the snapshot instead of signing.** Rejected: confidentiality
   is not the threat (the guest process can read its own snapshot at
   runtime anyway). Integrity is.
3. **Sign the base64 envelope, not the raw V8 bytes.** Rejected: the
   attacker can substitute the base64 blob too, so signing the decoded
   bytes the guest will actually hand to `v8.deserialize` is the
   load-bearing check.
4. **Status quo — leave unauthenticated.** Accepted only while the
   same-uid boundary holds. This ADR's existence documents the
   conditional acceptance.

## Out of scope

- Snapshot encryption (confidentiality is a separate threat).
- Authenticated V8 alternative (e.g. JSON-only snapshots): would be a
  larger change to the snapshot format and the namespace-restore API.
- Per-cell HMAC: the snapshot is the only persisted surface; in-memory
  cells do not need HMAC.

## References

- `docs/improvement-plan-2026-08-09.md` E.2
- `src/runtime/scratchpad/README.md:120` (gap declaration)
- `src/runtime/scratchpad/snapshot-hmac.ts` (Phase 1 helper)
- `test/unit/runtime/scratchpad/snapshot-hmac.test.ts` (Phase 1 tests)
- `docs/failure-mode-inventory.md` (closed entry below)
