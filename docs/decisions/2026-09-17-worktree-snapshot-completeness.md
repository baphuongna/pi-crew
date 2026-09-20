# Worktree snapshot completeness: destructive cleanup gated on a structured result

Date: 2026-09-17

## Status

Accepted

## Context

Task-worktree reuse snapshots dirty content into a recovery artifact, then runs
`git checkout -- .` + `git clean -fd` for a clean slate. The gate for that
destructive pair was the `boolean` returned by `snapshotDirtyWorktree()`, where
`true` meant only "writeArtifact did not throw": truncation at the 256 KiB
per-file cap, unreadable entries (probe: a `chmod 000` file vanished from BOTH
the artifact and the worktree), and a failed `git diff HEAD --binary` all still
returned `true`, so the reuse path destroyed data the artifact never contained.
This violated the standing AGENTS.md rule ("Worktree cleanup must preserve
dirty worktrees unless `force` is explicitly set"). The old whole-file
`readFileSync` also allocated the full file before truncating, so the cap did
not bound memory. Story: `docs/stories/RR-010/` (F01, verified stronger than
the original finding).

## Decision

- `snapshotDirtyWorktree()` returns a structured `WorktreeSnapshotResult`
  (`complete` / `truncated[]` / `skipped[]` / `trackedDiffError` /
  `writeError`); `complete` is true only when nothing was truncated, skipped,
  or failed.
- Both reuse gates (sync `prepareTaskWorkspace` and async
  `prepareTaskWorkspaceAsync`) call the pure predicate
  `shouldDiscardDirtyWorktree(result, force)` — `force || result.complete`.
  "Artifact written" is never accepted as evidence of "backup complete".
- Untracked reads go through `readFileCappedForSnapshot()` (open/fstat/read
  loop, at most `SNAPSHOT_MAX_FILE_BYTES` = 256 KiB), never a whole-file
  `readFileSync`; a short read counts as truncated (fail closed).
- Skipped entries are NAMED in the recovery artifact with a reason, and block
  cleanup instead of disappearing silently.
- `force` is an explicit per-call option on both prepare functions — not a
  global config flag (per-action approval must not become permanent approval).

## Alternatives Considered

1. Raise the cap — still loses data beyond any cap; allocation still unbounded.
2. Louder truncation warnings — still destroys; artifact stays false evidence.
3. Full base64 backup — artifact bloat (2 GiB file → ~2.7 GiB artifact).
4. Drop auto-clean entirely — breaks clean-slate reuse; `force` must remain.
5. `git stash` — changes semantics; itself a destructive git op; state lives
   outside `artifactsRoot`.
6. Global config flag for `force` — one-time opt-in becomes permanent approval.

## Consequences

Positive:
- Dirty worktree bytes survive reuse unless `force` is explicitly set — the
  AGENTS.md rule is enforced, not aspirational.
- Snapshot allocation is bounded regardless of file size; every
  skipped/truncated entry is visible by name before any delete.

Tradeoffs:
- Dirty worktrees with >256 KiB untracked files (or unreadable entries, or a
  failed tracked diff) are NO LONGER auto-cleaned — operators must pass `force`
  or move the file. Documented behavior change.
- `force` exists on both prepare functions but is not yet surfaced through the
  team-tool API (documented follow-up).
- An unreadable entry still cannot be backed up — it is now named and blocks
  the delete; with `force`, the loss still occurs.

## References

- Story: `docs/stories/RR-010/` (overview, design, exec-plan, validation)
- Verification: `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01
- Code: `src/worktree/worktree-manager.ts` (`WorktreeSnapshotResult`,
  `shouldDiscardDirtyWorktree`, `readFileCappedForSnapshot`, both reuse gates)
- Rule: `AGENTS.md` (worktree cleanup / `force`)
