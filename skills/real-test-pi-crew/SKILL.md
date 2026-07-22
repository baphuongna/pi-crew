---
name: real-test-pi-crew
description: "Real Pi/pi-crew verification — fast unit tests + bundle md5 + tmux/pty TUI probing + smoke team runs. Use after any change to broker/, ui/, keybindings, config, or verifier to prove the change works in live Pi, not just disk."
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
---

# real-test-pi-crew

End-to-end verification discipline for pi-crew changes. Distilled from a long debugging session that ended in a clean Phase-4-default-on release. The pain this skill prevents: shipping code that compiles + unit-tests-green but breaks in the user's live Pi session, or hangs the verifier worker.

## Core principle: disk ≠ live Pi

pi-crew edits land in two places:

1. **Source** (`src/`, `test/`, `package.json`, `workflows/`, `plan-templates/`) — git-tracked, `git diff` shows it.
2. **Bundle** (`dist/index.mjs`) — pre-built, loaded by Pi at extension cold-start.

Workflow files are runtime data → no rebuild needed. Everything else does. The most common silent-failure mode is:

> "I edited `src/`, ran tests (pass!), rebuilt bundle (good md5!), but my session still has the old code because I didn't `/quit` + reopen."

Always end-to-end verify in a real Pi session, not just on disk.

## Tier 1 — Critical unit tests (~21s, the only tests you need for broker/UI changes)

pi-crew has 642 unit-test files. The full suite takes >4 minutes and breaks the verifier worker (300s timeout). The bundled `test:critical` script is the curated fast path:

```bash
time npm run test:critical
# expected: 97/97 pass, ~21s, exit 0
# contains: 14 broker tests + keybinding-map.parity + pi-tui-dispatch-probe
#           + session-utils-extract + config-schema-sync + child-pi-env-spread
```

If `test:critical` doesn't exist yet, create it in `package.json` (only ~14 files; list them in the script so the suite is reproducible). See `test:critical` definition in `package.json` for the canonical list — broker + UI files only.

**Run `test:critical` after any edit to `src/runtime/crew-broker*.ts`, `src/ui/`, `src/config/`, `src/extension/registration/lifecycle-handlers.ts`, or `src/runtime/child-pi-spawn.ts`.**

## Tier 2 — Three-path proof (broker feature flag)

After any change to `src/config/defaults.ts` (which holds `DEFAULT_BROKER`) or `src/extension/registration/lifecycle-handlers.ts` (which holds `effectiveEnabled()`), prove all three kill-switch paths still work:

```bash
# 1. default (whatever DEFAULT_BROKER.enabled currently is)
npm run test:critical
# 2. env kill switch
PI_CREW_BROKER=0 npm run test:critical
# 3. env explicit-on (redundant under default-on, still must work)
PI_CREW_BROKER=1 npm run test:critical
```

All three must show `# pass 97 # fail 0`. Any difference indicates a bug in the precedence chain (`PI_CREW_BROKER` env > config > DEFAULT).

The `test:unit/crew-broker-feature-flag.test.ts` file has the env-precedence tests; `test/unit/crew-broker-server-gate.test.ts` has the controller-gate tests. Read both before touching either source file.

## Tier 3 — Typecheck + bundle

```bash
npm run typecheck   # ~20s, must exit 0 ("strip-types import ok")
npm run build:bundle  # <1s, prints "[build-bundle] dist/index.mjs NNNN KB"
md5sum dist/index.mjs
```

Cross-check `md5sum dist/index.mjs` against the loaded bundle in your session (the user runs `pi` and Pi loads `dist/index.mjs` at startup; the bundle your session is running is whatever was on disk at extension cold-start).

## Tier 4 — Bundle sync into a live Pi session

Source edits are NOT immediately visible to a running Pi session. The bundled `dist/index.mjs` is loaded at extension cold-start only.

Workflow files (`workflows/*.workflow.md`, `plan-templates.ts` task prompt strings) are an exception — runtime data, loaded per call. Editing them takes effect immediately, no rebuild needed.

To pick up source changes in your current session:

1. `npm run build:bundle` (regenerate `dist/index.mjs`)
2. The user must `/quit` + reopen Pi (extension cold-start re-loads bundle). Confirm by running `md5sum` in Pi and on disk — they must match.

To verify in a fresh pty/tmux session without disturbing the user's main Pi:

```bash
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi 'cd /path/to/pi-crew && exec pi 2>&1'
```

`tmux` is the cheap option. For bulk key + diag logging use the Python `pty` pattern below.

## Tier 5 — Live TUI probe (tmux send-keys)

After any change to `src/ui/`, verify dispatch in a real Pi session:

```bash
# Spawn
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  'cd /home/bom/source/my_pi/pi-crew && PI_CREW_BROKER_DIAG_UI=1 exec pi 2>&1'

# Capture screen
tmux capture-pane -t pi -p > /tmp/screen.txt

# Send commands
tmux send-keys -t pi '/team-help' Enter
sleep 1
tmux send-keys -t pi ':commands' Enter   # or whatever opens the overlay
```

**Key gotcha**: terminals send both `\x1b[A` (legacy CSI) and `\x1bOA` (app-cursor-mode) and Kitty-protocol variants for arrow keys. The robust pattern in pi-crew uses pi-tui's `matchesKey()` (see `src/ui/key-utils.ts`). The golden snapshot test at `test/unit/keybinding-map.parity.test.ts` covers all three encodings.

## Tier 6 — Live TUI probe (Python pty for bulk keys + diag)

When you need to send many keys in sequence + capture per-key diag output:

```python
#!/usr/bin/env python3
import os, pty, sys, time

CMD = ['pi']
ENV = {**os.environ, 'PI_CREW_BROKER_DIAG_UI': '1'}

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(CMD[0], CMD, ENV)
else:
    time.sleep(2)  # initial pi startup
    for key in ['j', 'j', 'k', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', 'q', 'q']:
        os.write(fd, key.encode())
        time.sleep(0.3)
    time.sleep(1)
    print(os.read(fd, 65536).decode(errors='replace'))
```

`PI_CREW_BROKER_DIAG_UI=1` causes the component's `handleInput` to write a `[PI-CREW-DIAG] component.handleInput data=…` line to stderr for every keystroke. Pair with `2>&1 | tee /tmp/diag.log` to capture the trace.

## Tier 7 — Smoke team run

After any change to plan templates, verifier prompts, or workflow files, prove the verifier doesn't hang:

```yaml
# in your parent Pi session:
team:
  action: run
  team: fast-fix
  workflow: fast-fix
  goal: "Smoke-verify <X>. Run `npm run test:critical && npx tsc --noEmit` once, cache, report exact pass/fail counts + total time. Confirm the verifier completes without hang (must be <300s)."
  async: false
```

The verifier worker LLM may ignore "fast" hints unless the prompt is *very* explicit. Two known failure modes:

1. **Verifier LLM runs `npm test`** (full unit + integration suite, >4 min) instead of `npm run test:critical`. Symptom: worker killed with exit 143 after exactly 300s. Fix: rewrite the verifier prompt to specify the exact fast command and include "Do NOT run `npm test` or `npm run test:unit`".
2. **Verifier LLM improvises** with a clean-cache `npm test` run anyway. The cache directive ("cache to `.crew/cache/`", "do NOT re-run") catches this — the second worker that observes a cached log should not re-run.

The fix is in 4 places: `src/runtime/plan-templates.ts` (`verificationCommand` + `taskTemplate`), `workflows/{fast-fix,default,plan-execute,review}.workflow.md` (verifier prompt strings).

## Anti-patterns observed in this session

| Anti-pattern | Cost | Fix |
|---|---|---|
| Default `npm test` for verifier | worker timeout 300s, run = "hang" | replace with `npm run test:critical && npx tsc --noEmit` (~50s) |
| Edit `src/` and assume session sees it | silent unchanged behavior in live Pi | rebuild bundle + verify md5 matches |
| Test by reading code | proves nothing about runtime | always end-to-end via Tier 1/3/5/7 |
| `npm test` (~5min) for in-loop verification | timeout | use `test:critical` (~21s) |
| `npm run test:unit` (642 files, >4min) for in-loop verification | timeout | use `test:critical` (14 files, ~21s) |
| Skip disabled-path proof | regression in `effectiveEnabled()` slips through | run all three (Tier 2) |
| Miss that `test/unit/` grew to 642 files | mis-judge runtime of "run tests" | measure full-suite time first |

## Quick reference — commands

```bash
# Tier 1 (critical unit, ~21s)
npm run test:critical                                    # default path
PI_CREW_BROKER=0 npm run test:critical                  # disabled proof
PI_CREW_BROKER=1 npm run test:critical                  # explicit-on proof

# Tier 3 (compile + bundle)
npm run typecheck
npm run build:bundle
md5sum dist/index.mjs

# Tier 5 (tmux probe)
tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi \
  'cd /home/bom/source/my_pi/pi-crew && PI_CREW_BROKER_DIAG_UI=1 exec pi 2>&1'
tmux send-keys -t pi '<key>' ; sleep 0.5
tmux capture-pane -t pi -p

# Tier 7 (smoke team)
# from parent Pi session only — uses the `team` tool, not shell
```

## Done-criteria checklist

Before claiming "tested":

- [ ] `test:critical` fresh-run: 97/97 pass
- [ ] 3-path proof (Tier 2) all pass — if broker changes
- [ ] `npm run typecheck` exit 0
- [ ] `npm run build:bundle` exit 0
- [ ] bundle md5 matches what the session loaded (or user has `/quit`-ed + reopened)
- [ ] live TUI smoke (Tier 5/6) for any UI change — keystroke reached dispatch
- [ ] smoke team run (Tier 7) for any verifier/plan-template change — completed, no hang

If any item is unchecked, the answer to "is it tested?" is **no**.
