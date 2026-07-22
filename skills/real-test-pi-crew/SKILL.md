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
  - "tier 1 / tier 2 / tier 3 / tier 4 / tier 5 / tier 6 / tier 7"
---

# real-test-pi-crew

End-to-end verification discipline for pi-crew changes. Distilled from the broker Phase-4 rollout (commits `1cb2dca` → `d599578` → `612e18b` → `4186284`, July 2026). The pain this skill prevents: shipping code that compiles + unit-tests-green but breaks in the user's live Pi session, or hangs the verifier worker.

## Core principle: disk ≠ live Pi

Two locations hold pi-crew state:

1. **Source** (`src/`, `test/`, `package.json`, `workflows/`, `src/runtime/plan-templates.ts`) — git-tracked, `git diff` shows it.
2. **Bundle** (`dist/index.mjs`) — pre-built, loaded by Pi at **extension cold-start only**.

The 3-way resolution order for `dist/index.mjs` (per `.crew/knowledge.md`):
```
1. dist/index.mjs (pre-built bundle) if present  ← DEFAULT since v0.9.17
2. Inline strip-types loading — fallback when bundle missing
   OR PI_CREW_USE_BUNDLE=0
```

**Workflow files are runtime data** — `workflows/*.workflow.md` and task prompt strings inside `src/runtime/plan-templates.ts` are loaded per-call, NOT bundled. Edits take effect immediately, no rebuild needed.

**The most common silent-failure mode**: edit `src/`, run `npm test` (pass!), rebuild bundle (good md5!), but the session still has the old code because Pi wasn't `/quit`-ed + reopened.

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

**Why**: any change to `DEFAULT_BROKER` (in `src/config/defaults.ts:169`) or `effectiveEnabled()` (in `src/extension/registration/lifecycle-handlers.ts:819-832`) can silently break the precedence chain. The chain:

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

All three must show `# pass 97 # fail 0`. Measured times in this session: 21s, 22s, 25s respectively.

**References**:

| What | Where |
|---|---|
| `DEFAULT_BROKER` constant | `src/config/defaults.ts:169-173` (Phase 4: `enabled: true`) |
| Precedence function | `src/extension/registration/lifecycle-handlers.ts:819-832` (`return cfg?.enabled !== false;` at line 828) |
| `resolveBrokerEnvOverride` | `src/config/defaults.ts:177-187` |
| Env-precedence unit tests | `test/unit/crew-broker-feature-flag.test.ts:31` (default-on assertion), `:50-95` (env=1/env=0/unset cases) |
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
| Bundle resolution rule | `.crew/knowledge.md` — "Entry point resolution order" section; **symlink is live for source files but the bundled `dist/index.mjs` is loaded** |
| Postinstall hook | `scripts/postinstall.mjs:43` — best-effort bundle rebuild; falls back to strip-types if esbuild missing |
| Bundle md5 after Phase-4 commit | `1cc4d55e18add7b9a036c569143320b6` (2.78 MB, no size change vs default-off) |

---

## Tier 4 — Bundle sync into a live Pi session

**What**: ensure the user's running Pi sees your changes.

**The 2-second rule**:
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
  'cd /home/bom/source/my_pi/pi-crew && exec pi 2>&1'
```

**References**:

| What | Where |
|---|---|
| Bundle resolution | `.crew/knowledge.md` — "dist/index.mjs (pre-built bundle) if present — DEFAULT since v0.9.17" |
| Bundle size impact after Phase-4 flip | `docs/decisions/2026-07-22-broker-phase4-gated-on.md` §Verification: "2.78 MB before and after the flip; the broker code was already in the bundle; only the default boolean changed" |
| Symlink confirmation | `.crew/knowledge.md` — `/home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew → /home/bom/source/my_pi/pi-crew` |

---

## Tier 5 — Live TUI probe via tmux send-keys

**What**: drive a real Pi session's keystrokes from the shell, capture screen state.

**Why tmux and not raw pty**: tmux gives you a clean separation — session persists across your bash commands, capture-pane gives ASCII screenshot, send-keys with hex escapes covers `\x1b[A` (legacy CSI), `\x1bOA` (app-cursor-mode), and Kitty-protocol variants.

**How**:

```bash
# Spawn (160x50 fits ~standard TUI)
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  'cd /home/bom/source/my_pi/pi-crew && exec pi 2>&1'

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

**Key gotcha**: terminals send arrow keys as one of 3 byte sequences. Pi-crew's `matchesKey()` helper (`src/ui/key-utils.ts:14-29`) normalizes all of them — but verify it does in your probe:

| Mode | Up arrow | Down arrow | Source |
|---|---|---|---|
| Legacy CSI | `\x1b[A` | `\x1b[B` | vt100, xterm |
| App-cursor-mode | `\x1bOA` | `\x1bOB` | vim, less, full-screen apps |
| Kitty protocol | `\x1b[1;2A` (Shift+Up) etc. | — | modern terminals (kitty, foot, ghostty) |

**References**:

| What | Where |
|---|---|
| `keyOf()` helper | `src/ui/key-utils.ts:14-29` |
| Dispatch path | `src/ui/keybinding-map.ts` (migrated to `matchesKey()` in commit `f05a10d`) |
| Golden snapshot test | `test/unit/keybinding-map.parity.test.ts` — 282 entries covering raw bytes + named KeyId |
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

**`PI_CREW_BROKER_DIAG_UI=1`** makes the component's `handleInput` write a `[PI-CREW-DIAG] component.handleInput data=…` line to stderr for every keystroke. Pair with `2>&1 | tee /tmp/diag.log`.

**References**:

| What | Where |
|---|---|
| Diag env var | `PI_CREW_BROKER_DIAG_UI=1` — written in `src/ui/run-dashboard.ts:handleInput` (and other overlay components) |
| Removed in commit | `00e8ba0 chore(broker): strip diagnostic noise from focused-field fix` — diag calls left in but no longer noisy |

---

## Tier 7 — Smoke team run (verifier prompt doesn't hang)

**What**: prove the verifier worker completes within `RESPONSE_TIMEOUT_MS` (300s).

**Why this is its own tier**: `test:critical` covers unit-level invariants, but the verifier LLM is a separate failure mode — it reads the verifier prompt from `src/runtime/plan-templates.ts:143, 190` (taskTemplate strings) or from `workflows/*.workflow.md:24, 30, 31` (workflow verifier sections), then decides which bash command to run. If the prompt says "Run tests" without specifying which, the LLM runs `npm test` and the worker hangs at 300s with exit 143.

**How** (from parent Pi session — `team` is a tool, not a shell command):

```yaml
team:
  action: run
  team: fast-fix
  workflow: fast-fix
  goal: "Smoke-verify <X>. Run `npm run test:critical && npx tsc --noEmit` once, cache output, report exact pass/fail counts + total time. Confirm verifier completes without hang (must be <300s)."
  async: false
```

**Real measured outcomes from this session**:

| Run ID | Goal | Result | Wall-clock |
|---|---|---|---|
| `team_20260722083504_cae04a2804a24d79` | smoke full-implementation | 3/4 phases, 04_verify hung on `npm test` | 572s |
| `team_20260722095143_2e58fce2ce91af19` | first smoke-fix smoke | 3/3 PASS, but verifier's bash hit 600s watchdog | 907s |
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

## Tier 8 — Bundle-vs-session sync via grep (final integrity check)

**What**: one-shot check that the session's loaded code matches what's on disk.

**How**:

```bash
# Disk
md5sum dist/index.mjs

# Session (ask user to run in their pi shell tool)
md5sum /home/bom/source/my_pi/node_modules/pi-crew/dist/index.mjs
# (or wherever the bundle is loaded from — see .crew/knowledge.md for the symlink path)
```

If the two md5s match → session is on the latest code. If not → user must `/quit` + reopen Pi.

**References**:

| What | Where |
|---|---|
| Symlink path | `.crew/knowledge.md` — `/home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew → /home/bom/source/my_pi/pi-crew` |
| Session load model | Same file: "dist/index.mjs (pre-built bundle) if present — DEFAULT since v0.9.17" |

---

## Anti-patterns (the cost is real, observed in this session)

| Anti-pattern | Cost | Where fixed | Reference |
|---|---|---|---|
| `npm test` in verifier prompt | 300s worker timeout, run = "hang" | `1cb2dca` | `src/runtime/plan-templates.ts:143, 190` + 4 workflow files |
| `npm run test:unit` for in-loop verify | >4 min, same hang | `1cb2dca` | `package.json:67` (`test:critical` script) |
| Default-off assumption in tests | Break when default flips | `612e18b` | `test/unit/crew-broker-feature-flag.test.ts:31` (`DEFAULT_BROKER.enabled === true`) |
| Test using real `loadConfig()` to mock config | Flaky when env / disk config changes | `612e18b` | `test/unit/crew-broker-server-gate.test.ts:78` (use `brokerEnv: "0"` instead of `flagOn: false`) |
| Source edit seen immediately | No, requires bundle rebuild + reload | n/a (permanent) | `.crew/knowledge.md` — bundle resolution rules |
| Skip disabled-path proof | `effectiveEnabled()` regression slips through | n/a (permanent) | Tier 2 above |
| `npm run test:unit` against 642 files | >4 min; mis-judges verifier runtime | n/a (permanent) | Tier 1 above |

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
  'cd /home/bom/source/my_pi/pi-crew && PI_CREW_BROKER_DIAG_UI=1 exec pi 2>&1'
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
- `src/extension/registration/lifecycle-handlers.ts:819-832` — `effectiveEnabled()` (precedence)
- `src/runtime/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = 300_000`
- `src/runtime/plan-templates.ts:143, 146, 190, 193` — verifier `taskTemplate` + `verificationCommand`
- `src/runtime/crew-broker.ts` — broker server (per-connection gate, NDJSON framing)
- `src/runtime/crew-broker-client.ts` — client (`isEventFrame()` distinguishes event vs response frames)
- `src/runtime/crew-broker-deps.ts` — socket-path + NDJSON + types consolidated
- `src/runtime/crew-broker-tokens.ts` — `BrokerTokenRegistry` with `timingSafeEqual`
- `src/ui/key-utils.ts:14-29` — `keyOf()` using pi-tui `matchesKey()`
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
