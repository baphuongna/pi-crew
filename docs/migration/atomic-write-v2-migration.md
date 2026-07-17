# atomic-write-v2 migration plan

> **Note:** `atomic-write-v2.ts` was consolidated into `atomic-write.ts` as of v0.9.42. This document is preserved as historical record — the migration was completed with v1 winning on simplicity + symlink-safety + link+unlink atomicity. The v2 class was never adopted; no v2 API surface ships with pi-crew.

> Status: **PROPOSED** — decision RECOMMEND MIGRATE (staged, feature-flagged).
> Source: performance review `docs/perf/performance-review-2026-07.md` (findings F3–F6).
> Scope: replace the standalone-function module `src/state/atomic-write.ts`
> with the class-based `src/state/atomic-write-v2.ts` (`AtomicWriter`) over
> three staged phases behind a feature flag.

## Table of contents

- [1. Why migrate](#1-why-migrate)
- [2. API differences](#2-api-differences)
- [3. Migration phases](#3-migration-phases)
  - [Phase 1 — dual-write (feature flag)](#phase-1--dual-write-feature-flag)
  - [Phase 2 — switch default](#phase-2--switch-default)
  - [Phase 3 — deprecate v1](#phase-3--deprecate-v1)
- [4. Risks and mitigations](#4-risks-and-mitigations)
- [5. Effort estimate](#5-effort-estimate)
- [6. Decision](#6-decision)
- [7. Appendix — call-site inventory](#7-appendix--call-site-inventory)

## 1. Why migrate

The performance review (F3, F4, F6) traced a write-path regression to commit
`13f4490`. That commit hardened `atomicWriteFile` against a CI-flake stale-read
race (the `mailbox-replay` intermittent failure) by adding **two** `fsync`
calls per synchronous write:

1. **Data fsync** — `fs.fsyncSync(fd)` on the temp file before rename
   (`atomic-write.ts` ~line 287, in the `atomicWriteFile` write body). This
   forces the written bytes out of the page cache to disk so a subsequent
   `readFileSync` after the rename always sees the new content.
2. **Directory fsync** — `fs.fsyncSync(dirFd)` on the parent directory after
   the rename (`atomic-write.ts` ~lines 307–309, POSIX-only, skipped on
   Windows). This makes the directory-entry update (the rename) durable so a
   subsequent `open()` cannot race and observe `ENOENT` or stale content on a
   high-I/O CI runner.

The dir-fsync is the expensive half. `persistSingleTaskUpdate` calls the write
path ~5 times per task; at 2 fsync per call that is roughly **+10 fsync per
task**, and directory fsync is especially costly on Windows and on
network/overlay filesystems. The review also had to bump the CI timeout
600s → 900s (commit `9bbeb45`) partly to absorb this cost.

`atomic-write-v2.ts` (the `AtomicWriter` class) keeps only the **data fsync**,
and even that is **best-effort** — it is wrapped in a `try/catch` that swallows
the error (`atomic-write-v2.ts` ~line 30 in `writeSync`, and `fd.sync()` in
`writeAsync`). It performs **no directory fsync at all**.

### Quantified difference

| Cost per write         | atomic-write.ts (v1)                  | atomic-write-v2.ts (v2)         |
| ---------------------- | ------------------------------------- | ------------------------------- |
| Data fsync             | 1 (mandatory, throws on failure)      | 1 (best-effort, swallowed)      |
| Directory fsync        | 1 (POSIX only)                        | 0                               |
| `isSymlinkSafePath`    | 2 full ancestor walks (pre + pre-rename) | 0                            |
| `lstat` syscalls       | ~10+ per level × 2 for a deep path    | 0                               |
| Rename mechanism       | `link()` + `unlink()` (+ retry/jitter) | `rename()` (single syscall)    |

The headline is roughly **2× fewer fsync operations per call** (drop the dir
fsync, keep data fsync), plus the elimination of two full ancestor-walk
symlink scans (F5) and the `link()`+`unlink()` pair in favor of a single
`rename()`. On a deep state-store path (`.crew/state/runs/{runId}/…`) the v1
path issues ~20+ `lstat` calls per write for symlink validation alone; v2
issues none. The net expected win on the hot `persistSingleTaskUpdate` path is
approximately halving the per-call durability cost, with a larger relative win
on syscall count.

The trade-off is explicit: **v2 loses the dir-fsync durability guarantee.** On
journaled Linux filesystems (ext4 with `data=ordered`, xfs) the rename is still
crash-atomic, but a power loss in the sub-millisecond window between write and
directory-entry flush can leave the *old* content visible after reboot. On
tmpfs this window is effectively the whole lifetime of the entry (no
durability at all). This is the guarantee the `13f4490` commit was added to
provide, so dropping it must be a conscious, documented decision (see
[risks](#4-risks-and-mitigations)).

## 2. API differences

The two modules are shaped very differently, so migration is not a
drop-in symbol rename — callers change from free functions to a constructed
instance.

### v1 — `atomic-write.ts` (module of standalone functions)

- `atomicWriteFile(filePath, content, expectedHash?)`
- `atomicWriteFileAsync(filePath, content)`
- `atomicWriteJson(filePath, value)`
- `atomicWriteJsonAsync(filePath, value)`
- `atomicWriteJsonCoalesced(filePath, value, coalesceMs?)` — 50 ms coalescing buffer
- `flushPendingAtomicWrites()` — flush the coalesce buffer
- `isSymlinkSafePath(filePath)` — exported symlink-safety guard
- `renameWithRetry(...)` / `renameWithRetryAsync(...)` — exported rename helpers with jitter
- `readJsonFile(filePath)` — tolerant JSON reader

Behavioral characteristics:

- **Symlink safety**: explicit `isSymlinkSafePath` check both **before open**
  and **again immediately before rename** (TOCTOU re-check), plus a
  post-rename `lstat` guard on failure.
- **Rename**: `link()` + `unlink()` (`renameWithLinkSync` /
  `renameWithLinkAsync`) so the destination symlink is *not* followed; Windows
  falls back to `renameSync`/`MoveFileEx`. Retries with exponential backoff and
  ±20% jitter.
- **Durability**: mandatory data fsync (throws on failure) + POSIX directory
  fsync.
- **Tmp naming**: `${filePath}.${randomUUID()}.tmp`.
- **Coalescing**: a per-path buffer with generation counters, retry/backoff,
  and process `exit`/`SIGTERM`/`SIGINT` auto-flush hooks.
- **Optional worker offload**: `atomicWriteFileAsync` can dispatch to a worker
  thread when `PI_CREW_WORKER_ATOMIC_WRITER=1`.

### v2 — `atomic-write-v2.ts` (`AtomicWriter` class)

- `new AtomicWriter(baseDir)` — constructed with a base directory
- `writeSync(targetPath, content)`
- `writeAsync(targetPath, content)`
- `writeJsonSync(targetPath, value)`
- `writeJsonAsync(targetPath, value)`
- private `.gitignore`-on-first-use per directory (writes `*\n` the first time
  a directory is touched)

Behavioral characteristics:

- **Symlink safety**: **none** — no `isSymlinkSafePath`, no pre/post checks.
- **Rename**: plain `rename()` (POSIX-atomic but **symlink-following**), single
  syscall, no retry/jitter loop.
- **Durability**: best-effort data fsync (swallowed), **no directory fsync**.
- **Tmp naming**: `${targetPath}.${randomUUID()}.tmp` (same scheme as v1).
- **Coalescing**: none (no buffer, no flush hooks).
- **Reader**: none (no `readJsonFile` equivalent).

### Feature-gap summary (what v2 does NOT have yet)

| Capability                         | v1  | v2  | Notes                                              |
| ---------------------------------- | --- | --- | -------------------------------------------------- |
| Symlink-safe rename                | ✅   | ❌   | v2 uses `rename()` which follows symlinks          |
| `isSymlinkSafePath` export         | ✅   | ❌   | consumed elsewhere — must stay available           |
| Coalesced writes + flush hooks     | ✅   | ❌   | required by `saveRunTasksCoalesced` path (F4)      |
| `readJsonFile`                     | ✅   | ❌   | tolerant reader used across state-store            |
| Retry/backoff on contended rename  | ✅   | ❌   | v2 throws on first `rename()` failure              |
| Windows short/long-name handling   | ✅   | ❌   | v1 has explicit `MoveFileEx` fallback              |
| Directory fsync                    | ✅   | ❌   | the durability guarantee being intentionally dropped |
| `.gitignore` on first use          | ❌   | ✅   | v2 convenience; v1 leaves this to callers          |

**Implication:** a straight swap is not viable until v2 grows (or the
dispatcher re-provides) the coalescing buffer, the tolerant reader, the retry
loop, and an opt-in symlink guard. The phased plan below keeps v1 as the source
of those capabilities during transition rather than porting them all up front.

## 3. Migration phases

### Phase 1 — dual-write (feature flag)

Estimated ~1–2 days.

- Introduce an environment feature flag `PI_CREW_ATOMIC_WRITER` with values
  `v1` (default) and `v2`.
- Add a thin adapter module `src/state/atomic-write-dispatcher.ts` that exposes
  the v1 free-function surface (`atomicWriteFile`, `atomicWriteJson`, and their
  async variants) and routes each call to either the v1 functions or a shared
  `AtomicWriter` instance based on the flag. Capabilities v2 lacks
  (`atomicWriteJsonCoalesced`, `flushPendingAtomicWrites`, `isSymlinkSafePath`,
  `readJsonFile`) continue to delegate to v1 unconditionally in this phase.
- Keep `atomic-write.ts` as the default; nothing changes for users who do not
  set the flag.
- Add a benchmark test that writes N files through both paths under **tmpfs**
  and **ext4** and asserts the fsync-count / wall-clock delta matches the
  ~2× prediction. Land it under `test/bench/` (guarded so it does not run in
  the default `test:unit` gate).

Exit criteria: flag flips implementation with zero behavior change for default
users; benchmark confirms the predicted delta.

### Phase 2 — switch default

Estimated ~1–2 days.

- Flip the dispatcher default to `v2`; users can opt back to the old path with
  `PI_CREW_ATOMIC_WRITER=v1`.
- Route direct callers of `atomicWriteFile` / `atomicWriteJson` (in
  `extension/team-tool.ts`, `state-store.ts`, and any other direct importers)
  through the dispatcher rather than importing `atomic-write.ts` directly.
- Before flipping, back-fill v2 (or the dispatcher wrapper around v2) with the
  currently-missing durability/safety features that production relies on:
  retry-on-contended-rename, an **opt-in** symlink guard for
  `userPiRoot()`-adjacent writes, and either the coalescing buffer or continued
  delegation to v1 for the coalesced path.
- Monitor for one full release cycle. Watch for stale-read CI flakes (the exact
  failure `13f4490` fixed) — if they resurface, the dir-fsync drop is the prime
  suspect and the flag provides an instant rollback.

Exit criteria: one clean release cycle on the v2 default with no stale-read or
symlink regressions reported.

### Phase 3 — deprecate v1

Estimated ~1 day.

- Remove `atomic-write.ts` and the `v1` flag branch (keep any still-needed
  utilities — notably the symlink-safe `link()`+`unlink()` helper and
  `isSymlinkSafePath` — either in the renamed module or a small
  `symlink-safety.ts`).
- Rename `atomic-write-v2.ts` → `atomic-write.ts` and update imports.
- Add a `CHANGELOG.md` entry under a **minor** version bump documenting the
  durability trade-off (no directory fsync by default) and the
  `PI_CREW_ATOMIC_WRITER` flag removal.

Exit criteria: single implementation, no flag, green CI, CHANGELOG documents
the durability change.

## 4. Risks and mitigations

### Drop of strict symlink safety (security)

v2 performs **no** `isSymlinkSafePath` check and uses `rename()`, which follows
a symlink at the destination. An attacker who can plant a symlink inside
`userPiRoot()` (or an ancestor of a write target) could redirect a write to an
arbitrary path.

Mitigations:

1. v2 callers must pre-validate every target path via the `paths.ts` helpers so
   writes are confined to the user's own pi-crew state tree.
2. Keep the v1 `link()`+`unlink()` rename helper and `isSymlinkSafePath` as
   reusable utilities even after the module rename, and offer them as an opt-in
   "safe rename" mode in the dispatcher for `userPiRoot()`-adjacent writes.
3. Add a CI test that plants a symlink inside the `.pi/agent/pi-crew/` tree and
   asserts the writer refuses (or does not follow) it.

### Lockfile / tmp collision risk

Both implementations name temp files `${target}.${randomUUID()}.tmp`. UUIDv4
collision probability is astronomically low (documented here for completeness).
The larger concern is the inode-scan cost of many `.tmp` siblings in a large
directory. Recommend writing tmp files into a per-process subdir
(`<baseDir>/.tmp/<pid>/`) to bound directory size and simplify crash cleanup.

### Crash-durability regression

v2's missing directory fsync means a power loss in the window between the data
write and the directory-entry flush can leave the **old** content visible after
reboot. This is rare on journaled filesystems (ext4/xfs) and common on tmpfs.

Mitigations:

1. Document the trade-off in the v2 module docblock and in `CHANGELOG.md`.
2. Keep the flag so at-risk deployments (non-journaled FS, tmpfs-backed state)
   can pin `v1`.
3. Optionally expose a per-call `durable: true` option in the dispatcher that
   re-enables the directory fsync for the small set of writes that truly need
   it (e.g. terminal manifest writes), so the common path stays fast while the
   critical path stays durable.

## 5. Effort estimate

**Size: M (3–5 days.)**

| Work item                                  | Estimate |
| ------------------------------------------ | -------- |
| Phase 1 — flag + dispatcher + benchmark    | ~1–2 days |
| Phase 2 — feature back-fill + switch + soak | ~1–2 days |
| Phase 3 — deprecate + rename + CHANGELOG   | ~1 day    |
| Benchmark harness (tmpfs + ext4)           | ~0.5 day  |
| Docs / review pass                         | ~0.5 day  |

## 6. Decision

**RECOMMEND MIGRATE** — staged, feature-flagged.

Justification:

- The write path is hot: `persistSingleTaskUpdate` calls it ~5×/task and the
  state-store fires on the same 1 Hz idle / 6 Hz active cadence as
  `loadConfig`. Halving the per-call durability cost (drop dir fsync, keep data
  fsync) plus eliminating the double ancestor-walk symlink scan is a meaningful
  and broadly-applied win.
- The durability risk from dropping the directory fsync is bounded: it only
  matters on non-journaled/tmpfs filesystems and only within the sub-millisecond
  on-disk write window. The `PI_CREW_ATOMIC_WRITER=v1` fallback lets at-risk
  setups opt out.
- The symlink-safety regression is the sharpest edge and is mitigated by
  `paths.ts` pre-validation, an opt-in safe-rename mode, and a CI symlink-plant
  test — not by accepting v2 as-is.

Because the plan is staged behind a flag with an instant rollback, the blast
radius at each step is small and the exact CI flake that `13f4490` fixed remains
observable (and reversible) during the Phase 2 soak.

## 7. Appendix — call-site inventory

Before Phase 2, enumerate the direct importers to route through the dispatcher.
As of this plan, `atomic-write-v2.ts` has **0 importers** (confirmed by
`grep -rn "atomic-write-v2" src/`). The v1 surface is consumed by
`state-store.ts`, `extension/team-tool.ts`, and the coalesced/reader paths;
run `grep -rn "atomic-write\b" src/` at the start of Phase 2 to produce the
authoritative list, since call sites shift between now and then.
