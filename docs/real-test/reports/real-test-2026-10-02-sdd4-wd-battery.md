# real-test-pi-crew — Run Report (SDD-4 W-D)

**Date**: 2026-10-02
**Trigger**: post-SDD-4 W-D + follow-ups (WI-1 crew-vibes stale-ctx `7b2dc7e2` · WI-2 G24 foreign-LIVE skip `8d56db21` · WI-3 NEW-3 coalesced hb.pid `c5961536` · WI-4 G25 heartbeat pulse `67b87e68` · WI-5 terminate kill `cdef3d62` · WI-6 W-C2 async-resume stale `6cdd4ac8` · **NEW-2 follow-up honest notify `a8d20bd0`** · bundle `ec4187b8`); team run `team_20261002030256_4b89e587e2b7d94d` (adaptive-10-executor, P4 battery)
**Repo HEAD**: `ec4187b8` (base `bf484db8`; 8 commits, none pushed)
**Bundle md5 (disk == committed)**: `65d35cd6db8de69afd322fa2e20020f7` (1588.7 KB — T11j green)
**Pi version**: 0.11.5 extension / pi 0.99.1 runtime / node v22.23.1
**Run by**: worker `adaptive-10-executor` — cold-start `pi -p` + tmux TUI probes in `/tmp/rt-sdd4` (markers: `.crew/` + `git init`), mọi probe `timeout -k 5` (Finding 3 SDD-3 honored — zero leaked probes).

## Pre-battery deviation (đã tự quyết, ask-unavailable)

P3 review (adaptive-07) verdict **FIX_THEN_SHIP với 1 MAJOR: NEW-2 chưa implement** (executor WI-2 đã park đúng luật ownership — `lifecycle-handlers.ts` ngoài scope WI). Criterion probe #4 của battery ("notify phải trung thực theo WI-2") không thể pass ở mức code. `ask` tool không có broker connection (scaffold mode) → best-judgment per tool guidance + PHASE RUNBOOK ("fix findings trước checkpoint kế") + remediation recipe hội tụ từ 2 reviewer độc lập: **implement NEW-2 như 1 commit riêng trước battery** — `a8d20bd0`, mechanical theo recipe (gate `repaired===true` + bounded per-runId dedupe Set + honest title/body), red-first 2 test fail đúng dishonest-notify tại `6cdd4ac8`:

```
not ok 1 - NEW-2 (b): … got [{"id":"stale_reconcile",…,"title":"Reconciled 1 stale run(s)",
  "body":"Found and repaired ghost runs from previous sessions: run-blocked-apprv"}] — 1 !== 0
not ok 2 - NEW-2 (a): 'title must state what actually happened (Repaired N stale run(s)), got: Reconciled 2 stale run(s)'
```

File mới: `test/unit/extension/registration/stale-reconcile-notify-honesty.test.ts` (real-feed integration qua harness preload-idle-render: session_start thật + reconcileAllStaleRuns thật + fixture trên đĩa) + `stale-reconcile-notify-dedupe.test.ts` (unit pin cho Set — mock.module bị cấm theo convention repo, real-feed không thể lặp lại repaired verdict vì repair persist terminal; documented trong header).

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 120/120, exit 0 (scrubbed PI_CREW_*/PI_TEAMS_*) — rerun tại `a8d20bd0` bởi executor này; adaptive-09 đã verify 120/120 tại `6cdd4ac8` |
| 3 typecheck + bundle | ✅ | typecheck exit 0 ("strip-types import ok") · bundle 1588.7 KB · staleness OK (bundle mới hơn src) · size 1.55 MB < 3.5 MB · test:bundle 2/2 |
| 7 smoke | ✅ | sync fast-fix `team_20261002044051_d062dc2ba8ce5633` **completed 3/3**, output verbatim `sdd4-t7-sync-ok`; async `team_20261002044436_aa9a61d9151a296b` **completed 3/3** (detached runner pid 3994733 tự hoàn tất sau khi orchestrator exit) |
| T4/T8 bundle sync (de-facto) | ✅ | tmux TUI probe session (cold-start 11:59, bundle `65d35cd6`) hiển thị ĐÚNG hành vi chỉ có trong bundle mới (notify format "Repaired N stale run(s)") — session-on-new-bundle proven bằng hành vi |
| 11 pinned suites | ✅ | stale-reconciler-rotation + sentinel-reclaim + sweep-test-tmp + run-state-layout-parity: **19/19** exit 0; thêm 8 file test WI-1..WI-6+NEW-2: **31/31** exit 0 |
| **Live orphan-heal probe** | ✅ | xem chi tiết dưới — reconciler verdict trung thực + notify honest + dedupe/no-spam **live-proven** |
| 11j committed-hash | ✅ | `check-bundle-staleness --committed-hash`: "OK: committed dist matches a fresh build from current src"; rebuild lại → md5 giống hệt + tree clean |
| Gates (8) | ✅ | test:critical 120 · typecheck · lint (2 infos) · format:check 1546 files · wc-gate (max live-session-runtime 1296/2000… crew-broker 1999/2000 pre-existing) · event-types --enforce "clean" · decision-drift "no drift" · env-vars "OK 519 files" — tất cả exit 0 tại `a8d20bd0` |

## Live orphan-heal probe (/tmp/rt-sdd4) — chi tiết

**Setup**: scratch `/tmp/rt-sdd4` (`.crew/` + `git init` marker); async run `team_20261002044932_36e9417fb1c4428f` (sleep-100 goal) dispatch qua cold-start `pi -p`; **orchestrator killed trước** (kill -9 tree), rồi runner pid 3998127 killed (group + children) → run stuck `running` + dead pid, không còn watcher (verified 30s). Fixture NEW-2: `probe_blocked_new2_000000000000001` (status blocked + `planApproval {required:true,status:"pending"}`) trồng trực tiếp trên đĩa.

1. **Reconciler verdict trung thực**: cold session #1 (`pi -p`) → `run.failed "Stale run reconciled: PID 3998127: process does not exist (heartbeat was 54s old); pid_dead; repaired 2 tasks"` + event `crew.run.reconciled_stale {verdict: pid_dead}` — run bị repair đúng (failed), KHÔNG đụng foreign-LIVE hay blocked run.
2. **Blocked fixture im lặng tuyệt đối**: qua **12+ session starts** (2 `pi -p` + 6 orphan tries + TUI boot + 3× `/reload`): ZERO notify cho `blocked_awaiting_approval` (repaired:false), manifest vẫn `blocked`, không bị repair — NEW-2 gate live-proven (pre-fix code đã notify "Found and repaired ghost runs" cho đúng class này — red ở unit).
3. **Honest positive notify**: tmux TUI session (không turn → không turnHook race, xem Finding 1) + orphan planted + `/reload` → sink `<crewRoot>/state/notifications/2026-10-02.jsonl` ghi đúng 1 entry:
   `id=stale_reconcile | title="Repaired 1 stale run(s)" | body="Repaired stale runs from previous sessions: probe_orphan_reload_0001 (pid_dead)"` — repaired-only, nêu runId + verdict, không claim gì thêm.
4. **Dedupe/no-spam live**: 2 lần `/reload` nữa (session_start re-fire cùng process) → sink vẫn **đúng 1 entry** stale_reconcile (count=1). Cross-restart tự nhiên: run đã repair → terminal → rời reconcile input (không bao giờ re-notify).

## Findings

1. **[LOW] Notify coverage race — `before_agent_start` turnHook reconciles fire-and-forget và thắng race 7/7 trong `pi -p`** (`src/extension/registration/lazy-configurers.ts:66-80`). Hook gọi `reconcileAllStaleRuns(...)` rồi discard kết quả (`.catch()` only); trong print-mode session nó deterministically chạy trước deferred cleanup (setTimeout 0) và拿下 run lock → repair diễn ra **âm thầm** (đúng, không dishonest — nhưng operator không được báo). 7 orphan tries liên tiếp repair không notify; chỉ khi cách ly bằng TUI không-turn + `/reload` thì notify path fires. Không sai tính trung thực (NEW-2 yêu cầu) — là gap coverage thông tin. Follow-up đề xuất: turnHook route kết quả qua cùng `decideStaleReconcileNotification` (dedupe Set chung đã chống double-notify), hoặc bỏ reconcile ở turnHook khi session-start vừa chạy.
2. **[INFO — đúng thiết kế] In-session runner-death detection hoạt động**: khi orchestrator còn sống, runner bị kill → `run.failed "Background runner died unexpectedly"` + `async.died {pid, "process does not exist"}` trong ~2s (async monitor trong session) — probe đầu tiên bị path này "ăn" scenario; orphan-heal reconcile chỉ cần thiết khi cả session chết (đúng mô hình W-D).
3. **[LOW — recurrence Finding 3 SDD-3] Zombie `timeout N pi -p` từ battery trước**: 7+ process (11-13h tuổi, cwd `/tmp/rt-sdd2|rt-sdd3*`) sống sót qua SIGTERM của timeout — đã SIGKILL có verify-cwd (chỉ kill cwd xác nhận thuộc battery cũ, skip `/home/bom/source/my_pi` + không đụng worker của run active). `timeout -k 5` dùng cho 100% probe của battery này → **0 leak mới**. Còn sót: PID 2829041 (SDD-3 Finding 3 nêu tên, cwd `/tmp/rt-20260930-buoi1`) — ngoài scope kill đã verify của tôi, đề xuất cleanup riêng.
4. **[NOTE — battery hygiene] Probe `pi -p` kế thừa env PI_CREW_* của worker** → `register.backgroundPreload` spam "Run 'team_20261002030256…' not found" dưới PI_TEAMS_DEBUG (nhàm, không ảnh hưởng verdict — run cha ở cwd khác). Battery probe sau này nên `env -u` bộ PI_CREW_*/PI_TEAMS_* khi cold-start pi.
5. **[NOTE] wc-gate `crew-broker.ts` 1999/2000** — pre-existing (review adaptive-07 đã ghi), mọi edit tương lai tới file đó sẽ vướng gate.

## What was NOT run + why

- Full `npm test` (>400s) — bị cấm theo packet + knowledge; thay bằng test:critical + targeted suites + 8 gates.
- T5/T6 keystroke probes, T9 full, T10 surface, T12, T13 — không có change nào trong src/ui, surface, resource .md, schema (decision table không yêu cầu; TUI dùng T4-style cho probe notify).
- `npm audit` / lockfile-sync — gợi ý của security-reviewer cho P4; package.json/lock không đổi trong batch này (verifier adaptive-09 đã xác nhận tree), để lại cho release gate khi publish.

## Verdict

**PASS** — mọi criterion battery thỏa: T7 sync+async completed; T3 xanh; T11 pinned 19/19 (+31/31 WI files); live orphan-heal probe chứng minh reconciler verdict trung thực + notify repaired-only honest + dedupe/no-spam ở CẢ hai tầng (unit red-first + live 12+ session starts); T11j committed-hash khớp; 8 gates exit 0; KHÔNG push/bump/publish. Finding 1 (turnHook notify-coverage race) là gap thông tin LOW, đề xuất follow-up riêng.

## Restart needed?

- [x] No — mọi probe cold-start dùng bundle `65d35cd6` (bundle mới nhất, committed).
- [ ] Session chính của user (nếu đang mở pi từ trước 11:39) cần restart để nhận bundle mới — không bắt buộc cho tính đúng đắn của evidence ở trên.
