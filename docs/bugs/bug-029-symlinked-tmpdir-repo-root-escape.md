# bug-029 — findRepoRoot escapes symlinked tmpdir boundary (macOS CI / state misrooting)

**Severity:** medium (test determinism on macOS CI; latent production state-isolation on any symlinked TMPDIR) · **Found:** 2026-08-19, T2 PR #48 CI · **Fixed:** same day

## Symptom
PR #48 CI: `run-cache.test.ts` failed **deterministically on macOS only** (2 consecutive runs, ubuntu/windows green, 12/12 locally on Linux) — exactly the last two tests:
- `getCacheStats: empty cache returns zeros` (expected 0, got 2)
- `getCacheStats: counts entries correctly` (expected 5, got 7)

## Root cause (two layers)
1. **Test isolation** — `makeTmp()` used raw `fs.mkdtempSync` (no `.git` marker), so `projectCrewRoot(tmp)` did not resolve inside the temp tree. All 12 tests shared whatever root the walk found.
2. **Source bug** — `computeRepoRoot` walks up from `fs.realpathSync(cwd)` (canonical path) but compared the boundary against `path.resolve(os.tmpdir())` (**lexical**). On macOS, `TMPDIR=/var/folders/…/T` realpaths to `/private/var/…/T`, the equality never fires, and the walk escapes the temp sandbox — latching onto an unrelated ancestor marker that exists on GH macOS runners (previously papered over by a `skip: darwin` in `paths.test.ts`).

Escaped root shared across tests → cache `index.json` accumulated (ghost entry test left 2 entries; +5 = 7) → the two `getCacheStats` assertions failed while the 10 self-consistent tests passed. Windows was coincidentally saved by the home boundary (`C:\Users\runneradmin` matches before any marker); Linux `/tmp` is not a symlink so the lexical compare worked.

## Fix
- `src/utils/paths.ts` — canonicalize both boundaries: `home` and `tempRoot` now go through `canonicalizePath()` (realpath with lexical fallback), matching the walk chain form.
- `test/unit/state/stores/run-cache.test.ts` — `makeTmp()` → `createTrackedTempDir()` (project convention: `.git` marker → project-scoped root inside the temp tree), hermetic regardless of the walk.
- `test/unit/utils/paths.test.ts` — removed the stale darwin `skip` ("Follow up: use a fully isolated nested temp tree" — this fix completes it) and added a deterministic red/green regression test (`base/package.json` marker + `TMPDIR` symlink so lexical ≠ real; asserts `findRepoRoot` returns `undefined`, with a vacuous-pass guard asserting `os.tmpdir()` observes the mutation).

## Production impact
A user running pi-crew from a marker-less scratch dir under a symlinked TMPDIR (every macOS) could get `.crew/` state rooted at an unrelated ancestor directory instead of falling back to user scope. Now the boundary holds: fallback to user scope as documented.

## Verification
- Regression test red without the source fix (stash → `fail 1`), green with it.
- `paths.test.ts` + `run-cache.test.ts` 30/30; `tsc --noEmit` clean; biome clean.
- Full unit + integration suites green modulo the documented load-amplification flakes (5 files, all pass in isolation, unrelated to `paths.ts`).
- CI re-run on the 3-OS matrix is the macOS confirmation gate.
