# 0001 Durable State as Source of Truth

Date: 2026-05-11

## Status

Accepted

## Context

pi-crew runs can last minutes to hours. Runs may be started from foreground
sessions, background processes, or async workers. Multiple observers (TUI
dashboard, status commands, event hooks) need to see the same run state.

## Decision

All run state is stored on disk as JSON files:
- `manifest.json` — run metadata, status, config
- `tasks.json` — task graph with statuses
- `events.jsonl` — append-only event log
- `agents/{taskId}/status.json` — per-agent state

All reads go through state store. All writes use atomic write helpers and
run-level locks (`withRunLockSync`).

## Alternatives Considered

1. In-memory state with periodic flush. Rejected: lost on crash, inconsistent across processes.
2. Database (SQLite). Rejected: adds native dependency, overkill for append-mostly data.

## Consequences

Positive:
- Crash recovery is possible by reading state from disk
- Multiple processes can observe the same run
- Event log provides audit trail

Tradeoffs:
- File I/O on every state mutation (mitigated by atomic writes)
- Windows EBUSY/EPERM requires retry logic
- Lock contention under heavy concurrent access
