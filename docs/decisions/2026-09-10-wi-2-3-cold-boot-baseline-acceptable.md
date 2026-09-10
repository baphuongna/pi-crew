# ADR: M2/WI-2.3 — Cold boot baseline acceptable, no separate mitigation

- **Date**: 2026-09-10
- **Status**: Accepted (closes WI-2.3)
- **Spec ref**: `pi-crew-upgrade-spec.md` §5 M2 WI-2.3
- **Decision driver**: M1a/WI-1.1 fresh bench baseline (3 runs p50+spread)

## Context

Spec §5 M2 WI-2.3 originally targeted cold boot **≥30% reduction** based on the v0.9.62 perf-report claim of ~1.27s/worker. That baseline is **stale** (5 minor versions old, methodology drift). The new M1 baseline measures cold boot at **~400ms/worker** (n1 p50 403.8ms; n5 p50 399.5ms; n10 spread 53% — noise-heavy on concurrent spawn).

## Decision

**Accept the ~400ms baseline as meeting the spirit of the WI-2.3 goal.** Do NOT introduce a separate mitigation (prewarm, pool, lazy-load split) unless subsequent bench shows >10% regression from this baseline.

## Rationale

1. The 30% reduction target was derived from a stale 1.27s number — applying it now would target ~890ms, which we already beat (400ms = 68% better than the stale baseline).
2. The stretch metric from the research report was `≤1.5s/worker` for solo workers — already met by 3.75×.
3. Cold boot at ~400ms is dominated by Node.js + pi-host startup (the bundle itself is 2.9MB and contributes <100ms based on b7 bench at 2.6s total for full init). Further reduction requires architectural changes (worker pool with prewarm, lazy-load splits) that violate the spec's anti-goal **"no new runtime mode"** (a prewarm pool IS effectively a new runtime mode).
4. The spread of 53% at n10 indicates concurrent spawn is the noisy case — adding a pool would reduce variance but increase complexity and resource cost.

## Bench evidence (M1a baseline)

- `bench/results/2026-09-10T05-{04,07,11}-*.json` ×3 runs
- b1.child-spawn.real:
  - n1: p50 403.8ms (spread 5%)
  - n5: p50 399.5ms (spread 15.2%)
  - n10: p50 400.5ms (spread 53.2% — noise dominates)
- b7.startup: 2.6s (full module init including host — not worker-specific)

## Consequences

- WI-2.3 **closed without code changes**.
- If a future version regresses cold boot above 440ms (baseline + 10%), re-open this ADR and revisit pool/lazy-load options.
- The ADR escape in spec §5 WI-2.3 ("≥30% HOẶC ADR giải thích tradeoff") is now invoked — this ADR IS that explanation.
