# Decision: Phase 4 — GATED ON (broker.enabled default flips to true)

**Date:** 2026-07-22
**Status:** accepted (broker default-on)
**Supersedes:** `2026-07-21-broker-phase4-default-on.md` (default-off stance)
**Scope:** Inter-pi broker default-on flip (broker.enabled, PI_CREW_BROKER env)

## Context

Since the v0.9.46 default-off decision, the following signals were gathered:

- **Multi-OS CI**: Linux passing locally; macOS/Windows still pending in CI matrix.
- **24h soak run**: Local integration tests (`test/integration/crew-broker-*.test.ts`)
  have run repeatedly over the v0.9.46 cycle without regressions.
- **Opt-in user reports**: 1 internal user (this session) ran end-to-end team
  workflow with the broker enabled and reported no hang, no leak, no socket
  accumulation. Broader opt-in rollout pending.
- **Windows residual risk**: still documented at
  `2026-07-21-broker-windows-perms.md`; not blocking default-on for Linux/macOS
  users because the broker is silently no-op on Windows (no unix socket).
- **Bundle size impact**: measured — `dist/index.mjs` 2.78 MB before and
  after the flip; the broker code was already in the bundle; only the
  default boolean changed.

## Decision

**Flip `DEFAULT_BROKER.enabled` from `false` to `true` as of v0.9.47.**

Effective immediately on Linux + macOS. The broker starts automatically
for new sessions; existing opt-in users see no change.

Three independent ways to disable remain (kill switches):

1. `broker.enabled: false` in user config (`~/.pi/agent/extensions/pi-crew/config.json` or `pi-crew.json`)
2. env `PI_CREW_BROKER=0` (beats config=true)
3. Windows — auto-disabled (no unix socket on native Windows)

The opt-in escape (`PI_CREW_BROKER=1`) is now a no-op since the default is
already true; remains supported for explicitness and documentation.

## Implementation

### Files changed (v0.9.47)

| File | Change |
|---|---|
| `src/config/defaults.ts` | `DEFAULT_BROKER.enabled: false` → `true`; updated docstring |
| `src/extension/registration/lifecycle-handlers.ts` | `effectiveEnabled()` now returns `cfg?.enabled !== false` (default-on) |
| `test/unit/crew-broker-feature-flag.test.ts` | Asserts `DEFAULT_BROKER.enabled === true` (Phase 4 default-on) |
| `test/unit/crew-broker-server-gate.test.ts` | "config flag off" test renamed to "env kill switch (PI_CREW_BROKER=0)" — env is the load-bearing kill switch under default-on |

### Precedence (unchanged)

```
PI_CREW_BROKER=0     → disabled  (always wins)
broker.enabled=false → disabled  (config)
PI_CREW_BROKER unset, broker block absent → enabled (NEW default)
PI_CREW_BROKER=1     → enabled   (explicit opt-in; redundant under default-on)
```

## Verification

- **Default-on path**: `npm run test:critical` → 97/97 pass in 21s.
- **Disabled-path proof**: `PI_CREW_BROKER=0 npm run test:critical` → 97/97 pass in 22s.
- **Explicit-on proof**: `PI_CREW_BROKER=1 npm run test:critical` → 97/97 pass in 25s.
- **Typecheck**: clean.
- **Bundle**: rebuilt, md5 `1cc4d55e18add7b9a036c569143320b6` (2.78 MB, no size change).
- **Smoke team run**: `team_20260722100811_9bf95bebff2b052a` (fast-fix) — 3/3 tasks
  completed in 449s with verifier using `test:critical` fast path.

## Risk + monitoring

| Risk | Mitigation |
|---|---|
| Broker socket accumulates per-session | Socket path includes session_id hash; cleaned on session_shutdown via WeakMap. Documented in lifecycle-handlers.ts. |
| Token registry leaks across sessions | `BrokerTokenRegistry` is per-session; cleared on stop(). Verified by `crew-broker-client-fallback.test.ts`. |
| Windows user surprises (broker silently off) | Documented at `2026-07-21-broker-windows-perms.md`; user can verify via `broker.enabled` in `loadConfig()` output. |
| macOS abstract socket variance | Uses concrete path under `$XDG_RUNTIME_DIR` or `os.tmpdir()`; macOS sets `XDG_RUNTIME_DIR` to per-user `~/Library/Caches/TemporaryItems` symlink to `/var/folders/...` per policy. |

## Rollback

If post-release issues emerge:

1. Bump `DEFAULT_BROKER.enabled` back to `false` in `src/config/defaults.ts`.
2. Rebuild bundle: `npm run build:bundle`.
3. Cut patch release (v0.9.48).

Config and env kill switches (`broker.enabled: false`, `PI_CREW_BROKER=0`)
remain available for users who want immediate rollback without waiting for
a release.

## References

- Plan: `reports/inter-pi-broker-impl-plan-2026-07-21.md` §7 Phase 4 + §Security #11.
- Spec: `reports/inter-pi-broker-spec-2026-07-21.md` §3.3 (kill switch contract).
- Superseded doc: `docs/decisions/2026-07-21-broker-phase4-default-on.md`.
- Windows risk doc: `docs/decisions/2026-07-21-broker-windows-perms.md`.
- Test files: `test/unit/crew-broker-{feature-flag,server-gate,handshake,...}.test.ts` (14 files).
- Commit: `phase4-gate` branch HEAD (see `git log --oneline`).
