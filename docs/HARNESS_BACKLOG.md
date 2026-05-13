# Harness Backlog

Use when an agent discovers a missing harness capability but should not change the operating model immediately.

## Items

### HB-001: Integration test harness

**Discovered while**: Review round 9 — all tests are unit tests, no multi-module integration tests exist.

**Current pain**: Cannot verify team-runner → state-store → child-process integration end-to-end without manual testing.

**Suggested improvement**: Add `test/integration/` with real file-system state, real child processes (with timeout).

**Risk**: normal

**Status**: proposed

### HB-002: Windows-specific test coverage

**Discovered while**: RR-002 Windows EBUSY fix — only tested manually, no automated Windows-specific tests.

**Current pain**: Windows bugs only caught in CI, not locally.

**Suggested improvement**: Add `test/platform/` with Windows-specific tests (EBUSY retry, path handling).

**Risk**: normal

**Status**: proposed

### HB-003: Performance regression baseline

**Discovered while**: Review noted `sleepSync` busy-wait on Windows — no perf benchmarks exist.

**Current pain**: Cannot detect performance regressions.

**Suggested improvement**: Add benchmark suite for critical paths (state writes, event append, task dispatch).

**Risk**: tiny

**Status**: proposed
