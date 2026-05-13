# 0003 Depth Guard for Nested Live-Session

Date: 2026-05-12

## Status

Accepted

## Context

Live-session agents run inside the current Pi agent process. If a team
workflow schedules a task that itself tries to create a team run with
live-session agents, the nested Pi agent instance attempts to spawn inside
the already-running agent. This causes stack overflow or resource exhaustion.

## Decision

Add a depth guard: track nesting depth via environment variable
`PI_CREW_SESSION_DEPTH`. If depth >= 2, force `child-process` mode instead of
`live-session`.

## Alternatives Considered

1. Allow unlimited nesting. Rejected: guaranteed crash.
2. Block nested runs entirely. Rejected: loses useful recursive team capability.
3. Use child-process for all nested runs. Accepted — this is the depth guard.

## Consequences

Positive:
- Nested team runs work safely via child-process
- No crash from stack overflow or resource exhaustion

Tradeoffs:
- Nested runs lose in-process speed advantage
- Environment variable tracking requires propagation
