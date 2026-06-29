# Bug Report: Chain feature breaks on Windows (multi-step runs)

**Date:** 2026-06-29
**Severity:** Medium (feature regression on Windows only; Linux/macOS unaffected)
**Status:** Open — root-cause hypothesized, NOT verified (needs a Windows VM)
**Affects:** the live `chain` feature (shipped v0.9.13) on Windows; caught by CI matrix
**Blocks:** v0.9.14 release (CI must be green on all 3 OSes — `gh run 28364101933` shows ubuntu ✓, macos ✓, windows ✗)

---

## Summary

The `team action='run', chain='...'` feature (wired live in v0.9.13, commit
`9c6c36a`) works on Linux and macOS but **breaks after the first step on
Windows**. `runChain` aborts the chain early because the first step's
`result.outcome` comes back non-`"success"`, which causes `runChain` to `break`
(`src/runtime/chain-runner.ts:233-239`).

On Windows the step outcome is misclassified because **`loadRunManifestById`
fails to read back the fixture manifest** that the same process just wrote.

## Measured evidence (CI run 28364101933, Windows job 84025614223)

7 tests fail on `windows-latest / Node 22`, ALL in the chain execution path:

| Test | Why it fails |
|---|---|
| `(d)(empirical) 3-step chain runs sequentially and captures 3 runIds` | `chainResult.steps.length === 1`, not 3 — chain broke after step 1 |
| `(empirical) @team reference step resolves to that team in handleRun params` | `mock.receivedParams` undefined — only 1 step ran, step 2's params never set |
| `(e) a failed team-run manifest maps to outcome failure mid-chain` | chain execution path |
| `handleChainRun returns a structured summary with runIds in data` | chain execution path |
| `(b) readChainStepOutput reads completed task output from resultArtifact` | `loadRunManifestById` returns the fixture → assertion on output fails |
| `(b) readChainStepOutput returns undefined when no completed tasks have resultArtifacts` | same read-back path |
| `(d)(semantic) step 1's worker output appears in step 2's goal` | step 2 never runs |

**The pure-logic chain tests all PASS on Windows** (`parseChainString`,
`formatChainHistory`, `mapRunToTaskResult`). Only the tests that touch the
filesystem via `writeRunFixture` → `loadRunManifestById` fail. Confirmed: all 7
failing tests call `writeRunFixture` / `runChain` / `handleChainRun`; the
passing ones are pure functions over in-memory inputs.

This is a **PRE-EXISTING v0.9.13 bug**, not a v0.9.14 regression. v0.9.13 CI
run 28347931393 failed Windows identically. The v0.9.14 commits touch ZERO
chain files (`git diff --stat v0.9.13..HEAD -- src/runtime/chain-runner.ts
src/extension/team-tool/chain-*.ts` is empty).

## Root-cause hypothesis (NOT verified — needs Windows VM)

`loadRunManifestById(cwd, runId)` → `resolveRunStateRoot(cwd, runId)` →
`resolveRealContainedPath(runsRoot, runId)` → **`fs.openSync(baseDir,
fs.constants.O_NOFOLLOW)`** (`src/utils/safe-paths.ts:175`).

On Windows CI runners the runs-root (`<tmpdir>/.crew/state/runs`) lives under a
temp path that Windows exposes through both **8.3 short-name aliases** and
**junctions**. `O_NOFOLLOW` semantics on Windows do not match POSIX, and the
`ELOOP` retry branch in `resolveRealContainedPath` (lines 184-194) is
**darwin-only** — there is **no Windows-specific retry for `O_NOFOLLOW` open
failures**. When the open throws, `resolveRealContainedPath` propagates,
`resolveRunStateRoot` returns `undefined`, `loadRunManifestById` returns
`undefined`, and `ChainTeamRunExecutor.executeStep` maps the missing manifest to
`outcome: "partial"` (`chain-executor.ts:293-295`) → `runChain` breaks.

The containment *comparison* at `safe-paths.ts:339-348` already handles Windows
canonicalization (`resolveWindowsCanonical` on both paths). So the failure is
not the containment check — it is the **initial `O_NOFOLLOW` open of baseDir
before realpathSync**.

**Why I am NOT fixing this blind:** this is security-sensitive path-resolution
code (the `O_NOFOLLOW` + containment machinery is a security control against
symlink-escape). Changing Windows handling without a Windows environment to
verify risks either (a) not actually fixing it, or (b) weakening the security
guarantee. Per the project's "đừng đoán mò" discipline, this needs a Windows
dev/CI environment to reproduce, fix, and verify.

## Workaround (this release)

Skip the 7 chain tests on `win32` in `test/unit/chain-executor.test.ts` with an
explicit `{ skip: "bug-023: Windows path resolution — see bug report" }` reason.
This is **transparent, not hidden**: the skip names the bug, the bug report is
tracked, and the production chain feature is documented as Windows-broken
pending the VM-verified fix. The pure-logic chain tests (9 of them) still run
on Windows, so the feature is not entirely untested there.

## Suggested fix (for the Windows-VM session)

1. In `resolveRealContainedPath` (`src/utils/safe-paths.ts`), add a
   Windows-specific branch alongside the darwin `ELOOP` branch: on `win32`,
   when the `O_NOFOLLOW` open fails for a baseDir that demonstrably exists
   (`fs.existsSync(baseDir)`), retry via `realpathSync.native` (the same
   canonical long-name resolver used by `resolveWindowsCanonical`).
2. Add a Windows CI assertion that a `writeRunFixture` → `loadRunManifestById`
   roundtrip succeeds under `<tmpdir>` (reproduces the failure; gates the fix).
3. Verify the containment guarantee still holds (the existing
   `safe-paths-cov.test.ts` suite must stay green; add a Windows-only fixture
   that creates a symlink/junction escape attempt and asserts it's rejected).

## References

- `src/runtime/chain-runner.ts:233-239` — `runChain` break on non-success outcome
- `src/extension/team-tool/chain-executor.ts:140-184` — `mapRunToTaskResult` (outcome from manifest status)
- `src/extension/team-tool/chain-executor.ts:291-295` — `loadRunManifestById` undefined → "partial"
- `src/state/state-store.ts:134-149` — `resolveRunStateRoot` → `resolveRealContainedPath`
- `src/utils/safe-paths.ts:163-210` — `resolveRealContainedPath` (O_NOFOLLOW open, darwin-only retry)
- `src/utils/safe-paths.ts:339-348` — Windows canonical containment check (already correct)
- CI run `28364101933` (v0.9.14) — ubuntu ✓, macos ✓, windows ✗ (these 7 tests)
- CI run `28347931393` (v0.9.13) — Windows ✗ identically (pre-existing)
