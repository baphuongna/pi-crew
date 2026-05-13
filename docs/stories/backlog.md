# Story Backlog

Candidate stories for future pi-crew development.

## Epic: Reliability

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| US-001 | Lock-free event log rotation | normal | P2 | planned |
| US-002 | Structured run-level lock cleanup | normal | P2 | planned |
| US-003 | Dead letter queue for permanently failed tasks | normal | P3 | planned |

## Epic: Performance

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| US-010 | Replace sleepSync busy-wait with proper async | normal | P3 | planned |
| US-011 | Stream-based event log for large runs | normal | P3 | planned |
| US-012 | Cache available models across runs | tiny | P3 | planned |

## Epic: DX (Developer Experience)

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| US-020 | Interactive run dashboard in TUI | normal | P2 | planned |
| US-021 | Run comparison (before/after) | normal | P3 | planned |
| US-022 | Export run report as markdown | tiny | P3 | planned |

## Epic: Integration

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| US-030 | Webhook notifications on run completion | normal | P3 | planned |
| US-031 | GitHub Actions integration (report results as PR comment) | normal | P3 | planned |

Create story packets from `docs/templates/story.md` when work is selected.
