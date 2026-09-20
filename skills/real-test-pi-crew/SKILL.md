---
name: real-test-pi-crew
description: >
  End-to-end verification for pi-crew changes: fast critical tests, 3-path kill-switch proof, bundle md5 sync, live TUI probing, smoke team runs, a live feature-action battery (team tool + subagent tools), a surface-mode battery (workers in real tmux/herdr panes, degrade-to-headless), a resource-contract battery (agent .md frontmatter dual-parse, routing render, output contracts), and a real-run UI render battery (every surface rendered from a real run's on-disk state: state glyphs, invented strings, pluralisation, truncation priority, usage formats, width survival).
  When NOT to use: unit tests for isolated modules (use test runner directly); pure test execution.

origin: pi-crew
triggers:
  - "test the change"
  - "verify it works"
  - "is it really working"
  - "live TUI test"
  - "smoke test pi-crew"
  - "run the critical tests"
  - "rebuild bundle"
  - "check bundle md5"
  - "tmux test"
  - "pty probe"
  - "did the verifier hang"
  - "worker timeout"
  - "verifier hangs"
  - "rebuild and retry"
  - "validation failed for tool"
  - "team tool broken"
  - "schema fix"
  - "feature battery"
  - "full features of pi-crew"
  - "surface test"
  - "surface mode"
  - "pane test"
  - "herdr test"
  - "degrade test"
  - "worker in pane"
  - "message tool test"
  - "delegate tool test"
  - "ask tool test"
  - "nested agent test"
  - "tier 1 / tier 2 / tier 3 / tier 4 / tier 5 / tier 6 / tier 7 / tier 8 / tier 9 / tier 10 / tier 11"
  - "read-your-writes"
  - "delayed write regression"
  - "coalesce regression"
  - "wc-gate"
  - "migration validator warning"
  - "slow tier"
  - "agent frontmatter"
  - "folded scalar"
  - "agent body change"
  - "routing metadata"
  - "output contract"
  - "loop guard"
  - "post-init skill check"
  - "resource contract"
  - "sigterm"
  - "silent bash"
  - "worker killed mid command"
  - "tier 12"
  - "tier 13"
  - "check the UI"
  - "run the UI"
  - "render every surface"
  - "full UI"
  - "does the card look right"
  - "undefined in the widget"
  - "spinner keeps spinning"
  - "hint cut off"
  - "tofu glyph"
  - "catalog png"
---

# real-test-pi-crew

End-to-end verification discipline for pi-crew changes. Distilled from the broker Phase-4 rollout (commits `1cb2dca` → `d599578` → `612e18b` → `4186284`, July 2026). The pain this skill prevents: shipping code that compiles + unit-tests-green but breaks in the user's live Pi session, or hangs the verifier worker.

**When to use**: after any change to `src/runtime/broker/*.ts` (broker + tokens + issuer), `src/ui/`, `src/config/` (incl. `src/config/migration-validator.ts`), `src/extension/registration/lifecycle-handlers.ts`, `src/runtime/child-pi/*.ts` (worker spawn/kill/steering), `src/runtime/surface/*.ts` (MuxSurface providers, degrade, launch script), `src/prompt/*.ts` (worker-side tools: ask / message / delegate / surface-worker recorder), `src/runtime/goal-workflow/plan-templates.ts`, `src/runtime/team-runner.ts` or `src/runtime/task-runner/**` (scheduler / execution — Tier 7 smoke), `src/state/**` (durable state — Tier 7 + 9a events/status + **Tier 11a read-your-writes**), `src/runtime/live-session/**` + `src/runtime/custom-tools/*` (live-session mode + worker custom tools), `src/schema/team-tool-schema.ts` (or any `Type.Unsafe({...})` schema definition), `src/extension/registration/team-tool.ts`, `workflows/*.workflow.md`, `.github/workflows/*.yml` (CI env — Tier 11e), `scripts/wc-gate.mjs` (Tier 11b), or before any commit touching these paths. Schema changes additionally require Tier 9 (feature battery) because the team tool's TypeBox schema is validated by pi-ai BEFORE the handler runs — a too-strict or malformed schema breaks every action silently. Surface changes additionally require Tier 10 (surface-mode battery) because surface is fail-closed: every failure degrades to headless and the run still goes green — only pane-level evidence proves the panes engaged. Resource `.md` changes (agent bodies/frontmatter, skill metadata, discovery, frontmatter parsing) additionally require **Tier 12** (resource-contract battery) because the agent/team/workflow frontmatter parser is line-based, not YAML — a folded scalar parses as `">"` for every consumer while all other tiers stay green.

> **Path map (2026-08-26 reorg + A1)**: `src/runtime/crew-broker*.ts` → `src/runtime/broker/`; `src/runtime/child-pi*.ts` → `src/runtime/child-pi/`; `src/runtime/plan-templates.ts` (flat) → `src/runtime/goal-workflow/plan-templates.ts`; NEW dirs `src/runtime/surface/` and `src/prompt/`. Test files moved with them (`test/unit/crew-broker-*.test.ts` → `test/unit/runtime/broker/`, `test/unit/keybinding-map.parity.test.ts` → `test/unit/ui/`, ...).

> **2026-09-11 update (Batch-1..10, branch `fix/bundle-skill-resolution-and-skill-meta`, tip `aa899a1e`)**: builtin agents 17 → **18** (librarian, oracle, designer, 3 councillors, orchestrator); every agent carries flat routing metadata; NEW **Tier 12** (resource-contract battery) for `agents/*.md` / `skills/*/SKILL.md` / discovery / frontmatter changes; staleness gate gained a path-leak scan (ARCH-7); `scripts/release-smoke.mjs` gained a tarball import + peer-install gate (ARCH-6); two new operational quirks documented (broker SIGTERM on long silent bash; `wait-request-broker.test.ts` 180s-per-file load flake). Orientation doc: `CONTEXT.md`.

> **2026-09-17 update (review-remediation wave F01–F20, 20 findings + baseline, `docs/archive/2026-09-17-pi-crew-review-verification.md`)**: three repo gates became **build-blocking in `ci.yml`** — `check:decision-drift`, `check:env-vars`, `check:event-types -- --enforce` (event registry 89 → **168** registered types, 0 drift); test-runner spawn deadline 900s → **1500s** + `PI_CREW_TEST_RUNNER_TIMEOUT_MS` override, and `resolveExitCode()` now fails CLOSED (ETIMEDOUT/spawn-error/signal-kill → non-zero; `NODE_TEST_CONTEXT` scrubbed from child env) — the silent exit-0 false-green class is closed; `PI_CREW_DEBUG_STALE` registered + routed via `getCrewEnv`. New state-machine contracts pinned by tests (all RED→GREEN): mailbox ack-sweep is FAIL-CLOSED on unreadable history (`mailbox-sweep-fail-closed.test.ts` — abort drops nothing, throttle window not consumed), run-lock staleMs steal of a LIVE in-process holder now warns `locks.steal-live-holder` (`run-lock-steal-live-holder-warn.test.ts`), async↔async run-lock mutual exclusion token-guarded. Suite anchors @ 2026-09-17: ~8012 unit tests (869 files), 130 pass + 4 skipped integration (35 files), `test:critical` 116, bundle 3357.3 KB md5 `25ffc88e9a13611f61871b4c4a5b17ab`.

## Core principle: disk ≠ live Pi

Two locations hold pi-crew state:

1. **Source** (`src/`, `test/`, `package.json`, `workflows/`, `src/runtime/goal-workflow/plan-templates.ts`) — git-tracked, `git diff` shows it.
2. **Bundle** (`dist/index.mjs`) — pre-built, loaded by Pi at **extension cold-start only**.

The 3-way resolution order for `dist/index.mjs` (per `index.ts:1-25`):
```
1. dist/index.mjs (pre-built bundle) if present  ← DEFAULT since the v0.9.17 bundle-as-default rollout
2. Inline strip-types loading — fallback when bundle missing
   OR PI_CREW_USE_BUNDLE=0
```

> **Note on version pins**: this skill mentions specific versions (v0.9.17, v0.9.46, v0.9.47) as anchors for *when a behavior was introduced*, not as a constraint on which version the skill applies to. The verification discipline (Tiers 1–10) applies to every pi-crew release. Verify the version pin is still accurate via `git log --oneline -- index.ts` and `git log --oneline -- src/ui/run-dashboard.ts`.

**Resource `.md` files are runtime data too** — `agents/*.md` and `skills/*/SKILL.md` load at RUN-CONSTRUCTION time from the package dir (they are NOT embedded in `dist/index.mjs`): edits take effect on the next team run / discovery call (discovery cache TTL ~30s — `invalidateAgentDiscoveryCache()` forces a fresh read), with NO bundle rebuild and NO Pi restart. `workflows/*.workflow.md` and task prompt strings inside `src/runtime/goal-workflow/plan-templates.ts` are the same: loaded per-call, NOT bundled. (Caveat: `src/` TypeScript that CONSUMES these files still follows the bundle rule below.)

**The most common silent-failure mode**: edit `src/`, run `npm test` (pass!), rebuild bundle (good md5!), but the session still has the old code because Pi wasn't `/quit`-ed + reopened.

## Prerequisites

Before running any tier, verify these are available:

| Tool | Used in | Check |
|---|---|---|
| `node` (>=22) | Tiers 1, 2, 3 | `node --version` |
| `npm` | All tiers | `npm --version` |
| `bash` | All tiers | `echo $BASH_VERSION` |
| `md5sum` | Tiers 3, 4, 8 | `which md5sum` (or `md5` on macOS) |
| `tmux` | Tier 5, 10 | `which tmux` (optional — Tier 6 is the fallback) |
| `herdr` | Tier 10c | `which herdr` (optional — only when pi itself runs inside a herdr pane) |
| `python3` | Tier 6 | `python3 --version` (optional — Tier 5 is the fallback) |
| `pi` in PATH | Tiers 5, 6 | `which pi` (must be installed via `npx pi install .`) |
| `git` | Reference lookups | `git log --oneline -1` should work |

Working directory should be the pi-crew repo root:

```bash
cd ${PWD}
ls package.json  # must exist
```

### CI integration

The skill maps to existing CI gates as follows:

| CI gate | Skill tier | File |
|---|---|---|
| `npm test:critical` (manual / pre-commit) | Tier 1 | n/a — not in CI by default |
| `PI_CREW_BROKER=0 npm run test:critical` | Tier 2 (env kill switch path) | n/a — manual |
| `npm run typecheck` | Tier 3 | `.github/workflows/*.yml` (every PR) |
| `npm run check:wc-gate` | Tier 11b | **in BOTH `ci` and `ci:fast` scripts** (`package.json:71-72`) + explicit step in `.github/workflows/ci.yml:66-71` (since `09dda842` — was `ci:fast`-only, i.e. advisory) |
| Bundle-staleness check (incl. **ARCH-7 path-leak scan** since `7d18508b` — line-scans `dist/index.mjs` + structural sourcemap check for tracked-source leaks) | Tier 3 last step | `scripts/check-bundle-staleness.mjs`; `--committed-hash` mode = Tier 11j release gate |
| `npm run test:bundle` (bundle import smoke, 2 tests) | Tier 3 post-build sanity | `test/unit/bundle-load.test.ts` |
| `node scripts/release-smoke.mjs` (manual, release cut) | Tier 3/11j companion | ARCH-6: installs pi-* peer deps, `import()`s the tarball-installed bundle (`:77`), shape-checks exports |
| Full `npm test` (= unit 869 files + integration 35 @ 2026-09-17) | n/a — too slow for in-loop | CI only; slow tier (3 files) is a SEPARATE glob `test:integration:slow` — only `npm run test:full` includes it |
| `PI_CREW_SMOKE=1` env | Tier 11e | set ONLY in `weekly-smoke.yml` (auth-gated); nightly.yml deliberately does NOT (comment at `:24`) |
| `npm run check:decision-drift` | Tier 11 (doc↔code) | **build-blocking in `.github/workflows/ci.yml` since 2026-09-17** (review-remediation baseline): every `PI_CREW_*` token cited in `docs/decisions/*.md` must exist in `src/` |
| `npm run check:env-vars` | Tier 11 | **build-blocking in `ci.yml` since 2026-09-17**: every `PI_CREW_*` read must be routed via `getCrewEnv` + registered |
| `npm run check:event-types -- --enforce` | Tier 9a/11 | **build-blocking in `ci.yml` since 2026-09-17**: event registry (`src/state/contracts.ts`) must cover every emitted type — 168 registered / 0 drift @ 2026-09-17 (was 89, drift silent) |
| `PI_CREW_TEST_RUNNER_TIMEOUT_MS` env | Tier 1 companion | overrides the test-runner spawn deadline (`scripts/test-runner.mjs:206`); default **1_500_000 ms** since 2026-09-17 (was 900_000 — sized for a 5800-test suite; the full suite outgrew it and the ETIMEDOUT became a false green pre-F05) |

To add Tier 1 to a pre-commit hook:

```bash
# .git/hooks/pre-commit (or via husky / pre-commit framework)
npm run test:critical || {
  echo "✋ test:critical failed — fix before commit"
  exit 1
}
```

To add Tier 1 to CI as a fast-feedback gate (under 30s):

```yaml
# .github/workflows/fast.yml
- name: Critical unit tests
  run: npm run test:critical
- name: Disabled-path proof
  run: PI_CREW_BROKER=0 npm run test:critical
- name: Explicit-on proof
  run: PI_CREW_BROKER=1 npm run test:critical
```

---

## Tier 1 — Critical unit tests (~21s, 102 tests, the only suite you need for broker/UI changes)

**What**: run the curated 14-file fast subset.

**Why this exists**: full `npm run test:unit` runs 823 files (was 642 at skill-writing time — it keeps growing), several minutes. Verifier worker response timeout would kill the worker mid-run → run = "hang". The fix (introduced in commit `1cb2dca`) splits out a `test:critical` subset covering exactly what changed in the broker/UI work.

**How**:

```bash
time npm run test:critical
```

Expected output: `# tests 102 # pass 102 # fail 0 # duration_ms ~21000`. (Count was 97 at v0.9.46, 101 at v0.9.66, **102 since the waitMethodsEnabled flip** — verify with the actual run; the skill's hard-coded numbers drift between releases.)

**References**:

| What | Where |
|---|---|
| Script definition | `package.json:85` — list of 14 files passed to `node scripts/test-runner.mjs` |
| Introduced in commit | `1cb2dca fix(verifier): use test:critical instead of test:unit to avoid worker timeout` |
| Runner wrapper | `scripts/test-runner.mjs` — injects `--test-force-exit`, forwards to `tsx --test` |
| The 14 files | broker: `test/unit/runtime/broker/crew-broker-{handshake,stale-socket,feature-flag,server-gate,client-fallback,mailbox-observer,close-during-reconnect,steer-dedup,symlink-steering}.test.ts`; UI: `test/unit/ui/keybinding-map.parity.test.ts`, `test/unit/ui/pi-tui-dispatch-probe.test.ts`; utils: `test/unit/utils/session-utils-extract.test.ts`; config: `test/unit/config/config-schema-sync.test.ts`; spawn env: `test/unit/runtime/child-pi/child-pi-env-spread.test.ts` |
| Failure mode that motivates it | Worker timeout in `src/runtime/child-pi/child-pi-constants.ts:23` (`RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs` — 300000 at the time, now 600000); verifier LLM ran `npm test` and got killed with exit 143 (SIGTERM) |

**Run after**: any edit to `src/runtime/broker/*.ts`, `src/ui/`, `src/config/`, `src/extension/registration/lifecycle-handlers.ts`, or `src/runtime/child-pi/*.ts`.

---

## Tier 2 — Three-path kill-switch proof

**What**: prove all three precedence paths in `effectiveEnabled()` still resolve correctly.

**Why**: any change to `DEFAULT_BROKER` (in `src/config/defaults.ts:191`) or `effectiveEnabled()` (in `src/extension/registration/lifecycle-handlers.ts:1026-1039`) can silently break the precedence chain. The chain:

```
PI_CREW_BROKER=0     → disabled (env always wins)
broker.enabled=false → disabled (config)
PI_CREW_BROKER unset → enabled (DEFAULT_BROKER=Phase 4 default-on)
PI_CREW_BROKER=1     → enabled (explicit; redundant under default-on)
```

**How**:

```bash
# 1. default path (whatever DEFAULT_BROKER.enabled is right now)
npm run test:critical
# 2. env kill switch
PI_CREW_BROKER=0 npm run test:critical
# 3. env explicit-on (must still work under default-on)
PI_CREW_BROKER=1 npm run test:critical
```

All three must show `# pass 101 # fail 0`. Measured times in this session (2026-08-11): ~26s for default, ~26s for `PI_CREW_BROKER=0`, ~26s for `PI_CREW_BROKER=1` (varies ±1-2s run-to-run).

**References**:

| What | Where |
|---|---|
| `DEFAULT_BROKER` constant | `src/config/defaults.ts:191` (Phase 4: `enabled: true`; `waitMethodsEnabled: true` at `:205` since the 2026-08-26 ask flip) |
| Precedence function | `src/extension/registration/lifecycle-handlers.ts:1026-1039` (`return cfg?.enabled !== false;`) |
| `resolveBrokerEnvOverride` | `src/config/defaults.ts:252` |
| Env-precedence unit tests | `test/unit/runtime/broker/crew-broker-feature-flag.test.ts:31` (default-on assertion), `:54-110` (env=1/env=0/unset/arbitrary cases at lines 54, 66, 78, 90, 103) |
| Controller-gate tests | `test/unit/runtime/broker/crew-broker-server-gate.test.ts:78` (env kill switch under default-on), `:143` (env=1 with no config) |
| Decision doc | `docs/decisions/2026-07-22-broker-phase4-gated-on.md` |
| Superseded doc | `docs/decisions/2026-07-21-broker-phase4-default-on.md` (marked SUPERSEDED in commit `4186284`) |
| Default flip commit | `612e18b feat(broker): Phase 4 gated ON — flip broker.enabled default to true` |

---

## Tier 3 — Typecheck + bundle rebuild + md5 sync

**What**: prove the bundle actually contains the source you just edited.

**How**:

```bash
npm run typecheck    # ~20s, exits 0 with "strip-types import ok"
npm run build:bundle # <1s, prints "[build-bundle] dist/index.mjs NNNN KB in NNN ms"
md5sum dist/index.mjs
node scripts/check-bundle-staleness.mjs   # ARCH-7: staleness + path-leak scan — exit 0
```

Compare the printed md5 against what the user's Pi session loaded. If they differ → the session is running stale bundle.

**References**:

| What | Where |
|---|---|
| `typecheck` script | `package.json` `"typecheck"` — runs `tsc --noEmit && node --experimental-strip-types -e "await import('./index.ts'); ..."` |
| `build:bundle` script | `package.json` `"build:bundle"` — runs `node scripts/build-bundle.mjs` |
| Bundle builder | `scripts/build-bundle.mjs` (esbuild-based, bundles `index.bundle.ts` → `dist/index.mjs`) |
| Bundle resolution rule | `index.ts:1-25` (entrypoint docstring); also `scripts/build-bundle.mjs:14-20` (entrypoint preference); **symlink is live for source files but the bundled `dist/index.mjs` is loaded** |
| Postinstall hook | `scripts/postinstall.mjs:43` — best-effort bundle rebuild; falls back to strip-types if esbuild missing |
| Bundle md5 anchors | `1cc4d55e18add7b9a036c569143320b6` (Phase-4 flip, ~2.78 MB) → `16e29d053bd370e24f40df147dadcb79` (v0.9.66, 2026-08-11) → `9b557ac106b82e1ee33d39dd0d6c7dd7` (post-MuxSurface-A1 main, 2026-08-27) → `945720b1ad25673d86e263cdd834532f` (post-Batch-10 branch tip `aa899a1e`, 2026-09-11, ~3.30 MB) → `25ffc88e9a13611f61871b4c4a5b17ab` (review-remediation F01–F20 wave, 2026-09-17, 3357.3 KB / 3,437,867 B). **Always check current**: `md5sum dist/index.mjs` |

---

## Tier 4 — Bundle sync into a live Pi session

**What**: ensure the user's running Pi sees your changes.

**The immediate-vs-rebuild rule** (which edits take effect without a rebuild):
- `workflows/*.workflow.md` edits → **immediate**, no rebuild, no restart
- `agents/*.md` + `skills/*/SKILL.md` edits → **immediate** — runtime data loaded from the package dir per discovery/run (cache TTL ~30s); NOT embedded in `dist/index.mjs`
- `src/runtime/goal-workflow/plan-templates.ts` → **needs rebuild** (correction of the pre-v0.9.17 claim above): it is `src/` TypeScript imported by the bundle, so its `taskTemplate` strings ship inside `dist/index.mjs` — edit → `build:bundle` → restart
- Everything else (`src/` edits, `package.json`) → must `npm run build:bundle` THEN user `/quit` + reopen Pi

**How to verify in this session**:

```bash
md5sum dist/index.mjs
# then in Pi session, the user runs `md5sum` in a shell tool
# if they differ, user needs to /quit + reopen
```

**How to verify in a fresh pty/tmux session without disturbing the user's main Pi**:

```bash
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  "cd ${PWD} && exec pi 2>&1"
```

**References**:

| What | Where |
|---|---|
| Bundle resolution | `index.ts:1-25` — "dist/index.mjs (pre-built bundle) if present AND not explicitly disabled — DEFAULT since v0.9.17" |
| Bundle size impact after Phase-4 flip | `docs/decisions/2026-07-22-broker-phase4-gated-on.md` §Verification: "2.78 MB before and after the flip; the broker code was already in the bundle; only the default boolean changed" |
| Symlink confirmation | **The symlink lives in the CONSUMING project, not inside pi-crew itself.** From the pi-crew repo, check the parent: `readlink ../node_modules/pi-crew` (returns `../pi-crew` for dev clones). For global installs: `readlink "$(npm root -g)"/pi-crew`. Pattern is always `<consumer>/node_modules/pi-crew → <pi-crew-repo>`. |

---

## Tier 5 — Live TUI probe via tmux send-keys

**What**: drive a real Pi session's keystrokes from the shell, capture screen state.

**Why tmux and not raw pty**: tmux gives you a clean separation — session persists across your bash commands, capture-pane gives ASCII screenshot, send-keys with hex escapes covers `\x1b[A` (legacy CSI), `\x1bOA` (app-cursor-mode), and Kitty-protocol variants.

**How**:

```bash
# Spawn (160x50 fits ~standard TUI)
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  "cd ${PWD} && exec pi 2>&1"

# Wait for pi to start
sleep 2

# Send slash command
tmux send-keys -t pi '/team-help' Enter
sleep 1
tmux capture-pane -t pi -p | tail -40

# Send raw escape sequence (app-cursor-mode up arrow)
tmux send-keys -t pi $'\x1bOA'
sleep 0.5
tmux capture-pane -t pi -p > /tmp/screen-after-up.txt
```

**Key gotcha**: terminals send arrow keys as one of 3 byte sequences. pi-crew's `matchesKey()` helper (`src/ui/key-utils.ts:37-42`, the `keyOf()` function) normalizes all of them — but verify it does in your probe:

| Mode | Up arrow | Down arrow | Source |
|---|---|---|---|
| Legacy CSI | `\x1b[A` | `\x1b[B` | vt100, xterm |
| App-cursor-mode | `\x1bOA` | `\x1bOB` | vim, less, full-screen apps |
| Kitty protocol | `\x1b[1;2A` (Shift+Up) etc. | — | modern terminals (kitty, foot, ghostty) |

**References**:

| What | Where |
|---|---|
| `keyOf()` helper | `src/ui/key-utils.ts:37-42` (import + type alias at lines 16-18) |
| Dispatch path | `src/ui/keybinding-map.ts` (migrated to `matchesKey()` in commit `f05a10d`) |
| Golden snapshot test | `test/unit/ui/keybinding-map.parity.test.ts` — 8 `it()` blocks asserting parity against a generated golden snapshot; `DEFAULT_BINDINGS` table has 31 action entries (`src/ui/keybinding-map.ts:147-211`; user-overridable via the `keybindings` config section / `PI_CREW_KEYBINDINGS` env) |
| Live probe test | `test/unit/pi-tui-dispatch-probe.test.ts` — direct probe of dispatch (3 tests) |
| Probe commit | `84944f7 test(probe): add invalidate() to control object so typecheck passes` |
| Tab/Space bind | `src/ui/run-dashboard.ts` + commit `15a0ffe fix(ui): also bind Tab/Space/Enter/S to select in dashboard dispatch` |
| Tmux session file | `/tmp/sock` (created on first `new-session -S`) |

---

## Tier 6 — Live TUI probe via Python pty (bulk keys + diag)

**What**: send many keys in sequence + capture per-keystroke diag output.

**When to use**: when you need to probe dispatch across multiple keypresses, or want to verify each key reached the component's `handleInput`.

**How** (simplified inline example — for the full hardened script with zombie reaping, non-blocking read, and escape-sequence decoding, use `scripts/pty_probe.py` directly):

```python
#!/usr/bin/env python3
"""pty_probe.py — bulk-key + diag probe for pi-crew TUI components."""
import os, sys, time

CMD = ['pi']
ENV = dict(os.environ)  # keystroke diag env var REMOVED (see note below)

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(CMD[0], CMD, ENV)
else:
    time.sleep(2)  # initial pi startup
    keys = [
        'j', 'j', 'k',                      # vim nav (run dashboard)
        '\x1b[A',                            # legacy CSI up
        '\x1b[B',                            # legacy CSI down
        '\x1bOA',                            # app-cursor-mode up
        '\x1bOB',                            # app-cursor-mode down
        'q', 'q',                            # quit (double-tap)
    ]
    for k in keys:
        os.write(fd, k.encode())
        time.sleep(0.3)
    time.sleep(1)
    sys.stdout.write(os.read(fd, 65536).decode(errors='replace'))
```

> ⚠️ The inline code above is a **teaching example**. For real use, run the bundled script (`scripts/pty_probe.py`, 161 lines) which adds zombie reaping (`_reap_child`), non-blocking read (`select.select` with 5s timeout), exec error handling, and `--keys` escape-sequence decoding:
> ```bash
> python3 scripts/pty_probe.py [--keys '\x1bOA,q,q'] [--cwd /path] [--startup-sleep 3]
> ```
> The inline code works for a quick one-off but **leaks a zombie `pi` process** on exit.

**Keystroke diag env var REMOVED (2026-08-10)**: `PI_CREW_BROKER_DIAG_UI=1` made `run-dashboard`'s `handleInput` write a `[PI-CREW-DIAG]` line to stderr per keystroke. It was removed in `e3ee6fe2` (PR-B5: remove TEMP DIAGNOSTIC from run-dashboard, UI-8) — there is no replacement in `src/`. **To prove keystroke arrival now, rely on screen-change evidence** (Tier 5 tmux `capture-pane` before/after each key, or the pty output diff): a key that changes screen state reached the TUI; a key that does not was consumed or never arrived. Capture the probe output to a file with `2>&1 | tee /tmp/pty-probe.log` and diff the rendered frames.

**References**:

| What | Where |
|---|---|
| Keystroke diag env var | **REMOVED** — `e3ee6fe2` (PR-B5/UI-8). No replacement; use screen-change evidence |
| Reduced-noise commit | `00e8ba0 chore(broker): strip diagnostic noise from focused-field fix` — diag calls left in but no longer noisy (pre-removal) |
| Original probe | `84944f7 test(probe): add invalidate() to control object so typecheck passes` |

---

## Tier 7 — Smoke team run (verifier prompt doesn't hang)

**What**: prove the verifier worker completes within `RESPONSE_TIMEOUT_MS` (**600s since the stuck-worker hardening — was 300s when this skill was distilled; `DEFAULT_CHILD_PI.responseTimeoutMs = 10 * 60_000`**).

**Why this is its own tier**: `test:critical` covers unit-level invariants, but the verifier LLM is a separate failure mode — it reads the verifier prompt from `src/runtime/goal-workflow/plan-templates.ts:144, 147` (taskTemplate strings) or from `workflows/*.workflow.md` (workflow verifier sections), then decides which bash command to run. If the prompt says "Run tests" without specifying which, the LLM runs `npm test` (823 files) and the worker gets killed by the response timeout with exit 143.

**How** (from parent Pi session — `team` is a tool, not a shell command):

```yaml
# illustrative — the actual tool takes positional + named params:
#   team action='run' team='fast-fix' workflow='fast-fix' goal='...' async=false
team:
  action: run              # run | status | events | cancel | retry | ...
  team: fast-fix           # team (a role-set): default / fast-fix / implementation / parallel-research / research / review
  workflow: fast-fix       # workflow (a phase DAG): default / fast-fix / plan-execute / implementation / review / research / parallel-research / pipeline / chain
  goal: "Smoke-verify <X>. Run `npm run test:critical && npx tsc --noEmit` once, cache output, report exact pass/fail counts + total time. Confirm verifier completes without hang (must be <600s)."
  async: false             # synchronous: wait for completion before returning
```

The `team` tool is described in the agent's system prompt. Use `team action='status' <runId>` to inspect mid-run, `team action='events' <runId> <limit>` for the event log, `team action='cancel' <runId>` to abort.

**Real measured outcomes from this session** (July 2026, under the old 300s timeout — wall-clock shape still representative):

| Run ID | Goal | Result | Wall-clock |
|---|---|---|---|
| `team_20260722083504_cae04a2804a24d79` | smoke full-implementation | 3/4 phases, 04_verify hung on `npm test` | 572s |
| `team_20260722095143_2e58fce2ce91af19` | first smoke-fix smoke | 3/3 PASS, verifier used fast path but ran multiple LLM turns (think→bash→observe→respond) totaling ~907s cumulative | 907s |
| `team_20260722100811_9bf95bebff2b052a` | re-smoke after workflow prompt fix | 3/3 PASS, verifier used `test:critical` cache | 449s |

**References**:

| What | Where |
|---|---|
| `verificationCommand` for plan-templates | `src/runtime/goal-workflow/plan-templates.ts:147, 151` — both templates now `npm run test:critical && npx tsc --noEmit` |
| `taskTemplate` for verifier | `src/runtime/goal-workflow/plan-templates.ts:144` — explicit "Do NOT run `npm test`" + "<2 min" budget |
| Workflow verifier prompts | `workflows/fast-fix.workflow.md:24`, `workflows/plan-execute.workflow.md:30`, `workflows/review.workflow.md:31` — all three pin `test:critical`; `workflows/default.workflow.md:39` uses generic wording ("FAST targeted checks only, never the full suite") |
| Verifier fix commit (plan-templates) | `1cb2dca fix(verifier): use test:critical instead of test:unit to avoid worker timeout` |
| Verifier fix commit (workflows) | `d599578 fix(workflows): specify fast test:critical command in verifier prompts` |
| Watchdog constant | `src/runtime/child-pi/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs` = **600_000** (`src/config/defaults.ts:26`; env override `PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS`, see `child-pi.ts:692-697`) |
| Cache directive | `Run FAST checks ONCE (cache output to .crew/cache/)` — anti-re-run safeguard baked into the verifier prompts |
| Decision doc | `docs/decisions/2026-07-22-broker-phase4-gated-on.md` §Verification (mentions the smoke run `team_20260722100811_9bf95bebff2b052a`) |

**Two known failure modes for verifier**:

1. **Verifier LLM runs `npm test`** (full unit + integration suite, >4 min) instead of `npm run test:critical`. Symptom: worker killed with exit 143 at the response timeout (300s historically — the measured runs below predate the bump to 600s). Fix: rewrite the verifier prompt to specify the exact fast command AND include "Do NOT run `npm test` or `npm run test:unit`".
2. **Verifier LLM improvises** with a clean-cache `npm test` run anyway. The cache directive ("cache to `.crew/cache/`", "do NOT re-run") catches this — the second worker that observes a cached log should not re-run.
3. **Broker SIGTERMs the worker mid long-silent-bash** (Batch-1 postmortem, `postmortem-batch-1-sigterm.md`): a worker running ONE >5–10 min command (full `npm test` ≈ 10 min) emits no LLM activity; the broker's responsiveness check kills it mid-run — exit 143 WHILE the command is still running, not a 600s response timeout. The transcript shows the command started and never returned. Work is usually intact (manual re-run was green); the kill is the "hang". Fix direction: split long suites into <5 min chunks or emit progress between commands. Tracked as `CONTEXT.md` Flagged #1.

---

## Tier 8 — Bundle-vs-session md5 sync (operational check)

**What**: the concrete md5 comparison step that *proves* Tier 4's claim. Tier 4 explains *when* you need a rebuild; Tier 8 is the *command* you run to confirm the session picked it up. Run Tier 8 as the final integrity check after Tier 3-4.

**How**:

```bash
# Disk
md5sum dist/index.mjs

# Session (ask user to run in their pi shell tool)
# The symlink is in the CONSUMING project, not inside pi-crew:
readlink ../node_modules/pi-crew/dist/index.mjs 2>/dev/null \
  || readlink "$(npm root -g)"/pi-crew/dist/index.mjs \
  || md5sum "$(npm root -g)"/pi-crew/dist/index.mjs
# (the consuming project loads pi-crew via this symlink — see index.ts:1-25)
```

If the two md5s match → session is on the latest code. If not → user must `/quit` + reopen Pi.

> **Agent-inside-session caveat**: when the agent *doing the testing* runs inside the very Pi session under test, the agent **cannot restart its own session** — only the user can. Pattern that works: (1) edit source + rebuild bundle, (2) ask the user to `/quit` + reopen, (3) on resume, re-check `md5sum dist/index.mjs` then issue a probe tool call (e.g. `team action='list'`). If the probe returns the *old* error (e.g. `Unknown type`, `Validation failed for tool team`), the session did NOT reload — there may be multiple `pi` PIDs and the user reopened a different one. Verify with `ps -eo pid,lstart,tty,args | grep pi` which PID is yours (the one whose session log is being appended to right now).

**References**:

| What | Where |
|---|---|
| Symlink path | `index.ts:1-25` — **the symlink lives in the CONSUMING project** (parent dir or global prefix), not inside pi-crew itself. From the repo: `readlink ../node_modules/pi-crew` (dev) or `readlink "$(npm root -g)"/pi-crew` (global). Verify with `readlink` + `npm root -g`. |
| Session load model | Same file: "dist/index.mjs (pre-built bundle) if present — DEFAULT since v0.9.17" |

---

## Tier 9 — Feature battery (live action coverage)

**What**: drive the team tool + subagent tools through a spread of actions from the parent Pi session to prove the full surface works end-to-end, not just one smoke run.

**Why this exists**: Tier 7 proves one team run completes. But pi-crew has **55 `team` actions across 5 domain dispatchers** (`RUN` 10: run/parallel/plan/plans/orchestrate/resume/retry/wait/steer/goal · `STATUS` 16: status/list/get/events/artifacts/summary/graph/search/health/worktrees/checkpoint/cache/explain/onboard/recommend/help · `CONTROL` 7 · `MANAGE` 16 · `AUTOMATE` 6 — `src/schema/team-tool-schema.ts:391-437`) plus the subagent tools (`Agent`, `crew_agent`, `get_subagent_result`, `steer_subagent` — with `crew_agent_result`/`crew_agent_steer` aliases), the worker-side tools (`ask`, `delegate`, `message`), and the `team-settings` config surface, dispatched through several code paths (sync run, async run, chain, parallel, direct subagent). A schema or registration regression can break *some* paths while others still pass. The battery catches path-specific breakage.

**When required**: any change to `src/schema/team-tool-schema.ts`, `src/extension/registration/team-tool.ts`, `src/extension/team-tool/*.ts` (handler dispatch), or the subagent-tool registration. Optional but cheap for any change — the read-only actions are free.

**How** (run from the parent Pi session — these are tool calls, not shell):

1. **9a. Read-only actions** (free, no subagent spawn — run these first as a fast battery):
   - `team action='list'` — teams/workflows/agents
   - `team action='recommend' goal='...'` — planner routing
   - `team action='health'` — run-state scan
   - `team action='doctor' focus='zombies'` — orphan subagent + orphan surface-pane scan (read-only)
   - `team action='status' runId='<recent>' details=false` — compact
   - `team action='events' runId='<recent>'` — full event lifecycle
   - `team action='summary' runId='<recent>'` — cost/by-role report
   - `team action='get' resource='workflow' team='implementation'` — resource inspect
   - `team action='explain' runId='<recent>'` — markdown render
   - `team action='worktrees' runId='<recent>'` — workspace listing
   - `team action='graph' runId='<recent>'` — task-graph render (newer action)
   - `team action='search' query='...'` — event/artifact search (newer action)
   - `team-settings` (slash) or `team action='settings' config={args:'get runtime.surface.mode'}` — config surface incl. the surface/nesting keys
2. **9b. Spawn paths** (cost tokens — one probe each is enough):
   - `team action='run'` sync (fast-fix, trivial goal) — proves sync run + child-pi spawn + provider-extension loading
   - `team action='run' async=true` — proves background dispatch
   - `team action='run' chain='"A" -> "B"'` — proves sequential handoff (chain runner). **Omit `workflow`** — passing `workflow:'chain'` forwards it to each step and fails fast (~58ms silent; issue #44).
   - `team action='orchestrate'` / `action='plan'` / `action='plans'` — planning surface without execution (cheap middle ground between 9a read-only and full spawn)
   - `Agent` direct subagent — proves the direct-subagent tool
   - `crew_agent` `run_in_background=true` then `get_subagent_result` — proves background subagent lifecycle
   - `steer_subagent` while a background subagent runs — proves live steering (timing-sensitive; was listed under 9c, but it is the canonical name now — `crew_agent_steer` is the alias)
3. **9b-W. Worker-tool paths** (cost tokens — proven via goal text that instructs the worker to call the tool; one probe each):
   - **ask round-trip**: goal says "use the `ask` tool to ask the parent <question>, wait for the reply". Proves `wait.request` → park → `team action='respond'` → pickup. **The gate `broker.waitMethodsEnabled` defaulted to `false` until 2026-08-26 (`ceb9a68d` flipped it) — ask slept silently for weeks while every wait.request was rejected `policy-disabled`.** If a worker "answers its own question" instead of asking, the gate or the prompt guidance regressed. Rejections are never silent: a `policy.action` event lands in `events.jsonl`.
   - **message notify**: goal says "use the `message` tool to notify the parent when done". Proves `msg.send` (non-blocking) + the broker `from`-override (anti-spoof) + the wake pattern on the orchestrator session. Rate-limit 10 msg/60s per worker — a burst probe should hit the limit, not hang.
   - **message DM/group**: goal says "DM task `<sibling taskId>` / send to group `x`" — proves `to:` routing + inbox pickup (delivered as fenced `<inbox-message>` DATA, not instructions).
   - **delegate nesting**: goal says "use the `delegate` tool to spawn a child agent". Proves the role gate is open for every role (D8, default-on), the depth cap (`nesting.maxDepth: 4` — a depth-5 attempt must reject with the structured policy message + `delegate.rejected` event, never silently), and the nested-slot budget. Kill switch: `nesting.enabled: false` in **user** config only (sensitive — project config cannot flip it).
   - **full loadout sanity** (D5): in any 9b run, have the worker report its loaded extensions/skills/tools. Workers are FULL pi sessions by default — no `--no-extensions`, no `--tools` allowlist, `--no-skills` only when the agent frontmatter says `inheritSkills: false`. A worker missing MCP tools/skills means the loadout policy regressed (see Anti-patterns, armed-role row).
4. **Acceptance**: every action returns without `Unknown type` / `Validation failed for tool team` / empty error text; every spawn path completes with `consistency=1` and the expected probe token in the agent output.

**Real measured outcome** (this session, after the v0.9.57 schema fix): 9a (15 team actions) + 9b (4 subagent tools / 3 run paths) exercised; all green; the two silent-failure modes that motivated this tier (`Unknown type` from `Type.Unsafe` without Kind, and `Validation failed for tool team` from empty-string-strict schema) were caught ONLY by this battery — Tier 1-8 all passed while the team tool was broken live. The session also surfaced the unauthorized-agent-edit anti-pattern (a chain-run agent edited `chain-runner.ts` mid-smoke) — see Anti-patterns.

**Not covered by the cheap battery above** — the actions below need extra setup, cost, or user confirmation. Run them only when the change touches their code path, and prefer a throwaway cwd / config so you don't mutate the user's real state. Organised by cost/safety. **As of 2026-08-11 (extended battery, run report `real-test-2026-08-11-scratchpad-I-batch.md`), 9c/9e/9f have been exercised live once each — they are no longer unproven, but still require explicit scope+confirmation to re-run.**

**9c. Lifecycle / recovery** (needs a *running* run — start an async run, then exercise these against its runId):
- `team action='wait' runId='...'` — block until completion
- `team action='steer' runId='...' message='...'` — inject a steering note mid-run
- `team action='status' runId='...' details=true` — full dump mid-run
- `team action='cache' subAction='...' runId='...'` — snapshot cache ops
- `team action='checkpoint' runId='...'` — state checkpoint
- `team action='cancel' runId='...'` — ⚠️ destructive (kills the run); use a throwaway run
- `team action='invalidate' runId='...'` — cache invalidation
- `team action='resume' runId='...'` / `retry` — resume a completed/failed run
- `team action='respond' taskId='...' message='...'` — mailbox reply (needs a waiting task)
- subagent steering (full procedure): `crew_agent run_in_background=true` a long task (e.g. `sleep 60`), then `steer_subagent` (alias `crew_agent_steer`) while it runs, then `get_subagent_result` — proves the steer arrived (timing-sensitive; assert the agent's output reflects the steer; the quick one-shot version lives in 9b)

**9d. Destructive** (⚠️ **requires explicit user confirmation** per the delegation policy — never run unprompted):
- `team action='prune' keep=<N>` — delete old finished runs
- `team action='cleanup'` — sweep stale workspaces/state
- `team action='forget' runId='...'` — delete one run's state
- `team action='doctor' focus='zombies'` is READ-ONLY (safe) but the follow-up `kill <PID>` it suggests is destructive — confirm with the user before killing

**9e. Admin / mutation** (mutates config or workflow files — use a scratch project cwd or back up first):
- `team action='create' resource='team' ...` / `update` / `delete` — manage teams/agents/workflows
- `team action='init'` / `config` / `validate` / `autonomy` / `settings` — project setup
- `team action='workflow-create'` / `workflow-save` / `workflow-delete` / `workflow-get` / `workflow-list` — workflow CRUD
- `team action='import'` / `imports` / `export` — run data portability
- `team action='parallel' tasks=[...]` — parallel dispatch (spawn path, costs tokens per task)

**9f. Background / scheduled** (expensive or niche):
- `team action='run' runKind='goal-loop'` — the goal loop runs many turns judging an objective; smoke with a trivial objective + low `maxTurns` (e.g. 2) to prove dispatch without burning budget
- `team action='schedule' cron='...' ...` / `scheduled` / `subAction='remove'` — cron; assert the job registers then remove it (cleanup)
- `team action='auto-summarize'` / `anchor` / `auto_boomerang` — background features; assert no-throw on a completed run
- `team action='api'` — programmatic surface

**Acceptance for 9c–9f**: the action returns a structured result (not `Unknown type` / not an empty error), and for spawn/lifecycle paths the run reaches the expected terminal status. For 9d/9e, the mutation is reversible or confined to scratch state.

---

## Tier 10 — Surface-mode battery (MuxSurface A1, workers in real panes)

**What**: prove workers can live in REAL multiplexer panes (tmux/herdr) — pane spawn, in-pane boot via launch script, auto-exit, degrade-to-headless on failure, doctor orphan cleanup — without breaking the headless default.

**Why this is its own tier**: surface is **fail-closed by design**. Every failure (no mux binary, forced-mode detect fail, depth > `maxDepth`, pane cap reached, `visibleAgents` empty, `mode: off`) degrades to headless and the run **still goes green**. A green run therefore proves NOTHING about panes — only pane-level evidence does (manifest `surface.panes`, `tmux list-panes`, the E2E sentinel). This is the exact inverse of Tier 9's silent schema failures: there the tool errors, here everything looks healthy. **NOTE (2026-08-27): async runs are NO LONGER hard-gated headless** — surface now follows env + `runtime.surface.*` config, not run-mode; so an async run with a live mux still engages panes.

**The #1 silent no-op**: `runtime.surface.visibleAgents` defaults to `[]` — surface is visible to NOBODY until opted in (spec §8.1, A1 default). A test that sets `mode: "auto"` (already the default) and expects panes will pass green with zero panes created. **Always set `visibleAgents` (exact agent/role names, or `["*"]`) when testing surface.** Configure via `team-settings set runtime.surface.visibleAgents '["*"]'` (slash) or `team action='settings' config={args:"set runtime.surface.visibleAgents [\"*\"]"}`.

**Config surface** (`src/config/types.ts:94`, manageable via team-settings — `src/extension/team-tool/handle-settings.ts:23-24`):
- `runtime.surface.mode`: `"auto"` (default — detect tmux/herdr, use panes when present) | `"tmux"` / `"herdr"` (force; detect fail → headless + warning event, **never a throw**) | `"off"`
- `runtime.surface.visibleAgents`: exact-match agent/role names, `["*"]` = all. Default `[]` = nobody.

**When required**: any change to `src/runtime/surface/**` (providers, resolve, spawn, degrade, launch script), `src/prompt/surface-worker.ts` (recorder + auto-exit + parent-guard), the surface branch of `src/runtime/child-pi/child-pi.ts`, surface fields in doctor, or the surface config keys.

### 10a. E2E suites (real tmux + real herdr, no mocks)

Hai suite sinh đôi, mỗi backend một file — tmux tự skip khi `CI=1` hoặc `$TMUX` unset (chạy từ TRONG tmux); herdr tự skip khi CI, đang trong tmux, hoặc socket herdr không tồn tại:

```bash
# tmux — from a shell inside tmux (or spawn a dedicated session):
tmux new-session -d -s crew-e2e "cd ${PWD} && \
  node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 \
  test/system/surface-tmux.e2e.test.ts 2>&1 | tee /tmp/surface-e2e.log"

# herdr — chạy khi herdr server sống và KHÔNG trong tmux (test tạo pane thật
# trong herdr của user ~4s rồi tự dọn — pane sẽ hiện lên màn hình):
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 \
  test/system/surface-herdr.e2e.test.ts
```

Mỗi suite 3 test (cùng kịch bản, provider khác nhau):
1. **spawn + self-close**: pane thật được tạo, launch script boot worker trong pane (sentinel mang pane id + PID của worker), pane tự đóng khi task xong (auto-exit qua `ctx.shutdown()`), run hoàn thành.
2. **kill-pane giữa chừng → degrade**: pane bị giết → `classifyOnExit` (2s) → cause-group lockout → re-dispatch headless → run vẫn `done`. Đây là proof "không chết khi multiplexer chết" — điều kiện nền của toàn bộ thiết kế.
3. **doctor orphan cleanup**: liệt kê + đóng pane mồ côi thật (từ terminal-run manifests), report chứa pane id.

Acceptance: 3/3 cho mỗi suite khi điều kiện backend thỏa; skip vì thiếu mux là **correct-by-design**, không phải fail — nhưng cũng không tính là "Tier 10 pass" cho backend đó (xem Done-criteria).

**Bài học wire herdr (3 bug thật chỉ E2E mới bắt được, fix `01af9a78` 2026-08-27)**: herdr 0.8.2 không push `pane.closed` cho process exit tự nhiên (chỉ `pane.exited`) — provider phải subscribe cả hai; frame `\n\n` khiến server đóng subscription; `attach` null khiến doctor không bao giờ đóng orphan herdr. Unit test fake socket KHÔNG bao giờ bắt được loại này — luôn chạy E2E thật khi đụng wire provider.

### 10b. Live surface run (từ parent Pi session)

```text
1. team-settings set runtime.surface.visibleAgents '["*"]'   # hoặc agent cụ thể, vd '["executor"]'
2. team action='run' team='fast-fix' goal='<trivial>' async=false
3. DẠNG KIỂM TRA (shell):
   tmux list-panes -a -F '#{pane_id} #{pane_title} #{pane_pid}' | grep <taskId>
   # pane title mang taskId; pane_pid là shell chạy launch script
4. Sau khi run xong: pane đã tự đóng (auto-exit); không còn pane mang taskId
5. team action='status' / manifest: surface.panes ghi nhận provider + pane ids
6. Dọn dẹp: team-settings set runtime.surface.visibleAgents '[]'
```

Evidence cần thu: pane id + title từ `list-panes` TRONG lúc run, và pane biến mất sau run. **Đừng lấy `manifest.surface.panes` làm evidence engage** — map này được `releaseSurfacePane` xóa ngay khi pane đóng, nên một run engage THÀNH CÔNG cũng kết thúc với `panes: {}`. Evidence đúng sau run: `events.jsonl` có `worker.surface_spawned` + `worker.surface_closed` (kèm paneId) và KHÔNG có `surface.degraded`; `manifest.surface.provider` + `workerPids` non-empty (chỉ nhánh surface mới ghi `workerPids` qua `notifyWorkerStarted`). Nếu đã set `visibleAgents` mà không thấy surface_spawned: đọc `worker.surface_gate_blocked` (từ `d668e166`) — nó cho biết gate nào chặn và vì sao (`{gate, reason, env}`). Không có các event đó → surface không engage được dù run xanh.

### 10c. herdr path (chỉ khi pi chạy trong herdr pane)

herdr chỉ được detect khi **chính pi session đang chạy trong một herdr pane** (design decision — không đoán mò qua socket nếu pi không thuộc herd). Socket API newline-JSON qua `~/.config/herdr/herdr.sock` (herdr 0.8.2+): 1 request = 1 connection, envelope `{"event":...}` (underscore), `pane.read` cần source `"visible"`. Nếu không có herdr: 10c skip với lý do "not in herdr pane" — chấp nhận được, miễn ghi rõ trong report.

### Surface failure modes → symptom map

| Symptom | Likely cause | Recovery |
|---|---|---|
| Run xanh nhưng không pane nào xuất hiện | `visibleAgents` còn `[]` (default) — silent no-op | Set `visibleAgents`; re-run. Từ `d668e166`: nếu đã opt-in mà vẫn headless, `events.jsonl` có `worker.surface_gate_blocked` mang `{gate, reason, env}` (chỉ phát khi visibleAgents non-empty — default runs im lặng) |
| `mode: "tmux"` nhưng vẫn headless | tmux binary/socket detect fail → degrade có chủ đích | `tmux info`; kiểm tra `$TMUX`; đọc warning event trong `events.jsonl` (không bao giờ im lặng) |
| Worker thứ 7 trở đi headless | Pane cap `MAX_SURFACE_WORKERS = 6` (`src/runtime/surface/resolve-surface.ts`) — hardcoded A1 | By design; config cap là A2 defer |
| Surface worker chết liên tục → quay lại headless | Degrade lockout: cause-group lockout + spawn-fail streak 3 | Đọc `events.jsonl` (degrade.classify events); fix gốc nhân (thường là launch script env) |
| Pane ở lại sau crash host | Orphan pane — doctor chưa quét | `team action='doctor' focus='zombies'` liệt kê + đóng; sweepLaunchScripts dọn script TTL |
| herdr không được detect | pi không chạy trong herdr pane | By design; chạy pi trong herdr pane rồi thử lại |
| herdr worker xong việc nhưng host treo tới deadline 600s | Provider thiếu subscribe `pane.exited` (herdr 0.8.2 không push `pane.closed` cho exit tự nhiên) — đã fix `01af9a78` | Chạy 10a herdr suite; đọc subscription wiring trong `herdr-provider.ts` |
| herdr subscription im lặng / mux-dead ngay lập tức | Frame `\n\n` (tự nối newline trên wrapper đã nối sẵn) — server coi empty line là malformed | Xem unit "wire framing" trong `herdr-provider.test.ts`; đừng thêm `\n` ở tầng provider |
| Async run tưởng "luôn headless" | **KHÔNG còn** — nhưng 2 lớp phải cùng mở: (1) hard-gate async bỏ 2026-08-27; (2) `BACKGROUND_RUNNER_ENV_ALLOWLIST` từng strip `TMUX`/`HERDR_*` khỏi detached runner → async vẫn gate `no-mux` dù host trong mux (battery 2026-08-30 Finding 2, fix `f0a41a16` thêm đủ mux env vào allow-list) | Test với live mux + `visibleAgents` set: async run PHẢI có `worker.surface_spawned` (verified live `team_20260830144901`: 3/3 panes, tab riêng, tab đóng khi run end); nếu chỉ thấy `no-mux` → kiểm allow-list trước khi nghi gate |

**Cảnh báo an toàn**: KHÔNG dùng `tmux kill-server` để "test degrade" trên máy user — nó giết toàn bộ session của user. Dùng `kill-pane` trên pane của run thử nghiệm (như E2E test #2 làm), hoặc chạy trong tmux server riêng (`tmux -S /tmp/crew-sock`).

---

## Tier 11 — Remediation regression battery (v0.10.5 deep-review fixes)

**What**: verify the v0.10.5 remediation invariants hold — the P0 read-your-writes revert (`b6eba80f`), the P1 enforcement/wiring hardening (`09dda842`), the broker doc-nit de-stack (`4ebd2ce4`), and the CI/test-tier reshuffle (`09dda842` + `2fb2b426`).

**Why this is its own tier**: the remediation fixed bugs that ALL of Tiers 1–10 missed — 18 hidden test failures from a delayed-write conversion (test:critical contains no stores/dwf/recovery tests), a production default-drift (`ui.widgetPlacement`), a deterministic-red CI env (`PI_CREW_SMOKE=1` in nightly), and a gate that existed but was never enforced (wc-gate). These need their own pin checks so the same classes don't regress.

**When required**: any change to `src/state/**` write paths (stores, atomic-write, event-log buffering), `src/config/migration-validator.ts` or its wiring, `scripts/wc-gate.mjs` or the `ci` scripts, `.github/workflows/*` env, `src/ui/settings-overlay.ts` / `handle-settings.ts` EFFECTIVE_DEFAULTS, or before a release cut.

### 11a. Read-your-writes (the P0 revert core)

**The rule (hard-won, `b6eba80f`)**: MỌI site có reader đồng bộ ngay sau write — test read-your-writes assertion, same-poll display, reload-inside-lock, cross-process reader — KHÔNG được convert sang buffered/coalesced, KỂ CẢ terminal-type buffered (flushPromise.then microtask chain ≠ same-tick). The WI-2.2 coalesce ("last value wins" + 50ms window) broke 3 public sync APIs: `plan-store loadPlanRecords`, `readOwnershipMap`, `loadRunManifestById` → 18 hidden test failures (plan-store 11, ownership-map 3, state-store 4).

```bash
# 1. stores stay on sync atomicWriteJson (coalesce reverted):
grep -c "atomicWriteJson" src/state/stores/plan-store.ts src/state/stores/ownership-map.ts  # >=1 each
# 2. terminal-state events are sync appendEvent (crash-recovery design comment at :221
#    (file lives at src/runtime/recovery/crash-recovery.ts after the runtime reorg)
grep -n "Log the event first" src/runtime/recovery/crash-recovery.ts   # design intent: sync
# 3. buffered-site census — snapshot & audit:
grep -rln "appendEventBuffered" src/ | wc -l   # 16 files / ~70 raw matches (incl. imports+definition) at v0.10.5; audited live conversions = 43; EVERY new site needs the reader-audit
# 4. the full gate — test:critical has NO stores/dwf/recovery coverage:
npm run test:unit    # 823 files, ~7500 tests, 15-18 min under load — MANDATORY after any delayed-write conversion program
```

### 11b. wc-gate enforcement (M4 done-gate)

```bash
npm run check:wc-gate                                  # exit 0, "max NNNN lines (limit 2000)"
node -e "const p=require('./package.json').scripts; console.log(p.ci.includes('check:wc-gate'), p['ci:fast'].includes('check:wc-gate'))"  # true true
grep -n "wc-gate" .github/workflows/ci.yml             # explicit step (since 09dda842; was ci:fast-only = advisory)
```

### 11c. Migration validator (M5 WI-5.6, warn-only)

Wired in `register.ts:62-74` — AFTER `installChildProcessAbortShield`, BEFORE `startRuntimeWarmup`; `console.warn`, never throws (spec: "warning không fail").

```bash
# offline (no pi session needed):
node --experimental-strip-types --no-warnings -e \
  'import("./src/config/migration-validator.ts").then(m=>console.log(JSON.stringify(m.validateEnv({PI_CREW_BROKER_DIAG_UI:"1",PI_CREW_SAFE_BASH:"1"}))))'
# expect: warnings[] with severity "removed" for BOTH keys; hasWarnings true
# live: PI_CREW_BROKER_DIAG_UI=1 pi …  → startup prints "[pi-crew] 1 deprecated env var(s) in use:" and boots normally
```

### 11d. Slow-tier hygiene (M3 tiering)

```bash
ls test/integration/slow/    # exactly 3: full-feature-smoke, phase5-observability, ui-performance
# the fast globs must NOT match slow/ (disjoint globs — test:full dup was a real bug):
grep -o "'test/unit/\*\*/\*.test.ts'\|'test/integration/\*.test.ts'" package.json
npm run test:integration:slow   # separate glob, 600s timeout
```

### 11e. Nightly env regression (deterministic-red trap)

`PI_CREW_SMOKE=1` arms HB-003a real-binary smoke which needs a pi binary + `PI_AUTH_JSON` — GH runners have neither → deterministic red. It is set ONLY in `weekly-smoke.yml` (auth-gated arm).

```bash
grep -n "PI_CREW_SMOKE" .github/workflows/nightly.yml      # comment ONLY (":24 deliberately NOT setting")
grep -n "PI_CREW_SMOKE" .github/workflows/weekly-smoke.yml # PI_CREW_SMOKE: "1" (:25)
```

### 11f. Event-log reject format

Buffered-append rejections must carry `type=<event-type>[<distinguisher>]` so ops can bisect a failed append to its event kind:

```bash
grep -rn 'type=\${' src/prompt/scratchpad-lifecycle.ts src/runtime/finalize-run.ts
# scratchpad-lifecycle:92  type=${type}
# finalize-run:242        ternary escalate/policy.action · :260 recovery.escalated/recovery.attempted
```

### 11g. widgetPlacement G17 default-drift

The drift: duplicated EFFECTIVE_DEFAULTS maps hardcoded `"aboveEditor"` while `defaults.ts`/`install.mjs`/`project-init` said `"bottom"` — the suite never compared them. NOTE `aboveEditor` remains a VALID enum value (schema/types/pi-widget mapping); only the DEFAULT was wrong.

```bash
grep -rn '"ui.widgetPlacement"' src/ui/settings-overlay.ts src/extension/team-tool/handle-settings.ts  # both :"bottom"
# live: team-settings get ui.widgetPlacement → bottom
```

### 11h. Worktree-twins stability (flaky→fixed)

Pre-fix flaked ~8% idle / ~50% under load (`try{return promise}finally{rmSync}` cleanup race); fixed by awaiting INSIDE the try. Run 3× consecutively — all green:

```bash
for i in 1 2 3; do node --experimental-strip-types --no-warnings --test test/unit/worktree/worktree-twins-contract.test.ts 2>&1 | grep -E "^# (pass|fail)"; done
```

### 11i. Export-surface + slash parity pinning

```bash
grep -nE "export.*(HELLO_DEADLINE_MS)|export \{ BROKER_PROTOCOL" src/runtime/broker/crew-broker.ts  # 0 hits (dead exports removed, 09dda842)
grep -n "MUST_INCLUDE" test/unit/extension/slash-command-parity.test.ts   # 5 core: team-run, teams, team-help, crew-view, crew-brief
```

### 11j. Bundle committed-hash (release gate)

Tier 3 checks disk-vs-session; this checks COMMITTED dist vs a fresh build — the gate that catches "src edited, bundle forgot":

```bash
node scripts/check-bundle-staleness.mjs --committed-hash   # "OK: committed dist matches a fresh build"
```

**Acceptance**: every sub-check above returns the expected value; 11a item 4 is the ONLY expensive one (mandatory after conversion programs, skippable for doc-only changes).

---

## Tier 12 — Resource-contract battery (agent .md + skill metadata)

**What**: prove agent frontmatter/bodies and skill metadata still parse and render after edits — through BOTH parsers and into the routing guidance the leader sees.

**Why this is its own tier**: `agents/*.md` are contracts — frontmatter grants tools and routing metadata (`useWhen`/`avoidWhen`/`cost`/`category`), the body IS the child's system prompt (`systemPromptMode: replace`), and the `## Output format` section is test-enforced. The agent/team/workflow frontmatter parser (`src/utils/frontmatter.ts`, `parseLines`) is **line-based, not YAML** — a folded scalar (`description: >`) parses as the literal string `">"` for EVERY consumer while typecheck/lint/test:critical all stay green (real regression: Batch 9, all 17 agents; fixed in `aa899a1e` by restoring single-line quoted values + teaching `parseLines` to strip symmetric quotes). Skills are exempt (they go through the real `yaml` package — folded scalars are FINE in `skills/*/SKILL.md`). Only a dual-parse probe catches this class.

**When required**: any change to `agents/*.md`, `skills/*/SKILL.md`, `src/agents/discover-agents.ts`, `src/skills/discover-skills.ts`, `src/utils/frontmatter.ts`, `src/runtime/skill-instructions.ts` (skill override resolution), or `src/extension/autonomous-policy.ts` (guidance render).

**Frontmatter contract rules** (agents/teams/workflows — the line-based parser):
- values stay **single-line**; a value containing `": "` MUST be wrapped in symmetric double quotes (`parseLines` strips them, `aa899a1e`)
- NEVER folded scalars (`key: >` / `key: |`) — they parse as `">"` / `"|"` (`CONTEXT.md` Flagged #4)
- routing keys are FLAT top-level CSV — `useWhen: "a, b"`, `avoidWhen: "…"`, `cost: cheap`, `category: orchestration` (parsed at `src/agents/discover-agents.ts:388-391`; a nested `routing:` block is silently ignored)

**How**:

```bash
# 12a. Output contracts — every builtin agent must have '## Output format' + fenced block:
node --experimental-strip-types --no-warnings --test --test-force-exit test/unit/agents/agent-output-contracts.test.ts
# 1 test iterating ALL builtin agents (18 @ 2026-09-11)

# 12b. BOTH-parser proof (discovery + strict YAML) — ALWAYS invalidate the discovery cache first:
node --experimental-strip-types --no-warnings -e '
import("./src/agents/discover-agents.ts").then(mod => {
  mod.invalidateAgentDiscoveryCache();
  const list = mod.discoverAgents(process.cwd()).builtin;
  const bad = list.filter(a => !a.description?.includes("When NOT to use:") || a.description.startsWith(String.fromCharCode(34)));
  const noRoute = list.filter(a => !a.routing?.useWhen);
  console.log("agents:", list.length, "| bad desc:", bad.length, "| no routing:", noRoute.length);
});'
# expect: agents: 18 | bad desc: 0 | no routing: 0
node -e '
const yaml=require("yaml"),fs=require("fs");let ok=0,fail=[];
for (const f of fs.readdirSync("agents")){
  const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync("agents/"+f,"utf-8"));
  if(!m)continue;
  try{const p=yaml.parse(m[1]);if(p.name&&p.description)ok++;}catch{fail.push(f);}
}
console.log("strict YAML:",ok,"ok /",fail.length,"fail",fail.length?JSON.stringify(fail):"");'
# expect: strict YAML: 18 ok / 0 fail

# 12c. Routing guidance renders (leader-side):
node --experimental-strip-types --no-warnings -e '
import("./src/agents/discover-agents.ts").then(async da=>{
  const pol=await import("./src/extension/autonomous-policy.ts");
  da.invalidateAgentDiscoveryCache();
  const g=pol.buildResourceRoutingGuidance(process.cwd(),40000);
  const agentLines=g.split("\n").filter(l=>l.startsWith("- ")&&!/defaultWorkflow=|roles=|steps=/.test(l)&&/\((builtin|project|user)\):/.test(l));
  const withRoute=agentLines.filter(l=>l.includes("useWhen="));
  console.log("rendered agent lines:",agentLines.length,"| with useWhen:",withRoute.length,
    "| orchestrator:",g.includes("- orchestrator ("),"| verifier:",g.includes("- verifier ("));
});'
# expect: every rendered AGENT line carries useWhen= (workflow lines legitimately lack it).
# The list is BUDGET-TRUNCATED BY DESIGN — at 40000 chars ~16/18 agents render; the tail
# (alphabetically last: verifier, writer) is cut first. Accept: with-route == agent-lines,
# newest agent (orchestrator) present, count >= 15. Do NOT assert 18/18 — truncation is correct.

# 12d. Fast unit batteries for the resource layer:
node --experimental-strip-types --no-warnings --test --test-force-exit \
  test/unit/bundle-skill-resolution.test.ts \
  test/unit/extension/registration/tool-loop-guard.test.ts \
  test/unit/runtime/core/skill-instructions.test.ts
# packageRoot skill resolution + loop guard (12 tests) + skill override wildcard `*` / denylist `!name` (26 tests)
```

**Acceptance**: 12a green; 12b BOTH parsers clean (18/18 descriptions with When-NOT, 0 quote leakage, 18/18 routing, 0 strict-YAML fails); 12c every rendered agent line carries `useWhen=` (budget-truncation is by design — see the note in 12c); 12d all pass. Agent/skill-only changes need NO bundle rebuild (runtime-loaded from the package dir) — but `src/` changes in the same commit still follow the Tier 3 bundle rule.

**References**:

| What | Where |
|---|---|
| Line-based parser + quote-strip | `src/utils/frontmatter.ts` (`parseLines`) — quote-strip added in `aa899a1e` |
| Flat routing keys parse | `src/agents/discover-agents.ts:388-391, 476` |
| Output-contract AC | `test/unit/agents/agent-output-contracts.test.ts` (Batch 9, `06c5d7ca`) |
| Skill override `*`/`!name` | `src/runtime/skill-instructions.ts` (`collectTaskSkillNames`, Batch 1+2 `c97bc578`) |
| Guidance builder | `src/extension/autonomous-policy.ts` (`buildResourceRoutingGuidance`) |
| Orchestrator (18th agent) | `agents/orchestrator.md` (Batch 10 `aa899a1e`) — process-only body; discovery guidance is the single routing authority |
| Quirk registry | `CONTEXT.md` — glossary + Flagged (#1 broker SIGTERM, #4 frontmatter parser) |

---

## Tier 13 — Real-run UI render battery (every surface, real state, no fixtures)

**What**: run a REAL team run, then render **every UI surface from that run's on-disk state** (`manifest.json` / `agents.json` / `tasks.json` / the snapshot cache / the real widget model) at several widths, and assert the cross-surface invariants that per-module unit tests structurally cannot see.

**Why this is its own tier**: unit tests assert whatever strings their author chose with fixtures their author built; executor summaries claim behaviour. Neither can catch a surface painting something that maps to **no data field** or **contradicts the state**. Measured 2026-09-16: a 4-executor parallel UI migration + an independent verifier + **7857 green tests** left **7 real defects** in the UI — one render pass over a real run found all of them in ~2 minutes. The battery is cheap; the class of bug it kills is invisible to everything else.

| Defect class | Real example (2026-09-16) | Why unit tests missed it |
|---|---|---|
| **Invented string** (hardcoded, maps to no field) | sidebar painted `122ab0dd · completed · right default` | no test asserts the ABSENCE of unexplained words |
| **Cross-surface inconsistency** | `fast-fix/fast-fix` in sidebar AND dashboard (each site joined `team/workflow` itself) | per-file fixtures used differing team names, so neither site looked wrong |
| **Wrong state glyph** | dock spun `⠹` on a finished run (`0 running · 3/3 done`) | the header always received a spinner frame; no test crossed "0 running" with the glyph |
| **Truncation eats the important token** | dashboard run list painted `› ✓ 122ab0dd complete…` — the status cut in half | fixture goals fit the width, so the narrow-width fallback never ran |
| **Wire format leaking into TUI** | sidebar `input=2780, output=3715, cacheRead=57216, cost=0.000000, turns=0` | the shared `formatUsage` helper IS correct for CLI output; only the TUI usage is wrong |
| **Unit-less / wrong-scale numbers** | `314.7s` instead of `5m44s` in the agents pane | tests asserted the numbers, never the format |
| **Pluralisation** | `1 runs`, `3 agents`, `1 tools` | fixtures used plural counts |
| **Optional segment unguarded** | live `undefined — ↓·enter` after a run finished — the pure builder guarded it, the **component path did not** | the builder test passed; the component path had no zero-runs test |

**When required**: ANY change under `src/ui/**`, or any change that alters what a surface prints (a formatter, a status-slot map, a label helper). Also required after parallel/subagent UI work — delegated claims are hypotheses until rendered.

**How**:

```bash
# 0. Produce real state — a real run (read-only goal keeps it safe + fast):
#    from the parent Pi session: team action='run' team='fast-fix' goal='<read-only 1-question task>'
#    → note the runId; state lands in <workspace>/.crew/state/runs/<runId>/
# 1. Write the harness to /tmp (NEVER into the repo) and render every surface.
#    Template (adjust imports to the surfaces you touched):
cat > /tmp/full-ui.ts <<'EOF'
import * as fs from "node:fs";
import { asCrewTheme } from "/ABS/PATH/pi-crew/src/ui/theme-adapter.ts";
import { formatCompactToolProgress } from "/ABS/PATH/pi-crew/src/ui/tool-progress-formatter.ts";
import { teamToolRenderer } from "/ABS/PATH/pi-crew/src/ui/tool-renderers/index.ts";
import { buildWidgetLines } from "/ABS/PATH/pi-crew/src/ui/widget/widget-renderer.ts";
import { buildTaskListLines } from "/ABS/PATH/pi-crew/src/ui/widget/task-list.ts";
import { LiveRunSidebar } from "/ABS/PATH/pi-crew/src/ui/live-run-sidebar.ts";

const CWD = "/ABS/PATH/WORKSPACE";                 // where .crew/state lives
const RUN = `${CWD}/.crew/state/runs/<runId>`;
const manifest = JSON.parse(fs.readFileSync(`${RUN}/manifest.json`, "utf8"));
const agents = JSON.parse(fs.readFileSync(`${RUN}/agents.json`, "utf8"));
const tasks = JSON.parse(fs.readFileSync(`${RUN}/tasks.json`, "utf8"));
const theme = asCrewTheme({});
const R = (c: any, w = 118) => c.render(w).map((l: string) => l.replace(/\s+$/, "")).join("\n");
const L = (ls: string[]) => ls.map((l) => l.replace(/\s+$/, "")).join("\n");
const hdr = (t: string) => `\n═══ ${t} ═══`;
const details = { action: "run", status: manifest.status, runId: manifest.runId, team: manifest.team, agentRecords: agents };

console.log(hdr("CALL"), R(teamToolRenderer.renderCall({ action: "run", goal: manifest.goal, team: manifest.team }, theme, { argsComplete: true })));
// STREAMING must go through the PRODUCER, not a hand-built string:
const stream = formatCompactToolProgress({ agentId: manifest.runId, status: "running", runId: manifest.runId,
  startedAt: new Date(manifest.createdAt).getTime(), manifest, tasks, agents });
console.log(hdr("STREAMING"), R(teamToolRenderer.renderResult({ details: { action: "run" }, content: [{ type: "text", text: stream }] }, { isPartial: true }, theme, {})));
console.log(hdr("COLLAPSED"), R(teamToolRenderer.renderResult({ details }, { action: "run" }, theme, {})));
console.log(hdr("EXPANDED"), R(teamToolRenderer.renderResult({ details }, { action: "run" }, theme, { expanded: true })));
console.log(hdr("EXPANDED@80"), R(teamToolRenderer.renderResult({ details }, { action: "run" }, theme, { expanded: true }), 80));

// WidgetRun NEEDS `snapshot` (the plan card reads snapshot.tasks) — a bare {run, agents} renders EMPTY and looks like a bug:
const { createRunSnapshotCache } = await import("/ABS/PATH/pi-crew/src/ui/run-snapshot-cache.ts");
const snap = createRunSnapshotCache(CWD).refreshIfStale(manifest.runId);
const done = [{ run: manifest, agents, snapshot: snap }];
const live = [{ run: { ...manifest, status: "running" }, agents: agents.map((a: any, i: number) => ({ ...a, status: i === 0 ? "running" : a.status })), snapshot: snap }];
const dead = [{ run: { ...manifest, status: "failed" }, agents, snapshot: snap }];
for (const [name, runs, w] of [["done", done, 118], ["done@50", done, 50], ["running", live, 118], ["failed", dead, 118]] as const) {
  console.log(hdr(`DOCK ${name}`), L(buildWidgetLines(CWD, 0, 8, runs as never, 0, w, {})));
}
console.log(hdr("PLAN CARD"), L(buildTaskListLines(done as never, 118, theme)) || "(empty)");

const sidebar = new LiveRunSidebar({ cwd: CWD, runId: manifest.runId, done: () => undefined, theme: {}, config: {} as never });
console.log(hdr("SIDEBAR"), R(sidebar, 118));
// Dashboard + browser: see docs/ui-samples/capture.ts sections 13/14 for the exact constructors.
EOF
node --experimental-strip-types --no-warnings /tmp/full-ui.ts | tee /tmp/full-ui.txt

# 2. Invariant sweep over the rendered text (all of these must be ZERO hits):
grep -nE "undefined|[╭╮╰╯├┤]|->" /tmp/full-ui.txt                          # unguarded segment / retired frame / legacy separator
grep -nE "\b1 (runs|tools|agents|tasks|edits)\b" /tmp/full-ui.txt        # pluralisation (note: `11 tools` legitimately contains `1 tools` — anchor the match)
grep -nE "input=|output=|cacheRead=|cost=[0-9]" /tmp/full-ui.txt           # wire format leaked into a TUI surface
python3 - <<'PY'
import re
bad = []
for ln in open("/tmp/full-ui.txt", encoding="utf-8"):
    if "═══" in ln: continue
    # spinner present while nothing is running?
    if re.search(r"[⠁-⣿]", ln) and re.search(r"0 running", ln): bad.append(("spinner+0-running", ln.rstrip()))
    plain = re.sub(r"\x1b\[[0-9;]*m", "", ln)
    if len(plain.rstrip("\n")) > 120: bad.append(("over-width", plain.rstrip()))
    if "··" in plain and "↓·enter" in plain and plain.rstrip().endswith("…"): bad.append(("hint clipped", plain.rstrip()))
print("BAD:", bad if bad else "none")
PY

# 3. Narrow-width survival: the actionable hint must be the LAST thing to go.
#    Render the dock at 40/50/60 and assert `↓·enter` (or its tail) is still there.

# 4. Cross-surface consistency (same run, every surface):
#    - team label identical everywhere (`fast-fix`, never `fast-fix/fast-fix`)
#    - run id rendered at the same width everywhere (shortId = last 8)
#    - durations in ONE format (`5m44s`, never `344.3s`)
#    - usage in ONE format (`↑2.8k ↓3.7k`, never `input=…`)
#    - status word never truncated (`completed`, never `complete…`)
```

**Mandatory rules for this tier**

- **Render REAL state, never hand-built fixtures.** Fixtures are how the seven defects above survived: the author picks values that fit and read well. `team action='run'` costs ~120s and gives you goals, ids, counts and usage that are the wrong length, the wrong shape and the wrong scale — which is the point.
- **Feed STREAMING through the producer** (`formatCompactToolProgress`), not a string you typed. Half the streaming bugs live in the producer→parser contract (`test/unit/runtime/core/tool-progress-formatter.test.ts`).
- **Render EVERY state you support**: running / done / failed / focused / idle / narrow. A glyph or fallback that is correct in one state is routinely wrong in another (spinner on a finished run; a hint clipped at 50 columns).
- **`undefined` sweep must cover the COMPONENT path**, not just the pure builder. `widget-renderer.buildWidgetLines` had `if (!zero) return []` for three weeks while `src/ui/widget/index.ts` composed the same row with an unguarded template literal — the live `undefined — ↓·enter`.
- **Any word you cannot trace to a data field is a bug.** For each literal in the rendered output ask "which field/derivation produced this?" — `right default` had no answer.
- Keep the harness in `/tmp`. It is a probe, not a deliverable; if it is worth keeping, it belongs in the repo's catalog script (see below), not in a random test file.

**Catalog (if the repo ships one, `docs/ui-samples/`)**

- `capture.ts` renders real components into `captures/*.txt`; `render_png.py` turns them into terminal-style PNGs. Re-run BOTH after any UI change, then look at one image — text captures hide font-level breakage.
- `render_png.py` must **fail loudly when the font has no glyph** for a character (the coverage self-check compares each glyph against the `.notdef` box). DejaVu Sans Mono — the best-covered mono font on a stock Linux box — lacks the **braille spinner range** (U+2800–U+28FF) and `⟳ ⏰ ⎿`, so a naive render ships `□` for every running row. Mappings in use: braille → `◐`, `⟳` → `↻`, `⎿` → `└`, `⏰`/`⏱` → `o`.
- Set **line-height == font-size**, otherwise box-drawing rails paint as a dashed line.
- Heavy box glyphs (`┏ ┃ ┗`) render with light strokes in DejaVu/Noto — a font trait, not a capture bug. Document it instead of hunting fonts.

**Acceptance**: every surface renders; the invariant sweep returns zero hits; each state (running/done/failed/focused/idle/narrow) renders the right glyph and keeps the actionable hint; no `undefined`, no retired frame glyph, no `->`, no wire format, no invented word; durations/usage/plurals consistent across surfaces; catalog (if present) regenerated and one PNG visually inspected.

**Reference implementations**: `docs/ui-samples/capture.ts` (sections 13–18 render dashboard/browser/inline panel/transcript/live-conversation/settings from a REAL temp run written through the state-store APIs), `docs/ui-samples/render_png.py` (glyph coverage self-check + substitutions), `docs/UI-DESIGN-SYSTEM.md` (the grammar each surface must follow), `src/ui/rail.ts` (the single source of glyphs/helpers).

---

## Anti-patterns (the cost is real, observed in this session)

| Anti-pattern | Cost | Where fixed | Reference |
|---|---|---|---|
| `npm test` in verifier prompt | worker killed at the response timeout (300s then, 600s now), run = "hang" | `1cb2dca` | verifier `taskTemplate`/`verificationCommand` in `src/runtime/goal-workflow/plan-templates.ts` (now `:144, 147, 151`) + workflow files |
| `npm run test:unit` for in-loop verify | >4 min, same hang | `1cb2dca` | `package.json:85` (`test:critical` script) |
| Default-off assumption in tests | Break when default flips | `612e18b` | `test/unit/runtime/broker/crew-broker-feature-flag.test.ts:31` (`DEFAULT_BROKER.enabled === true`) |
| Test using real `loadConfig()` to mock config | Flaky when env / disk config changes | `612e18b` | `test/unit/runtime/broker/crew-broker-server-gate.test.ts:78` (use `brokerEnv: "0"` instead of `flagOn: false`) |
| Source edit seen immediately | No, requires bundle rebuild + reload | n/a (permanent) | `index.ts:1-25` — bundle resolution rules |
| Skip disabled-path proof | `effectiveEnabled()` regression slips through | n/a (permanent) | Tier 2 above |
| `npm run test:unit` against the full suite (823 files now, 642 then) | several minutes; mis-judges verifier runtime | n/a (permanent) | Tier 1 above |
| Skip typecheck | TS errors slip past `test:critical` (which uses `--test-timeout=30000`) | n/a (permanent) | Tier 3 above |
| Run `pi` from a stale bundle | Session shows old behavior despite src/ edits | n/a (permanent) | `scripts/check-bundle-staleness.mjs` — CI gate |
| Test by reading code | Proves nothing about runtime | n/a (permanent) | All tiers above |
| `makeFakeCtx({ flagOn: false })` without `brokerEnv: "0"` | `makeFakeCtx` deletes `PI_CREW_BROKER` env if `brokerEnv` is undefined | `612e18b` (test fix) | `test/unit/runtime/broker/crew-broker-server-gate.test.ts:78` — pass `brokerEnv: "0"` to preserve env |
| Trust green CI on one OS | macOS/Windows regressions slip through | n/a (permanent) | `.crew/knowledge.md` — "CI runs 3 OSes ... A flake on one OS IS a real bug" |
| Trusting a team-run agent not to edit the repo under test | Agents spawned by `team`/`Agent`/`crew_agent` inherit the session cwd and have `edit`/`write` tools — a proactive LLM (observed with deepseek) will make **unauthorized source edits** to pi-crew during a trivial smoke run (e.g. "improving" `chain-runner.ts` while parsing a chain string). The edit can be correct + green-tested yet still be unintended scope creep that silently lands in your commit. **Sharpened by D5 (2026-08-26)**: workers used to be tool-allowlisted (`read,grep,bash,...` by role); since full-loadout default EVERY worker has `edit`/`write` + extensions, so this risk now applies to ANY role, not just armed ones. | n/a (permanent) | After EVERY team/subagent run: `git status` and verify each changed file was authored by you. Diff + review any surprise change before staging. Consider `workspaceMode: 'worktree'` for parallel/risky runs to isolate mutations. |
| **Armed-role tool-surface bug (found live 2026-08-11; INVERTED by D5 2026-08-26)**: originally an opt-in tool (e.g. `scratchpad`) armed via `ROLE_TOOL_CONFIGS[role]` + env never appeared in the worker surface — the builtin `agents/*.md` frontmatter `tools:` allowlist hard-filtered it via `--tools`. **Since D5 (`bcb9dd5d`, spec v0.7 §10) workers are FULL pi sessions by default: no `--no-extensions`, no `--tools`, no `--no-skills` unless the agent frontmatter declares them (`src/runtime/model/pi-args.ts:283-330`) — so the default failure mode flipped.** Now a tool missing from a worker means either (a) the agent's frontmatter declares a restrictive `tools:` list (opt-in) that doesn't include it, or (b) `inheritSkills: false` / SEC-1 declaration-strip on a dynamic/project agent source. Control tools (`ask`, `delegate`) are auto-added to any declared list. Reproduce: `pi -p --tools read,bash "list tools"` → restricted; plain `pi -p` → full set. | `f753be30` → `bcb9dd5d` | **Fix**: for agents that OPT IN to restrictions, keep `agents/*.md` frontmatter `tools:` in sync with `ROLE_TOOL_CONFIGS` (add new tools to BOTH for pinned roles). A worker claiming a tool is "not available" is a REAL signal — check the worker's actual argv (`--tools` present?) and frontmatter, not just env vars. |
| **Surface test that never engages surface**: `runtime.surface.visibleAgents` defaults to `[]` (nobody). A test setting only `mode:"auto"` (already default) passes green with ZERO panes — surface's fail-closed degrade makes the headless path indistinguishable from success in the run result. | n/a (process) | Always set `visibleAgents` when testing surface, and require pane-level evidence (events `worker.surface_spawned`/`worker.surface_closed`, `tmux list-panes` during the run, sentinel PID). See Tier 10. |
| **Reading `manifest.surface.panes == {}` at run END as "zero panes engaged"** (observed 2026-08-27, full-10tier report): `releaseSurfacePane` deletes the pane entry the moment the pane closes, so a FULLY SUCCESSFUL surface run also ends with `panes:{}` — the report flipped a live herdr engagement (pane `w6:pW`, `worker.surface_spawned` seq 99) into "by-design headless, gate short-circuited". Same trap, other direction: the executor worker re-derived the gate trace from ITS OWN env (`PI_CREW_DEPTH=1` — the CORRECT and EXPECTED depth for a tier-1 worker) instead of the HOST env the gate actually reads (`child-pi.ts` passes `depthEnv ?? process.env`), concluding "headless" while literally running inside a herdr pane (`PI_CREW_SURFACE_PANE=w6:pW` sat unread in its own env). | n/a (process) | Engage-evidence = `events.jsonl` (`worker.surface_spawned` + `worker.surface_closed`, no `surface.degraded`) + `manifest.surface.provider`/`workerPids` (only the surface branch writes `workerPids`). A worker's self-report of "which path taken" is a HYPOTHESIS — workers cannot see the host's gate inputs; trust events over worker prose. |
| **Reporting "session is loading the latest code" from FILE-md5 equality alone** (disk vs symlink): a live report (2026-08-27) did exactly this — md5 disk = md5 symlink → "Tier 4 PASS" — while the parent pi process had started BEFORE the bundle rebuild and was still running the PRE-A1 bundle in memory. Every downstream anomaly then got misread as a code bug (a false "config parser drops surface" finding + root-cause misread). File equality only proves the FILES match, not what the PROCESS loaded — extension code loads at cold-start only. | n/a (permanent) | Tier 4/8 needs PROCESS-level liveness: after any rebuild, the session must `/quit` + reopen, then prove the new code is live via a behavior probe (e.g. `team action='settings' config={args:'get runtime.surface.visibleAgents'}` must recognize the key; any new run's worker env shows `PI_CREW_MAX_DEPTH=4`). Corroborate with `ps -eo pid,lstart,args | grep pi` — a session started before the rebuild mtime is stale, full stop. |
| **Assuming `ask`/messaging works because the code exists**: `ask` shipped behind `broker.waitMethodsEnabled` default `false` and slept ~3 weeks — every production wait.request was rejected `policy-disabled` while unit tests stayed green (the broker ctor is fail-closed by design; only the DEFAULT was wrong). Flipped `true` in `ceb9a68d` (2026-08-26) + "never guess, call ask" prompt guidance. | `ceb9a68d` | A worker-tool claim needs a live round-trip probe (Tier 9b-W): wait.request → park → respond → pickup, with the reply visible in the worker transcript. Gate rejections emit `policy.action` events — grep events.jsonl, don't trust silence. |
| `Type.Unsafe({ anyOf/type })` schema field **without** `[TypeBox.Kind]` symbol | `Value.Check` throws `Unknown type` the first time a model emits that field (e.g. `skill`, `config`) — every team action returns `isError:true` text `"Unknown type"`. Tier 1-8 stay green because unit tests never send the offending field. | v0.9.57 | `src/schema/team-tool-schema.ts` — `SkillOverride`/`FreeformConfig` switched from `Type.Unsafe` to TypeBox-native `Type.Union`/`Type.Record`. See Tier 9. |
| Schema too strict for model-emitted empty strings (`runId:""`, `workspaceMode:""`, `budgetTotal:0`) | pi-ai `validateToolArguments` runs BEFORE the pi-crew handler and rejects `""` against Literal unions / patterns → `Validation failed for tool team` → model loops. | v0.9.57 | `src/schema/team-tool-schema.ts` — added `Literal("")` to unions, `^$|` pattern for runId, `""` to action enum, `0`/Boolean allowances. Handler-side `normalizeTeamParams` drops the empties. |
| Claiming "all tiers pass" while 9c–9f (or Tier 10) were never run | Overclaim — once reported "9 tiers pass" when only 9a (8/10) + 9b (4/5) had actually run; 9c–9f were skipped. Past runs then become unverifiable ("did it really pass 9 tiers?"). **2026-08-11 repeat**: an initial report said "9c–9f skipped" yet the summary read as full coverage until the gap was called out. Tier 10 adds the surface variant: a green headless run reported as "surface pass". | n/a (process) | Fill `REPORT-TEMPLATE.md` per-tier DURING the run. "Tier 9 pass" = 9a AND 9b AND the applicable 9c–9f, each with evidence; "Tier 10 pass" = pane-level evidence, not a green run. Round-up-to-pass is the anti-pattern this row exists to prevent. If tiers/sub-tiers are skipped, SAY SO in the verdict and do not phrase it as "all pass". |
| chain run with `workflow:"chain"` forwarded to steps | Every chain step fails in ~58ms with an EMPTY error string — looks like a parse failure but isn't. `chain-dispatch` forwards `params.workflow` ("chain") into executor overrides; each step then runs the "chain" workflow via the normal `executeTeamRun` path and fails fast + silently. | Open (issue #44) | Omit `workflow` when invoking `action:'run' chain=...` — chain then runs 2/2 success (~308s). See `docs/bugs/chain-workflow-forward-quirk.md`. |
| **Env allow-list strip mux vars — async surface chết ở tầng env, không phải tầng gate** (battery 2026-08-30 Finding 2): gate async-run đã bỏ nhưng `BACKGROUND_RUNNER_ENV_ALLOWLIST` vẫn strip `TMUX`/`HERDR_*` → detached runner thấy `no-mux` → async headless mãi mãi. Gate telemetry (`asyncRun:true` trong env snapshot) nói đúng — không gate async — nhưng env detection fail vì biến bị cắt trước khi process chào. Unit test allow-list không catch (list "đúng" theo nghĩa cũ); chỉ async run LIVE với mux mới lộ. | `f0a41a16` (2026-08-30) | Mọi env var mà `src/runtime/surface/*` đọc phải có trong `BACKGROUND_RUNNER_ENV_ALLOWLIST` (pin test `test/unit/runtime/core/async-runner.test.ts` "forwards mux env"). Thêm env detection mới → thêm vào allow-list + pin test cùng lúc. |
| **`set <array-key> []` là no-op** (battery 2026-08-30 Finding 3): `parseStringList` normalize `[]` → `undefined` → patch mất key → `mergeConfig` giữ list cũ trên đĩa; `Effective` hiển thị sai giá trị đã set. `unset` vẫn hoạt động (workaround). | `5a31ccf6` (2026-08-30) | `[]` tường minh là GIÁ TRỊ, không phải unset. Test round-trip: set → get → soi config trên đĩa (test/unit/config/surface-config.test.ts F3 block). |
| **Convert write-site sang buffered/coalesced khi CÓ reader đồng bộ ngay sau write** (P0 remediation 2026-09-10, `b6eba80f`): 29 site bị revert. WI-2.2 coalesce ("last value wins" + 50ms window) làm hỏng 3 public sync APIs (plan-store `loadPlanRecords`, `readOwnershipMap`, `loadRunManifestById`) → 18 hidden test failures mà test:critical KHÔNG bắt (không chứa stores/dwf/recovery). Kể cả terminal-type `appendEventBuffered` vẫn qua `flushPromise.then(...)` microtask chain → KHÔNG same-tick → cancel.ts task.cancelled phải revert về sync. | `b6eba80f` | **Read-your-writes exclusion rule**: reader-after-write = never convert (any flush-latency > 0 breaks the contract). Sau MỌI conversion program: full `npm run test:unit` bắt buộc. Xem Tier 11a. |
| **Gate tồn tại nhưng không được enforce** (P1 remediation, `09dda842`): wc-gate wired chỉ vào `ci:fast` — full `ci` script và tất cả GitHub workflows không chạy nó → một commit phình crew-broker.ts quá 2000 dòng vẫn PR-green. "Có script check" ≠ "gate được enforce". | `09dda842` | Gate mới phải vào: (1) script `ci`, (2) workflow yml step, (3) done-criteria của skill. Xem Tier 11b. |
| **Set CI env cho arm không có dependency của nó** (P0/P1 remediation): `PI_CREW_SMOKE=1` trong nightly.yml arm HB-003a cần pi binary + `PI_AUTH_JSON` — GH runner không có → deterministic red, không phải flake. | `b6eba80f` | Mỗi env var CI: liệt kê dependency (binary/auth/socket) trước khi set; arm auth-gated (weekly-smoke) mới được set. Xem Tier 11e. |
| **Fix finding của reviewer mà không tự verify** (deep review 2026-09-10): 1 trong 4 HIGH findings là false positive — "background-runner exit-loss" thực tế được cover bởi EL-2 `flushBufferedQueuesSync()` (sync lock + appendFileSync + fsync) trên `process.on("exit")` tại event-log.ts:1227. Fix theo finding mù quáng sẽ ĐÃ THÊM regression. | n/a (process) | Mọi finding trước khi fix: trace counter-evidence (exit handlers, sync flush paths). Finding = hypothesis, không phải fact. |
| **Duplicated defaults map drift (G17-class)** (P0 remediation, `b6eba80f`): 2 bản EFFECTIVE_DEFAULTS (`settings-overlay.ts`, `handle-settings.ts`) hardcode `"aboveEditor"` trong khi nguồn chân lý (defaults.ts/install.mjs) nói `"bottom"` — suite không có test so 2 bản với nhau, drift sống sót qua 7500 tests. | `b6eba80f` | Defaults phải có MỘT nguồn chân lý, hoặc test so các bản sao. Live probe: `team-settings get <key>`. Xem Tier 11g. |
| **Test vacuous — assert trên fixture chứ không trên wiring** (P1 remediation, `09dda842`): migration-validator test 2 từng assert key tự chế không có trong registry → luôn pass dù validator chưa được wire vào registerPiTeams. | `09dda842` | Test phải dùng key THẬT từ registry (`PI_CREW_BROKER_DIAG_UI` severity "removed"), và wiring test phải prove call-site (register.ts:68), không chỉ prove pure function. |
| **Folded YAML scalar (`key: >`) in agent/team/workflow frontmatter** (Batch-9 regression, fixed `aa899a1e`): `utils/frontmatter.ts` is line-based — folded descriptions parsed as literal `">"` for ALL 17 agents while typecheck/lint/test:critical stayed green (skills unaffected: real `yaml` package). Symptom: guidance renders `name (builtin): >`, When-NOT text missing. | `aa899a1e` | Agent/teams/workflows frontmatter values stay single-line; quote values containing `": "` (parser strips symmetric quotes); run the Tier 12b dual-parse probe after EVERY resource `.md` frontmatter edit. Folded scalars remain fine in `skills/*/SKILL.md` only. |
| **Worker killed mid long-silent-bash** (Batch-1 postmortem): one >5–10 min command (full `npm test` ≈ 10 min) emits no LLM activity → the broker's responsiveness check SIGTERMs the worker mid-run — exit 143 WHILE the command runs, not a 600s response timeout. Work was intact; manual re-run green — the kill WAS the "hang". | n/a (quirk — `CONTEXT.md` Flagged #1; P2 candidate) | Split long suites into <5 min chunks or emit progress between commands. On exit-143-mid-command: re-run manually BEFORE diagnosing a code bug. Postmortem: `postmortem-batch-1-sigterm.md` (workspace root). |
| **`pkill -f "test:unit"` kills your own shell** (2026-09-16): the pattern matches the `bash -c` cmdline of the tool call that runs it, so the command dies before it starts the replacement suite — and the log file simply never appears. | n/a (self-inflicted) | Kill by pid (`pgrep -f test-runner` → `kill <pid>`), or match a pattern the sink does not contain | Tier 13 "How" step 0 — detached start: `(setsid nohup npm run test:unit > /tmp/suite.log 2>&1 < /dev/null &)` |
| **`pgrep -f test-runner` read as liveness** (2026-09-16): the same self-match makes it report `RUNNING` forever, so a suite that died 10 minutes ago looks alive and the "result" you read is a truncated log. | n/a (self-inflicted) | Liveness = `ps -eo pid,etime,cmd \| grep -E "test-runner\|node --test"` with the grep itself excluded | Tier 13 harness step 1 — a run is DONE only when the `# tests/# pass/# fail` block exists at EOF |
| **Reading a truncated suite log as a summary** (2026-09-16): the runner died with `Test runner error: spawnSync … ETIMEDOUT` at subtest 3946/7860 under load; the last numbers looked like a verdict. | n/a (runner) | The verdict is the `# tests/# pass/# fail` block at EOF — absent means the run did not finish; re-run in the foreground with nothing else heavy running. Since 2026-09-17 (F05) the runner itself fails CLOSED on this class — `resolveExitCode()` (`scripts/test-runner.mjs:44`) maps ETIMEDOUT/spawn-error/signal-kill to a non-zero exit, so wrappers/CI see red instead of a silent exit-0 false green; the spawn deadline also rose 900s→1500s (`PI_CREW_TEST_RUNNER_TIMEOUT_MS` override) | Failure symptoms row "Test runner error: spawnSync … ETIMEDOUT" |
| **Running the full suite on a tree you are still editing** (2026-09-16): a 12-minute suite started before the last fixes reports failures that no longer exist — and passes fixes that were not in yet. | n/a (process) | Freeze the tree first; if you must edit, the run is VOID — say so instead of quoting its numbers | Done-criteria: "Full `test:unit` fresh-run" |
| **Grepping the bundle without context or escape-awareness** (2026-09-16): esbuild escapes non-ASCII as `\u250F` (uppercase hex) so glyph greps miss, while `"->"` (the progress **wire format**, `roleSeparator`) and `Crew agents` (error message + task-graph markdown) are permanent false positives. | n/a (permanent) | Grep the codepoint escape (`u250F`, `u258F`) and always print ±90 chars of context before concluding | Tier 3 bundle check + Tier 13 step 2 (escape-aware proof snippet) |
| **Trusting a delegated UI claim** (2026-09-16): four parallel executors + a verifier reported "dedupe applied" and "hints canonical"; the rendered surfaces still showed `fast-fix/fast-fix` and an invented `· right default`. Summaries describe intent. | n/a (process) | Render the surface with REAL state before believing any UI claim — including your own | Tier 13 (this entire tier exists for this class) |
| **Declaring a red gate "pre-existing" (or "my regression") from reasoning alone** (2026-09-16): `check:env-vars` was red; the file was untouched, but that is an argument, not evidence. | n/a (process) | Prove it in a clean-HEAD worktree: `git worktree add -q /tmp/pc-head HEAD && (cd /tmp/pc-head && node scripts/check-env-vars.mjs); git worktree remove --force /tmp/pc-head` | Same recipe as the broker-flake proof (Tier 1 / Failure symptoms) |
| **Shipping a catalog PNG with tofu boxes** (2026-09-16): the catalog rendered the braille spinner + `⟳` + `⎿` as `□` — invisible in the `.txt` captures, obvious the moment the image was opened. | `docs/ui-samples/render_png.py` glyph self-check | Make the renderer FAIL on any character it cannot paint (compare against the `.notdef` box), then map the offender | Tier 13 "Catalog" + `render_png.py` (`_has_glyph`, `BRAILLE_TO`) |
| **Treating `wait-request-broker.test.ts` load-timeout as a product bug**: the test runner's per-file 180s timeout is below this file's full-suite runtime under parallel load — fails only with the whole suite, passes in isolation. Pre-existing flake, NOT a regression from your change. | n/a (test infra) | Re-run the single file before fixing anything: `node scripts/test-runner.mjs test/unit/runtime/broker/wait-request-broker.test.ts`. Green in isolation = infra flake; move on. |

---

## Failure symptoms + recovery

When a tier fails, the recovery is usually quick. Match the symptom to the cause:

| Symptom | Likely cause | Recovery |
|---|---|---|
| `test:critical` returns `# fail N>0` | Regression in touched source | Read the failing test's name + assertion; fix the source; rerun |
| `test:critical` hangs >60s | One test opened a socket/pty that didn't close | Run individual file: `node --import tsx/esm --test --test-force-exit test/unit/<file>.test.ts`; check for missing `await` or unclosed handle |
| `typecheck` fails with `TS2xxx` | TS type drift after src/ edit | Fix the type error; do not commit until exit 0 |
| `build:bundle` fails | esbuild error in `index.bundle.ts` | Run `npx esbuild --bundle src/index.bundle.ts --outfile=dist/index.mjs` for the verbose error |
| `md5sum dist/index.mjs` differs from session | Stale bundle in user's Pi | User must `/quit` + reopen Pi; new extension cold-start loads new bundle |
| Tmux probe: keys not reaching component | Wrong terminal encoding | Check `pi-tui` env; use both `\x1b[A` and `\x1bOA`; check `matchesKey` is wired in the dispatched class |
| `pty_probe.py` errors `OSError: [Errno 6] No such device` | Pty already closed | Reduce `--startup-sleep` or check `pi` actually launched |
| Smoke team: 04_verify exits with 143 | Verifier ran slow command (typically `npm test`) | Read worker transcript for actual command run; fix the verifier prompt per Tier 7 |
| Smoke team: worker times out (exit 143) | Either verifier command slow OR LLM thinking cap | Check `RESPONSE_TIMEOUT_MS` (600s; env override `PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS`); bump only if you verified the command itself finishes under it |
| `stale-ctx` error in worker output | Extension ctx is stale after session replacement | This is runtime noise, not a regression; ignore. (Source: `.crew/knowledge.md` "Process Safety" notes) |
| Bundle md5 not changing after rebuild | Stale `dist/` cache or esbuild no-op | `rm -rf dist/ && npm run build:bundle`; verify new md5 |
| Team tool returns `Unknown type` (isError:true, short text) | `Value.Check` in the handler hit a `Type.Unsafe({...})` schema node with **no `[TypeBox.Kind]` symbol** — only triggered when the model actually sends that field. Tier 1-8 pass; only Tier 9 (feature battery) catches it. | Replace the `Type.Unsafe` with a TypeBox-native constructor (`Type.Union`, `Type.Record`, `Type.Any`). Reproduce with `node --input-type=module -e "import {Value} from '@sinclair/typebox/value'; import {TeamToolParams} from './src/schema/team-tool-schema.ts'; Value.Check(TeamToolParams, {action:'list', skill:'', config:{}})"` — a throw = the bug. |
| `Validation failed for tool "team": ... must be equal to constant` | pi-ai `validateToolArguments` (`@earendil-works/pi-ai/dist/utils/validation.js`) rejects model-emitted `""`/`0`/`false` defaults against Literal unions / patterns / minimums — it runs BEFORE the pi-crew handler, so handler-side normalization is too late. | Loosen the schema to accept the unset marker (`Literal("")`, pattern `^$|...`, `Literal(0)`, add `Boolean()` to unions). Verify with the pi-ai validator directly: `import {validateToolArguments} from '@earendil-works/pi-ai'; validateToolArguments({name:'team',parameters:TeamToolParams},{name:'team',arguments:{...fullModelBlob}})`. |
| User says "restarted" but the probe still shows the OLD error | Multiple `pi` PIDs open; the user reopened a different terminal than the one the agent runs in; the agent's session never reloaded the bundle. | `ps -eo pid,lstart,tty,args \| grep pi` to list PIDs; match the agent's session log (the `.jsonl` being appended right now) to its PID; have the user reopen THAT session, or move the work into the freshly-opened one. |
| Surface run green but zero panes created | `runtime.surface.visibleAgents` still `[]` (default — visible to nobody), or the env has no live mux (no `$TMUX` / no herdr socket / `runtime.surface.mode: off`), or depth > `maxDepth`. **NOT async anymore** — async runs are no longer hard-gated headless (2026-08-27): surface now follows env + `runtime.surface.*` config, not run-mode. | Set `visibleAgents` (`team-settings set runtime.surface.visibleAgents '["*"]'`) — note `[]` is a silent no-op, `unset` removes it. If run async, it still engages panes when env has a live mux. Check `worker.surface_gate_blocked` events (mode/depth/cap/role/no-mux) in `events.jsonl`. See Tier 10. |
| Worker boots in pane then dies instantly / pane flashes | Launch script env broken (missing `PI_CREW_SURFACE_PANE`, wrong cwd) or parent-guard tripped (host PID died / starttime mismatch) | Read the pane's recorder log (`agents/{taskId}/events.jsonl`) + degrade.classify events in run `events.jsonl`; check `PI_CREW_PARENT_PID` propagation in `src/runtime/child-pi/child-pi-spawn.ts` |
| `ask` tool fast-fails "proceed with best judgment" | `broker.waitMethodsEnabled: false` somewhere (user config can re-close the default) | `team-settings get broker.waitMethodsEnabled`; expect `true` (default since `ceb9a68d`); grep events.jsonl for `policy.action` |
| `delegate` rejects with a policy message | By design when depth cap hit (`maxDepth: 4`) or `nesting.enabled: false` in USER config (sensitive — project cannot flip) | Check depth in the rejection payload; `delegate.rejected` event in events.jsonl confirms the structured (non-silent) path |
| herdr provider never engages | pi is not itself running inside a herdr pane (design: no socket guessing) | Run pi inside herdr, then `runtime.surface.mode` auto/`herdr`; verify `~/.config/herdr/herdr.sock` responds |
| Surface run >5 phút bị stale-reconcile giết oan (worker khỏe, pane sống) | F1 (đã fix f12f4f5d + af2f8eb4): recorder chỉ flush ở turn boundary → lastSeen đóng băng giữa turn; reconciler cũ time-based không pid-gate. **Bẫy đa host**: MỘT pi session chạy bundle cũ cũng đủ giết run của session khác (sweep quét mọi runs) — tát cả host phải cùng version | Kiểm tra mọi pi process cùng bundle (`ps` lstart vs dist mtime); `PI_CREW_DEBUG_STALE=1` sidecar /tmp/pi-crew-f1-debug.log ghi mọi verdict STALE để bắt hung thủ; kỳ vọng sidecar rỗng khi mọi host đã fix |
| Worker exits 143 WHILE a long bash command is still running (no LLM-activity window before the kill) | Broker responsiveness SIGTERM on silent long commands (`CONTEXT.md` Flagged #1) — distinct from `RESPONSE_TIMEOUT_MS` (600s no-response) | Split the command; emit progress between steps; re-run the suite manually — work is usually intact. See `postmortem-batch-1-sigterm.md` |
| Full `test:unit` fails ONLY on `wait-request-broker.test.ts` under parallel load | Per-file 180s runner timeout vs the file's real runtime (passes isolated) | `node scripts/test-runner.mjs test/unit/runtime/broker/wait-request-broker.test.ts` — green in isolation = infra flake, not a regression |
| `undefined` (or `undefined — …`) painted in a live surface | an optional segment interpolated into a template literal without a guard. **Check BOTH paths**: the pure builder and the component that composes the same row (2026-09-16: `widget-renderer.buildWidgetLines` guarded it, `src/ui/widget/index.ts` did not). | Guard before composing (`if (!x) return [] / return undefined`), add a regression lock that renders the zero-state through the COMPONENT, and sweep every `${optional}` on the surface. |
| Spinner keeps spinning after the run finished (`⠹ … 0 running`) | the surface hardcodes a spinner frame instead of deriving the glyph from state | Derive it: spinner only while an agent/run is actually running, otherwise the outcome glyph (`✓`/`✗`). Assert in the battery that "0 running" never coexists with a braille glyph. |
| Actionable hint clipped at a narrow width (`···· ↓…`) | the leader/hint is composed at a pinned budget and the WHOLE line is truncated afterwards, so the tail dies first | Compose the tail with the shared leader helper at `budget = min(pinned, width - 2)` so the LEFT segment is trimmed (with `…`) and the hint survives. Probe at 40/50/60 columns. |
| A status/word truncated mid-token (`complete…`, `fast-f…`) | a narrow-width fallback truncating `head · meta` as ONE string | Give the fallback an explicit priority order (status > id > goal > meta) and clip the lowest-priority segment; never `truncate()` a concatenation that mixes a must-survive token with a droppable one. |
| A surface shows a word nobody can trace to data (`· right default`) | a hardcoded literal left in a template | Delete it or replace it with the real field (`run.workspaceMode`). Add "every literal traces to a field" to the Tier 13 sweep. |
| `input=2780, output=3715, cost=0.000000` inside a TUI panel | a `key=value` formatter (CLI/status output) reused where the compact TUI form belongs | Keep the wire formatter for CLI/log output; add a compact form for the rail (`↑2.8k ↓3.7k`, cost only when > 0). Same for durations: `formatDuration` (`5m44s`), never `(ms/1000).toFixed(1)}s`. |
| Catalog PNG shows `□` / dashed rails | the render font lacks the glyph (braille spinner, `⟳ ⏰ ⎿`) or `line-height > font-size` | Re-run with the coverage self-check in `render_png.py`; keep the substitution map up to date; set `LH = FS`. |
| `Test runner error: spawnSync … ETIMEDOUT` mid-suite | the runner's own spawn deadline hit under load (a real test spawns node children); deadline is **1500s since 2026-09-17** (900s before) | Re-run in the foreground with nothing else heavy running; a truncated log is not a verdict. If it repeats on one file, run that file alone. On a loaded box you may raise `PI_CREW_TEST_RUNNER_TIMEOUT_MS` — but note the run now exits non-zero (fail-closed, F05), so a wrapper green is trustworthy |
| Guidance / `team action='list'` shows an agent description as `>` or missing When-NOT text | Folded-scalar frontmatter (`description: >`) — the line-based parser reads `>` literally (CONTEXT.md Flagged #4) | Restore the single-line value (double-quote it if it contains `": "`); re-run the Tier 12b dual-parse probe |

## Performance budget (per-tier soft limits)

| Tier | Soft limit | Hard limit | What happens over hard limit |
|---|---|---|---|
| 1 (`test:critical`) | 25s | 60s | Worker likely hung — cancel + bisect by file |
| 2 (3-path proof, total) | 75s | 180s | Same as above |
| 3 (`typecheck` + `build:bundle`) | 25s | 60s | `typecheck` regression — check imports |
| 4 (md5 sync check) | <1s | 5s | Disk/symlink issue |
| 5 (tmux spawn) | 5s | 15s | tmux server issue |
| 6 (pty probe) | 5s | 15s | `pi` not in PATH |
| 7 (smoke team) | 60s (verifier only) | 600s (worker hard limit) | Worker killed by `RESPONSE_TIMEOUT_MS` |
| 8 (final md5 sync) | <1s | 5s | Disk/symlink issue |
| 9 (feature battery) | 30s (read-only batch) + ~120s per spawn probe | 600s per spawn probe (worker hard limit) | Spawn probe hung or returned `Unknown type`/`Validation failed` — a schema or registration regression; see Tier 9 + Failure symptoms |
| 10a (surface E2E suite) | 90s | 180s | tmux server issue or a real spawn/degrade regression — investigate, don't bump |
| 10b (live surface run) | ~120s (one fast-fix run) | 600s (worker hard limit) | Pane never engaged (check `visibleAgents`) or auto-exit failed leaving panes open |
| 10c (herdr path) | ~120s | 600s | herdr socket protocol drift — check `herdr api schema --json` against `src/runtime/surface/herdr-provider.ts` |
| 13 (real-run UI render: 1 real fast-fix run + harness + sweep) | 150s | 300s | A surface is reading disk on the paint path, or the run itself hung — the render is <10ms, so a slow Tier 13 means the harness is doing I/O it shouldn't |

If a tier runs over the hard limit, **stop and investigate** — don't bump the budget silently. The budget exists precisely so regressions in test runtime (which usually means a regression in test setup/teardown) are caught early.

---

## Edge cases

### macOS specifics

| Topic | Linux | macOS | Action |
|---|---|---|---|
| `md5sum` | yes | no (use `md5 -r`) | The Prerequisites table notes this. |
| `XDG_RUNTIME_DIR` | `/run/user/<uid>` | unset by default | pi-crew falls back to `os.tmpdir()` (per-user `/var/folders/.../T/`). Broker works the same. |
| Unix abstract socket | yes | no | The broker uses **concrete paths** under `$XDG_RUNTIME_DIR`, so it works on both. |
| `tmux` | usually preinstalled | `brew install tmux` | Same commands; the `pty_probe.py` works on both. |
| `/tmp/sock` | tmpfs | `/tmp` is `nodeboot`-protected (cleared on reboot but not on logout) | Same. |

### Non-standard paths

The skill assumes pi-crew is at `${PWD}` (the directory you `cd`'d into). If you have it elsewhere:

```bash
export PI_CREW_ROOT=/path/to/pi-crew
cd $PI_CREW_ROOT
# Now ${PWD} resolves correctly inside the skill
```

The `cd ${PWD}` calls appear in the Prerequisites section, Tier 4, Tier 5, and the Quick reference section — all use the same path. Once you `cd` into the repo once, all commands that reference `${PWD}` resolve correctly. Tier 6 uses `scripts/pty_probe.py --cwd` instead, and Tier 8 uses `readlink` (no `cd` needed).

### No-`tmux` fallback

If `tmux` is not installed, use Tier 6 (Python pty) instead. Tier 6 doesn't depend on tmux; it spawns `pi` directly under a pty. The trade-off: Tier 5 gives you `capture-pane` for ASCII screenshots; Tier 6 gives you per-keystroke diag output.

### Stale `/tmp/sock` (tmux session already exists)

If a previous Tier 5 run left a `/tmp/sock` server running, `tmux new-session -S /tmp/sock` will reuse it instead of creating a fresh session. The new `pi` instance attaches to the existing session, which may have leftover state. To force a fresh session:

```bash
tmux -S /tmp/sock kill-server 2>/dev/null  # clean up
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi "cd ${PWD} && exec pi 2>&1"
```

### Multiple concurrent Pi sessions

When the user has multiple Pi sessions open (e.g., main + scratch), each loads the same `dist/index.mjs`. The `md5sum` check is global — if any session loaded the old bundle, you need to restart ALL of them, not just the one you're testing in. Tier 8 covers this only for the user's "main" Pi; warn them about siblings.

### Broker on Windows

`broker.enabled=true` is silently no-op on native Windows (no unix-domain socket). Users on WSL1/2 get full broker behavior. Don't waste time running Tier 7 smoke tests on native Windows — the verifier will run fine but the broker won't actually do anything. Use `PI_CREW_BROKER=0` to skip the broker entirely.

---

## Cross-skill notes

This skill overlaps with these built-in/project skills. Pick the right one:

| Skill | When to use instead |
|---|---|
| `test` (built-in) | When you want generic test execution guidance (not pi-crew-specific) |
| `lint` (built-in) | When you only need lint + format (Tier 3's typecheck replaces it for TypeScript) |
| `verify-before-complete` (project) | When claiming "done" without specific tier discipline; this skill's Tier 1-8 are stricter and pi-crew-specific |
| `code-optimizer` (built-in) | When auditing for perf, not for verification |
| `iterative-audit` (project) | When doing a multi-round codebase audit; this skill's "review kỹ" rounds are a different beast — they're verification, not audit |
| `review` / `security-review` (built-in) | When reviewing someone else's PR diff; this skill is for verifying YOUR OWN changes |

The "skill stack" for a typical pi-crew change:

```
1. Edit src/
2. tier 1 (test:critical)        ← this skill
3. tier 2 (3-path proof)         ← this skill, if broker change
4. tier 3 (typecheck + bundle)   ← this skill
5. tier 5/6 (live TUI)           ← this skill, if ui change
6. tier 7 (smoke team)           ← this skill, if plan/workflow change
7. tier 9 (feature battery)      ← this skill, if schema/tool-surface change
8. tier 10 (surface battery)     ← this skill, if surface/pane change
8b. tier 12 (resource contracts) ← this skill, if agents/skills .md or discovery change
9. commit + push
10. verify-before-complete       ← make the "done" claim with evidence
```

---

## Feature coverage map (tính năng → tier verify)

Use this to answer "đủ full tính năng chưa?" without re-deriving. Every user-facing pi-crew feature, and the cheapest tier that proves it live. If a feature row has no evidence in the report, the battery was not "full" — regardless of how many tiers ran.

| Feature | Code entry | Verify via |
|---|---|---|
| Team tool — 55 actions / 5 domains | `src/schema/team-tool-schema.ts:391-437`, dispatch in `src/extension/team-tool/` | 9a (read-only) + 9b/9c/9d/9e/9f theo domain |
| Runtime mode `child-process` (default) | `src/runtime/child-pi/` | 9b sync run + T7 |
| Runtime mode `scaffold` (dry-run) | `src/runtime/task-runner/pre-execution.ts:176` | 9b `action='plan'`/`'plans'` (preview không spawn) hoặc run với `runtime.mode='scaffold'` |
| Runtime mode `live-session` (experimental) | `src/runtime/live-session/` | Run với `runtime.mode='live-session'` + irc tool xuất hiện trong worker (`src/runtime/custom-tools/irc-tool.ts`) |
| Subagent tools (Agent / steer / result) | `src/extension/registration/subagent-tools.ts` | 9b (`Agent`, `crew_agent`+`get_subagent_result`, `steer_subagent`) |
| Worker tool `ask` (blocking Q→parent) | `src/prompt/prompt-runtime.ts:639`, broker wait.* | 9b-W ask round-trip |
| Worker tool `message` (notify/DM/group) | `src/prompt/message-tool.ts` | 9b-W message probes |
| Worker tool `delegate` (nested spawning) | `src/prompt/prompt-runtime.ts:414` | 9b-W delegate + depth-cap reject |
| Full loadout (D5) | `src/runtime/model/pi-args.ts:283-330` | 9b-W full-loadout sanity |
| Surface panes tmux/herdr (A1) | `src/runtime/surface/` | T10 (10a E2E + 10b live + 10c herdr) |
| Broker (mailbox, steer, tokens) | `src/runtime/broker/` | T1/T2 + 9c steer/respond + T10a test #2 |
| Dashboard + keybindings + overlays | `src/ui/`, commands `src/extension/registration/commands/` | T5/T6 probe + parity golden test |
| **UI surfaces render from real run state** (tool card, dock widget, plan card, sidebar, dashboard, browser, overlays) | `src/ui/**`, grammar in `docs/UI-DESIGN-SYSTEM.md`, primitives in `src/ui/rail.ts` | T13 (real-run render battery: state glyphs, invented strings, pluralisation, truncation priority, usage/duration formats, narrow-width hint survival) |
| UI catalog artifacts (`captures/*.txt` + `png/*.png`, regenerated from real components) | `docs/ui-samples/capture.ts`, `docs/ui-samples/render_png.py` | T13 catalog step (regenerate both + open one PNG; renderer fails on a missing glyph) |
| Slash commands (8: run/status/doctor/help/dashboard/settings/init/config) | `commands/{run,status,manage,dashboard}.ts` | T5 send-keys một lệnh `/team-*` |
| team-settings / config | `src/extension/team-tool/handle-settings.ts` | 9a settings get + 10b set visibleAgents |
| Worktree isolation | `src/worktree/` | 9a worktrees + 9b run `workspaceMode='worktree'` |
| Async detached runs + watchdog | `src/runtime/async-runner.ts` | 9b async + 9f (survive host exit: E2E riêng) |
| Crash recovery / resume | `src/state/`, 9c | 9c resume/retry + checkpoint |
| Export/import bundles | `src/extension/team-tool/` (import/imports/export) | 9e |
| Schedule/cron, goal-loop, anchors | AUTOMATE domain | 9f |
| Doctor / health / zombies + orphan panes | `src/extension/team-tool/doctor.ts` | 9a doctor + T10a test #3 |
| Model fallback chain | `src/config/types.ts` (modelFallback) | unit tests + 9b sync run (auto-tail chay ngầm) |
| State perf (fsync coalescing, event-log tail) | `src/state/` | bench `scripts/run-bench.mjs` (b5/b11-b13) — không cần battery live |
| Delayed-write conversions / read-your-writes (v0.10.5 remediation) | `src/state/` atomic-write, `appendEventBuffered` sites | T11a (stores sync + census + full test:unit gate) |
| wc-gate ≤ 2000 lines (M4 done-gate) | `scripts/wc-gate.mjs` | T11b + CI (`ci` script + ci.yml step) |
| Migration validator (deprecated env warn) | `src/config/migration-validator.ts`, wired `register.ts:68` | T11c (offline validateEnv + live startup warn) |
| Slow tier (3 heavy tests) | `test/integration/slow/` | T11d (disjoint globs + separate run) |
| CI env sanity (SMOKE arm) | `.github/workflows/nightly.yml` / `weekly-smoke.yml` | T11e (grep pins) |
| Event-log reject format | `scratchpad-lifecycle.ts:92`, `finalize-run.ts:242,260` | T11f |
| ui.widgetPlacement default | `settings-overlay.ts:351`, `handle-settings.ts:43` | T11g + live team-settings get |
| Worktree twins contract | `src/worktree/worktree-manager.ts` | T11h (3× consecutive runs) |
| Bundle committed-hash gate | `scripts/check-bundle-staleness.mjs --committed-hash` | T11j |
| Agent routing metadata (`useWhen`/`avoidWhen`/`cost`/`category`; 18 agents) | `agents/*.md` frontmatter; parsed `src/agents/discover-agents.ts:388-391` | T12b (dual parse) + T12c (guidance render) |
| Agent output contracts (`## Output format` + fenced block, all builtins) | enforced by `test/unit/agents/agent-output-contracts.test.ts` | T12a |
| Orchestrator agent (18th builtin, delegated orchestration) | `agents/orchestrator.md` | 9a `team action='list'` shows 18 + T12 |
| Skill override wildcard/denylist (`*`, `!name`) | `src/runtime/skill-instructions.ts` (`collectTaskSkillNames`) | T12d (skill-instructions unit tests) |
| Tool loop guard (read-only tools warn@3/block@5; ask wait-guard) | `src/extension/registration/tool-loop-guard.ts`; config `runtime.reliability.loopGuard` | `tool-loop-guard.test.ts` (12 tests, T12d) + live: same read-only tool 5× → structured block; exempt tools (team/Agent/…) unaffected |
| Post-init skill check (SKILL.md presence/severity) | `src/extension/post-init-skill-check.ts`, wired `register.ts:132` | startup log probe: `[pi-crew] …` warn/error only when skills broken |
| Detached-run delivery bound (3 attempts → drop + warn) | `src/runtime/detached-run-results.ts` (`MAX_DELIVERY_ATTEMPTS`) | unit tests |
| Byte-stable worker prefix (ARCH-3) | `src/runtime/task-runner/prompt-builder.ts` stablePrefix/dynamicSuffix split | byte-identity unit test (strictEqual) |
| Release tarball import gate (ARCH-6) | `scripts/release-smoke.mjs` (installs pi-* peers, `import()`s installed bundle `:77`, shape-checks exports) | release cut: `node scripts/release-smoke.mjs` |
| Bundle path-leak scan (ARCH-7) | `scripts/check-bundle-staleness.mjs` (line-scan dist + structural sourcemap check) | T3 staleness run + T11j |

---

## Maintenance

The skill mentions specific commits, line numbers, and version pins. As the code evolves, these will drift. Maintenance playbook:

| What | When | How |
|---|---|---|
| Verify line refs after each `src/` commit | Every commit touching the cited file | `git log -p -- src/extension/registration/lifecycle-handlers.ts \| grep effectiveEnabled` — if line moved, update the skill |
| Verify commit hashes still exist | Quarterly or before major edits | `git log --oneline -1 <hash>` — if gone, find the equivalent newer commit |
| Verify version pins (v0.9.46, etc.) | Each release | `git log --oneline -- src/ui/run-dashboard.ts \| head -5` — confirm diag removal history (e3ee6fe2) still accurate |
| Verify `test:critical` still has 14 files | Each `src/runtime/broker/*.ts` edit | `grep test:critical package.json` — adjust the file list |
| Verify Tier 7 verifier prompts still say `test:critical` | Each workflow file edit | `grep "Run FAST checks" workflows/*.workflow.md` |
| Verify Tier 10 surface refs | Each `src/runtime/surface/**` edit | `ls test/system/surface-*.e2e.test.ts` + grep `MAX_SURFACE_WORKERS` in resolve-surface.ts — cap/config shape may drift between A1 → A2 |
| Verify herdr wire details | Each herdr release bump | `herdr api schema --json` vs `src/runtime/surface/herdr-provider.ts` (envelope/pane.read source/1-conn-per-request were verified on herdr 0.8.2) |
| Verify Tier 11 census numbers | Each `src/state/**` write-path commit | `grep -rln "appendEventBuffered" src/ \| wc -l` — update the 16-file / 43-conversion anchor in 11a when it drifts |
| Verify wc-gate still enforced | Each `package.json` / ci.yml edit | `node -e "require('./package.json').scripts.ci.includes('check:wc-gate')"` + grep ci.yml — a gate removed from `ci` reverts to advisory |
| Verify migration-validator wiring | Each `register.ts` refactor | `grep -n validateEnv src/extension/register.ts` — must stay after `installChildProcessAbortShield`, before `startRuntimeWarmup`, warn-only. ALSO `grep -n runPostInitSkillCheck src/extension/register.ts` (:132) — async post-init, warn/error only |
| Verify builtin agent count + contracts | Each `agents/*.md` commit | Tier 12a/12b — **18 @ 2026-09-11** (`aa899a1e`); update this skill's count when it changes |
| Verify frontmatter stays single-line/quoted | Each `agents/`, `teams/`, `workflows/` `.md` edit | Tier 12b dual-parse probe — BOTH discovery and strict `yaml` must pass |
| Verify staleness leak-scan still runs | Each `check-bundle-staleness.mjs` edit | `node scripts/check-bundle-staleness.mjs` after `build:bundle` — exit 0 (staleness + path-leak) |
| Verify release-smoke peer pins + import gate | Each `release-smoke.mjs` edit / release cut | `node scripts/release-smoke.mjs` — peer install + import + shape checks green |

The skill does NOT need to be updated for every commit — only when the cited lines/files move. Consider it a "living reference" not a "live spec".

---

## Quick reference — exact commands

```bash
# Tier 1 (critical unit, ~21s, 102 tests)
npm run test:critical
# Tier 2 (3-path proof, broker changes only)
PI_CREW_BROKER=0 npm run test:critical
PI_CREW_BROKER=1 npm run test:critical
# Tier 3 (compile + bundle)
npm run typecheck
npm run build:bundle
md5sum dist/index.mjs
# Tier 4 (sync check — symlink is in the CONSUMING project)
readlink ../node_modules/pi-crew  # dev: → ../pi-crew
readlink "$(npm root -g)"/pi-crew  # global install
# Tier 5 (tmux probe)
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  "cd ${PWD} && exec pi 2>&1"
tmux send-keys -t pi '<key>' ; sleep 0.5
tmux capture-pane -t pi -p
# Tier 6 (pty probe)
python3 scripts/pty_probe.py 2>&1 | tee /tmp/diag.log
# Tier 7 (smoke team)
# from parent Pi session only — uses the `team` tool, not shell
# Tier 8 (final md5 sync — compare disk vs loaded bundle)
md5sum dist/index.mjs
md5sum "$(npm root -g)"/pi-crew/dist/index.mjs 2>/dev/null \
  || md5sum ../node_modules/pi-crew/dist/index.mjs
# Tier 9 (feature battery — from parent Pi session, tool calls not shell)
#   read-only: team action=list / recommend / health / doctor / status / events / summary / get / explain / worktrees / settings
#   spawn:     team action=run (sync) ; team action=run async=true ; team action=run chain='"A" -> "B"'
#              Agent (direct) ; crew_agent run_in_background=true + get_subagent_result ; steer_subagent
#   worker tools (goal-text probes): ask round-trip ; message notify/DM/group ; delegate nesting (depth-cap reject)
#   reproduce the two silent schema failures:
#   node --input-type=module -e "import {Value} from '@sinclair/typebox/value'; import {TeamToolParams} from './src/schema/team-tool-schema.ts'; Value.Check(TeamToolParams, {action:'list', skill:'', config:{}})"  # throws 'Unknown type' = Type.Unsafe-without-Kind bug
# Tier 10 (surface battery)
#   team-settings set runtime.surface.visibleAgents '["*"]'    # opt-in — default [] engages NOTHING
tmux list-panes -a -F '#{pane_id} #{pane_title} #{pane_pid}'  # during run: pane per taskId
#   E2E suite (must run inside tmux):
node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/system/surface-tmux.e2e.test.ts
#   doctor orphan panes: team action='doctor' focus='zombies'
# Tier 11 (v0.10.5 remediation regression)
npm run check:wc-gate                                          # 11b: exit 0, max <= 2000
node -e "const p=require('./package.json').scripts; console.log(p.ci.includes('check:wc-gate'))"  # 11b: true
node --experimental-strip-types --no-warnings -e 'import("./src/config/migration-validator.ts").then(m=>console.log(JSON.stringify(m.validateEnv({PI_CREW_BROKER_DIAG_UI:"1"}))))'  # 11c
ls test/integration/slow/                                      # 11d: 3 files
grep -n "PI_CREW_SMOKE" .github/workflows/nightly.yml          # 11e: comment only, NOT set
grep -rn 'type=\${' src/prompt/scratchpad-lifecycle.ts         # 11f: reject format
grep -rn '"ui.widgetPlacement"' src/ui/settings-overlay.ts src/extension/team-tool/handle-settings.ts  # 11g: bottom
for i in 1 2 3; do node --experimental-strip-types --no-warnings --test test/unit/worktree/worktree-twins-contract.test.ts 2>&1 | grep -E '^# (pass|fail)'; done  # 11h
grep -rln 'appendEventBuffered' src/ | wc -l                   # 11a: census (16 files @ v0.10.5)
node scripts/check-bundle-staleness.mjs --committed-hash      # 11j: OK
# Tier 12 (resource contracts — agents/skills .md + discovery changes)
node --experimental-strip-types --no-warnings --test --test-force-exit test/unit/agents/agent-output-contracts.test.ts  # 12a
node --experimental-strip-types --no-warnings -e 'import("./src/agents/discover-agents.ts").then(m=>{m.invalidateAgentDiscoveryCache();const l=m.discoverAgents(process.cwd()).builtin;console.log("agents:",l.length,"| bad desc:",l.filter(a=>!a.description?.includes("When NOT to use:")).length,"| no routing:",l.filter(a=>!a.routing?.useWhen).length);})'  # 12b: 18 | 0 | 0
node -e 'const yaml=require("yaml"),fs=require("fs");let ok=0;for(const f of fs.readdirSync("agents")){const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync("agents/"+f,"utf-8"));if(m){try{if(yaml.parse(m[1]).name)ok++;}catch{}}}console.log("strict YAML:",ok)'  # 12b: 18
node --experimental-strip-types --no-warnings --test --test-force-exit test/unit/bundle-skill-resolution.test.ts test/unit/extension/registration/tool-loop-guard.test.ts test/unit/runtime/core/skill-instructions.test.ts  # 12d
node scripts/check-bundle-staleness.mjs                              # staleness + ARCH-7 path-leak scan (also after every build:bundle)
node scripts/release-smoke.mjs                                       # release cut: peer install + tarball import + shape check (ARCH-6)
# Tier 13 (real-run UI render battery — any src/ui/** change, or after ANY delegated UI work)
#   from the parent Pi session: team action='run' team='fast-fix' goal='<read-only 1-question task>'   # ~120s, gives REAL state
#   then render every surface from that run's on-disk state (harness template in Tier 13; keep it in /tmp):
node --experimental-strip-types --no-warnings /tmp/full-ui.ts | tee /tmp/full-ui.txt
grep -nE "undefined|[╭╮╰╯├┤]|->" /tmp/full-ui.txt                     # 0 hits (unguarded segment / retired frame / legacy separator)
grep -nE "(^|[^0-9])1 (runs|tools|agents|tasks)\b" /tmp/full-ui.txt    # 0 hits (anchor the plural check — `11 tools` contains `1 tools`)
grep -nE "input=|output=|cacheRead=|cost=[0-9]" /tmp/full-ui.txt        # 0 hits (wire format leaked into a TUI panel)
#   state glyph: a braille spinner must never coexist with `0 running`; hint (`↓·enter`) must survive at 40/50/60 cols
#   catalog: regenerate BOTH artifacts, then LOOK at one image
node --experimental-strip-types --no-warnings docs/ui-samples/capture.ts   # captures/*.txt
python3 docs/ui-samples/render_png.py                                      # png/*.png (fails loudly on a glyph the font lacks)
#   bundle-side proof (escape-aware — esbuild writes \u250F uppercase):
python3 - <<'PY'
s=open("dist/index.mjs",encoding="utf-8").read()
for k,v in {"rail open u250F":"u250F" in s,"section u2523":"u2523" in s,"retired u256D":"u256D" in s,"raw undefined-hint":"undefined \u2014 " in s}.items(): print(f"{k}: {v}")
PY
#   11a full gate (after ANY delayed-write conversion program): npm run test:unit  # ~7500 tests, 15-18 min
```

---

## Done-criteria checklist

Before claiming "tested":

- [ ] Tier 1: `test:critical` fresh-run, all pass (<25s). Count varies by release — was 97 at v0.9.46, 101 at v0.9.66, **102 since the waitMethodsEnabled flip**; record the actual count in the report.
- [ ] Tier 2: 3-path proof all pass — **required if you touched `src/config/defaults.ts` or `src/extension/registration/lifecycle-handlers.ts`**
- [ ] Tier 3: `npm run typecheck` exit 0, `npm run build:bundle` exit 0
- [ ] Tier 4: bundle md5 matches what the session loaded (or user has `/quit`-ed + reopened)
- [ ] Tier 5/6: live TUI smoke for any `src/ui/` change — keystroke reached `handleInput`
- [ ] Tier 7: smoke team run for any `src/runtime/goal-workflow/plan-templates.ts` or `workflows/*.workflow.md` change — completed, no hang, verifier output under 60s
- [ ] Tier 8: final md5 sync check passed
- [ ] Tier 9: feature battery — **required if you touched `src/schema/team-tool-schema.ts`, `src/extension/registration/team-tool.ts`, any `Type.Unsafe({...})` schema, or any armed-role tool list (`agents/*.md` / `src/config/role-tools.ts`)**. 9a read-only batch all return clean; one probe per 9b spawn path (sync / async / chain / `Agent` / `crew_agent`+`get_subagent_result`) completes with `consistency=1`. Run 9c–9f only when the change touches their code path; **at least one full 9c/9e/9f sweep per release is recommended so the battery stays proven** (see `real-test-2026-08-11-scratchpad-I-batch.md`); 9d (destructive) requires explicit user confirmation. **After every run: `git status` to catch unauthorized agent edits.**
- [ ] Tier 13: real-run render battery — **required for ANY `src/ui/**` change** (and after any parallel/delegated UI work). One real `team action='run'` producing on-disk state; every surface rendered from that state at 118 + a narrow width; invariant sweep clean (no `undefined` / retired frame glyph / `->` / wire format / invented word / bad plural); the correct glyph per state (running vs done vs failed — never a spinner with `0 running`); the actionable hint survives the narrowest width; durations, usage and run ids formatted identically on every surface; catalog regenerated (capture + PNG) and one image visually inspected. **Fixtures do not count** — the defects this tier exists to catch (invented strings, wrong-state glyphs, truncation that eats a must-survive token) are invisible to author-chosen fixture values.
- [ ] **Output report**: save `docs/real-test/reports/real-test-<YYYY-MM-DD>-<slug>.md` from `skills/real-test-pi-crew/REPORT-TEMPLATE.md`, filled DURING the run with per-tier evidence (counts/md5/runId) — not reconstructed from memory afterward. This is what makes past runs verifiable instead of trust-the-summary.
- [ ] Tier 10: surface battery — **required if you touched `src/runtime/surface/**`, `src/prompt/surface-worker.ts`, the surface branch of `src/runtime/child-pi/child-pi.ts`, or the surface config keys**. 10a E2E 3/3 per backend available (tmux trong tmux; herdr ngoài tmux + socket sống — skip vì thiếu mux là correct-by-design nhưng KHÔNG tính pass cho backend đó); 10b live run với session ĐÃ reload bundle mới (xem Anti-patterns "file-md5 only") + `visibleAgents` set + pane-level evidence (pane id/title during run, `worker.surface_spawned`/`worker.surface_closed` events, pane auto-closed after — KHÔNG dùng `manifest.surface.panes` làm evidence engage, xem Anti-patterns "panes == {}"); 10c herdr live chỉ khi pi chạy trong herdr pane (skip kèm lý do nếu không).
- [ ] Tier 11: remediation regression battery — **required if you touched `src/state/**` write paths, `migration-validator.ts`/its wiring, `scripts/wc-gate.mjs` or `ci` scripts, `.github/workflows/*` env, EFFECTIVE_DEFAULTS maps, or you are cutting a release**. Sub-checks a–j per Tier 11; 11a item 4 (full `test:unit`) mandatory after any delayed-write conversion program, skippable for doc-only changes. Record: buffered-site census count, wc-gate max, staleness `--committed-hash` result.
- [ ] Tier 12: resource-contract battery — **required if you touched `agents/*.md`, `skills/*/SKILL.md`, `src/agents/discover-agents.ts`, `src/skills/discover-skills.ts`, `src/utils/frontmatter.ts`, `src/runtime/skill-instructions.ts`, or `src/extension/autonomous-policy.ts`**. 12a contracts green; 12b BOTH parsers clean (agent count — **18 @ 2026-09-11** — 0 bad descriptions, 0 missing routing, 0 strict-YAML fails); 12c every rendered agent line carries `useWhen=` (budget-truncated by design; newest agent visible); 12d unit batteries pass. Agent/skill-only changes need NO bundle rebuild (runtime-loaded from the package dir) — `src/` changes in the same commit still follow the Tier 3 bundle rule.

**"All tiers pass" is a claim that needs per-row evidence.** Tier 9 means 9a **and** 9b **and** whichever of 9c–9f applies to the change — not "9a passed, therefore 9 passed". Tier 10 means pane-level evidence exists, not "run went green" (surface fail-closes to headless on every failure, so green proves nothing). If any required item above is unchecked or lacks concrete evidence (a number, an md5, a runId, a pane id), the answer to "is it tested?" is **no** — say so explicitly instead of rounding up to "pass".

---

## File-anchored references (full index)

Decision docs:
- `docs/decisions/2026-07-21-broker-phase4-default-on.md` — interim default-off (SUPERSEDED)
- `docs/decisions/2026-07-22-broker-phase4-gated-on.md` — default-on flip + risk + monitoring + rollback
- `docs/decisions/2026-07-21-broker-windows-perms.md` — Windows named-pipe perms + Phase-4 update note

Source files (critical paths):
- `src/config/defaults.ts:191` — `DEFAULT_BROKER` (`:205` `waitMethodsEnabled: true`), `:221` `DEFAULT_NESTING`, `:252` `resolveBrokerEnvOverride`
- `src/extension/registration/lifecycle-handlers.ts:1026-1039` — `effectiveEnabled()` (precedence)
- `src/runtime/child-pi/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs` = **600_000** (`src/config/defaults.ts:26`; was 300_000 before the stuck-worker hardening — see Tier 7)
- `src/runtime/goal-workflow/plan-templates.ts:144, 147, 151` — verifier `taskTemplate` + `verificationCommand`
- `src/runtime/broker/crew-broker.ts` — broker server (per-connection gate, NDJSON framing)
- `src/runtime/broker/crew-broker-client.ts` — client (`isEventFrame()` distinguishes event vs response frames)
- `src/runtime/broker/crew-broker-tokens.ts` — `BrokerTokenRegistry` with `timingSafeEqual`, secret-based revocation
- `src/runtime/broker/broker-issuer.ts` — per-run broker issuer (env injection at spawn)
- `src/runtime/broker/crew-broker-child.ts` — child-side broker client wiring
- `src/ui/key-utils.ts:37-42` — `keyOf()` using pi-tui `matchesKey()`
- `src/ui/keybinding-map.ts` — dispatch using `matchesKey()` (commit `f05a10d`)
- `src/runtime/model/pi-args.ts:283-330` — D5 loadout: `--tools`/`--no-skills` ONLY khi agent frontmatter khai báo; `DEFAULT_MAX_CREW_DEPTH = 4`
- `src/extension/registration/subagent-tools.ts` — `Agent` (:70), `get_subagent_result` (:359), `steer_subagent` (:475, alias `crew_agent*`)
- `src/runtime/live-session/live-session-runtime.ts` + `src/runtime/custom-tools/irc-tool.ts` — live-session mode + peer-to-peer irc (experimental)

Surface files (Tier 10 critical paths):
- `src/runtime/surface/surface-provider.ts` — SurfaceProvider interface (spec §4)
- `src/runtime/surface/resolve-surface.ts` — fail-closed detect matrix (spec §3), `MAX_SURFACE_WORKERS = 6`
- `src/runtime/surface/tmux-provider.ts` / `herdr-provider.ts` — pane lifecycle per backend (herdr: 1 req = 1 conn, only-in-pane detect)
- `src/runtime/surface/surface-spawn.ts` — prepareSurfaceSpawn + waitForSurfaceExit (env `PI_CREW_SURFACE`, `PI_CREW_SURFACE_PANE`, `PI_CREW_AUTO_EXIT`, `PI_CREW_PARENT_PID`)
- `src/runtime/surface/degrade.ts` — classifyOnExit 2s, cause-group lockout, spawn-fail streak 3, headless resume
- `src/runtime/surface/launch-script.ts` — 0600 script builder + TTL sweep + depth guard
- `src/prompt/surface-worker.ts` — recorder (seq-seeded), auto-exit via `ctx.shutdown()`, parent-guard `/proc` starttime
- `src/extension/team-tool/doctor.ts:522+` — T12 orphan surface-pane cleanup + surface telemetry

Worker-tool files (Tier 9b-W):
- `src/prompt/prompt-runtime.ts:414, 639, 1053-1059` — `delegate` / `ask` registration (+ `message` via `src/prompt/message-tool.ts`)
- `src/prompt/message-tool.ts` + `inbox-poll.ts` — message tool (rate-limit 10/60s, `from` broker override), inbox pickup fences messages as DATA
- `src/prompt/worker-events-channel.ts` — `emitTerminal()` bypasses rate-limit
- `src/config/types.ts:94` — `runtime.surface` config shape; `src/extension/team-tool/handle-settings.ts:23-24` — team-settings keys

Test files (the 14 in `test:critical`):
- `test/unit/runtime/broker/crew-broker-{handshake,stale-socket,feature-flag,server-gate,client-fallback,mailbox-observer,close-during-reconnect,steer-dedup,symlink-steering}.test.ts`
- `test/unit/ui/keybinding-map.parity.test.ts`
- `test/unit/ui/pi-tui-dispatch-probe.test.ts`
- `test/unit/utils/session-utils-extract.test.ts`
- `test/unit/config/config-schema-sync.test.ts`
- `test/unit/runtime/child-pi/child-pi-env-spread.test.ts`

Surface tests (Tier 10):
- `test/system/surface-tmux.e2e.test.ts` — 3 E2E tests, gated `CI || ! $TMUX` (spawn/self-close, kill-pane→degrade→headless resume, doctor orphan cleanup)
- `test/unit/runtime/surface/` — resolve-surface, degrade, prepare-surface-spawn, surface-spawn unit tests
- `test/unit/config/surface-config.test.ts` — config shape + team-settings keys

Integration tests (Tier 1 covers none — these are for full E2E):
- `test/integration/crew-broker-msg.test.ts` — 5 tests (Phases 1)
- `test/integration/crew-broker-phase2-3.test.ts` — events.subscribe + task.waitStatus + steer.push + escalate

Workflow files:
- `workflows/fast-fix.workflow.md:24` — verifier prompt (commit `d599578`)
- `workflows/default.workflow.md:31` — verifier prompt
- `workflows/plan-execute.workflow.md:30` — verifier prompt
- `workflows/review.workflow.md:31` — verifier prompt

UI design system + catalog (Tier 13):
- `docs/UI-DESIGN-SYSTEM.md` — the RAIL grammar every surface must follow (glyphs `┏ ┣ ┃ ┗`, canopy `NAME ▸ SUBJECT`, dot leaders, eighth-block gauge, cursor `›`, overflow `▲/▼`, hint format) + the 7 surface classes + the width contract
- `src/ui/rail.ts` — SINGLE SOURCE of the glyphs/helpers (`RAIL`, `canopyLine`, `sectionLine`, `railLine`, `railLeaders`, `gaugeBar`, `statusSlot/Badge/Icon`, `overflowHint`, `formatHint`/`keyToken`, `CURSOR`/`ACTIVE`, `dedupeAgentLabel`, `padVisual`/`truncVisual`). Surfaces must import from here, never re-declare `┏`/`┃`/`▕` locally.
- `src/ui/adaptive-card.ts` — width-deferred wrapper (`render(width)` is the real width; a frame baked for 116 columns tears at 100)
- `src/ui/format-helpers.ts` — `formatCount` (pluralisation: `1 tool`), `formatDuration` (`5m44s`, never `314.7s`), `teamWorkflowLabel` (collapses `team/team`), `truncLine`
- `src/ui/widget/widget-renderer.ts` — dock row (`buildWidgetLines`, `idleWidgetLine`, `widgetActivityGlyph`, `widgetRailSlot`, `dockTail` hint budget) — the zero-runs branch is the live `undefined — ↓·enter` regression site
- `src/ui/live-run-sidebar.ts` / `src/ui/run-dashboard.ts` / `src/ui/agents-jobs-browser.ts` / `src/ui/settings-overlay.ts` / `src/ui/dashboard-panes/*` — surfaces migrated to RAIL 2026-09-16
- `docs/ui-samples/capture.ts` (real renders incl. sections 13–18 from a run written through the state-store APIs) + `docs/ui-samples/render_png.py` (glyph coverage self-check + substitution map) + `docs/ui-samples/README.md`
- Tests: `test/unit/ui/rail.test.ts`, `dock-rail`, `dashboard-rail`, `panes-rail`, `overlays-rail` (grammar locks), `test/unit/ui/tool-renderers-redesign.test.ts` (card), `test/unit/ui/tool-renderers-frame-width.test.ts` (width invariant)

Resource-contract files (Tier 12):
- `src/utils/frontmatter.ts` — LINE-BASED parser (`parseLines`): single-line values, symmetric-quote strip (`aa899a1e`); folded scalars unsupported for agents/teams/workflows (skills use the real `yaml` package — folded OK there)
- `src/agents/discover-agents.ts:388-391, 476` — flat routing keys (`useWhen`/`avoidWhen`/`cost`/`category` as top-level CSV); discovery cache TTL ~30s (`invalidateAgentDiscoveryCache()`)
- `src/extension/autonomous-policy.ts` — `buildResourceRoutingGuidance` renders routing cards into the leader's injected policy (the single canonical routing source)
- `src/runtime/skill-instructions.ts` — `collectTaskSkillNames`: `*` wildcard + `!name` denylist skill overrides
- `src/extension/registration/tool-loop-guard.ts` — ARCH-1 loop guard: read-only tools warn@3/block@5, ask wait-guard warn@2/block@3rd, FIFO 512; exempts team/crew_agent/Agent/get_subagent_result; config `runtime.reliability.loopGuard`
- `src/extension/post-init-skill-check.ts` (32L) — SKILL.md presence check; wired async at `register.ts:132`, warn/error log only
- `src/runtime/detached-run-results.ts` — `MAX_DELIVERY_ATTEMPTS = 3`; drop + `detached-run-results.delivery-gave-up` log
- `test/unit/agents/agent-output-contracts.test.ts` — output-contract AC across ALL builtin agents
- `test/unit/bundle-skill-resolution.test.ts` + `test/unit/extension/registration/tool-loop-guard.test.ts` (12 tests) + `test/unit/runtime/core/skill-instructions.test.ts` (26 tests)
- `scripts/release-smoke.mjs` — ARCH-6: installs pi-* peers, `import()`s the tarball-installed bundle (`:77`), shape-checks exports
- `CONTEXT.md` — repo orientation: glossary + Flagged quirks (#1 broker SIGTERM, #2 wait-broker flake, #4 frontmatter parser)

Batch-1..10 wave (branch `fix/bundle-skill-resolution-and-skill-meta`, 2026-09-11, base v0.10.5):
- `c97bc578` — BUG-1 packageRoot skill resolution + SKILL-HYGIENE-1 post-init check + SKILL-HYGIENE-2 `*`/`!name` + SKILL-META-1 (34 skills When-NOT — folded OK for skills)
- `3de89a2f` / `07c5e014` / `24c63c75` / `b120187f` — skill Budget/Self-restraint + agent body upgrades (all roles; librarian/oracle/designer added)
- `60e2cb96` — councillor agents (`inheritProjectContext: false`, deny-all-write toolset)
- `d36ad4eb` — ARCH-1 tool loop guard + ARCH-3 byte-stable prefix
- `7d18508b` — ARCH-2/5/6/7 (ARCH-4 skipped per ADR 2026-08-15 — live-session frozen)
- `06c5d7ca` — PROMPT-1/2/5 (output-contract AC, task-rejection line, agent When-NOT — introduced the folded-scalar regression)
- `aa899a1e` — Batch 10: routing metadata (18 agents), orchestrator, delivery bound, CONTEXT.md, folded-scalar fix + quote-strip

Commits (chronological, the patterns they introduced):
- `1cb2dca` — `test:critical` script + plan-templates verifier fix
- `d599578` — 4 workflow verifier prompt fixes
- `612e18b` — Phase 4 default-on flip (code + decision doc)
- `4186284` — mark default-off doc SUPERSEDED + index update

MuxSurface A1 wave (2026-08-26/27, branch `feature/mux-surface-a1` → main at `ec1ba5d3`):
- `ceb9a68d` — ask gate flip: `waitMethodsEnabled` default `true` + never-guess guidance
- `bcb9dd5d` — D5 loadout: worker = full pi session by default (restriction opt-in via frontmatter)
- `de671c5d` — D8 nesting: `delegate` tool for every role, depth cap 4
- `f843e14a` / `49ca2468` / `fcb68713` — D9 `message` tool + broker from-override + wake pattern
- `a77127fd` — `runtime.surface` config + team-settings keys
- `b2851e98` → `04d86582` / `1854a532` — SurfaceProvider interface + tmux/herdr providers
- `c29a1370` / `c2ba6f2d` / `9c5ad869` — launch script + spawn branch + recorder/auto-exit/parent-guard
- `5b7b8033` — EventLogTailSource (host tails per-agent event log)
- `2eb6cfb4` / `7065cb9d` / `69803eb7` — broker token revocation (stale-token + secret-based check)
- `df861630` — degrade flow: classify timeout, cause-group lockout, spawn-fail lockout, headless resume
- `f0586a74` — doctor zombie surface fields + orphan pane cleanup
- `7340305b` / `ec1ba5d3` — ADR + spec errata + test matrix; herdr race synthetic-exit fix

Spec + ADR for the surface feature:
- `docs/superpowers/specs/2026-08-26-mux-surface-design.md` — spec v0.7.1 (D1-D9, §12 data contracts, §13 sequences, §14 A1/A2 scope)
- `docs/decisions/2026-08-26-mux-surface-a1.md` — ADR (process ownership, A2 defer list, D7 errata)

Real team runs (Tier 7 outcomes):
- `team_20260722083504_cae04a2804a24d79` — full-implementation, 3/4 phases done, 04_verify hung (root cause investigation)
- `team_20260722095143_2e58fce2ce91af19` — first fast-fix smoke, 3/3 PASS (after `test:critical` introduced)
- `team_20260722100811_9bf95bebff2b052a` — final fast-fix smoke, 3/3 PASS, verifier used cached output (449s wall-clock)
