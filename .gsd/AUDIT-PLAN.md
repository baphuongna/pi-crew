# Pi-Crew Security Audit — Fix Plan (2026-07-14)

## Findings (verified from source)

### Fix 1: `workflows/intermediate-store.ts` — writeIntermediate path traversal (CRITICAL)
- **Problem**: `writeIntermediate()` has NO `isSafePathId()` check on `phase`/`stepId`, while `readIntermediate()` already has it (M-2 fix). An attacker-controlled `phase` or `stepId` could write to arbitrary paths.
- **Evidence**: `readIntermediate` has guard at line ~35, `writeIntermediate` does not.
- **Fix**: Add `isSafePathId(phase) && isSafePathId(stepId)` guard to `writeIntermediate()`, return early (throw or return empty string) if invalid. Mirror the pattern from `readIntermediate`.
- **Files**: `workflows/intermediate-store.ts`

### Fix 2: `state/instinct-store.ts` — projectId path traversal (HIGH)
- **Problem**: `getProjectInstinctPath(projectId)` uses raw `projectId` in `path.join()` with no validation. Public methods `saveInstinct()`, `getProjectInstincts()` pass raw `projectId` through.
- **Fix**: Add `isSafePathId(projectId)` validation in `getProjectInstinctPath()` or at entry points. Throw if invalid.
- **Files**: `state/instinct-store.ts`

### Fix 3: `runtime/verification-gates.ts` — env leak by default (HIGH)
- **Problem**: `buildVerificationEnv()` returns full `process.env` when `PI_CREW_VERIFICATION_SANITIZE_ENV` is not set (default). This leaks ALL secrets to verification commands.
- **Fix**: Flip the default — sanitize by default, make it opt-out. Change `isVerificationEnvSanitizeEnabled()` to return `true` when the var is NOT set (or remove the env-var check entirely and always sanitize).
- **Files**: `runtime/verification-gates.ts`

### Fix 4 (optional): `runtime/pi-spawn.ts` — execSync → execFileSync (LOW)
- **Problem**: `execSync("npm root -g")` uses shell. Hardcoded command is safe from injection, but `execFileSync` is preferred.
- **Note**: Doc comment says `execSync` is intentional for Windows PATHEXT. Low priority, may skip.
- **Files**: `runtime/pi-spawn.ts`

## Execution Plan

### Phase 1: Fix 1 — intermediate-store.ts
- Add `isSafePathId(phase) && isSafePathId(stepId)` guard to `writeIntermediate()`
- Add unit test for path traversal rejection in writeIntermediate

### Phase 2: Fix 2 — instinct-store.ts
- Add `isSafePathId(projectId)` validation
- Add unit test for invalid projectId rejection

### Phase 3: Fix 3 — verification-gates.ts
- Change `isVerificationEnvSanitizeEnabled()` to default true (sanitize by default)
- Update any tests that depend on the old default behavior

### Phase 4: Typecheck + Test
- `npx tsc --noEmit`
- `npm test`
- Verify all tests pass

### Phase 5: Commit + Release
- Commit with `fix(security): audit round 1 — path traversal + env leak`
- Update CHANGELOG.md
- Bump version (patch)
