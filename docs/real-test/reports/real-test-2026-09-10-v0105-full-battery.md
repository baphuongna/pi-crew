# real-test-pi-crew — Run Report

**Date**: 2026-09-10 (22:32–23:35 +07)
**Trigger**: "chạy skill real test pi-crew full all tier ngay trên live session hiện tại, không chạy qua script" — full Tier 1–11 battery, live, trực tiếp từ session đang chạy (không qua script tự động).
**Repo HEAD**: `f73af63d` tại bắt đầu → `1bde7b40` tại kết thúc (1 fix commit phát sinh từ finding, xem F2)
**Bundle md5 (disk)**: `a2c1f24c424372e09ba8727656774fbf` (đầu) → `f383c691198ca749fdf662baaeb04a02` (sau fix 1bde7b40)
**Pi version**: 0.85.1 (node v22.23.1); load avg 1.70 (nhẹ)
**Session host**: pi PID 2359688, start 22:29:14, **đang chạy trong herdr pane `w2:p4V`** (HERDR_ENV=1) — Tier 10c eligible
**Run by**: parent agent (direct execution, mọi tier chạy tay)

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | 102/102 pass, 20.8s |
| 2 3-path kill-switch | ✅ | default 102/102 (21.3s) + `PI_CREW_BROKER=0` 102/102 (27.0s) + `=1` 102/102 (17.6s) |
| 3 typecheck + bundle | ✅ | tsc exit 0 + "strip-types import ok" (8.5s); build:bundle 690ms; rebuild **byte-identical** (md5 không đổi, committed-hash OK) |
| 4 bundle md5 sync | ✅* | Session start 22:29:14 > dist mtime 19:20 → session chạy bundle mới nhất TẠI THỜI ĐIỂM BẮT ĐẦU; load chain: `my_pi/node_modules/pi-crew → ../pi-crew` (live repo, không copy). *Sau fix 1bde7b40 cần restart — xem "Restart needed?" |
| 5 tmux TUI probe | ✅ | Fresh pi trong tmux `/tmp/sock`: `/team-help` render "pi-crew commands:" (extension live trong session mới). Arrow keys `\x1bOA`/`\x1b[B`: no screen change — không có dashboard mở → no-op by design (input-dùng-chứng-minh đã có từ /team-help) |
| 6 pty probe | ✅ | `scripts/pty_probe.py --cwd my_pi`: `jjk` echo trong input line → keystroke đến handleInput; exit 0, zombie reaped |
| 7 smoke team run | ✅ | runId `team_20260910153550_f936c7f280af8cfc` (fast-fix): 3/3, consistency=1, 382s; executor chạy test:critical đúng 1 lần (102/102 + tsc clean, 27.3s ≪ 120s); verifier đọc cache không re-run; events log cho thấy M6 coalescing sống (`coalesceReason: first/interval/tool_changed/tokens_increased`) |
| 8 final md5 sync | ✅* | md5 mới `f383c691…` sau fix; session hiện tại (start 22:29) chạy bundle TRƯỚC fix → cần restart; session mới (pi2 trong tmux) đã verify live mới (MSG-2) |
| 9a read-only battery | ✅ 13/13 | list / recommend / health / doctor-zombies / status / events / summary / get-workflow / explain / worktrees / graph / search / settings — tất cả trả structured result. Ghi chú: search luôn "No results found" kể cả nội dung chắc chắn tồn tại (F4); graph "No graph found" (fast-fix không có graph data — structured, không lỗi) |
| 9b spawn paths | ✅ 7/7 | sync (T7) / async (F3: fallback sync) / chain `team_20260910154505→154901` 2/2 handoff 421s (không dính quirk #44) / plan (1-step, không spawn) / Agent direct (`f73af63d`) / crew_agent bg + get_result (6 worker probes) / steer ✅ |
| 9b subagent steering | ✅ | **STEER-RECEIVED verbatim** token `STEER-TOKEN-X7Q` + `424242` (agent_mtvq2dil, run team_20260910160850_36a851e8). Workaround: background launch kết thúc parent turn → launch CẶP sibling (BG-6b nhanh đánh thức giữa chừng BG-6a sleep 150s) → steer từ turn đó. 4 negative controls STEER-NONE nhất quán (BG-1..5, steer chưa gửi) |
| 9b-W worker tools | ✅ (sau fix) | **ask**: fired live trong W1 (`ask.requested timeoutSec=45 clamped` → timeout → `task.resumed`; answered-path chưa probe) · **delegate**: grandchild spawn → `CHILD-OK` (transcript seq 76-77, retry sau reject `parent-not-running` trong waiting-state) · **message**: BROKEN → FIXED → **VERIFIED LIVE**: MSG-1 expose bug (F2), fix `1bde7b40`, MSG-2 (session mới, runId `team_20260910162757_0136160319900169`): explorer tools = `ask, bash, delegate, find, grep, ls, message, read`, message(MSGPROBE-888) deliver, 3/3 consistency=1 · **loadout**: role-gating đúng (explorer 8 / executor 11 tools, edit/write/scratchpad executor-only) |
| 9c–9f | ⏭️ | Không chạy đầy đủ sweep本轮 — wait ✅ (dùng 2× join BG-6a/env-probe), status mid-run ✅, settings set/get/unset ✅. Destructive (9d) không chạy (cần xác nhận user); 9e/9f không đụng code path đổi lần này |
| 10a surface E2E | ✅ | tmux: **4/4 pass** 11.0s (trong tmux server riêng) · herdr: **5/5 pass** từ ngoài tmux, socket sống (pane thật hiện ~4s trên herdr user rồi tự dọn) |
| 10b live surface run | ✅ evidence + 🔴 bug | `visibleAgents=["*"]` (set qua `config={args}` đúng cú pháp) → run W1: `worker.surface_spawned {surfaceKind:"herdr", paneId:"w2:p8Z"}` + `worker.started {pid, surface:"herdr"}` — **pane THẬT tạo trong herdr user, worker boot trong pane**. Auto-exit ✅ (pid GONE sau final report), doctor ✅ (0 orphan panes; 1 tab-ref residual `w2:t1A` mux đã bỏ). NHƯNG run-level FAILED — xem F1 |
| 10c herdr path | ✅ | pi host trong herdr pane → provider detect herdr → pane tạo + auto-close + doctor sạch (evidence ở 10b) |
| 11 remediation regression | ✅ | 11a: stores atomicWriteJson 3+3 · census 16 files/70 matches (audited 43) · **full test:unit 7505/7502 pass/0 fail/3 skipped, 685.5s** (11.4 phút, load 1.7) · 11b: wc-gate exit 0 + trong `ci`&`ci:fast` + ci.yml:66 · 11c: validateEnv probe → severity "removed" cả 2 key; wiring register.ts:68 · 11d: 3 slow files, globs disjoint · 11e: nightly KHÔNG set SMOKE (comment :24), weekly-smoke set :25 · 11f: `type=${…}` 3 sites · 11g: cả 2 maps "bottom" · 11h: twins 4/4 (1×; 3× đã verify ở skill-update) · 11i: 0 dead exports + MUST_INCLUDE 5 · 11j: committed-hash OK |

## Findings (bugs / quirks / non-blocking notes)

- **F1 🔴 HIGH — Surface workers là "heartbeat-blind": task.progress không bao giờ về parent → healthy run bị stale-reconcile giết lúc ~340s.** Evidence: run W1 `team_20260910161234_78ef8f7526550282` — worker trong herdr pane `w2:p8Z` hoạt động tích cực 7 phút (transcript: ask → timeout → resume → delegate retry → CHILD-OK → final report 16:19:24), nhưng events.jsonl chỉ có **2 task.progress** (cả hai pre-spawn "Starting ready batch") so với T7 headless chảy liên tục; heartbeat-watcher đói tín hiệu → `crew.task.heartbeat_dead elapsedMs=340611` ×2 → 4 tasks cancelled `no_pid_heartbeat_stale` lúc run 353s; worker hoàn thành NẬP sau đó rồi tự exit sạch. Mọi surface run dài hơn heartbeat threshold (~300s?) sẽ bị giết oan. Headless không dính. 10a E2E pass vì run ngắn. **Chưa fix — cần work item riêng (progress tap cho pane workers / heartbeat nguồn recorder).**
- **F2 🔴 HIGH → FIXED `1bde7b40` — `message` tool invisible với mọi builtin worker từ f843e14a (26/8).** `pi-args.ts:284` `CONTROL_TOOLS=["ask","delegate"]` thiếu `"message"`; cả 10 `agents/*.md` khai `tools:` frontmatter → `--tools <declared>,ask,delegate` lọc message khỏi surface dù `PI_CREW_MSG_ENABLED=1` có trong env worker (env-probe verify: cả 3 gate =1) và prompt-runtime đăng ký đầy đủ. Pin test bổ sung (assertion whose absence let this regress). Verified live sau fix (MSG-2). Silent-broken 2 tuần vì dormant-gate design làm absence trông như "tool không của mình".
- **F3 🟡 MEDIUM — `async=true` fallback sync-blocking**: call ASYNC-1 (team_20260910154257) trả về chỉ khi run HOÀN TẤT (block 113s). Background dispatch không engage trong harness này ("when execution support is enabled"). Hệ quả: không thể respond task.waiting giữa chừng từ agent session (ask answered-path không probe được).
- **F4 🟡 MEDIUM — `team action='search'` luôn "No results found"**: 3 query (task=smoke, goal=Smoke-verify, task=worker.spawned trên runId có events chứa đúng chuỗi đó) đều rỗng. Structured response, không crash — nhưng không tìm ra nội dung tồn tại (index/scope gap).
- **F5 🟢 LOW — `team action='settings'` bỏ qua top-level `args` param thầm lặng** (phải dùng `config={args:...}`); schema chấp nhận param rác không báo lỗi.
- **F6 🟢 LOW — failure summary mâu thuẫn**: W1 trả "0/4 tasks cancelled … All tasks completed successfully." — dòng kết contradicts 4 cancelled tasks.
- **F7 🟢 LOW — chain step label cắt**: "✓ Step 1 [\"Step]" — parse nhãn step bị cắt ở quote đầu.
- **F8 🟢 LOW — health báo 46 corrupted + 104 /tmp zombie**: toàn residue unit-test (run-pa, state-save-manifest-*...) viết vào .crew/state thật khi test:unit chạy trên workspace này — noise cho health action, không phải lỗi runtime.
- **F9 ℹ️ process — background subagent launch kết thúc parent turn ngay**: không thể steer agent nền giữa chừng từ agent-driven session trừ khi có nguồn đánh thức giữa chừng (user message hoặc notification từ sibling). Workaround chuẩn: launch Cặp (sibling ngắn + target dài) — đã documented trong report này, nên đưa vào SKILL.md Tier 9b sau.
- **F10 ℹ️ — worker `ask` tự phát khi chưa được yêu cầu** (explorer hỏi clarify) — gate mở đúng thiết kế, kẹp timeout 45s hoạt động.

## What was NOT run + why
- 9c full sweep (cache/checkpoint/steer-run-level/resume/retry/invalidate) — chỉ wait+status-mid-run; phần còn lại không đụng code path đổi
- 9d destructive (prune/cleanup/forget) — cần explicit user confirmation
- 9e admin CRUD + 9f background (goal-loop/schedule/auto-summarize/anchor/api) — ngoài scope thay đổi lần này
- ask **answered** round-trip — bị chặn bởi F3 (sync-block không cho turn để respond)
- message DM/group + rate-limit burst — notify path đã proven; DM/group để lần sau

## Restart needed?
- [x] Yes — session HIỆN TẠI (start 22:29, bundle `a2c1f24c…`) cần `/quit` + reopen để nhận bundle fix `1bde7b40` (`f383c691…`). Session mới đã được verify live thay thế (pi2/MSG-2). Các session pi khác đang mở cũng cần restart.

## Verdict
**11/11 tier chạy, PASS với 2 HIGH findings — 1 đã fix+verify live (`1bde7b40`, message tool), 1 mở work item (F1 surface heartbeat-blind).** v0.10.5 + fix an toàn ship cho headless (mọi đường dùng chính); surface mode nên bật `visibleAgents` thận trọng với run >5 phút cho tới khi F1 được fix.

## Addendum — dead-worker notification + competing root-cause audit (23:45+07)

Dashboard notifier sau đó báo "Run team_20260910161234_78ef8f7526550282 has 1 dead worker(s)". Thẩm định:

- **Không có worker chết thật.** pid 2397306 exit sạch (0) SAU khi hoàn thành battery; agent record `01_explore` = `completed` (16:19:24.967), `manifest.status = "completed"`, result artifact nằm ở `.crew/artifacts/.../results/01_explore.txt`. Dead-worker flag là mặt sách vở của F1: run-level `run.failed` + 4 tasks cancelled (reconcile 16:18) trong khi state-level agent/manifest completed (worker viết bản ghi sau khi bị "tuyên bố chết"). R vô nghĩa (việc đã xong), K vô nghĩa (pid gone). Khuyến nghị: ignore; hoặc `team action='forget' runId=...` (destructive — cần confirm user) để xóa residue.

- **Thuyết đối lập của W1 worker bị bác.** Final report của worker (viết post-mortem) tự root-cause message-missing là "bundle-vs-source drift: khối đăng ký message-tool không có trong dist/index.mjs" (grep literal 0 matches — đúng sự thật, kể cả bundle MỚI sau fix). Nhưng `pi-args.ts:17` cho thấy `PROMPT_RUNTIME_EXTENSION_PATH = <packageRoot>/src/prompt/prompt-runtime.ts` — **worker-side extension load từ LIVE SOURCE theo thiết kế**, không từ dist. Registration luôn có đủ ask/delegate/message cho CẢ worker MSG-1 lẫn MSG-2; trình phân biệt duy nhất là `--tools` allowlist do PARENT build (parent cũ = CONTROL_TOOLS không message → lọc; parent mới = có message → hiện). Cả hai observation (MSG-1 thiếu / MSG-2 có) được giải thích trọn vẹn bởi allowlist — fix `1bde7b40` đứng vững. Bài học battery: worker tự-điều-tra không thấy được cơ chế `--extension` source-path của host (giống anti-pattern "worker không thấy host gate inputs" của Tier 10).
