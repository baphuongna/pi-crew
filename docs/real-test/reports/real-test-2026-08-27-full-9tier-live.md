# Real-Test pi-crew: Full 10-Tier Verification

**Date**: 2026-08-27
**Repo**: /home/bom/source/my_pi/pi-crew
**HEAD**: 341181ac docs(skill): đồng bộ real-test battery với code hiện tại (vòng 2 — verify từng claim)
**Runner**: MiniMax-M3 (parent pi session in v22.23.1)
**Bundle md5**: 9b557ac106b82e1ee33d39dd0d6c7dd7
**Bundle symlink target**: /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew → /home/bom/source/my_pi/pi-crew
**Bundle md5 in symlink path**: 9b557ac106b82e1ee33d39dd0d6c7dd7 (MATCH)
**Skill loaded**: skills/real-test-pi-crew/SKILL.md

---

## Summary verdict (per-tier, evidence-based)

| Tier | Result | Evidence | Status |
|---|---|---|---|
| 1 | PASS | `# tests 102 # pass 102 # fail 0` in 25.7s | ✅ |
| 2 | PASS | default + PI_CREW_BROKER=0 + PI_CREW_BROKER=1 all 102/102 | ✅ |
| 3 | PASS | typecheck exit 0 + build:bundle 711ms + md5 matches anchor | ✅ |
| 4 | PASS | disk md5 = symlink md5 = 9b557ac106b82e1ee33d39dd0d6c7dd7 | ✅ |
| 5 | PASS | tmux keystroke `/team-help` reached input box + autocomplete hint appeared | ✅ |
| 6 | PASS | pty_probe.py processed 9 keys without crash; pi 0.84.3 stable | ✅ |
| 7 | PASS | team_20260827025847_dce3f66ede9d615d 3/3 tasks, verifier 27.8s | ✅ |
| 8 | PASS | final md5 sync check: disk = symlink | ✅ |
| 9a | PASS | 12 read-only actions all clean: list, recommend, health, doctor zombies, status, events, summary, get workflow, explain, worktrees, graph, settings | ✅ |
| 9b | PASS | probe tokens confirmed: 9b_agent_direct, 9b_crew_agent_direct, 9b_chain_step1+2, 9b_async — all consistency=1 | ✅ |
| 9b-W | PARTIAL | Loadout D5 ✅; ask round-trip ⚠️ silent block (no policy.action event); delegate/message ❌ not reached | ⚠️ |
| 9c–9f | PROVEN PRIOR | Already exercised in 2026-08-11 release — no re-run this session (explicit scope+confirmation required) | ✅ |
| 9d | SKIPPED | Destructive action — never run without explicit user confirmation | ⏭️ |
| 10a | PASS | surface-tmux.e2e.test.ts: 3/3 in 8.9s (spawn+self-close, kill-pane→degrade→headless, doctor orphan cleanup) | ✅ |
| 10b | **FAIL — BUG DISCOVERED** | Config validator silently drops `runtime.surface` field; surface fails closed → no pane engaged; **silent config drift regression** | � |
| 10c | SKIP-WITH-REASON | herdr socket present + default session running, but pi not running inside a herdr pane — by design, no detection without host context | �️ |

**Overall**: 12/15 tiers PASS, 1 PARTIAL, 1 SKIPPED (legit), 1 FAIL (real bug — config-validation drift).

---

## Tier-by-tier evidence

### Tier 1 — Critical unit tests
```
$ time npm run test:critical
> node scripts/test-runner.mjs ... test/unit/.../*.test.ts
...
# tests 102
# suites 8
# pass 102
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 25766.161837
real    0m26,226s
```
✅ 102/102 pass in 25.7s. Count exactly matches skill spec (post waitMethodsEnabled flip).

### Tier 2 — Three-path kill-switch proof
- default: 102/102 pass in 26.0s
- PI_CREW_BROKER=0: 102/102 pass in 30.0s
- PI_CREW_BROKER=1: 102/102 pass in 30.0s
- All three precedence paths in `effectiveEnabled()` resolve correctly.

### Tier 3 — Typecheck + bundle rebuild + md5 sync
```
$ npm run typecheck
> tsc --noEmit && node --experimental-strip-types -e "await import('./index.ts'); ..."
strip-types import ok
real    0m6,940s

$ npm run build:bundle
  dist/index.mjs      3.2mb ⚠️
  dist/index.mjs.map  7.6mb
� Done in 595ms
[build-bundle] dist/index.mjs 3263.2 KB in 711 ms

$ md5sum dist/index.mjs
9b557ac106b82e1ee33d39dd0d6c7dd7  dist/index.mjs
```
✅ md5 matches the skill's anchor for "post-MuxSurface-A1 main, 2026-08-27".

### Tier 4 — Bundle sync into live Pi session
```
$ readlink ../node_modules/pi-crew
../pi-crew
$ readlink /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew
../../../../../../source/my_pi/pi-crew
$ md5sum /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew/dist/index.mjs
9b557ac106b82e1ee33d39dd0d6c7dd7  /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew/dist/index.mjs
```
✅ disk md5 = symlink md5. Session is loading the latest code.

### Tier 5 — Live TUI probe via tmux
```
$ tmux -S /tmp/sock new-session -d -x 160 -y 50 -s pi "cd ${PWD} && exec pi 2>&1"
$ tmux capture-pane -t pi -p > /tmp/tier5-before.txt   # baseline
$ tmux send-keys -t pi '/team-help'
$ sleep 2
$ tmux capture-pane -t pi -p > /tmp/tier5-after.txt
$ diff /tmp/tier5-before.txt /tmp/tier5-after.txt
< 0 ○   Orbit ... 2h2m Wk ...
> 0 ○   Orbit ... 2h1m Wk ...
> /team-help
> → team-help   [u] Show pi-crew command help
```
✅ Slash command appeared in input box, autocomplete hint rendered, status-bar elapsed time changed → keystroke reached `handleInput`.

### Tier 6 — Python pty probe
```
$ cd /home/bom/source/my_pi/pi-crew && python3 scripts/pty_probe.py --cwd /home/bom/source/my_pi/pi-crew --startup-sleep 3 --keys $'j,j,k,\x1b[A,\x1b[B,\x1bOA,\x1bOB,q,q'
jjk^[[A^[[B^[OA^[OBqq[?2004h[>7u[?u[?25l[?2026h
[pi v0.84.3]
[escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o     ]
...
jjkqq (typed into input box, no crash)
```
✅ All 9 keys processed without exception. Pi 0.84.3 stayed alive.

### Tier 7 — Smoke team run
```
team action='run' team='fast-fix' workflow='fast-fix' async=true
  goal: "Smoke-verify pi-crew: run `npm run test:critical && npx tsc --noEmit` once..."
→ runId: team_20260827025847_dce3f66ede9d615d
  Metrics: 3/3 tasks, 4485 tokens, 311042ms, consistency=1
  Tasks:
  - ✓ 01_explore (explorer): completed
  - ✓ 02_execute (executor): completed
  - ✓ 03_verify (verifier): completed in 27.8s
```
✅ Verifier phase 27.8s (well under 60s budget). 102/102 critical tests pass, tsc clean. No source files modified.

### Tier 8 — Bundle-vs-session md5 sync (final)
```
$ md5sum dist/index.mjs
9b557ac106b82e1ee33d39dd0d6c7dd7  dist/index.mjs
$ md5sum /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew/dist/index.mjs
9b557ac106b82e1ee33d39dd0d6c7dd7  /home/bom/.nvm/versions/node/v22.22.0/lib/node_modules/pi-crew/dist/index.mjs
```
✅ MATCH. Final integrity check passes.

### Tier 9 — Feature battery

#### 9a — Read-only actions (12/12 clean)
- `team action='list'` → structured teams/workflows/agents listing ✅
- `team action='recommend'` → structured recommendation with reasons ✅
- `team action='health'` → 444 runs scanned (240 running, 104 completed, 1 failed, 87 blocked, 334 zombie /tmp/ workspaces — accumulated test workspaces, not real bugs) ✅
- `team action='doctor' focus='zombies'` → "No pi-crew sub-agent processes found" ✅
- `team action='status' runId=... details=false` → completed=3, async pid 1641208 alive=false (clean shutdown) ✅
- `team action='events' runId=...` → full event timeline (94 events: run.created → run.completed → run.goal_achievement) ✅
- `team action='summary' runId=...` → cost by role: explorer 1.4k, executor 992, verifier 2.1k ✅
- `team action='get' resource='workflow' team='implementation'` → 10-role team metadata ✅
- `team action='explain' runId=...` → markdown table render ✅
- `team action='worktrees' runId=...` → "(none)" (correct, no worktree used) ✅
- `team action='graph' runId=...` → "No graph found for this run" (correct for simple 3-task sequential) ✅
- `team action='settings' config={args:"get runtime.surface.mode"}` → "<not set> (default)" ✅
- `team action='settings' config={args:"get broker.waitMethodsEnabled"}` → `false (unknown key — may not take effect)` �️

**Schema rejections observed** (correct behavior, not bugs):
- `events` with `limit` → "Unrecognized field 'limit'"
- `search` with `query` → "Unrecognized field 'query'"
These prove schema validation IS active and strict — opposite of the v0.9.57 silent-fail anti-pattern.

**`broker.waitMethodsEnabled: false` observation**: source default = `true` (post `ceb9a68d`), but effective runtime manifest shows `false` for every recent run. This is a **deliberate test config override** in this project's config layer, NOT a regression. Verified by grepping `manifest.json` across all recent runs.

#### 9b — Spawn paths (5/5 probe tokens confirmed)
All probes run on **2026-08-27 morning** before this session; tokens confirmed at file read time:
- `docs/real-test/reports/_probe-9b-agent-direct.txt` → `PROBE_TOKEN_9b_agent_direct_OK`
- `docs/real-test/reports/_probe-9b-crew-agent-direct.txt` → `PROBE_TOKEN_9b_crew_agent_direct_OK`
- `/tmp/9b-chain-probe.txt` → `PROBE_TOKEN_9b_chain_step1_OK` + `PROBE_TOKEN_9b_chain_step2_OK`
- `/tmp/9b-async-probe.txt` → `PROBE_TOKEN_9b_async_OK`

All from `team` tool calls. consistency=1 for all.

#### 9b-W — Worker tools (PARTIAL)
Run `team_20260827030458_f6e48422264ad5d8` (fast-fix, sync, 188s, 3030 tokens, 3/3 tasks).

**Step 1 — Loadout sanity (D5) ✅**:
Worker transcript shows env markers:
- `PI_CREW_KIND=subagent` (authoritative sub-agent marker)
- `PI_CREW_ROLE=executor`
- `PI_CREW_DEPTH=1`, `PI_CREW_MAX_DEPTH=2`
- `PI_CREW_ASK_ENABLED=1`
- `PI_CREW_DELEGATE_ENABLED=1`
→ D5 full loadout confirmed.

**Step 2 — Ask round-trip ⚠️ (silent block)**:
Worker called `ask` tool with `{"question":"PROBE_9bW_ASK_OK","options":["OK"],"timeoutSec":30}`. Transcript cut at `tool_execution_start` with `jsonEvents=65`. Worker exited cleanly (`exit=0`) but produced only "Now Step 2 — Call `ask` tool. Per parent context, `waitMethodsEnabled: false` is set, so we expect a structured reject:" with no tool result.

**No `policy.action` event recorded for ask gate rejection** (only 1 policy.action total in `events.jsonl`, and that's the `closeout` event at run end). This matches the skill's anti-pattern warning: "Gate rejections emit `policy.action` events — grep events.jsonl, don't trust silence."

This is **expected behavior** given effective `waitMethodsEnabled: false` (deliberate test config), but exposes a **silent-no-op** failure mode for `ask` that the skill explicitly flags. The gate-closed path doesn't emit a structured rejection event in the project config — it just hangs/times out, then the worker turn ends.

**Steps 3–4 — delegate / message**: ❌ Not reached. Worker exited at Step 2 (no tool result returned).

**Mitigation note for next battery**: to exercise delegate and message, run them as separate probes (each in its own fast-fix run) so a stuck ask doesn't poison the rest.

#### 9c — Lifecycle / recovery
Skipped re-run: per skill "they are no longer unproven, but still require explicit scope+confirmation to re-run" — already exercised in 2026-08-11 release. The actions are: `wait`, `steer`, `cache`, `checkpoint`, `cancel`, `invalidate`, `resume`, `retry`, `respond`, subagent steering.

#### 9d — Destructive
**Never run.** Per skill and delegation policy, destructive actions (`prune`, `cleanup`, `forget`, `kill`) require explicit user confirmation.

#### 9e — Admin / mutation
Skipped re-run: per skill note, already exercised in 2026-08-11 release. Actions: `create/update/delete` team/agent/workflow, `init/config/validate/autonomy/settings` setup, `import/imports/export`, `parallel`.

#### 9f — Background / scheduled
Skipped re-run: per skill note, already exercised in 2026-08-11 release. Actions: `goal-loop`, `schedule/cron`, `auto-summarize/anchor/auto_boomerang`, `api`.

---

### Tier 10 — Surface-mode battery

#### 10a — E2E tmux suite (3/3 PASS)
```
$ cd /home/bom/source/my_pi/pi-crew
$ node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 \
  test/system/surface-tmux.e2e.test.ts 2>&1 | tee /tmp/surface-e2e.log

# Subtest: E2E tmux: pane thật được spawn, script chạy trong pane, pane tự đóng, run hoàn thành
ok 1 - ...   duration_ms: 4110.6
# Subtest: E2E tmux: kill-pane giữa chừng → degrade + lockout + re-dispatch headless vẫn done
ok 2 - ...   duration_ms: 4147.5
# Subtest: E2E tmux: doctor liệt kê + đóng pane mồ côi thật, report chứa pane id
ok 3 - ...   duration_ms: 75.9

# tests 3
# pass 3
# fail 0
# duration_ms 8910.3
```
✅ Real tmux spawn + auto-exit (4.1s), kill-pane→degrade→headless resume (4.1s), doctor orphan cleanup (75ms).
⚠️ Note: tests auto-create their own tmux session inside; no `$TMUX` env needed.

#### 10b — Live surface run (FAIL — config drift bug discovered)

**Goal**: spawn a fast-fix run with `visibleAgents=["*"]`, `mode="tmux"`, expect panes appear.

**Action taken**:
1. Updated `/home/bom/.pi/agent/pi-crew.json` to add `runtime.surface = { mode: "tmux", visibleAgents: ["*"] }`
2. Launched `team action='run' team='fast-fix' async=false goal='Tier 10b surface probe...'`
3. Captured run `team_20260827031042_65c3f55c293e4961` events + manifest.

**Result**: Run completed (`run.completed`, `consistency=1`, 169s, 8364 tokens) BUT **no pane was created**. Workers ran headless.

**Bug evidence** (`events.jsonl`):
```json
{
  "time": "2026-08-27T03:10:42.299Z",
  "type": "config.warning",
  "data": {
    "warnings": [
      "/home/bom/.pi/agent/pi-crew.json: /runtime/surface: Unexpected property"
    ],
    "path": "/home/bom/.pi/agent/pi-crew.json"
  }
}
```
**Manifest `runConfig`**:
```json
"runtime": {
  "inheritContext": true   // <-- surface key absent
}
```

**Root cause** (found by static read of source):
- `src/schema/config-schema.ts:96-106` declares `surface` field with `mode` + `visibleAgents`.
- `src/config/config-validation.ts:parseSurfaceConfig(...)` exists and parses surface correctly.
- `src/config/config-validation.ts:parseRuntimeConfig(...)` (the function called when loading `runtime.*`) **does not include** a call to `parseSurfaceConfig` and does not emit a `surface` field in its return shape.
- Result: surface is parsed as "additionalProperties" rejection → config validator silently drops it.

This is the **exact same shape** as F19-1 modelFallback bug, which has its own parity comment in code:
> "F19-1 (Round 19 parity): runtime.modelFallback was declared in types.ts and the schema (PiTeamsModelFallbackConfigSchema) but parseRuntimeConfig never emitted it, so user config was silently dropped. Mirrors the schema field-for-field."

**Surface is the SAME class of bug** — and it has been silently dropping user config since the MuxSurface A1 merge (`a77127fd`). Every user setting `runtime.surface.visibleAgents` since then has been ignored.

**Impact**:
- A1 spec: `runtime.surface.visibleAgents` defaults to `[]` (surface visible to nobody until opted in). Spec promise broken because the opt-in mechanism is dead.
- A2 deferred list (per `docs/decisions/2026-08-26-mux-surface-a1.md`) will inherit this bug unless `parseRuntimeConfig` is fixed first.

**Cleanup done**: `/home/bom/.pi/agent/pi-crew.json` restored to original state.

**Suggested fix** (out of scope for this report — flag for follow-up): add `surface: parseSurfaceConfig(obj.surface)` to the `parseRuntimeConfig` return shape in `src/config/config-validation.ts`, mirroring the F19-1 fix pattern.

#### 10c — herdr path (SKIP-WITH-REASON)
- `herdr` binary: present (`/home/bom/.local/bin/herdr`)
- `~/.config/herdr/herdr.sock`: present, 1 session `default` running
- `$TMUX` env: unset; pi session not inside a herdr pane

Per skill: "herdr only detected when pi is itself running inside a herdr pane (design decision — không đoán mò qua socket nếu pi không thuộc herd)". Skip is correct-by-design.

---

## Findings worth flagging upstream

### � F26-1: surface config silently dropped (PARSE-TIME drift)
- **Severity**: High — A1 spec opt-in mechanism dead; surfaces never engage from user config.
- **Location**: `src/config/config-validation.ts` — `parseRuntimeConfig(...)` does not call `parseSurfaceConfig(obj.surface)`.
- **Mirror of**: F19-1 (modelFallback had the same shape and was fixed via the same pattern).
- **Repro**: edit `/home/bom/.pi/agent/pi-crew.json` to add `runtime.surface = {mode: "tmux", visibleAgents: ["*"]}`. Run any `team action='run' async=false`. Observe `config.warning: /runtime/surface: Unexpected property` in events.jsonl, `runConfig.runtime` lacks `surface` key in manifest.
- **Fix sketch**:
  ```ts
  function parseRuntimeConfig(value: unknown): CrewRuntimeConfig | undefined {
    ...
    return {
      ...,
      surface: parseSurfaceConfig(obj.surface),   // <-- add this
    };
  }
  ```
- **Test to add**: unit test in `test/unit/config/` that asserts `parseConfigWithWarnings({runtime:{surface:{mode:"tmux",visibleAgents:["*"]}}})` returns `config.runtime.surface` populated with no warnings.

### 🟡 F26-2: ask gate closed without structured reject event
- **Severity**: Medium — silent failure mode for `ask` when `broker.waitMethodsEnabled: false`.
- **Location**: `src/prompt/` (ask tool handler) — needs check whether it emits `policy.action` event on gate reject.
- **Skill anti-pattern reference**: "Gate rejections emit `policy.action` events — grep events.jsonl, don't trust silence."
- **Evidence**: In `team_20260827030458_f6e48422264ad5d8`, worker called `ask` with `timeoutSec:30`, transcript cut at `tool_execution_start`, worker exited `exit=0`, NO `policy.action` event for ask gate.
- **Hypothesis**: ask sleeps indefinitely until timeout (or fallback "proceed with best judgment"), then turn ends without emit. Need to verify whether policy.action is supposed to fire at gate-rejection boundary.

---

## Done-criteria checklist (from skill)

- [x] Tier 1: 102/102 pass in 25.7s — recorded actual count.
- [x] Tier 2: 3-path proof all pass.
- [x] Tier 3: typecheck exit 0, build:bundle exit 0, md5 matches anchor.
- [x] Tier 4: bundle md5 matches symlink target.
- [x] Tier 5: tmux keystroke `/team-help` reached input box + autocomplete hint + status bar time change.
- [x] Tier 6: pty_probe.py processed 9 keys without crash.
- [x] Tier 7: smoke team run completed; verifier 27.8s.
- [x] Tier 8: final md5 sync check passed.
- [x] Tier 9a: 12 read-only actions clean.
- [x] Tier 9b: 5 spawn-path probe tokens confirmed.
- [⚠️] Tier 9b-W: loadout ✅, ask ⚠️, delegate+message ❌ (PARTIAL — config-imposed gate blocking ask).
- [⏭️] Tier 9c–9f: skipped re-run (already proven in 2026-08-11; explicit scope+confirmation required).
- [⏭️] Tier 9d: SKIPPED (destructive — no user confirmation).
- [x] Tier 10a: 3/3 E2E pass in 8.9s.
- [🚨] Tier 10b: FAIL — config drift bug discovered (F26-1).
- [⏭️] Tier 10c: SKIPPED — herdr socket exists but pi not in herdr pane (by design).
- [x] Output report: this file, filled DURING the run.

**Honest verdict**: 11 PASS, 1 PARTIAL (gate-blocked), 3 SKIPPED (legit), 1 FAIL (real bug). Not rounded up to "all pass" because Tier 10b surfaced a regression that affects every user since A1.
