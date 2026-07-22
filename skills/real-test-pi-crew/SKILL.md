---
name: real-test-pi-crew
description: "End-to-end verification for pi-crew changes via fast unit tests, 3-path kill-switch proof, bundle md5 sync, tmux/pty live TUI probing, and smoke team runs. Use after any change to broker/, ui/, keybindings, config, plan-templates, or verifier workflows — or before any commit touching these paths."
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
  - "tier 1 / tier 2 / tier 3 / tier 4 / tier 5 / tier 6 / tier 7 / tier 8"
---

# real-test-pi-crew

End-to-end verification discipline for pi-crew changes. Distilled from the broker Phase-4 rollout (commits `1cb2dca` → `d599578` → `612e18b` → `4186284`, July 2026). The pain this skill prevents: shipping code that compiles + unit-tests-green but breaks in the user's live Pi session, or hangs the verifier worker.

## Core principle: disk ≠ live Pi

Two locations hold pi-crew state:

1. **Source** (`src/`, `test/`, `package.json`, `workflows/`, `src/runtime/plan-templates.ts`) — git-tracked, `git diff` shows it.
2. **Bundle** (`dist/index.mjs`) — pre-built, loaded by Pi at **extension cold-start only**.

The 3-way resolution order for `dist/index.mjs` (per `index.ts:5-22`):
```
1. dist/index.mjs (pre-built bundle) if present  ← DEFAULT since the v0.9.17 bundle-as-default rollout
2. Inline strip-types loading — fallback when bundle missing
   OR PI_CREW_USE_BUNDLE=0
```

> **Note on version pins**: this skill mentions specific versions (v0.9.17, v0.9.46, v0.9.47) as anchors for *when a behavior was introduced*, not as a constraint on which version the skill applies to. The verification discipline (Tiers 1–8) applies to every pi-crew release. Verify the version pin is still accurate via `git log --oneline -- index.ts` and `git log --oneline -- src/ui/run-dashboard.ts`.

**Workflow files are runtime data** — `workflows/*.workflow.md` and task prompt strings inside `src/runtime/plan-templates.ts` are loaded per-call, NOT bundled. Edits take effect immediately, no rebuild needed.

**The most common silent-failure mode**: edit `src/`, run `npm test` (pass!), rebuild bundle (good md5!), but the session still has the old code because Pi wasn't `/quit`-ed + reopened.

## Prerequisites

Before running any tier, verify these are available:

| Tool | Used in | Check |
|---|---|---|
| `node` (>=22) | Tiers 1, 2, 3 | `node --version` |
| `npm` | All tiers | `npm --version` |
| `bash` | All tiers | `echo $BASH_VERSION` |
| `md5sum` | Tiers 3, 4, 8 | `which md5sum` (or `md5` on macOS) |
| `tmux` | Tier 5 | `which tmux` (optional — Tier 6 is the fallback) |
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
| Bundle-staleness check | Tier 3 last step | `scripts/check-bundle-staleness.mjs` |
| Multi-OS CI | n/a (skill is local) | `.github/workflows/*.yml` — Linux + macOS + Windows |
| Full `npm test` (>5 min) | n/a — too slow for in-loop | CI only |

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

## Tier 1 — Critical unit tests (~21s, 97 tests, the only suite you need for broker/UI changes)

**What**: run the curated 14-file fast subset.

**Why this exists**: full `npm run test:unit` runs 642 files, >4 minutes. Verifier worker timeout is 300s → worker killed mid-run, run = "hang". The fix (introduced in commit `1cb2dca`) splits out a `test:critical` subset covering exactly what changed in the broker/UI work.

**How**:

```bash
time npm run test:critical
```

Expected output: `# tests 97 # pass 97 # fail 0 # duration_ms ~21000`.

**References**:

| What | Where |
|---|---|
| Script definition | `package.json:67` — list of 14 files passed to `node scripts/test-runner.mjs` |
| Introduced in commit | `1cb2dca fix(verifier): use test:critical instead of test:unit to avoid worker timeout` |
| Runner wrapper | `scripts/test-runner.mjs` — injects `--test-force-exit`, forwards to `tsx --test` |
| The 14 files | broker: `crew-broker-{handshake,stale-socket,feature-flag,server-gate,client-fallback,mailbox-observer,close-during-reconnect,steer-dedup,symlink-steering}.test.ts`; UI: `keybinding-map.parity.test.ts`, `pi-tui-dispatch-probe.test.ts`, `session-utils-extract.test.ts`; config: `config-schema-sync.test.ts`, `child-pi-env-spread.test.ts` |
| Failure mode that motivates it | Worker timeout in `src/runtime/child-pi-constants.ts:23` (`RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs` = 300000); verifier LLM ran `npm test` and got killed at 300s with exit 143 (SIGTERM) |

**Run after**: any edit to `src/runtime/crew-broker*.ts`, `src/ui/`, `src/config/`, `src/extension/registration/lifecycle-handlers.ts`, or `src/runtime/child-pi-spawn.ts`.

---

## Tier 2 — Three-path kill-switch proof

**What**: prove all three precedence paths in `effectiveEnabled()` still resolve correctly.

**Why**: any change to `DEFAULT_BROKER` (in `src/config/defaults.ts:169`) or `effectiveEnabled()` (in `src/extension/registration/lifecycle-handlers.ts:819-833`) can silently break the precedence chain. The chain:

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

All three must show `# pass 97 # fail 0`. Measured times in this session: ~20s for default and `PI_CREW_BROKER=0`, ~21s for `PI_CREW_BROKER=1` (varies ±1s run-to-run).

**References**:

| What | Where |
|---|---|
| `DEFAULT_BROKER` constant | `src/config/defaults.ts:169-173` (Phase 4: `enabled: true`) |
| Precedence function | `src/extension/registration/lifecycle-handlers.ts:819-833` (`return cfg?.enabled !== false;` at line 828) |
| `resolveBrokerEnvOverride` | `src/config/defaults.ts:186-193` |
| Env-precedence unit tests | `test/unit/crew-broker-feature-flag.test.ts:31` (default-on assertion), `:54-110` (env=1/env=0/unset/arbitrary cases at lines 54, 66, 78, 90, 103) |
| Controller-gate tests | `test/unit/crew-broker-server-gate.test.ts:78` (env kill switch under default-on), `:143` (env=1 with no config) |
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
```

Compare the printed md5 against what the user's Pi session loaded. If they differ → the session is running stale bundle.

**References**:

| What | Where |
|---|---|
| `typecheck` script | `package.json` `"typecheck"` — runs `tsc --noEmit && node --experimental-strip-types -e "await import('./index.ts'); ..."` |
| `build:bundle` script | `package.json` `"build:bundle"` — runs `node scripts/build-bundle.mjs` |
| Bundle builder | `scripts/build-bundle.mjs` (esbuild-based, bundles `index.bundle.ts` → `dist/index.mjs`) |
| Bundle resolution rule | `index.ts:5-22` (entrypoint docstring); also `scripts/build-bundle.mjs:14-20` (entrypoint preference); **symlink is live for source files but the bundled `dist/index.mjs` is loaded** |
| Postinstall hook | `scripts/postinstall.mjs:43` — best-effort bundle rebuild; falls back to strip-types if esbuild missing |
| Bundle md5 after Phase-4 commit | `1cc4d55e18add7b9a036c569143320b6` (~2.78 MB at the time; bundle size drifts ±5% between releases, check current `ls -la dist/index.mjs`) |

---

## Tier 4 — Bundle sync into a live Pi session

**What**: ensure the user's running Pi sees your changes.

**The immediate-vs-rebuild rule** (which edits take effect without a rebuild):
- `workflows/*.workflow.md` edits → **immediate**, no rebuild, no restart
- `src/runtime/plan-templates.ts` `taskTemplate` strings → **immediate**, runtime data
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
| Bundle resolution | `index.ts:5-22` — "dist/index.mjs (pre-built bundle) if present AND not explicitly disabled — DEFAULT since v0.9.17" |
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
| Golden snapshot test | `test/unit/keybinding-map.parity.test.ts` — 7 `it()` blocks asserting parity against a generated golden snapshot; BINDINGS table has 27 entries (`src/ui/keybinding-map.ts:132-180`) |
| Live probe test | `test/unit/pi-tui-dispatch-probe.test.ts` — direct probe of dispatch (3 tests) |
| Probe commit | `84944f7 test(probe): add invalidate() to control object so typecheck passes` |
| Tab/Space bind | `src/ui/run-dashboard.ts` + commit `15a0ffe fix(ui): also bind Tab/Space/Enter/S to select in dashboard dispatch` |
| Tmux session file | `/tmp/sock` (created on first `new-session -S`) |

---

## Tier 6 — Live TUI probe via Python pty (bulk keys + diag)

**What**: send many keys in sequence + capture per-keystroke diag output.

**When to use**: when you need to probe dispatch across multiple keypresses, or want to verify each key reached the component's `handleInput`.

**How**:

```python
#!/usr/bin/env python3
"""pty_probe.py — bulk-key + diag probe for pi-crew TUI components."""
import os, sys, time

CMD = ['pi']
ENV = {**os.environ, 'PI_CREW_BROKER_DIAG_UI': '1'}

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

**`PI_CREW_BROKER_DIAG_UI=1`** makes `run-dashboard`'s `handleInput` write a `[PI-CREW-DIAG]` line to stderr for every keystroke. (The diag is currently wired only in `run-dashboard`, not in `settings-overlay` or other overlays — if you need diag in another overlay, port the `process.env.PI_CREW_BROKER_DIAG_UI === "1"` check from `src/ui/run-dashboard.ts:831`.) Pair with `2>&1 | tee /tmp/diag.log`.

**References**:

| What | Where |
|---|---|
| Diag env var | `PI_CREW_BROKER_DIAG_UI=1` — checked at `src/ui/run-dashboard.ts:831` |
| Reduced-noise commit | `00e8ba0 chore(broker): strip diagnostic noise from focused-field fix` — diag calls left in but no longer noisy |
| Original probe | `84944f7 test(probe): add invalidate() to control object so typecheck passes` |

---

## Tier 7 — Smoke team run (verifier prompt doesn't hang)

**What**: prove the verifier worker completes within `RESPONSE_TIMEOUT_MS` (300s).

**Why this is its own tier**: `test:critical` covers unit-level invariants, but the verifier LLM is a separate failure mode — it reads the verifier prompt from `src/runtime/plan-templates.ts:143, 190` (taskTemplate strings) or from `workflows/*.workflow.md:24, 30, 31` (workflow verifier sections), then decides which bash command to run. If the prompt says "Run tests" without specifying which, the LLM runs `npm test` and the worker hangs at 300s with exit 143.

**How** (from parent Pi session — `team` is a tool, not a shell command):

```yaml
# illustrative — the actual tool takes positional + named params:
#   team action='run' team='fast-fix' workflow='fast-fix' goal='...' async=false
team:
  action: run              # run | status | events | cancel | retry | ...
  team: fast-fix           # team (a role-set): default / fast-fix / implementation / parallel-research / research / review
  workflow: fast-fix       # workflow (a phase DAG): default / fast-fix / plan-execute / implementation / review / research / parallel-research / pipeline / chain
  goal: "Smoke-verify <X>. Run `npm run test:critical && npx tsc --noEmit` once, cache output, report exact pass/fail counts + total time. Confirm verifier completes without hang (must be <300s)."
  async: false             # synchronous: wait for completion before returning
```

The `team` tool is described in the agent's system prompt. Use `team action='status' <runId>` to inspect mid-run, `team action='events' <runId> <limit>` for the event log, `team action='cancel' <runId>` to abort.

**Real measured outcomes from this session**:

| Run ID | Goal | Result | Wall-clock |
|---|---|---|---|
| `team_20260722083504_cae04a2804a24d79` | smoke full-implementation | 3/4 phases, 04_verify hung on `npm test` | 572s |
| `team_20260722095143_2e58fce2ce91af19` | first smoke-fix smoke | 3/3 PASS, verifier used fast path but ran multiple LLM turns (think→bash→observe→respond) totaling ~907s cumulative | 907s |
| `team_20260722100811_9bf95bebff2b052a` | re-smoke after workflow prompt fix | 3/3 PASS, verifier used `test:critical` cache | 449s |

**References**:

| What | Where |
|---|---|
| `verificationCommand` for plan-templates | `src/runtime/plan-templates.ts:146, 193` — both templates now `npm run test:critical && npx tsc --noEmit` |
| `taskTemplate` for verifier | `src/runtime/plan-templates.ts:143, 190` — explicit "Do NOT run `npm test`" + "<2 min" budget |
| Workflow verifier prompts | `workflows/fast-fix.workflow.md:24`, `workflows/default.workflow.md:31`, `workflows/plan-execute.workflow.md:30`, `workflows/review.workflow.md:31` |
| Verifier fix commit (plan-templates) | `1cb2dca fix(verifier): use test:critical instead of test:unit to avoid worker timeout` |
| Verifier fix commit (workflows) | `d599578 fix(workflows): specify fast test:critical command in verifier prompts` |
| Watchdog constant | `src/runtime/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = DEFAULT_CHILD_PI.responseTimeoutMs` |
| Cache directive | `Run FAST checks ONCE (cache output to .crew/cache/)` — anti-re-run safeguard baked into all 4 workflow verifier prompts |
| Decision doc | `docs/decisions/2026-07-22-broker-phase4-gated-on.md` §Verification (mentions the smoke run `team_20260722100811_9bf95bebff2b052a`) |

**Two known failure modes for verifier**:

1. **Verifier LLM runs `npm test`** (full unit + integration suite, >4 min) instead of `npm run test:critical`. Symptom: worker killed with exit 143 after exactly 300s. Fix: rewrite the verifier prompt to specify the exact fast command AND include "Do NOT run `npm test` or `npm run test:unit`".
2. **Verifier LLM improvises** with a clean-cache `npm test` run anyway. The cache directive ("cache to `.crew/cache/`", "do NOT re-run") catches this — the second worker that observes a cached log should not re-run.

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
# (the consuming project loads pi-crew via this symlink — see index.ts:5-22)
```

If the two md5s match → session is on the latest code. If not → user must `/quit` + reopen Pi.

**References**:

| What | Where |
|---|---|
| Symlink path | `index.ts:5-22` — **the symlink lives in the CONSUMING project** (parent dir or global prefix), not inside pi-crew itself. From the repo: `readlink ../node_modules/pi-crew` (dev) or `readlink "$(npm root -g)"/pi-crew` (global). Verify with `readlink` + `npm root -g`. |
| Session load model | Same file: "dist/index.mjs (pre-built bundle) if present — DEFAULT since v0.9.17" |

---

## Anti-patterns (the cost is real, observed in this session)

| Anti-pattern | Cost | Where fixed | Reference |
|---|---|---|---|
| `npm test` in verifier prompt | 300s worker timeout, run = "hang" | `1cb2dca` | `src/runtime/plan-templates.ts:143, 190` + 4 workflow files |
| `npm run test:unit` for in-loop verify | >4 min, same hang | `1cb2dca` | `package.json:67` (`test:critical` script) |
| Default-off assumption in tests | Break when default flips | `612e18b` | `test/unit/crew-broker-feature-flag.test.ts:31` (`DEFAULT_BROKER.enabled === true`) |
| Test using real `loadConfig()` to mock config | Flaky when env / disk config changes | `612e18b` | `test/unit/crew-broker-server-gate.test.ts:78` (use `brokerEnv: "0"` instead of `flagOn: false`) |
| Source edit seen immediately | No, requires bundle rebuild + reload | n/a (permanent) | `index.ts:5-22` — bundle resolution rules |
| Skip disabled-path proof | `effectiveEnabled()` regression slips through | n/a (permanent) | Tier 2 above |
| `npm run test:unit` against 642 files | >4 min; mis-judges verifier runtime | n/a (permanent) | Tier 1 above |
| Skip typecheck | TS errors slip past `test:critical` (which uses `--test-timeout=30000`) | n/a (permanent) | Tier 3 above |
| Run `pi` from a stale bundle | Session shows old behavior despite src/ edits | n/a (permanent) | `scripts/check-bundle-staleness.mjs` — CI gate |
| Test by reading code | Proves nothing about runtime | n/a (permanent) | All tiers above |
| `makeFakeCtx({ flagOn: false })` without `brokerEnv: "0"` | `makeFakeCtx` deletes `PI_CREW_BROKER` env if `brokerEnv` is undefined | `612e18b` (test fix) | `test/unit/crew-broker-server-gate.test.ts:78` — pass `brokerEnv: "0"` to preserve env |
| Trust green CI on one OS | macOS/Windows regressions slip through | n/a (permanent) | `.crew/knowledge.md` — "CI runs 3 OSes ... A flake on one OS IS a real bug" |

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
| Smoke team: worker times out at 300s | Either verifier command slow OR LLM thinking cap | Check `RESPONSE_TIMEOUT_MS` (300s); bump only if you verified the command itself finishes <300s |
| `stale-ctx` error in worker output | Extension ctx is stale after session replacement | This is runtime noise, not a regression; ignore. (Source: `.crew/knowledge.md` "Process Safety" notes) |
| Bundle md5 not changing after rebuild | Stale `dist/` cache or esbuild no-op | `rm -rf dist/ && npm run build:bundle`; verify new md5 |

## Performance budget (per-tier soft limits)

| Tier | Soft limit | Hard limit | What happens over hard limit |
|---|---|---|---|
| 1 (`test:critical`) | 25s | 60s | Worker likely hung — cancel + bisect by file |
| 2 (3-path proof, total) | 75s | 180s | Same as above |
| 3 (`typecheck` + `build:bundle`) | 25s | 60s | `typecheck` regression — check imports |
| 4 (md5 sync check) | <1s | 5s | Disk/symlink issue |
| 5 (tmux spawn) | 5s | 15s | tmux server issue |
| 6 (pty probe) | 5s | 15s | `pi` not in PATH |
| 7 (smoke team) | 60s (verifier only) | 300s (worker hard limit) | Worker killed by `RESPONSE_TIMEOUT_MS` |
| 8 (final md5 sync) | <1s | 5s | Disk/symlink issue |

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
7. commit + push
8. verify-before-complete        ← make the "done" claim with evidence
```

---

## Maintenance

The skill mentions specific commits, line numbers, and version pins. As the code evolves, these will drift. Maintenance playbook:

| What | When | How |
|---|---|---|
| Verify line refs after each `src/` commit | Every commit touching the cited file | `git log -p -- src/extension/registration/lifecycle-handlers.ts \| grep effectiveEnabled` — if line moved, update the skill |
| Verify commit hashes still exist | Quarterly or before major edits | `git log --oneline -1 <hash>` — if gone, find the equivalent newer commit |
| Verify version pins (v0.9.46, etc.) | Each release | `git log --oneline -- src/ui/run-dashboard.ts \| head -5` — find when diag was wired |
| Verify `test:critical` still has 14 files | Each `src/runtime/crew-broker*.ts` edit | `cat package.json \| grep test:critical` — adjust the file list |
| Verify Tier 7 verifier prompts still say `test:critical` | Each workflow file edit | `grep "Run FAST checks" workflows/*.workflow.md` |

The skill does NOT need to be updated for every commit — only when the cited lines/files move. Consider it a "living reference" not a "live spec".

---

## Quick reference — exact commands

```bash
# Tier 1 (critical unit, ~21s, 97 tests)
npm run test:critical
# Tier 2 (3-path proof, broker changes only)
PI_CREW_BROKER=0 npm run test:critical
PI_CREW_BROKER=1 npm run test:critical
# Tier 3 (compile + bundle)
npm run typecheck
npm run build:bundle
md5sum dist/index.mjs
# Tier 4 (sync check)
# ask user: md5sum /path/to/loaded/bundle
# Tier 5 (tmux probe)
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  "cd ${PWD} && PI_CREW_BROKER_DIAG_UI=1 exec pi 2>&1"
tmux send-keys -t pi '<key>' ; sleep 0.5
tmux capture-pane -t pi -p
# Tier 6 (pty probe)
python3 scripts/pty_probe.py 2>&1 | tee /tmp/diag.log
# Tier 7 (smoke team)
# from parent Pi session only — uses the `team` tool, not shell
# Tier 8 (final md5 sync)
md5sum dist/index.mjs && md5sum /loaded/bundle/path
```

---

## Done-criteria checklist

Before claiming "tested":

- [ ] Tier 1: `test:critical` fresh-run, 97/97 pass, ~21s
- [ ] Tier 2: 3-path proof all pass — **required if you touched `src/config/defaults.ts` or `src/extension/registration/lifecycle-handlers.ts`**
- [ ] Tier 3: `npm run typecheck` exit 0, `npm run build:bundle` exit 0
- [ ] Tier 4: bundle md5 matches what the session loaded (or user has `/quit`-ed + reopened)
- [ ] Tier 5/6: live TUI smoke for any `src/ui/` change — keystroke reached `handleInput`
- [ ] Tier 7: smoke team run for any `src/runtime/plan-templates.ts` or `workflows/*.workflow.md` change — completed, no hang, verifier output under 60s
- [ ] Tier 8: final md5 sync check passed

If any required item is unchecked, the answer to "is it tested?" is **no**.

---

## File-anchored references (full index)

Decision docs:
- `docs/decisions/2026-07-21-broker-phase4-default-on.md` — interim default-off (SUPERSEDED)
- `docs/decisions/2026-07-22-broker-phase4-gated-on.md` — default-on flip + risk + monitoring + rollback
- `docs/decisions/2026-07-21-broker-windows-perms.md` — Windows named-pipe perms + Phase-4 update note

Source files (critical paths):
- `src/config/defaults.ts:155-187` — `DEFAULT_BROKER` + `resolveBrokerEnvOverride`
- `src/extension/registration/lifecycle-handlers.ts:819-833` — `effectiveEnabled()` (precedence)
- `src/runtime/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = 300_000`
- `src/runtime/plan-templates.ts:143, 146, 190, 193` — verifier `taskTemplate` + `verificationCommand`
- `src/runtime/crew-broker.ts` — broker server (per-connection gate, NDJSON framing)
- `src/runtime/crew-broker-client.ts` — client (`isEventFrame()` distinguishes event vs response frames)
- `src/runtime/crew-broker-tokens.ts` — `BrokerTokenRegistry` with `timingSafeEqual`
- `src/runtime/broker-issuer.ts` — per-run broker issuer (env injection at spawn)
- `src/runtime/crew-broker-child.ts` — child-side broker client wiring
- `src/ui/key-utils.ts:37-42` — `keyOf()` using pi-tui `matchesKey()`
- `src/ui/keybinding-map.ts` — dispatch using `matchesKey()` (commit `f05a10d`)

Test files (the 14 in `test:critical`):
- `test/unit/crew-broker-{handshake,stale-socket,feature-flag,server-gate,client-fallback,mailbox-observer,close-during-reconnect,steer-dedup,symlink-steering}.test.ts`
- `test/unit/keybinding-map.parity.test.ts`
- `test/unit/pi-tui-dispatch-probe.test.ts`
- `test/unit/session-utils-extract.test.ts`
- `test/unit/config-schema-sync.test.ts`
- `test/unit/child-pi-env-spread.test.ts`

Integration tests (Tier 1 covers none — these are for full E2E):
- `test/integration/crew-broker-msg.test.ts` — 5 tests (Phases 1)
- `test/integration/crew-broker-phase2-3.test.ts` — events.subscribe + task.waitStatus + steer.push + escalate

Workflow files:
- `workflows/fast-fix.workflow.md:24` — verifier prompt (commit `d599578`)
- `workflows/default.workflow.md:31` — verifier prompt
- `workflows/plan-execute.workflow.md:30` — verifier prompt
- `workflows/review.workflow.md:31` — verifier prompt

Commits (chronological, the patterns they introduced):
- `1cb2dca` — `test:critical` script + plan-templates verifier fix
- `d599578` — 4 workflow verifier prompt fixes
- `612e18b` — Phase 4 default-on flip (code + decision doc)
- `4186284` — mark default-off doc SUPERSEDED + index update

Real team runs (Tier 7 outcomes):
- `team_20260722083504_cae04a2804a24d79` — full-implementation, 3/4 phases done, 04_verify hung (root cause investigation)
- `team_20260722095143_2e58fce2ce91af19` — first fast-fix smoke, 3/3 PASS (after `test:critical` introduced)
- `team_20260722100811_9bf95bebff2b052a` — final fast-fix smoke, 3/3 PASS, verifier used cached output (449s wall-clock)
