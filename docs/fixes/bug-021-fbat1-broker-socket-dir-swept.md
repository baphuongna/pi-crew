# Bug #21 (F-BAT1): Broker socket dir swept by /tmp cleanup + stale-probe unlink race

Live-caught by the full-tier live battery 2026-10-08 (T9b-W). Fixed in `2e6d1d1f`.

## Symptom

Worker coordination tools (`ask` / `message` / `delegate`) returned ENOENT live — in BOTH
sync and async runs — while the runs themselves stayed green (graceful degrade: the exact
"green but dead" silent-failure class the battery exists to catch).

Evidence (run battery 2026-10-08):
- 2 runs (sync `team_…061857`, async `team_…061124`) × 3 workers each.
- Workers DID receive pre-minted creds (`PI_CREW_BROKER_SOCKET=/tmp/pi-crew-1000/pi-crew-<hash>.sock`)
  — the socket file simply did not exist (dir empty; `ss` showed no listener).
- The user's session env lacked `XDG_RUNTIME_DIR` (launched from Paseo terminal — not a
  login env), so the broker host fell back to `/tmp` while earlier sessions had bound
  under `/run/user/1000`.
- Unit broker suites were green — runtime/lifecycle problem, not a protocol problem.

## Root Cause (two stacked)

### 1. Namespace collision — live socket dir matched by debris sweeps

With `XDG_RUNTIME_DIR` absent, `getPerUserSocketDir()` fell back to
`/tmp/pi-crew-<uid>`. Three independent /tmp sweeps pattern-match `pi-crew-*` as
workspace debris and `rmSync` it:

- `cleanupLegacyOrphanTempDirs` (pi-args.ts, 24h-legacy sweep)
- the orphan temp reconciler
- the health zombie scan

Any of them could delete the LIVE broker socket dir of a no-XDG session. Sessions with
`XDG_RUNTIME_DIR` set were immune (broker under `/run/user`, never swept) — which is why
the bug only bit some launches.

### 2. Stale-probe race — timeout treated as definitive death

`removeStaleBrokerSocket` probed the socket and treated a connect **timeout** (250ms) as
"stale", unlinking a HEALTHY (slow-to-accept, busy host) broker socket. Only a definitive
`ECONNREFUSED` (kernel rejects connect — the listener is truly gone) is proof of death.

(Runners were exonerated: they consume stdin pre-minted creds rather than starting
brokers, and the orphan reconciler skips no-state dirs.)

## Fix

`src/utils/socket-path.ts`:

1. `getPerUserSocketDir()` — no-XDG fallback renamed to `.pi-crew-broker-<uid>`
   (dot-prefixed: no sweep pattern matches it). XDG path unchanged (`pi-crew-<uid>`
   under `/run/user`).
2. `removeStaleBrokerSocket()` — unlink ONLY on definitive `ECONNREFUSED`; timeout or
   any other error keeps the socket. Injectable `netModule` param (CrewBroker precedent)
   lets tests pin the race deterministically.

## Verification

- Pin suite `test/unit/utils/socket-path-fbat1.test.ts` (6 tests) — mutation-checked:
  single mutations are neutralized by the paired guard (defense-in-depth by design);
  reverting BOTH halves of fix 2 correctly reddens.
- Gates: `test:critical` 120/120, typecheck, lint, format:check, bundle rebuild
  deterministic (md5 `99c1a55b…`).
- Live E2E on the fixed bundle (fresh session, same no-XDG env): socket binds at
  `/tmp/.pi-crew-broker-1000/` and survives the whole run; `ask` round-trip delivers the
  leader reply through dependency-context (worker quotes it verbatim — run
  `team_20261008114453_f519d2c7cf620d1b`); `message` notify delivered to parent.
- Post-restart acceptance from the user's own session (PID 391081, bundle `99c1a55b`):
  session socket `pi-crew-4b3a061a.sock` alive 30+ min at the dot-path through multiple
  sweep cycles; `ask.requested` events delivered with zero ENOENT.

## Operational note

Stale sockets at the OLD no-XDG path (`/tmp/pi-crew-<uid>/…sock`) from pre-fix sessions
can be removed manually; they are not reused by the fixed code. Brokers under
`/run/user/1000` (XDG sessions) are unchanged.
