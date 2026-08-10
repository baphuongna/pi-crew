# 0007 Active-Run Registry Binary Index

Date: 2026-05-14

## Status

Accepted — implemented (`src/state/stores/active-run-registry.ts:118-192`).
The implementation uses a JSON-stringified body under a `PICREW2BIN` magic
+ version header rather than the v8-serialize / msgpack style proposed
below, because `JSON.parse` is schema-safe (no hostile-object risk from
`v8.deserialize`). During the transition window both JSON and binary
mirrors are written; see `writeEntries` (`active-run-registry.ts:194-274`).

## Context

`active-run-registry.ts` performs ~10 syscalls per registry lookup
(JSONL append, readdirSync of state/runs, statSync per directory).
On `session_start` this dominates extension wake-up time when the user
has many historical runs.

## Decision (proposed)

Replace the JSONL-backed registry with a small binary index file
(`<crewRoot>/state/active-runs.bin`) using a length-prefixed
msgpack-style record. A single read populates an in-memory map.

For backwards compatibility, the loader continues to parse the legacy
JSONL when the binary file is absent, and writes both formats during a
2-release transition. Readers prefer binary when both exist.

## Alternatives considered

1. SQLite — adds a native dependency that breaks Node's strip-types
   loader; rejected.
2. Just cache the JSONL parse — only saves on subsequent session_start
   within the same process; doesn't help cold start across processes.
3. Memory-mapped file — more complex; similar throughput.

## Consequences

Positive:
- One read replaces O(N) syscalls.
- Index can carry derived metadata (run.status snapshot) so the
  widget can render without touching individual run dirs.

Tradeoffs / risks:
- Custom format requires test coverage for partial writes / corruption.
- Migration window needs operational care: any tool reading the legacy
  JSONL must continue to work for 2 releases.
- Binary corruption recovery: fall back to JSONL truth source and
  rewrite binary from scratch.

## Next steps

1. Define schema (run id, status, started-at, sessionId, pid).
2. Implement reader/writer with checksum per record.
3. Backwards compat: read binary if present, else JSONL; write both.
4. After 2 release cycles, drop JSONL writer.
5. Land ADR as "Accepted" once migration complete.
