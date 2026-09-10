# Gap Freshness Audit — G1→G29 at HEAD

| | |
|---|---|
| **Date** | 2026-09-10T03:04Z |
| **HEAD** | `627f59c9` (= spec baseline; unchanged) |
| **Node / OS** | `v22.23.1` / linux `6.17.0-35-generic` |
| **Method** | every G# re-verified by freshly-run grep/wc/read — no number inherited from `research-pi-crew-upgrade-2026-07.md` |
| **Scope** | WI-1.0 of the Upgrade Program spec v1.0 §5 (M1a) |

Status legend: **OPEN** (still a real gap at HEAD) · **ALREADY-SHIPPED** (gap gone) ·
**PARTIAL-SHIPPED** (main body shipped, bounded remainder — treat remainder as the real scope) ·
**STALE-NUMBER** (the research number itself is wrong; corrected number given).

Summary: **26 OPEN · 3 PARTIAL-SHIPPED (G10/G20/G23) · 0 fully ALREADY-SHIPPED · 10 gaps carry stale numbers** (G7, G9, G11, G13, G14, G15, G18, G21 + minor line-drift G1/G26).
Net effect for planning: M1b/M5 scopes shrink where shipped (G10 remainder = 2 items, G20 = 2 sub-items, G23 = 2 owners); nothing gets *added*; two dynamic counts corrected (54→**55** actions, ~37→**41** commands).

---

## 1. Gap table G1–G29

Verify commands are run from repo root (`pi-crew/`). "Expected" = what the audit run produced at HEAD `627f59c9`.

### Tema 1 — Hiệu năng (G1–G4)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G1** | **OPEN** (perf # STALE — header v0.9.62, 2026-08-06) | Sync `appendEvent` surface **80 call-sites / 31 files** (exact match to R2); `appendEventBuffered` exists but only 2 call-sites; `appendEventAsync` = 70/22 files; `appendEventFireAndForget` = 25 (primitive R2 didn't count). team-runner still calls sync `appendEvent` (e.g. `team-runner.ts:429` region, event `run.goal_achievement`). Bench b4 ~14 ms/ev from stale report — re-measure = WI-1.1 | `grep -rn "appendEvent(" src --include="*.ts" \| grep -v "appendEventBuffered" \| grep -v "\.test\.ts" \| wc -l` then exclude the 1 `function appendEvent(` def | 81 raw → **80 sync**; files: `grep -rln ... \| wc -l` → **31**; buffered → **2**; async `grep -rn "appendEventAsync(" \| grep -v function \| wc -l` → **70** |
| **G2** | **OPEN** (perf # STALE) | Cold boot ~1.27 s/worker from stale perf-report (header v0.9.62); `bench/b1-child-spawn.bench.ts` + `b7-startup.bench.ts` exist; warmup only covers extension host (`src/runtime/model/runtime-warmup.ts`), no child pool/prewarm | `head -12 docs/perf-report.md` ; `ls bench/b1-child-spawn.bench.ts bench/b7-startup.bench.ts src/runtime/model/runtime-warmup.ts` | header shows `# pi-crew Performance Report (v0.9.62)`; all 3 files exist |
| **G3** | **OPEN** (perf # STALE) | `atomicWriteJson` floor ~13 ms/op in stale report (b3/b8); coalesced pattern exists only for crew-agents (`saveCrewAgentsCoalesced`, crew-agent-records.ts:491, callers :473 + team-runner.ts:1135) — not extended to manifest/tasks | `grep -rn "saveCrewAgentsCoalesced" src --include="*.ts" \| grep -v test` | 3 hits (def + 2 callers) |
| **G4** | **OPEN** | Retrieval round-3 shipped in 0.10.3 (CHANGELOG :71 "7.1s → 2.0s cold / 0.28s warm"); end-to-end **non-retrieval remainder never re-measured** after that round — that measurement = WI-1.1 bench + true full-suite duration | `grep -n "retrieval 7.1s" CHANGELOG.md` | hit at CHANGELOG.md:71 |

### Tema 2 — Cấu trúc (G5–G9)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G5** | **OPEN** | `crew-broker.ts` = **2328 lines** (byte-exact match to research; sole `src/runtime/` violator of the ≤2000 done-gate) | `wc -l src/runtime/broker/crew-broker.ts` | `2328` |
| **G6** | **OPEN** | **15 files >1000 lines** non-test in src/ (top: crew-broker 2328, worktree-manager 1351, event-log 1285, live-session-runtime 1267, state-store 1259, team-runner 1220, lifecycle-handlers 1204, child-pi 1203, atomic-write 1198, run-snapshot-cache 1151, prompt-runtime 1088, child-executor 1068, settings-overlay 1059, dynamic-workflow-context 1013, background-runner 1002). mailbox **no longer** >1000 (list drifted down by mailbox) | `find src -name '*.ts' -not -name '*.test.ts' \| xargs wc -l \| awk '$1>1000 && $2!="total"' \| sort -rn` | 15 rows, top = 2328 crew-broker.ts |
| **G7** | **OPEN** — **STALE-NUMBER** (7→11 pairs) | Sync/async twins: worktree-manager now has **11 suffix-pairs** (`git`, `findGitRoot`, `assertCleanLeader`, `branchExists`, `pruneStaleWorktrees`, `cleanupCreatedWorktree`, `prepareTaskWorkspace`, `captureWorktreeDiffStat`, `captureWorktreeDiff`, `prepareAgentWorktree`, `cleanupAgentWorktree`); state-store **3 pairs** (`saveRunManifest`, `saveRunTasks`, `loadRunManifestById`) — 3 exact, 7 drifted UP. ADR `docs/decisions/2026-08-10-reduce-sync-async-twins.md` exists, still not implemented | suffix-pair counter over `grep -oE "^(export )?(async )?function [a-zA-Z]+" src/worktree/worktree-manager.ts` (see §4 snippet) | worktree **11**, state-store **3** |
| **G8** | **OPEN** | Dual worker runtimes: `src/runtime/live-session/` = **7 files**, runtime = **1267 lines** (exact) beside default child-process runtime | `find src/runtime/live-session -name "*.ts" \| wc -l && wc -l src/runtime/live-session/live-session-runtime.ts` | `7`, `1267` |
| **G9** | **OPEN** — number drifted (research "10 file") | `sleepSync` live calls = **10 call-sites / 9 files**: active-run-registry:90, locks:338+445, sequence-cache:253, event-log:196, atomic-write:398+488, crash-recovery:89, foreground-control:152, crew-agent-records:251 (+ def in `src/utils/sleep.ts:10` + 1 comment at event-log.ts:287). Mailbox no longer among them (matches spec R2 note: mailbox = comment only) | `grep -rn "sleepSync(" src --include="*.ts" \| grep -v "\.test\.ts"` | 12 lines; minus 1 def + 1 comment → **10 live / 9 files** |

### Tema 3 — Dead code (G10–G15)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G10** | **PARTIAL-SHIPPED** — 6/8 deleted; remainder OPEN (WI-5.1) | Deleted (0 non-test hits): `crewEventBus`, `src/plugins/` (dir gone), `iteration-hooks` (only 2 comment refs left, head-snap-stage.ts:7,11), `child-pi-pool`, `notifyMessage`, `setVisible`. Still present: `setStatusFallback` ×2 (powerbar-publisher.ts:44 local-fn, pi-ui-compat.ts:74 exported) and `host_request` dead surface (`src/runtime/scratchpad/protocol.ts:48`) | `for s in crewEventBus notifyMessage setVisible child-pi-pool setStatusFallback host_request; do grep -rn "$s" src --include="*.ts" \| grep -v "\.test\.ts"; done` | first 4 symbols → 0 hits; setStatusFallback → 2 hits; host_request → protocol.ts:48,54,56 |
| **G11** | **OPEN** — LOC number stale (2321→**2591**) | Scratchpad still present: `src/runtime/scratchpad/*` + `src/prompt/scratchpad-lifecycle.ts` = **2591 LOC**, **22** test files (research: 19). Decision gate §5 exists (`docs/improvement-plan-2026-08-11.md:461`). I5 adoption metrics ARE live — registered at **`src/state/contracts.ts:156-157`** (`scratchpad.cell`, `scratchpad.restored`) — note: spec §5 WI-5.2 cites path `contracts.ts` without dir; it is `src/state/contracts.ts`, NOT under scratchpad/ | `sed -n '155,158p' src/state/contracts.ts` ; `find src -path "*scratchpad*" -name "*.ts" -not -name "*.test.ts" \| xargs wc -l \| tail -1` | `"scratchpad.cell", "scratchpad.restored"` visible; total `2591` |
| **G12** | **OPEN** (0 real consumer) — **false-positive trap documented** | pi-crew's RPC channels (`pi-crew:rpc:run/status/live-control`) referenced only inside pi-crew (src, tests, dist bundle). `source/pi-subagent3` + `source/pi-subagents3` appear in a workspace grep but ship their **own local `cross-extension-rpc.ts` copy** — they do NOT import pi-crew's RPC | `grep -rln "pi-crew:rpc" /home/bom/source/my_pi --include="*.ts" \| grep -v node_modules` | hits only under `pi-crew/src`, `pi-crew/test`, `pi-crew/dist` |
| **G13** | **OPEN** — fix-scripts count **14** (research "~15") | Litter all present: `vscode-extension/` (contains only `node_modules/`), `run-deep-review-loop.sh`, `test-integration-check.ts`, `fallow-audit-report/` (2 files), **14** `scripts/fix-*.cjs`. `undefined/` = **empty dir tree** `undefined/.pi/{teams/state/runs, agent}` — 0 files, NOT git-tracked (decision belongs to WI-1b.3) | `ls scripts/fix-*.cjs \| wc -l` ; `find undefined -type f \| wc -l` | `14`; `0` files |
| **G14** | **OPEN** — **STALE-NUMBER: 54 → 55 actions** | Flat LLM-facing `TeamToolParams.action` enum built dynamically = **56 entries incl. leading `""` placeholder → 55 real actions** (RUN 10 + STATUS 16 + CONTROL 7 + MANAGE 16 + AUTOMATE 6; source comment `team-tool-schema.ts:387` itself says "= 55"). Root `schema.json` is the *config* schema — unrelated; action enum must be counted programmatically | `node --experimental-strip-types --no-warnings -e "import('./src/schema/team-tool-schema.ts').then(m=>{const e=m.TeamToolParams.properties.action.enum;console.log(e.length, new Set(e).size)})"` | `56 56` → minus the `""` placeholder = **55 actions** |
| **G15** | **OPEN** — **STALE-NUMBER: ~37 → 41 total** | Programmatic registrations in the 4 modules (`registration/commands/{run,status,manage,dashboard}.ts`) = 31 `pi.registerCommand(` call-sites (28 static + 3 loops) → **38 commands** (loops add 10: run.ts 3 `team-resume/team-export/team-cancel`; status.ts 5 + 2). **Plus 3 outside those modules**: `crew-view` (inline-panel/index.ts:251), `crew-back` (:255), `team-vibes` (crew-vibes/index.ts:438) → **41 total**. (command-registration.ts:1 hit is a doc comment, not a call) | `grep -rh "pi\.registerCommand(" src --include="*.ts" \| grep -v "\.test\.ts" \| wc -l` ; then read the 3 `for (const [name` loops | **35** raw incl. 1 comment → 34 real call-sites → 41 commands |

### Tema 4 — Docs drift (G16–G18)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G16** | **OPEN** — research's "missing keys" list itself partially stale | Confirmed drift: README:701 `ui.widgetPlacement` enum `aboveEditor \| belowEditor` + default `aboveEditor` vs code `defaults.ts:137` = **`"bottom"`** (value not even in documented enum); README misses `widgetRowStyle` (:139) + `inlinePanel` (:140) — but `mascotStyle`/`mascotEffect` **ARE documented** (README:714,715), so "5 key thiếu" is really **2 missing + 1 wrong default/enum**; commands-reference lacks `/crew-view` `/crew-back` `/team-vibes` — all 3 **exist in src** (see G15) and are un-documented; `docs/architecture.md:6` says **v0.9.0** (actual 0.10.3) and :86 flat `src/runtime/child-pi.ts` (actual `child-pi/` dir); AGENTS.md:72 `src/runtime/task-runner.ts` (actual `task-runner/` dir); ROADMAP-2026-Q3.md:85 R4-3 still "backlog" though dashboard shipped (`team-dashboard` registered, dashboard.ts). **No dedicated trust-model file exists** (only mentions in 3+ docs) — canonical absent, not just scattered | `grep -n "widgetPlacement" README.md src/config/defaults.ts` ; `grep -n "crew-view\|crew-back\|team-vibes" docs/commands-reference.md` ; `sed -n '6p' docs/architecture.md` ; `grep -n "task-runner" AGENTS.md` ; `grep -n "R4-3" docs/ROADMAP-2026-Q3.md` | README enum≠code default `"bottom"`; commands-reference → 0 hits; `**Current version:** v0.9.0`; AGENTS.md:72 flat path; R4-3 backlog |
| **G17** | **OPEN** — **worse than research: drift already HAPPENED** | `install.mjs` duplicates defaults AND has already diverged: writes `widgetPlacement: "aboveEditor"` vs src `"bottom"`; missing `widgetRowStyle`/`inlinePanel` keys entirely (install.mjs `ui:` block ~:34-45 vs defaults.ts:137-143). Top-level side-effect, no export (R2 P2-8 confirmed) | `grep -n "widgetPlacement\|widgetRowStyle\|inlinePanel" install.mjs src/config/defaults.ts` | install.mjs: only `aboveEditor`, no row-style/inlinePanel; defaults.ts: `bottom`, `compact`, `true` |
| **G18** | **OPEN** — counts grew (1177→**1365** docs files) | `docs/` = **1365** files; **1122 loose `perf-report-team_*.md`** at docs/ top level; `docs/archive/` exists but contains **0** perf-report-team_* | `find docs -maxdepth 1 -name "perf-report-team_*" \| wc -l` ; `find docs/archive -name "perf-report-team_*" \| wc -l` | `1122`; `0` |

### Tema 5 — Test & verification (G19–G21)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G19** | **OPEN** (duration UNKNOWN) | `npm test` = test:unit + test:integration (glob suites); `test:critical` = **14 files** (9 broker + 5) — verified in package.json:85. Full-suite true duration unmeasured outside worker env (the >580 s timeout is from an old improvement-plan, not a fresh measurement) — WI-1.1 measures it | `node -e "console.log((require('./package.json').scripts['test:critical'].match(/\.test\.ts/g)||[]).length)"` | `14 files` |
| **G20** | **PARTIAL-SHIPPED** — research declared-gaps 1+2 stale | `timeout-layer-contract.test.ts` **EXISTS** (3-layer contract) — declared-gap #2 already closed; EPIPE retry handling **EXISTS** (`model-fallback.ts:403-409` comments+logic, `guest.ts` too) — declared-gap #1 mostly closed. Remaining (per spec WI-3.2): config-mutation variant + EPIPE classifier assessment. **Note: `docs/failure-mode-inventory.md:18-21` still lists BOTH as open "Declared gaps" — the inventory doc itself is stale** (feeds WI-1b.1) | `ls test/unit/runtime/timeout-layer-contract.test.ts` ; `grep -n "EPIPE" src/runtime/model/model-fallback.ts` ; `sed -n '18,22p' docs/failure-mode-inventory.md` | file exists; EPIPE hits ~:403-409; inventory still lists gaps 1+2 |
| **G21** | **OPEN** — counts drifted (33/18 → **46 src / 20 test**) | team-tool test ratio still sparse: **46** non-test src files under `src/extension/team-tool/` vs **20** test files (research: 33≈18). `config-schema-sync.test.ts` covers schema.json only — **no overlay-table sync test**; `settings-overlay.ts:47` comment confirms manual mirror ("Setting Definitions — mirrors config schema") | `find src/extension/team-tool -name "*.ts" -not -name "*.test.ts" \| wc -l` ; `find test -path "*team-tool*" -name "*.test.ts" \| wc -l` ; `grep -n "mirrors config schema" src/ui/settings-overlay.ts` | `46`; `20`; hit at :47 |

### Tema 6 — Security (G22–G23)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G22** | **OPEN** | DWF `.dwf.ts` loads via jiti, **no vm sandbox** — own header states "the script CAN reach process/require/import directly — the frozen ctx is a contract surface, not a security boundary. `.dwf.ts` = postinstall-equivalent trust. isolated-vm v1.5" (`dynamic-workflow-context.ts:8-12`) | `sed -n '1,13p' src/runtime/goal-workflow/dynamic-workflow-context.ts` | header contains "postinstall-equivalent trust" |
| **G23** | **PARTIAL-SHIPPED** — F.1/F.2 wired; remainder = 2 owners | **Shipped**: F.1 `crew.limits.unbounded_total` metric wired (`src/observability/event-to-metric.ts:46`); F.2 cardinality-eviction gauge wired (`src/observability/metrics-primitives.ts:57-67`, `crew.metrics.cardinality_evicted`). **Still open (no owner/target)**: E.2 `v8.deserialize` unauth (import at `src/runtime/scratchpad/guest.ts:33`) and SEC-008 EPERM-as-stealable (`src/state/coordination/locks.ts:49-67` EPERM branch) | `grep -rn "unbounded_total" src --include="*.ts" \| grep -v test` ; `grep -n "deserialize" src/runtime/scratchpad/guest.ts` | event-to-metric.ts:46; guest.ts:33 |

### Tema 7 — Product/UX (G24–G29)

| G# | Status | Verified fact @ HEAD | Verify command | Expected |
|---|---|---|---|---|
| **G24** | **OPEN** | `onWithReplay` has exactly **1 real caller**: `crew-broker.ts:1251` (all other hits are comments/docstrings in run-event-bus.ts:70,167,386, cursor.ts:584, crew-broker.ts:1162). Dashboard/sidebar re-open still misses catch-up | `grep -rn "onWithReplay" src --include="*.ts" \| grep -v "\.test\.ts"` | 7 hits; only crew-broker.ts:1251 is a call |
| **G25** | **OPEN** | ROADMAP Phase 3 items R3-1 (US-021 summary before/after), R3-2 (US-022 export md), R3-3 (review findings artifact), R3-4 (citations) — **all still backlog** | `grep -n "US-021\|US-022\|R3-3\|R3-4" docs/ROADMAP-2026-Q3.md` | 4 backlog rows (:66-69) |
| **G26** | **OPEN** (line drift :42-44→**:53**) | `BROKER_PROTOCOL = 1`, single version, strict equality check, no negotiation (`crew-broker.ts:53`, checks at :680,738) | `grep -n "BROKER_PROTOCOL" src/runtime/broker/crew-broker.ts` | def at :53 |
| **G27** | **OPEN** | herdr graceful-kill TODO(A2) still present (`herdr-provider.ts:24-26` header + :492-493 — graceful and force both go through `pane.close`); heartbeat staleness comment at `team-runner.ts:57-70`; mascot = **436 lines** in core UI (`src/ui/mascot.ts`) | `grep -n "TODO(A2)" src/runtime/surface/herdr-provider.ts` ; `wc -l src/ui/mascot.ts` | :25 header + :493; `436` |
| **G28** | **OPEN** — "1 untracked probe in dist" claim STALE | `scripts/check-bundle-staleness.mjs` is **mtime-only** (:30,:50,:68,:89-90 — zero content-hash logic); `.github/workflows/ci.yml` **intentionally excludes** the staleness check (comment: "only meaningful locally") and has **NO committed-dist gate before `Build bundle`** → tautology vector confirmed (CI rebuilds, then tests its own rebuild; committed dist never compared as-is). dist/ dirty = **3 modified** (`build-meta.json`, `index.mjs`, `index.mjs.map`), **0 untracked in dist/** — the untracked probes live in `docs/real-test/reports/_probe-*` (4 files), not dist | `git status --short dist/` ; `grep -c "mtime" scripts/check-bundle-staleness.mjs` ; `grep -n "bundle-staleness\|Build bundle" .github/workflows/ci.yml` | 3 ` M` lines, 0 `??`; mtime ≥ 5 hits; ci.yml has exclusion comment + rebuild step |
| **G29** | **OPEN** | `install.mjs` writes config once, skips if file exists ("already exists" log), **no schema-migration path** on upgrade | `grep -n "already exists" install.mjs` | hit in the config-write guard |

---

## 2. Dynamic-count verification (build-time numbers WI-1.0 was asked to pin)

### 2.1 Slash commands — actual **41** (research "~37" → STALE-NUMBER)

Counted via programmatic registration, not doc text:

| Module | call-sites | static names | loop-registered | commands |
|---|---|---|---|---|
| `registration/commands/run.ts` | 12 | 11 | 3 (`team-resume`, `team-export`, `team-cancel`) | 14 |
| `registration/commands/status.ts` | 4 | 2 | 5+2 (`team-status/summary/events/artifacts/worktrees` + `team-validate/team-doctor`) | 9 |
| `registration/commands/manage.ts` | 11 | 11 | 0 | 11 |
| `registration/commands/dashboard.ts` | 4 | 4 | 0 | 4 |
| **4-module subtotal** | 31 | 28 | 10 | **38** |
| `ui/inline-panel/index.ts` | 2 | `crew-view`(:251), `crew-back`(:255) | — | 2 |
| `extension/crew-vibes/index.ts` | 1 | `team-vibes`(:438) | — | 1 |
| **Total** | **34** | | | **41** |

Verify:
```bash
grep -rc "pi\.registerCommand(" src --include="*.ts" | grep -v ":0" | grep -v test
# → run.ts:12 status.ts:4 manage.ts:11 dashboard.ts:4 inline-panel:2 crew-vibes:1
# (+1 comment-only hit in command-registration.ts — not a call)
grep -A5 "for (const \[name" src/extension/registration/commands/run.ts src/extension/registration/commands/status.ts
# → the 3 loop tables (10 names)
```
Implication for WI-5.5 (table-driven codegen): the generate set must cover **41**, and 3 of them live outside `registration/commands/**` — ownership map already assigns `registration/commands/**` to M5; `inline-panel/` and `crew-vibes/` are NOT in it (flag to leader when M5 is scheduled).

### 2.2 Team-tool actions — actual **55** (research "54" → STALE-NUMBER)

Flat `TeamToolParams.properties.action.enum` (built at import time from 5 domain unions):

| Domain | count | actions |
|---|---|---|
| RUN | 10 | run parallel plan plans orchestrate resume retry wait steer goal |
| STATUS | 16 | status list get events artifacts summary graph search health worktrees checkpoint cache explain onboard recommend help |
| CONTROL | 7 | cancel invalidate respond cleanup prune forget doctor |
| MANAGE | 16 | create update delete init config validate autonomy settings workflow-create/get/list/save/delete import imports export |
| AUTOMATE | 6 | schedule scheduled anchor auto-summarize auto_boomerang api |
| **Total** | **55** | (flat enum = 56 entries: 55 + leading `""` placeholder emitted by `buildStringEnum`) |

Verify (re-runnable):
```bash
node --experimental-strip-types --no-warnings -e \
  "import('./src/schema/team-tool-schema.ts').then(m=>{const e=m.TeamToolParams.properties.action.enum;console.log('enum:',e.length,'unique:',new Set(e).size,'real actions:',e.filter(x=>x!=='').length)})"
# → enum: 56 unique: 56 real actions: 55
```
Note: root `schema.json` is the **config** schema (top-level props: autonomous/agents/ui/…), it contains no action enum — counting "54" from it was never possible; the number is import-time dynamic, exactly why spec routed it through this audit.

### 2.3 CI inventory — local `ci` chain vs `.github/workflows/ci.yml`

Local `ci` (package.json) = **13 check steps + full `npm test` + `npm pack --dry-run`**. GH CI runs 11 of the 13 (+ full test + pack + an extra tarball-install smoke local ci doesn't have):

| # | local `ci` step | in GH ci.yml? | where / why not |
|---|---|---|---|
| 1 | `check:lockfile-sync` | ✅ | step "Lockfile sync" (pre-install) |
| 2 | `typecheck` | ✅ | step "Typecheck" |
| 3 | `lint` | ✅ | step "Lint" |
| 4 | `format:check` | ✅ | step "Format check" |
| 5 | `check:conflict-markers` | ✅ | step "Checks (conflict markers / lazy imports)" |
| 6 | `check:decision-drift` | ❌ **local-only** | no GH step |
| 7 | `check:env-vars` | ❌ **local-only** | no GH step |
| 8 | `check:event-types` | ❌ **local-only** | no GH step |
| 9 | `check:lazy-imports` | ✅ | same "Checks" step |
| 10 | `check:bundle-staleness` | ❌ **local-only (excluded by comment)** | ci.yml: "intentionally excluded — it is mtime-based … only meaningful locally" |
| 11 | `build:bundle` | ✅ | step "Build bundle" — runs BEFORE tests (tautology vector, see G28) |
| 12 | `check:bundle-size` | ✅ | step "Check bundle size" |
| 13 | `test:bundle` | ✅ | step "Bundle load test" |
| — | `npm test` | ✅ | step "Test" |
| — | `npm pack --dry-run` | ✅ | step "Pack dry run" |
| — | *(GH-only extra)* tarball install + `node --check` smoke | n/a | step "Install + load smoke test" (not in local ci) |
| — | *(GH-only extra)* fallow audit job | n/a | non-blocking (`continue-on-error: true`) |

Verify: `grep -nE "check:|build:bundle|npm test|npm pack" package.json` vs `grep -nE "run: npm run|run: npm (test|ci|pack)" .github/workflows/ci.yml`.

Also confirmed: **no scheduled workflows for the full suite** (`ls .github/workflows/` → ci + smoke/weekly-smoke only) — feeds WI-3.0.

---

## 3. Anti-goal re-check (spec §7) — crewHooks

`crewHooks` is **ACTIVE — 6 call-sites / 4 files, exact match to the spec's corrected count** (do NOT list as dead in any milestone):

```
src/runtime/team-runner.ts:455           crewHooks.emit({
src/runtime/team-runner.ts:553           crewHooks.emit({
src/runtime/task-runner/post-execution.ts:530   crewHooks.emit({
src/runtime/task-runner/child-executor.ts:497   crewHooks.emit({
src/runtime/skill-effectiveness.ts:420   crewHooks.register("task_completed",
src/runtime/skill-effectiveness.ts:459   crewHooks.register("task_failed",
```
Verify: `grep -rn "crewHooks\." src --include="*.ts" | grep -v "\.test\.ts" | grep -v "crew-hooks.ts"` → the 6 lines above.

---

## 4. Re-runnable helper (G7 twin counter)

```bash
node -e "
const fs = require('fs');
for (const f of ['src/worktree/worktree-manager.ts','src/state/stores/state-store.ts']) {
  const src = fs.readFileSync(f,'utf8');
  const names = [...src.matchAll(/(?:export )?(?:async )?function (\w+)\(/g)].map(m=>m[1]);
  const uniq = [...new Set(names)];
  const pairs = [];
  for (const n of uniq) {
    const base = n.replace(/Sync$/,'').replace(/Async$/,'');
    if (n.endsWith('Sync') || n.endsWith('Async')) {
      const hasAsync = n.endsWith('Async') || uniq.includes(base+'Async');
      const hasSync = n.endsWith('Sync') || uniq.includes(base+'Sync') || uniq.includes(base);
      if (hasAsync && hasSync && !pairs.includes(base)) pairs.push(base);
    }
  }
  console.log(f, pairs.length, JSON.stringify(pairs));
}
"
# worktree-manager.ts 11 [...] ; state-store.ts 3 [saveRunManifest,saveRunTasks,loadRunManifestById]
```

---

## 5. Planning impact (for the spec tracker / leader)

1. **Nothing grows**: 0 of 29 gaps fully closed, but 3 shrink (G10: remainder = `setStatusFallback`×2 + `host_request`; G20: remainder = config-mutation variant + classifier assessment + stale inventory doc; G23: remainder = assign E.2/SEC-008 owners).
2. **Corrected numbers to propagate**: team-tool **55** actions (not 54) — WI-5.4; slash commands **41** (38 in the 4 modules + 3 outside) — WI-5.5 + note that `inline-panel/` & `crew-vibes/` are outside the M5 ownership map; appendEvent surface confirmed 80/31 (census input unchanged); G7 twins 11+3; sleepSync 10/9; team-tool test ratio 46/20; scratchpad 2591 LOC / 22 test files; docs 1365 / 1122 loose perf reports.
3. **G17 urgency up**: the install.mjs↔defaults.ts duplication has *already* drifted (`aboveEditor` vs `"bottom"`) — WI-1b.2 is not hypothetical drift-prevention, it fixes a live mismatch users hit on fresh installs.
4. **G28 confirmed exactly as spec §3 says**: mtime-only gate + CI exclusion + rebuild-before-test (no committed-dist compare) + dist dirty (3 modified; the "1 untracked probe in dist" from research is stale — probes are under `docs/real-test/reports/`).
5. **G12 false-positive trap**: workspace grep hits `pi-subagent3`/`pi-subagents3` — they vendor their own RPC module; pi-crew's RPC remains 0-consumer. Any future re-verification must grep for the channel names (`pi-crew:rpc*`), not the module name.
