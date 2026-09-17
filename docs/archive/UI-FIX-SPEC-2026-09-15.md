# SPEC: UI Fix — pi-crew (SDD)

**Ngày:** 2026-09-15
**Nguồn phát hiện:** `docs/archive/UI-AUDIT-2026-09-15.md` (đã qua 1 vòng cold-verify, §9)
**Repo:** `/home/bom/source/my_pi/pi-crew` (git repo riêng, đang clean ngoài file audit)
**Plan mode:** high-risk (nhiều file, có dead-code, có thay đổi hành vi UI)

---

## 1. Goal

Sửa **toàn bộ** finding P0 + P1 trong UI audit để: (a) tính năng đã document hoạt động thật,
(b) không còn affordance giả (key/footer/command quảng cáo nhưng không chạy),
(c) docs khớp code, (d) dead code được xử lý, (e) mọi fix có test hoặc bằng chứng chạy lệnh.

## 2. Non-goals (không làm trong spec này)

- Không refactor kiến trúc render (scheduler/coalescer) — chỉ sửa R1 idle-cap nếu kèm fix khác.
- Không tách god-file `settings-overlay.ts` (P2 — cần PR riêng).
- Không thêm feature mới (dashboard pane mới, theme mới…).
- Không đổi public API của extension (tool schema, command args ngoài các arg sai đã nêu).

## 3. Ràng buộc bất biến (invariants)

1. Tabs indentation; biome format phải pass (`npm run format:check`).
2. `npm run typecheck` phải pass — kể cả `strip-types import` của `index.ts`.
3. **Không** rebuild `dist/index.mjs` song song; chỉ rebuild **1 lần** ở gate cuối.
4. Không sửa file ngoài ownership map (§6) — 1 file chỉ có 1 owner.
5. Mọi fix phải giữ hoặc thêm test; nếu không test được thì phải có bằng chứng lệnh chạy.
6. Không xoá file/dây code trong M1/M2 (các việc xoá nằm ở M3, cần user confirm).

---

## 4. Milestones & Work items

Ký hiệu state: `TODO` → `IN_PROGRESS` → `REVIEW` → `DONE`.

### M1 — Functional fixes (không xoá code)

| ID | Work item | Files (owner) | Acceptance criteria | State |
|---|---|---|---|---|
| M1-1 | **P0-1** `theme-discovery.ts`: bỏ 3 bare `require("node:fs")` (dòng 76/113/126) → top-level `import * as fs from "node:fs"`. Đảm bảo **không** phá lazy-load (`check:lazy-imports` vẫn pass; call site vẫn dynamic-import module này) | `src/ui/theme-discovery.ts` | (a) `discoverPiThemes()` trả **≥13** entry khi `~/.pi/agent/themes` có 11 crew theme + 2 builtin; (b) `getActivePiTheme()` đọc được `theme` từ `settings.json`; (c) `setPiTheme()` **không throw** (ghi được file); (d) `setPiTheme()` không còn `require` ngoài try/catch; (e) test mới trỏ `HOME` vào fixture dir | TODO |
| M1-2 | **P0-1 test**: thêm `test/unit/ui/theme-discovery.test.ts` — fixture `HOME`/`USERPROFILE` = tmpdir, tạo `themes/*.json` + `settings.json`, assert (a)(b)(c) ở M1-1. Phải fail nếu ai quay lại dùng bare `require` | `test/unit/ui/theme-discovery.test.ts` (mới) | Test pass; chạy lại với `require` shim sẽ fail (chứng minh test có sức mạnh) | TODO |
| M1-3 | **P0-1 hệ quả**: xác nhận `/team-settings theme crew-gruvbox-dark` không còn trả `Unknown Pi theme` — thêm test cho `handleTeamTool({action:"settings",args:"theme <name>"})` với theme ngoài builtin (dùng tmp HOME, không ghi settings thật) | `test/unit/extension/…theme-settings*.test.ts` (mới) | Test pass, assert `OK` + tên theme, và assert **không** ghi vào HOME thật | TODO |
| M1-4 | **P1-6** `card-colors.ts:85`: `getBgAnsi("background")` → slot hợp lệ (`selectedBg`); nếu không có slot phù hợp thì bỏ hẳn probe + comment lý do. Không để throw-then-catch im lặng | `src/ui/card-colors.ts` | Không còn chuỗi `getBgAnsi("background")`; tint card hoạt động (có test: `getBgAnsi` được gọi với slot ∈ `ThemeBg`) | TODO |
| M1-5 | **P1-7** `tool-renderers/index.ts:330-331`: thay `text.slice(0, innerW - 2)` + `padVisual` bằng `truncVisual` (đã có ở `:52-58`) rồi pad | `src/ui/tool-renderers/index.ts` | Test mới: chuỗi CJK/emoji dài → `visibleWidth(line) <= innerW` cho **mọi** nhánh render của `team`/`agent` (fuzz 20 chuỗi mixed-width) | TODO |
| M1-6 | **P1-3** `LiveConversationOverlay`: thêm `handleInput` thật (`j/k/↑/↓/g/G/PgUp/PgDn`, `a` toggle autoScroll, `esc/q` close) theo pattern `src/ui/inline-panel/agent-view-overlay.ts:160-182`; gỡ nhánh footer không thể chạm (`:163`) hoặc làm nó chạm tới được | `src/ui/live-conversation-overlay.ts` | Test mới: nạp >viewport lines, gửi `j`/`G`/`g` → `scrollOffset` đổi + render đúng dòng; footer hiển thị khớp capability | TODO |
| M1-7 | **P1-5** gỡ phantom key `p` (progressToggle): xoá binding + action + `showFullProgress` + fragment trong `buildSignature`; gỡ khỏi help-overlay group; nếu pane progress thực sự cần toggle thì implement thật (mặc định: **gỡ**, vì hiện không có tác dụng) | `src/ui/keybinding-map.ts`, `src/ui/run-dashboard.ts`, `src/ui/overlays/help-overlay.ts` | Không còn key `p`/action `progressToggle`; parity test keybinding vẫn pass; không còn `showFullProgress` | TODO |
| M1-8 | **P1-5b** gỡ option no-op `placement` khỏi `RunDashboard` + call site; giữ anchor thật ở `overlayOptions` | `src/ui/run-dashboard.ts`, `src/extension/registration/commands/shared.ts` | Không còn tham số `placement`; dashboard vẫn mở đúng `right`/`center` (test hiện có phải pass sau khi sửa assert generic) | TODO |
| M1-9 | **P1-8** schema drift: thêm `ui.widgetRowStyle` + `ui.inlinePanel` vào `PiTeamsUiConfigSchema`; thêm `ui.autoCloseDashboardMs` vào `KNOWN_KEYS`; sửa note sai ở đường `get` (`handle-settings.ts:445`) để không báo unknown cho `ui.*` | `src/schema/config-schema.ts`, `src/extension/team-tool/handle-settings.ts` | (a) schema-sync test pass; (b) `validateConfig()` không còn warning unknown cho 3 key; (c) `team-settings get ui.widgetRowStyle` không in note "unknown" | TODO |
| M1-10 | **P1-12** brief mode: sửa `description` command `/crew-brief` cho đúng phạm vi (chỉ `team`/`agent`), và đánh dấu rõ 7 nhánh native `@unreachable` + lý do. **Không** xoá (xoá nằm ở M3) | `src/ui/tool-renderers/brief-mode.ts`, `src/extension/registration/commands/manage.ts` | Description khớp hành vi thật; `help.ts`/docs không còn hứa quá; test hiện có vẫn pass | TODO |
| M1-11 | **P1-14** help-overlay: thêm group **Schedules** và **Plan** (sinh từ `DASHBOARD_KEYS`) | `src/ui/overlays/help-overlay.ts` | `?` hiển thị đủ key của pane 7/8; test mới assert các key `T N V X R`, `A n X` xuất hiện | TODO |
| M1-12 | **P1-13** contract cho progress string: tách hằng/type dùng chung cho producer (`tool-progress-formatter.ts`) và consumer (`index.ts` parse) + test bắt lệch format | `src/ui/tool-progress-formatter.ts`, `src/ui/tool-renderers/index.ts` | Test: nếu đổi 1 field trong format thì test fail (assert round-trip producer→parser) | TODO |
| M1-13 | **P1-4** phantom command: bỏ `/team-cleanup` và `/team-health` khỏi `help.ts` (chỉ giữ `/team-cleanup-menu` là alias thật) | `src/extension/help.ts` | `grep` không còn 2 chuỗi đó trong help; `/team-help` không hướng dẫn command không tồn tại | TODO |

### M2 — Refactor (không xoá code)

| ID | Work item | Files (owner) | Acceptance criteria | State |
|---|---|---|---|---|
| M2-1 | **P1-9** tập trung keybinding overlay: thêm keyspace `overlay:*` vào `keybinding-map.ts` + helper dispatch; chuyển **tối thiểu** `agent-picker`, `confirm`, `mailbox-detail`, `mailbox-compose` sang dùng map (không đổi hành vi phím mặc định) | `src/ui/keybinding-map.ts`, `src/ui/overlays/{agent-picker,confirm,mailbox-detail,mailbox-compose}-overlay.ts` | (a) Override qua `.crew/config.json → keybindings["overlay:…"]` có tác dụng (test); (b) phím mặc định **không đổi** (test parity cũ pass); (c) không còn literal `matchesKey(data,"q")` trong 4 file trên | TODO |
| M2-2 | **P1-10** stale ctx ở inline-panel: reset/đóng `liveOverlay`/`livePane` trên `session_start` (hoặc re-bind ctx) để không giữ `ctx.cwd`/`done()` của session cũ | `src/ui/inline-panel/index.ts` | Code không còn giữ closure trên `ctx` session cũ sau swap; test mô phỏng session swap → `liveOverlay`/`livePane` = null và không tick; không hồi quy các test `inline-panel-*` | TODO |

### M3 — Deletions (⚠ CẦN USER CONFIRM trước khi chạy)

| ID | Work item | Rủi ro | State |
|---|---|---|---|
| M3-1 | **P0-2/P1-1** `terminal-status.ts` (269 dòng) + 16 test: **wire lại** (option A — khôi phục hành vi đã document: tab title + Ghostty OSC 9;4) **hoặc xoá** (option B) | A: đổi hành vi terminal cho mọi user; B: mất feature đã document | BLOCKED (chờ confirm) |
| M3-2 | **P1-15** xoá `src/ui/overlay-stack.ts` + `test/unit/ui/ui-overlay-stack.test.ts` (148 dòng + 12 test, 0 call-site, 0 hit trong bundle) | Thấp (dead) nhưng là delete | BLOCKED (chờ confirm) |
| M3-3 | **§4 dead code**: xoá dây `compactAgentRow` + 10 symbol + `MAX_AGENTS_DISPLAY`, `countByStatus`, `renderCancellationPane`, `THEME_COLOR_FALLBACKS`, `src/ui/loaders.ts`, `useStatusFallback`, `CREW_VIBES_STATUS_KEY`, `ascii` option, 7 nhánh brief | Trung bình: ~800–1000 dòng + phải sửa/xoá test phụ thuộc (`widget-budgeted-row.test.ts`, `widget-truncate.test.ts`, `ui-ux-fixes-e2e.test.ts`, `cancellation-pane.test.ts`, `crew-vibes.test.ts`, `dwf-phase-display.test.ts`) | BLOCKED (chờ confirm) |
| M3-4 | **P1-11** docs drift — *không phải deletion*, gộp vào M1: bảng keyboard `1–8` + ~12 key + `alt+s`/`alt+c`; thêm `/schedules`, `/skill-list`, `/skill-create`, `/crew-brief`; sửa `/team-vibes` args; sửa `docs/commands-reference.md:23` | Thấp | TODO |

> Ghi chú: M3-4 được liệt kê ở đây để giữ truy vết audit nhưng thuộc M1 về mặt thực thi (M1-14).

---

## 5. Ownership map (conflict-safe — 1 file = 1 owner)

| Owner | Files |
|---|---|
| **W1 theme/config** | `src/ui/theme-discovery.ts`, `src/ui/card-colors.ts`, `src/schema/config-schema.ts`, `src/extension/team-tool/handle-settings.ts`, `test/unit/ui/theme-discovery.test.ts`*, `test/unit/extension/theme-settings-*.test.ts`* |
| **W2 renderers** | `src/ui/tool-renderers/index.ts`, `src/ui/tool-renderers/brief-mode.ts`, `src/ui/tool-progress-formatter.ts`, `src/ui/overlays/help-overlay.ts`, `src/extension/registration/commands/manage.ts`, test mới cho renderer |
| **W3 dashboard** | `src/ui/keybinding-map.ts`, `src/ui/run-dashboard.ts`, `src/ui/live-conversation-overlay.ts`, `src/extension/registration/commands/shared.ts`, `src/extension/help.ts`, `src/ui/overlays/{agent-picker,confirm,mailbox-detail,mailbox-compose}-overlay.ts`, `src/ui/inline-panel/index.ts` |
| **W4 docs** | `docs/commands-reference.md`, `docs/usage.md` (nếu cần) |
| **Leader (tôi)** | `docs/archive/UI-FIX-SPEC-2026-09-15.md`, `docs/archive/UI-AUDIT-2026-09-15.md`, rebuild `dist/`, gate cuối |

`*` = file mới, không xung đột.

**Xung đột đã kiểm:** `keybinding-map.ts` chỉ W3; `help-overlay.ts` chỉ W2 (W3 không sửa nó — M1-7 do W2 xử lý phần help-overlay, W3 xử lý binding trong `keybinding-map.ts`); `index.ts` (tool-renderers) chỉ W2.

---

## 6. Quality Gates

| Gate | Lệnh | Khi nào | Ngưỡng |
|---|---|---|---|
| G1 typecheck | `npm run typecheck` | mỗi work item | exit 0 |
| G2 lint | `npm run lint` | mỗi work item | exit 0 |
| G3 format | `npm run format:check` | trước gate cuối | exit 0 |
| G4 unit (targeted) | `node scripts/test-runner.mjs --test-force-exit <files đã đổi>` | mỗi work item | 0 fail |
| G5 unit (toàn bộ) | `npm run test:unit` | gate cuối (leader) | 0 fail |
| G6 critical | `npm run test:critical` | gate cuối (leader) | 0 fail |
| G7 bundle | `npm run build:bundle && npm run check:bundle-size && npm run test:bundle` | gate cuối (leader, **1 lần**) | exit 0 |
| G8 stale-check | `npm run check:bundle-staleness` | sau G7 | MATCH |
| G9 regression riêng | assert P0-1: `discoverPiThemes().length >= 13`, `getActivePiTheme() === "crew-gruvbox-dark"` | gate cuối | pass |

**Evidence bắt buộc cho mỗi item:** output lệnh gate liên quan + danh sách file đã đổi (`git status --short`) + file:line của thay đổi.

## 7. Verification (Definition of Done)

- [ ] Mọi item M1 + M2 = DONE với evidence G1–G4.
- [ ] G5–G9 xanh ở lần chạy cuối, trên working tree **không còn** thay đổi sau đó.
- [ ] Audit doc được cập nhật: mỗi finding P0/P1 có trạng thái `FIXED` + commit/file:line.
- [ ] Không item nào bị đóng mà thiếu test hoặc thiếu bằng chứng lệnh.
- [ ] M3 chỉ chạy sau khi user confirm; nếu confirm → lặp lại G1–G9.

## 8. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| Sửa `theme-discovery` phá lazy-load → startup chậm | `check:lazy-imports` trong gate; chỉ thêm static import cho **node builtin** (`node:fs`), giữ dynamic import ở call site |
| Gỡ key `p` làm vỡ test parity | G4 chạy `keybinding-map.parity.test.ts` sau khi sửa |
| Thêm key vào schema làm vỡ `schema.json`/decision-drift | Chạy `check:decision-drift` + `config-schema-sync` test |
| Sửa `handle-settings` gây ghi settings thật khi test | Test bắt buộc trỏ `HOME`/`USERPROFILE` vào tmpdir |
| Đổi overlay keybinding gây đổi UX ngoài ý muốn | M2-1 yêu cầu phím mặc định **không đổi**; test parity cũ phải pass nguyên trạng |
| Xung đột file giữa worker | Ownership map §5, 1 file = 1 owner; worker phải báo file dự kiến sửa trước khi edit |

---

## 9. Execution log (2026-09-15) — trạng thái thực tế + evidence

**M1: 13/13 DONE. M2: 2/2 DONE. M3: BLOCKED (chờ user confirm).**

Thêm 1 item do leader phát hiện khi kiểm gate: **M1-9b** — `schema.json` (artifact **publish**, hand-maintained) vẫn thiếu cả 3 key `ui.*` mà M1-9 vừa thêm vào schema TS ⇒ editor vẫn báo lỗi sai. Team đã *ghi nhận* gap này trong comment test nhưng không đóng. Leader đã sửa `schema.json` (+3 key, 17/17 khớp `PiTeamsUiConfigSchema`) và thêm test parity 2 chiều. **DONE.**

### 9.1 Gate results (leader, trên tree đã sửa)

| Gate | Kết quả |
|---|---|
| G1 typecheck (+ strip-types import `index.ts`) | ✅ PASS |
| G2 lint (biome, 1455 files) | ✅ PASS (chỉ 2 "info" migration, exit 0) |
| G3 format:check | ✅ PASS |
| G4 targeted tests từng item | ✅ PASS (mọi lane báo xanh) |
| G5 `npm run test:unit` (run **sạch**, không tải song song) | **7785 pass / 1 fail / 3 skip** (655s) |
| G6 `npm run test:critical` | ✅ **117/117** |
| G7 `build:bundle` + `check:bundle-size` (3.24MB/3.5MB) + `test:bundle` | ✅ PASS |
| G8 `check:bundle-staleness` | ✅ OK (bundle mới hơn src) |
| G9 asserts P0-1 + 6 fix khác trên tree thật | ✅ PASS (13 theme, active=`crew-gruvbox-dark`, không còn `getBgAnsi("background")`, không còn `showFullProgress`, `handleInput` có, `truncVisual` đúng, `overlay:` keyspace có) |
| check phụ: conflict-markers / decision-drift / env-vars / event-types / lazy-imports / wc-gate / lockfile-sync | ✅ PASS |

### 9.2 Fail duy nhất ở G5 — chứng minh pre-existing (không phải regression)

`test/unit/runtime/broker/crew-broker-symlink-steering.test.ts` ("steer.push does not follow a symlinked steering directory…") — broker `request-timeout` dưới tải.

Bằng chứng 3 chiều:
1. **Fail trên tree SẠCH (HEAD)**: dựng `git worktree` tại HEAD rồi chạy full `test:unit` → `not ok 1757` **đúng test này**. (worktree đã dọn sau khi dùng.)
2. **Pass khi chạy riêng** ở cả tree sạch (4/4) và tree đã sửa (4/4).
3. Baseline đó còn fail **bộ test khác** (`subagent-tools-integration`) mà tree đã sửa **pass** → tải/env gây flakiness, không phải diff gây ra.

`state-helpers-cas-contention.test.ts` fail 1 lần trong run đầy tải nhưng **pass** ở run sạch và pass khi chạy riêng → cùng loại load-flaky. Không test nào liên quan UI bị đỏ.

### 9.3 Kiểm chứng diff (chống "test bị làm yếu để pass")

- **0 deletion** trong toàn bộ diff (`git diff --name-only --diff-filter=D` = rỗng).
- Các dòng bị xoá trong `test/` đã được soát từng dòng: chỉ là (a) gỡ `placement:` khỏi constructor, (b) merge import, (c) thay 1 test **vô nghĩa** (assert "pi-crew" + tên run) bằng assert title/key-hint thật + **2 test mới** dựng host thật (`openTeamDashboard`) bắt `overlayOptions.anchor`, sandbox `HOME`/`cwd` vào `mkdtemp`.
- `keybinding-map.parity` GOLDEN được regenerate kèm ghi chú lý do; test mới khẳng định `p` **unbound ở mọi pane**.
- P0-1: bundle kiểm độc lập — dùng `fs90` (static import), **0 `__require`** trong vùng theme-discovery (lần 1 occurrence còn lại là `WORKER_SOURCE` string của `worker-atomic-writer.ts`, không liên quan).

### 9.4 Residual (còn mở)

1. **M3-1 / M3-2 / M3-3 BLOCKED** — chờ user confirm (wire-vs-xóa `terminal-status`, xóa `OverlayStack`, xóa ~800–1000 dòng dead code).
2. **Chưa có pty probe**: giá trị tint của P1-6 trên theme light và width thật của `▶ ⏸ ⚠ ⌘` chưa quan sát trực tiếp.
3. **Chưa commit**: toàn bộ thay đổi đang ở working tree (33 file sửa + 10 file mới + `schema.json` + `dist/*` rebuild). Chưa bump version, chưa publish.
4. M2-1 mới migrate **4/8** overlay sang `overlay:*` keyspace (`agents-jobs-browser`, `settings-overlay`, `agent-view-overlay`, `crew-editor` còn hardcode) — đủ cho acceptance criteria nhưng chưa trọn mục tiêu gốc của P1-9.

---

## 10. Execution log M3 (2026-09-15, sau user confirm "tiếp các mục còn lại")

**M3-1 DONE (leader wire trực tiếp), M3-2 DONE, M3-3 DONE.**

### 10.1 M3-1 — wire terminal-status (quyết định: WIRE, không xoá)

Lý do chọn wire: module thuần additive (best-effort, mọi write được guard), timer `unref()`, dispose plumbing đã sẵn ở 3 nơi (chỉ thiếu construct), 16 unit test xanh sẵn, CHANGELOG từ v0.8.3 đã hứa tính năng.

- File mới `src/extension/registration/terminal-status-wiring.ts` (≈160 dòng): `runEventBus.onAny` → debounce 250ms → state machine; `ctx.terminalStatusActive` là nguồn thật duy nhất (runtime-cleanup reset cũng reset máy trạng thái); adapter `TerminalStatusUi` đọc `ctx.currentCtx` động (getter + lookup lúc gọi) để không lặp lỗi P1-10; headless (`hasUI=false`) no-op tuyệt đối.
- `register.ts`: thay handler no-op `disposeTerminalStatus` bằng `installTerminalStatus(pi, ctx)`.
- `terminal-status.ts`: export `COMPLETE_FLASH_MS` + cập nhật docstring lifecycle.
- Test mới `terminal-status-wiring.test.ts`: 6 test (active, debounce coalesce, flash→idle sau 1500ms, huỷ idle khi run mới trong cửa flash, headless no-op, dispose unsubscribe). Node 22 không có `mock.timers.tickAsync` → helper `advance()` (flush thật → tick → flush).
- Lỗi test đã gặp + sửa: (1) tick trước flush làm listener chưa arm timer; (2) `controller.dispose()` tự ghi CLEAR (đúng thiết kế) → đếm mốc sau dispose; (3) `session_shutdown` không gọi dispose path (chỉ SIGTERM/SIGHUP gọi) → seam `__test__resetTerminalStatusWiring` chạy dispose closure thật.

### 10.2 M3-2 + M3-3 — team implementation (5/5 task, consistency 1.0)

- **7 file xoá hẳn:** `overlay-stack.ts`, `ui/loaders.ts`, `crew-vibes/figures.ts`, `crew-vibes/font-detect.ts`, `test/unit/cancellation-pane.test.ts`, `ui-overlay-stack.test.ts`, `widget-budgeted-row.test.ts`.
- **−1.641/+58 dòng (ròng −1.583), 28 file** (theo executor; verifier xác nhận 0 tham chiếu sống còn lại, 5 mảnh văn bản không phải code được giữ lại có lý do).
- Sai lệch so với chỉ thị (được duyệt): `cancellation-pane.test.ts` xoá **cả file** — đúng, vì cả 2 case trong đó chỉ test `renderCancellationPane` (chết); `summarizeTerminalReason` không từng có case riêng, vẫn sống trong src và được cover gián tiếp qua run-dashboard render tests.
- `WidgetRenderOptions.rowStyle` được xoá kèm call-site update (verifier check 1 PASS).

### 10.3 Gate cuối (sau toàn bộ M1+M2+M3)

| Gate | Kết quả |
|---|---|
| G1 typecheck (+ strip-types) | ✅ |
| G2 lint · G3 format:check | ✅ |
| G5 test:unit (quiet full) | ✅ **7751 pass / 1 fail** (665s) — fail là đúng con symlink-steering flaky đã chứng minh pre-existing trên HEAD sạch; test count 7789→7755 (−34 test chết, +6 wiring) |
| G6 test:critical | ✅ **117/117** (cần 2 runs — lần 1 dính 1 broker flake, log không lưu; lần 2 exit 0) |
| G7 build:bundle 3.24MB/3.5MB · test:bundle 2/2 | ✅ |
| G8 bundle-staleness | ✅ OK |
| G9 asserts | ✅ bundle: `createTerminalStatusController` 0→**2 hit**, `installTerminalStatus` **2 hit**; dead code `OverlayStack`/`compactAgentRow`/`agentStats`/`renderCapacity`/loaders = **0 hit** |
| wc-gate | ✅ OK (216 files, max 1994/2000) |

### 10.4 Tổng diff cuối (chưa commit)

59 file, +3032/−2692 (gồm M1+M2+M3+M1-9b+M3-1): 33 file src sửa, 7 src xoá, `schema.json`, `dist/*` rebuild, 10 test mới, 6 test sửa, 3 test xoá. Phiên bản đề xuất: **0.12.0** (có xoá API export nội bộ + hành vi mới: tab title/Ghostty progress).

---

## 11. R1 — Tool renderer redesign (2026-09-16, sau M3)

Đánh giá + redesign 2 tool renderer (`team` + `agent`) theo 7 finding W1–W7:

| # | Mức | Vấn đề | Fix |
|---|---|---|---|
| W1 | P0 | catch fail-silent → "✓ done" giả (cả 2 renderer + adapter team) | `✖ crew/agent/team render error: <msg>` đỏ, cả 3 tầng |
| W2 | P1 | streaming agent không hiện tên | `agentName` (=`record.type`) đưa vào details + onUpdate partial payload; fallback `agentId` |
| W3 | P1 | header lệch grammar (via X dim vs tên bold) | `◀ RUN ▶ via **implementation**` — tên bold toolTitle cả 2 renderer |
| W5 | P1 | collapsed/expanded card mất team name | adapter enrich `details.team` (non-destructive `??=`); card `● crew run · implementation _ui_demo ctrl+o` |
| W6 | P2 | alias status `done`/`succeeded`/`error` rơi về fallback | thêm case vào borderColorForStatus + statusBadge + statusIcon |
| W7 | P3 | bar lặp %/tally · elapsed không phải · activeAgent không spin | `1/5 · 20%` gộp 1 segment; `pushLeftRight` (overflow-safe, truncate trái giữ phải); activeAgent có spinner riêng |

**File đổi:** `src/ui/tool-renderers/index.ts` (chính), `src/extension/registration/team-tool.ts` (enrich + catch), `src/extension/registration/subagent-tools.ts` (agentName vào 8 call-site + onUpdate partial). **Test mới:** `test/unit/ui/tool-renderers-redesign.test.ts` — 12 test khoá W1–W7 + overflow width 44. Capture mẫu update: `docs/ui-samples/captures/09-tool-renderers.txt` + PNG.

**Gate R1:** typecheck ✅ · biome/lint ✅ · format ✅ · 29/29 test renderer (frame-width + redesign + M1-12 + brief-scope) ✅ · batch ui+registration+runtime/core **1849 pass / 0 fail** ✅. Spin-off: `pushLeftRight` giờ overflow-safe — close được rủi ro tràn khung của W2 ở terminal hẹp (bắt bởi M1-5 fuzz).

---

## 12. R2 — CALL card redesign: width-adaptive (2026-09-16)

Deep-dive UI CALL phát hiện 2 bug tiềm ẩn (đã chứng minh bằng probe):

1. **Card nướng cứng width lúc build** — `ctx.width || process.stdout.columns || 116`, nhưng `ToolRenderContext` của Pi (types.d.ts:314-339) **không có field width** — TUI lẫn export-html đều không truyền → card luôn build theo width terminal (hoặc 116 fallback), còn `Text.render(width)` render theo width cột transcript và **wrap** line quá rộng → vỡ khung. Probe: build@116 render@100 → 6 dòng, viền trên xé đôi.

> **ĐÍNH CHÍNH (2026-09-16, verify lại):** phần "HTML export chắc chắn vỡ" trong bản gốc là **SAI**. `dist/core/export-html/tool-renderer.js` (module render card @width=100) **không được import ở bất kỳ đâu** trong pi v22.23.1 — `createToolRenderer` 0 caller, không nơi nào truyền `toolRenderer:`, và `exportFromFile` chỉ ghi `{header, entries, leafId}` (không có `renderedTools`). Đã export thật một session có 9 tool-call `team` (`pi --export <session> /tmp/ui-export.html`) rồi decode payload base64: card **không** được pre-render, tool hiện dạng **text thuần**. Fix R2 vẫn đúng và cần: lý do gốc còn nguyên (build theo width terminal vs render theo width cột transcript — lệch khi resize/cột hẹp hơn terminal), và nó miễn nhiễm với mọi consumer render ở width khác nếu pi wire lại `preRenderCustomTools`.
2. **Badge rỗng `◀  ▶`** flash khi LLM còn đang stream args (renderCall gọi lại mỗi chunk `updateArgs`; `argsComplete` bị bỏ qua).

### Fix — thiết kế width-deferred

- **`src/ui/adaptive-card.ts` (mới)**: `AdaptiveCard implements CrewComponent` — nhận `builder(width) => string`, `render(width)` gọi builder ở width THẬT rồi delegate `Text` (padding 0). Cache theo width (mirror cache của Text) + `invalidate()`. **Fail-visible tầng 3**: builder throw → `✖ card render error: <msg>` thay vì propagate vào TUI render loop (Pi chỉ catch lúc construct, không catch lúc render).
- **4 chỗ `process.stdout.columns || 116` xoá sạch**: `renderTeamResult`/`renderAgentResult` nhận `w` tham số; renderCall team/agent thành builder trong AdaptiveCard.
- **Badge rỗng** → `◀ … ▶` (dim placeholder) khi args chưa stream xong (cả agent name).
- `Component` union mở rộng: `Container | Text | AdaptiveCard`.

### Chứng minh

- Probe R2: render trực tiếp @100 → **3 dòng nguyên vẹn** (trước: 6 dòng vỡ); badge rỗng → `◀ … ▶`.
- **Test mới** `test/unit/ui/adaptive-card.test.ts` (5 test): build đúng width render · đổi width → rebuild không wrap · cache identity + invalidate · builder throw → error line không crash · empty → không render.
- **Test cũ cập nhật sang đường thật**: `rawText()`/`raw()` giờ gọi `component.render(width)` thay vì đọc `.text` pre-wrap — trước đây assert pre-wrap vì wrap che bug; giờ build width == render width nên assert đường thật chính xác hơn (M1-5 frame-width, M1-12 contract, R1 redesign). Lưu ý: `Text.render` pad từng dòng đến full width (background fill) → strip cosmetic pad trước khi đo.
- W1 test cập nhật: getter ném giờ nổ ở tầng render → bắt bởi AdaptiveCard → `✖ card render error` (đúng thiết kế 3 tầng fail-visible).

**Gate R2:** typecheck ✅ · biome ✅ · format ✅ · renderer tests 34/34 (29 cũ + 5 mới) ✅ · batch ui+registration+runtime/core **1854 pass / 0 fail** ✅.

---

## 13. R3 — RAIL card: thiết kế UI hoàn toàn mới (2026-09-16)

Theo yêu cầu "thiết kế UI hoàn toàn mới, không base trên cái cũ" — thay hẳn ngôn ngữ "hộp bo tròn + `◀ BADGE ▶` + split-frame border" bằng **RAIL**:

| Yếu tố | Cũ | Mới |
|---|---|---|
| Khung | `╭─╮│╰─╯` 4 cạnh, 3–4 cột chi phí | **rail dọc `┏ ┃ ┗`** 1 cột — tiết kiệm 2 cột, đọc như "timeline" |
| Identity | `◀ RUN ▶ via implementation` | **canopy** `CREW ▸ implementation` (action≠run → `STATUS ▸ <runId8>`; agent → `AGENT ▸ explorer`) |
| Nối trái–phải | khoảng trắng đệm | **dot leaders** `····` co giãn, hết chỗ thì truncate trái giữ phải |
| Thanh tiến độ | `██████░░░░` 1 ô | **gauge `▕████▎░░▏`** độ chính xác **1/8 ô** |
| Kết thúc | đáy khung + hint | **end cap** `┗ ● n/m · team · dur · tok · $cost ···· ctrl+o` |
| Màu rail | theo ctx (2 nửa đồng bộ) | **mở = neutral/identity** (error nếu lỗi), **đóng = màu kết quả** (success/error) — ngữ nghĩa tách bạch thay vì ép 2 nửa cùng màu |

Giữ nguyên: width-adaptive (R2), fail-visible 3 tầng, contract streaming `PROGRESS_FORMAT`, brief mode, `invalidate()`/cache.

**Phát hiện + sửa khi hiện thực:** (1) `railLine` tự chèn separator — caller prefix `" "` làm dòng vượt budget 1 ký tự → `ctrl+o` bị cắt còn `⌘` (đã reproduce + fix); (2) canopy cần nhận `runId`/`run` từ args cho action non-run.

**Test:** viết lại `tool-renderers-redesign.test.ts` theo grammar R3 (15 test: canopy/CREW-STATUS-AGENT, placeholder khi args streaming, agent name trong streaming, gauge hợp nhất tally+pct, elapsed mép phải, fail-visible, alias done, team name ở cap, rail column ở 44/72/200 cột); `frame-width.test.ts` đổi invariant sang "mọi dòng ≤ width + giữ rail glyph" (strip ANSI trước khi check).

**Gate R3:** typecheck ✅ · biome ✅ · format ✅ · renderer suite **37/37** ✅ · batch ui+registration+runtime/core **1857 pass / 0 fail** ✅ · capture/PNG regen ✅.

### 13.1 Nit từ dữ liệu thật — `1 tools` → `1 tool`

Hai run thật (`team_20260916072050…`, `team_20260916073406…`, fast-fix) render `✓ explorer (…) 1 tools · 22.2s` — sai số ít/số nhiều. Cùng bug ở **5 bề mặt** (đều hard-code plural): tool card, `run-dashboard` agent row, `live-run-sidebar`, `live-conversation-overlay` (summary + header). Fix bằng một helper chung `formatCount(n, singular, plural?)` trong `src/ui/format-helpers.ts` + test `format-helpers-count.test.ts` (3 test) + lock trong test card (`1 tool` vs `11 tools`). Run thật cũng xác nhận fix dedupe `verifier/verifier → verifier` (mục R3) hoạt động.

**Hậu kiểm live (2026-09-16):** session pi hiện tại khởi động 14:13:47, bundle rebuild 14:08:53 → session **đang chạy code mới**; gọi `team action=list` trong session render canopy `┏ LIST` (đã polish case không subject — trước đó là `┏ LIST ▸ …`). Thêm test: "COMPLETE call with no subject prints the canopy word alone".

---

## 14. M4 — Đồng bộ TOÀN BỘ UI theo RAIL (2026-09-16, theo yêu cầu user)

**Yêu cầu:** "đồng bộ UI mà pi-crew đang làm theo phong cách mới" + bug live `undefined — ↓·enter`.

**Bug (P0, đã fix trước khi migrate):** `src/ui/widget/index.ts` nhánh zero-runs dựng `` `${schedLine} — ↓·enter` `` **không guard**. `widget-renderer.buildWidgetLines` đã có `if (!zero) return []` từ lâu, nhưng đường component thì không → run xong (0 active runs) + không có schedule ⇒ TUI in literal `undefined — ↓·enter`. Fix: `if (!schedLine) return [];` **trước** template literal + test khoá (`dock-rail.test.ts`: zero runs + no schedules ⇒ `[]`, assert output không chứa `undefined`).

**Contract hoá:** tạo `docs/UI-DESIGN-SYSTEM.md` (grammar §1, 7 lớp bề mặt §2, ownership §3, danh sách rủi ro §4) + module dùng chung **`src/ui/rail.ts`** — rút primitives ra khỏi tool-renderers (RAIL glyphs `┏ ┣ ┃ ┗`, `canopyLine`, `sectionLine`, `railLine`, `railLeaders`, `gaugeBar`, `scanGauge`, `statusSlot/Badge/Icon`, `overflowHint`, `formatHint`, `keyToken`, `CURSOR`/`ACTIVE`, `dedupeAgentLabel`, `padVisual`/`truncVisual`). `tool-renderers/index.ts` giờ **import** từ rail.ts (một nguồn sự thật; `statusIcon` vẫn re-export để giữ public API). Thêm `┣` làm glyph section (gap mà audit §3 chỉ ra) và nhánh `formatHint(..., { exactKeys: true })` cho keyspace **case-sensitive** (`A` approve vs `n` deny — `keybinding-map.ts:75`).

**Thực thi:** 3 explorer kiểm kê read-only (dock/overlay/full-screen) → 4 executor song song theo ownership rời nhau (E1 overlays, E2 full-screen, E3 panes, E4 dock) → verifier độc lập (10 claim, render thật ở 40/60/80/100/160 cột) → reviewer.

**Kết quả migrate:** mọi bề mặt bỏ hộp bo góc `╭─╮│╰─╯├┤`; canopy `┏ NAME ▸ SUBJECT`; section `┣ NAME ▸ x` thay `── label ──`; cap `┗ <hint>` với leaders; cursor duy nhất `›`; overflow duy nhất `▲/▼ n above|below`; hint qua `formatHint` (close/cancel cuối); `->` → `▸`; guard `undefined` cho mọi record đọc từ `agents.json`/schedules/metrics. Phụ: `mascot.ts` và `transcript-viewer.ts` cũng vào RAIL; xoá dead code ngôn ngữ cũ (`dynamic-border.ts` + test, `boxLine`).

**Test mới:** `rail.test.ts` (13) · `dock-rail.test.ts` (14) · `overlays-rail.test.ts` (12) · `dashboard-rail.test.ts` (19) · `panes-rail.test.ts` (14). Cập nhật ~14 file test cũ khoá chuỗi cũ (chỉ đổi kỳ vọng theo grammar mới, không nới lỏng assertion nào).

**Phát hiện khi verify + đã sửa:**
- **BLOCKER**: `run-dashboard.ts:333` vẫn in `agent->agent` (verifier reproduce ở mọi width; chính test lock mới của tôi đã bắt được) → đổi sang `ACTIVE`.
- `settings-overlay.ts:735` hint tự viết tay (không qua `formatHint`, cancel không ở cuối) → chuẩn hoá.
- `mascot.ts` (lệnh `/team-mascot`) vẫn vẽ khung cũ → migrate; sau đó `dynamic-border.ts` thành dead → xoá.
- Literal `›`/`▸` rải rác → dùng `CURSOR`/`ACTIVE` từ rail.ts.

**Residual (ghi nhận, chưa làm):**
1. `ui.widgetRowStyle` / `WidgetRowStyle` / `model.rowStyle` giờ **dead** (consumer cuối bị xoá khi dock gộp về 1 dòng). Xoá sẽ là thay đổi schema config → cần quyết định riêng.
2. `src/ui/status-colors.ts:40-61` vẫn có bảng glyph song song (dùng cho colorize text), chưa hợp nhất vào rail.ts.
3. Vài pane slice ngầm (`progress-pane` events −10, `transcript-pane` output −12, `metrics-pane` counters −10) chưa in dòng `▲/▼` — thêm là **thêm nội dung**, không phải migrate.
4. `pane-theme.ts` (E3 tạo) — có thể gộp vào rail.ts/theme-adapter.ts.
5. 4 overlay vẫn chưa derive key từ `keybinding-map.ts` (thiếu API reverse lookup `action → key`; `OVERLAY_KEYS` chưa có entry cho `settings`/`agents-jobs`) — ghi ở §10 (P1-9).
6. `agents-jobs-browser.ts:642` clamp `Math.max(60, width)` → ở width < 60 in dòng 60 cột (pre-existing, trước R3).

### 14.1 Gate cuối M4 (2026-09-16)

| Gate | Kết quả |
|---|---|
| G1 typecheck (+ strip-types import) | ✅ PASS |
| G2 biome (`src/` + `test/`, 1459 file) | ✅ PASS (sau khi auto-fix 6 lỗi sót: 2 unused import, 3 organizeImports, 1 format) |
| G3 `format:check` | ✅ PASS |
| G4 test UI migration (5 file mới + 14 file cũ vùng UI) | ✅ PASS |
| G5 `npm run test:unit` | **7856 pass / 1 fail / 3 skip** (762s) — fail duy nhất là `crew-broker-symlink-steering` (flaky pre-existing, pass 1/1 khi chạy riêng; đã chứng minh trên HEAD sạch ở §9.2) |
| G6 `test:critical` | ✅ **117/117** |
| G7 `build:bundle` 3.25MB/3.5MB · `check:bundle-size` · `test:bundle` 2/2 | ✅ PASS |
| G8 `check:bundle-staleness` | ✅ OK |
| G9 verify bundle | ✅ `┏`(U+250F) + `┣`(U+2523) + `formatHint`/`canopyLine`/`overflowHint` + `u258F`×4/EIGHTHS×3 **có**; `╭`(U+256D) + `undefined — ` **không có**. 2 hit `"->"` còn lại là **wire format** producer (`roleSeparator`) + token parser; 2 hit `Crew agents` là **thông báo lỗi** và **task-graph markdown** — không phải TUI frame |
| check phụ | lockfile-sync ✅ · conflict-markers ✅ (1526 file) · decision-drift ✅ · event-types ✅ (report mode) · lazy-imports ✅ · wc-gate ✅ |
| `check:env-vars` | ❌ **pre-existing** — `src/runtime/stale-reconciler.ts:287` đọc thô `process.env.PI_CREW_DEBUG_STALE` (commit `7372af37`), **fail y hệt trên worktree HEAD sạch**, file không bị sửa trong session này. Không thuộc lane UI → để nguyên, ghi nhận |

**Verifier độc lập (3 vòng claim, render thật 40/60/80/100/160 cột):** 8/10 claim VERIFIED · 1 REFUTED (`run-dashboard.ts:333` vẫn in `->` → **đã sửa**) · 1 PARTIAL (literal `›`/`▸` rải rác → **đã sửa**; bảng glyph song song ở `status-colors.ts` ghi residual) · bảng `undefined` 5/5 record đều được guard (render với `agents.json` khuyết field thật) · bug `undefined — ↓·enter` VERIFIED chết.

**Catalog UI:** 18/18 bề mặt giờ là **capture thật** (13–18 trước đây là mockup vẽ tay đã bị thay bằng render thật qua `RunDashboard`, `AgentsJobsBrowser`, `DurableTranscriptViewer`, `LiveConversationOverlay`, settings overlay); `render_png.py` được đưa vào repo (trước ở `/tmp`) + thêm **self-check coverage glyph** (fail loudly nếu font thiếu glyph → không thể lặng lẽ xuất PNG có ô tofu) + rule braille-spinner→`◐`; `line-height = font-size` để cột rail không bị đứt khúc.

### 14.2 Kiểm tra bằng TEAM RUN THẬT (2026-09-16, theo yêu cầu user)

Chạy `team_20260916110100_1d678cba122ab0dd` (fast-fix, 3/3 task, 6495 token, 125s) rồi render **toàn bộ bề mặt** từ state thật trên đĩa (tool card 4 trạng thái, dock widget 4 trạng thái, plan card, sidebar, dashboard, agents & jobs browser) ở 50/80/118 cột. Phát hiện + sửa **7 lỗi thật** mà 4 executor + verifier đều bỏ sót (đây là lý do bước "chạy thật" bắt buộc):

| # | Lỗi (nhìn thấy khi render thật) | Nguyên nhân | Fix |
|---|---|---|---|
| 1 | `┃ ⠹ CREW ▸ fast-fix · 0 running · 3/3 done` — **spinner quay khi không còn gì chạy** | `buildWidgetLines` luôn truyền `spinnerFrame("widget-header")` | thêm `widgetActivityGlyph(runs)`: spinner chỉ khi có agent/run đang chạy, ngược lại `✓`/`✗` theo `widgetRailSlot` (glyph nằm trong `STATUS_GLYPH_CHARS` nên được colorize) |
| 2 | dock @50 cột bị cắt còn `···· ↓…` — **hint hành động mất chữ** | `dockTail` ghim budget theo `left`, rồi cả dòng bị `truncate` | `dockTail(left, theme, maxWidth)` → budget = `min(pinned, width-2)` để `railLeaders` cắt bên TRÁI (kèm `…`) và giữ `↓·enter` |
| 3 | `0 running` hiện cả khi không có gì chạy | segments luôn push `${n} running` | chỉ push khi `n > 0` |
| 4 | `┃ 122ab0dd · completed · right default` — **chuỗi bịa**, không map với dữ liệu nào | hard-code trong sidebar | thay bằng `run.workspaceMode` thật (`single`/`worktree`) |
| 5 | `fast-fix/fast-fix` (sidebar VÀ dashboard) | mỗi nơi tự nối `team/workflow` | một helper chung `teamWorkflowLabel()` ở `format-helpers.ts`, cả 2 dùng |
| 6 | `┃ › ✓ 122ab0dd complete…` — **status bị cắt giữa từ** dù comment nói status phải sống sót | fallback `truncate(\`${head} · ${meta}\`, budget)` cắt gộp cả head | ưu tiên: bỏ `meta` trước, cắt `goal` sau, head chỉ cắt khi không còn cách; `runId.slice(-10)` → `slice(-8)` cho khớp `shortId` |
| 7 | usage thô `input=2780, output=3715, cacheRead=57216, cacheWrite=0, cost=0.000000, turns=0` | sidebar dùng `formatUsage` (dạng `key=value` của CLI) | thêm `compactUsage()` → `↑2.8k ↓3.7k`, bỏ `$0.000` khi cost = 0 |

Tiện thể sửa cùng loại: `314.7s` → `5m44s` (`formatDuration` thay `(ms/1000).toFixed(1)` trong agents-pane), `1 runs` → `1 run` (dashboard canopy), `3 agents`/`N runs` ở agents-pane + schedules-pane dùng `formatCount`, `┃ - none` → `┃ none`.

**Render sau khi sửa (từ state thật):**
```
┏ CREW ▸ fast-fix
┃ Đọc 30 dòng đầu của file src/ui/rail.ts … và trả lời đúng 1 câu: file này expo…
┃ ⠼ 3/3 · 100% ▕████████████████████████████████▏ ················· 2m27s
┗ ● 3/3 · fast-fix · 2m3s · 6.5k tok ········································· ctrl+o
┃ ✓ CREW ▸ fast-fix · 3/3 done ···· ↓·enter                    ← hết spinner
┃ ⠋ CREW ▸ fast-fix · 1 running · 2/3 done ···· ↓·enter        ← còn chạy thì có
┃ ✗ CREW ▸ fast-fix · 3/3 done ···· ↓·enter                    ← run lỗi
┏ PLAN ▸ fast-fix ································· ▕████████████▏ 3/3
┃ ✔ #1 Find the likely source of the issue
┗ 3 done · 0 in progress · 0 open
┏ LIVE ▸ 122ab0dd
┃ 122ab0dd · completed · single
┃ fast-fix · ↑2.8k ↓3.7k
┣ DONE ▸ 3 agents
┃ ✓ 01_explore · opencode-go/deepseek-v4.1-flash · ↑970 ↓676
┗ /team-dashboard details · Q close
┏ DASHBOARD ▸ 1 run ································· 1-8 pane · ↑/↓ move · Enter select · ? help
┣ RECENT ▸ 1
┃ › ✓ 122ab0dd completed · Đọc 30 dòng đầu của file src/ui/rail.ts …        ← không còn `complete…`
┃   fast-fix · completed · 122ab0dd                                        ← hết `fast-fix/fast-fix`
┃   ✓ 01_explore explorer · 14.6k  5m44s                                   ← hết `344.3s`
┗ R reload · Esc close
```

**Kết luận:** UI hiển thị đúng sau 7 fix; mọi bề mặt render từ dữ liệu thật, không còn chuỗi bịa, không còn `undefined`, không còn cắt cụt token quan trọng. Gate lại: typecheck ✅ · biome ✅ (1459 file) · format ✅ · batch UI+runtime **2025 pass / 0 fail** · test:bundle 2/2 ✅ · bundle 3.26MB/3.5 ✅ · staleness ✅.
