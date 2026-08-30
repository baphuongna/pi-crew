---
name: real-test-pi-crew
description: "End-to-end verification for pi-crew changes: fast critical tests, 3-path kill-switch proof, bundle md5 sync, live TUI probing, smoke team runs, a live feature-action battery (team tool + subagent tools), and a surface-mode battery (workers in real tmux/herdr panes, degrade-to-headless)."
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
  - "tier 1 / tier 2 / tier 3 / tier 4 / tier 5 / tier 6 / tier 7 / tier 8 / tier 9 / tier 10"
---

# real-test-pi-crew

End-to-end verification discipline for pi-crew changes. Distilled from the broker Phase-4 rollout (commits `1cb2dca` → `d599578` → `612e18b` → `4186284`, July 2026). The pain this skill prevents: shipping code that compiles + unit-tests-green but breaks in the user's live Pi session, or hangs the verifier worker.

**When to use**: after any change to `src/runtime/broker/*.ts` (broker + tokens + issuer), `src/ui/`, `src/config/`, `src/extension/registration/lifecycle-handlers.ts`, `src/runtime/child-pi/*.ts` (worker spawn/kill/steering), `src/runtime/surface/*.ts` (MuxSurface providers, degrade, launch script), `src/prompt/*.ts` (worker-side tools: ask / message / delegate / surface-worker recorder), `src/runtime/goal-workflow/plan-templates.ts`, `src/runtime/team-runner.ts` or `src/runtime/task-runner/**` (scheduler / execution — Tier 7 smoke), `src/state/**` (durable state — Tier 7 + 9a events/status), `src/runtime/live-session/**` + `src/runtime/custom-tools/*` (live-session mode + worker custom tools), `src/schema/team-tool-schema.ts` (or any `Type.Unsafe({...})` schema definition), `src/extension/registration/team-tool.ts`, `workflows/*.workflow.md`, or before any commit touching these paths. Schema changes additionally require Tier 9 (feature battery) because the team tool's TypeBox schema is validated by pi-ai BEFORE the handler runs — a too-strict or malformed schema breaks every action silently. Surface changes additionally require Tier 10 (surface-mode battery) because surface is fail-closed: every failure degrades to headless and the run still goes green — only pane-level evidence proves the panes engaged.

> **Path map (2026-08-26 reorg + A1)**: `src/runtime/crew-broker*.ts` → `src/runtime/broker/`; `src/runtime/child-pi*.ts` → `src/runtime/child-pi/`; `src/runtime/plan-templates.ts` (flat) → `src/runtime/goal-workflow/plan-templates.ts`; NEW dirs `src/runtime/surface/` and `src/prompt/`. Test files moved with them (`test/unit/crew-broker-*.test.ts` → `test/unit/runtime/broker/`, `test/unit/keybinding-map.parity.test.ts` → `test/unit/ui/`, ...).

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

**Workflow files are runtime data** — `workflows/*.workflow.md` and task prompt strings inside `src/runtime/goal-workflow/plan-templates.ts` are loaded per-call, NOT bundled. Edits take effect immediately, no rebuild needed.

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

## Tier 1 — Critical unit tests (~21s, 102 tests, the only suite you need for broker/UI changes)

**What**: run the curated 14-file fast subset.

**Why this exists**: full `npm run test:unit` runs 810 files (was 642 at skill-writing time — it keeps growing), several minutes. Verifier worker response timeout would kill the worker mid-run → run = "hang". The fix (introduced in commit `1cb2dca`) splits out a `test:critical` subset covering exactly what changed in the broker/UI work.

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
| Bundle md5 anchors | `1cc4d55e18add7b9a036c569143320b6` (Phase-4 flip, ~2.78 MB) → `16e29d053bd370e24f40df147dadcb79` (v0.9.66, 2026-08-11) → `9b557ac106b82e1ee33d39dd0d6c7dd7` (post-MuxSurface-A1 main, 2026-08-27). **Always check current**: `md5sum dist/index.mjs` |

---

## Tier 4 — Bundle sync into a live Pi session

**What**: ensure the user's running Pi sees your changes.

**The immediate-vs-rebuild rule** (which edits take effect without a rebuild):
- `workflows/*.workflow.md` edits → **immediate**, no rebuild, no restart
- `src/runtime/goal-workflow/plan-templates.ts` `taskTemplate` strings → **immediate**, runtime data
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

**Why this is its own tier**: `test:critical` covers unit-level invariants, but the verifier LLM is a separate failure mode — it reads the verifier prompt from `src/runtime/goal-workflow/plan-templates.ts:144, 147` (taskTemplate strings) or from `workflows/*.workflow.md` (workflow verifier sections), then decides which bash command to run. If the prompt says "Run tests" without specifying which, the LLM runs `npm test` (810+ files) and the worker gets killed by the response timeout with exit 143.

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

## Anti-patterns (the cost is real, observed in this session)

| Anti-pattern | Cost | Where fixed | Reference |
|---|---|---|---|
| `npm test` in verifier prompt | worker killed at the response timeout (300s then, 600s now), run = "hang" | `1cb2dca` | verifier `taskTemplate`/`verificationCommand` in `src/runtime/goal-workflow/plan-templates.ts` (now `:144, 147, 151`) + workflow files |
| `npm run test:unit` for in-loop verify | >4 min, same hang | `1cb2dca` | `package.json:85` (`test:critical` script) |
| Default-off assumption in tests | Break when default flips | `612e18b` | `test/unit/runtime/broker/crew-broker-feature-flag.test.ts:31` (`DEFAULT_BROKER.enabled === true`) |
| Test using real `loadConfig()` to mock config | Flaky when env / disk config changes | `612e18b` | `test/unit/runtime/broker/crew-broker-server-gate.test.ts:78` (use `brokerEnv: "0"` instead of `flagOn: false`) |
| Source edit seen immediately | No, requires bundle rebuild + reload | n/a (permanent) | `index.ts:1-25` — bundle resolution rules |
| Skip disabled-path proof | `effectiveEnabled()` regression slips through | n/a (permanent) | Tier 2 above |
| `npm run test:unit` against the full suite (810 files now, 642 then) | several minutes; mis-judges verifier runtime | n/a (permanent) | Tier 1 above |
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
- [ ] **Output report**: save `docs/real-test/reports/real-test-<YYYY-MM-DD>-<slug>.md` from `skills/real-test-pi-crew/REPORT-TEMPLATE.md`, filled DURING the run with per-tier evidence (counts/md5/runId) — not reconstructed from memory afterward. This is what makes past runs verifiable instead of trust-the-summary.
- [ ] Tier 10: surface battery — **required if you touched `src/runtime/surface/**`, `src/prompt/surface-worker.ts`, the surface branch of `src/runtime/child-pi/child-pi.ts`, or the surface config keys**. 10a E2E 3/3 per backend available (tmux trong tmux; herdr ngoài tmux + socket sống — skip vì thiếu mux là correct-by-design nhưng KHÔNG tính pass cho backend đó); 10b live run với session ĐÃ reload bundle mới (xem Anti-patterns "file-md5 only") + `visibleAgents` set + pane-level evidence (pane id/title during run, `worker.surface_spawned`/`worker.surface_closed` events, pane auto-closed after — KHÔNG dùng `manifest.surface.panes` làm evidence engage, xem Anti-patterns "panes == {}"); 10c herdr live chỉ khi pi chạy trong herdr pane (skip kèm lý do nếu không).

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
- `src/runtime/child-pi/child-pi-constants.ts:23` — `RESPONSE_TIMEOUT_MS = 300_000`
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
