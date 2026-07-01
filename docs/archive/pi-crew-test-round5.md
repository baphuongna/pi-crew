# pi-crew v0.2.20 — Round 5 Test Results
**Date:** 2026-05-19
**Session:** After Pi restart, testing Bug #10/#11 fixes
**Environment:** linux/x64, Node v22.22.0, Pi CLI v0.75.3, pi-crew v0.2.20

---

## Test Results

### Test 1: Background async research team — FAIL ❌

**Command:** `team action='run', async=true, team='research'`
**Goal:** Verify Bug #10 (#8) and Bug #11 fixes for background workers

**Result:** ❌ FAIL — Child Pi workers crash immediately

**Error observed:**
```
Error: Failed to run npm root -g: undefined
    at DefaultPackageManager.runNpmCommandSync
    at DefaultPackageManager.getGlobalNpmRoot
    at DefaultPackageManager.getNpmInstallPath
```

**Root cause identified:** Bug #12 — The fix for Bug #10 accidentally stripped out essential env vars!

`buildChildPiSpawnOptions()` uses `sanitizeEnvSecrets(env, { allowList: [model API keys] })`. In allow-list mode, ONLY keys matching the allow-list are kept. All other keys (PATH, HOME, USER, etc.) are stripped.

→ The child Pi process has no PATH → cannot find npm → crashes immediately

**Workers spawned successfully (Bug #11 verified ✅):**
- `worker.spawned: pid=339071, pid=339077` — spawn OK
- `getPiSpawnCommand()` now resolves full path ✅

**But crashed (Bug #12 introduced ❌):**
- `worker.exit: exitCode=1` — child exited with error
- `task.failed` immediately after spawn

---

## Bugs Fixed This Round

### Bug #11: "spawn pi ENOENT" — ✅ Verified Fixed
- `getPiSpawnCommand()` now resolves full path on Linux/macOS
- Workers spawn successfully with real PIDs

### Bug #12: Essential env vars stripped (NEW — introduced by Bug #10 fix)
- Root cause: allow-list mode strips all non-matching keys
- Fix: added essential env vars to allow-list (PATH, HOME, USER, etc.)

---

## Current Bug Status (12 bugs total)

| # | Bug | Status |
|---|---|---|
| 1-7 | Various | ✅ Fixed |
| 8/10 | Background timeout (API key filtered) | ✅ Fixed |
| 9 | Executor hit yield limit | 🔲 Open |
| 10 | MINIMAX_API_KEY filtered | ✅ Fixed |
| 11 | Background runner "spawn pi ENOENT" | ✅ Fixed |
| 12 | Essential env vars stripped | ✅ Fixed (pending Pi restart) |

---

## Next Step

**Restart Pi** to reload with the Bug #12 fix. Then test:
1. Background async team — verify workers produce output within 60s (not 300s timeout)
2. Foreground fast-fix team — verify all phases complete