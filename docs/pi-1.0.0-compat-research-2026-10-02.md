# pi 1.0.0 ↔ pi-crew Compatibility Research

**Ngày**: 2026-10-02
**Status**: VERIFIED-RESEARCH — mọi claim dưới đây có evidence file:line; các claim chưa verify trực tiếp được đánh dấu rõ (§8 Gaps).
**Scope**: READ-ONLY research. Không npm install vào pi-crew, không sửa source. Output duy nhất = doc này.
**Nguồn đối chiếu**:
- SDK pi 1.0.0 full package: `/tmp/pi100/package` (CHANGELOG.md, docs/, dist/*.d.ts, package.json)
- Baseline 0.99.2: `pi-crew/node_modules/@earendil-works/pi-coding-agent/`
- Repo pi-crew tại commit thời điểm run `team_20261002112756_c18188ea2530391a` (line numbers có thể lệch ±2 nếu source đổi sau ngày này)
**Phương pháp**: 4 explorer shards (core/UI/runtime/extensions) + 1 analyst synthesis, mỗi claim cross-check ≥2 shard; writer đã tự re-verify các trích dẫn load-bearing (xem §9 Verification log).

---

## TL;DR

**pi 1.0.0 tương thích pi-crew ở MỌI bề mặt coupling đã kiểm tra — không có thay đổi code pi-crew bắt buộc nào.** Bề mặt API extension byte-gần-identical: 3 file d.ts trung tâm zero-diff, barrel `index.d.ts` chỉ thêm 1 type (`QuietStartup`). Cả 4 thay đổi hành vi thật của 1.0.0 (fullscreen default, quy tắc `typeof tools.X`, `--provider` yêu cầu `--model`, MCP creds per-server) đều rơi NGOÀI bề mặt pi-crew dùng.

Việc duy nhất PHẢI làm: **bump devDeps `^0.99.1` → `^1.0.0` (4 gói, đồng bộ) + chạy gate ladder §6.2**. Gap số 1 chưa verify: **pi-tui 1.0.0** — bundle-external nên runtime luôn resolve theo Pi của host (§8 G-A).

---

## 0. Bảng impact tổng hợp

Điểm dùng → trạng thái ở 1.0.0 → hành động (`none` / `adapt` / `blocked`) → evidence file:line.

| # | Điểm coupling | Trạng thái 1.0.0 | Hành động | Evidence |
|---|---|---|---|---|
| M1a | 18+ SDK symbols pi-crew import (seam `pi-api.ts`) | Unchanged — tất cả vẫn export, cùng vị trí | none | `pi-crew/src/extension/pi-api.ts:32-42`; `/tmp/pi100/package/dist/index.d.ts:2,3,8,9,19,20,31,36,37` |
| M1b | Barrel diff 0.99.2→1.0.0 | Chỉ **+1 type `QuietStartup`** (additive), còn lại byte-identical | none | `dist/index.d.ts:22` (1.0.0 có, 0.99.2 không); re-diff lines 1–30 = identical ngoài :22 |
| M1c | G2: `DefaultResourceLoader` + `extensionsOverride` | Zero-diff d.ts; option giữ nguyên signature | none | `src/runtime/live-session/live-session-runtime.ts:704-733`; `dist/core/resource-loader.d.ts:87,120,123` (1.0.0) |
| M1d | G22: UI compat guards (`setWidget`/`showCustom`/`setStatusFallback`) | Zero-diff `types.d.ts`; guard feature-detect nên vẫn đúng | none | `src/ui/pi-ui-compat.ts:40-52,70-90,91-97`; `dist/core/extensions/types.d.ts:84,101-104,121-131` (1.0.0) |
| M1e | 19 sự kiện `pi.on` pi-crew đăng ký | Tất cả còn, type không đổi | none | `dist/core/extensions/types.d.ts:1145-1182` (1.0.0); danh sách đầy đủ §1.4 |
| M1f | `registerMcpServer` / `McpExposure` | Vẫn export (không đổi union) nhưng pi-crew **0 dùng** (grep 0 hits) | none | `dist/index.d.ts:11,31`; `dist/core/mcp-servers.d.ts:16,103` |
| M2a | 13 spawn flags `buildPiWorkerArgs` build | Tất cả còn, semantics như cũ | none | `src/runtime/model/pi-args.ts:258-398`; `docs/cli.md` từng dòng — bảng §2 |
| M2b | `--provider` giờ yêu cầu `--model` (fail nếu thiếu) | pi-crew **không bao giờ truyền** (grep src = 0 hits) | none | `docs/cli.md:63-64`; CHANGELOG 1.0.0 Fixed #10236 |
| M2c | `-p` / `--mode json` semantics | Không đổi | none | `docs/cli.md:44-48` |
| M3a | Probing `typeof tools.X` | **0 occurrences** trong src/test/scripts/skills/agents (4 shards grep convergent) | none | CHANGELOG 1.0.0 Changed (rule chỉ áp codemode scripts) |
| M3b | G2 MCP strip vs MCP-exposure mới | **No-op xác nhận** — `builtin:mcp` id giữ nguyên 1.0.0; strip chạy TRƯỚC khi server connect | none | `src/runtime/mcp-proxy.ts:152-154,195-208`; `docs/cli.md:186`; `docs/codemode.md:49` |
| M4 | `tuiMode` default flip `regular`→`fullscreen` | Host-side only; **0 tham chiếu `tuiMode` trong src** pi-crew; worker chạy `-p --mode json` (headless) | docs/harness only | `docs/settings.md:94`; CHANGELOG 1.0.0 Changed; `pi-args.ts:265` |
| M5 | mcp.json auth (per-server creds, `authServerMetadataUrl`) | Additive + host-side migration; pi-crew không đọc/ghi mcp.json | none | `docs/mcp.md:119-121,152-159`; CHANGELOG 1.0.0 Changed/Added |
| M6a | devDeps `^0.99.1` ×4 | Quá cũ cho typecheck/module resolution với 1.0.0 | **adapt**: bump `^1.0.0` ×4 | `pi-crew/package.json:150-153` |
| M6b | peerDeps `"*"` + optional meta | Đã chấp nhận 1.0.0 sẵn | none (giữ `*`) | `pi-crew/package.json:132-138,159-172` |
| M6c | Exports map / subpath blocking | **Identical** 0.99.2 ↔ 1.0.0 → tình trạng Phase D không đổi | none | exports field 2 bản `package.json`; `src/runtime/peer-dep.ts:33-70` |
| G-A | pi-tui 1.0.0 (runtime, bundle-external) | **Chưa verify** — không có tarball trong `/tmp/pi100` | verify trước/at bump | `scripts/build-bundle.mjs:64-69`; §9 G-A |

Không có row nào `blocked`.

---

## 1. M1 — API diff

### 1.1 Khung so sánh

- Pi-crew **không import subpath** nào của `@earendil-works/pi-coding-agent` (grep `pi-coding-agent/` = 0 hits) — toàn bộ coupling qua root entry. Tải SDK runtime qua dynamic ESM `import()` của `exports["."].import`: `src/runtime/peer-dep.ts:33-70`.
- Seam type-level trung tâm: `src/extension/pi-api.ts:32-42` (7 type re-exports + `createBashTool`, `defineTool` runtime).

### 1.2 Kết quả diff các file d.ts (0.99.2 trong node_modules vs 1.0.0 ở /tmp/pi100)

| File | Diff |
|---|---|
| `dist/index.d.ts` (barrel) | **+`type QuietStartup`** ở dòng 22 (settings-manager block). Mọi dòng khác byte-identical. (Đã re-diff lines 1–30.) |
| `dist/core/extensions/types.d.ts` | **Zero diff** → toàn bộ ExtensionAPI/ExtensionContext/ctx.ui/pi.on types/registerMcpServer contract như cũ |
| `dist/core/resource-loader.d.ts` | **Zero diff** → G2 anchor an toàn |
| `dist/core/sdk.d.ts` | **Zero diff** → `createAgentSession`/`createBashTool`/... như cũ |
| `dist/core/mcp-servers.d.ts` | Chỉ **+`authServerMetadataUrl?: string`** (additive, ~:70-75) |

Lưu ý correction: một shard báo "empty diff" cho barrel — sai chi tiết, đúng verdict. Diff thật = **+1 additive type**.

### 1.3 Từng symbol pi-crew import (tất cả UNCHANGED ở 1.0.0)

Qua seam `pi-api.ts:32-42`:

| Symbol | Vị trí export 1.0.0 `dist/index.d.ts` |
|---|---|
| `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ExtensionToolContext`, `ToolDefinition`, `BeforeAgentStartEvent`, `InputEvent`, `InputEventResult`, `ContextEvent`, `KeybindingsManager`, `MessageRenderOptions` | :8 |
| `AgentSessionEvent` | :3 |
| `defineTool` | :9 |
| `createBashTool` | :20 |
| `DefaultResourceLoader` | :19 |
| `getAgentDir` | :2 |

Import rải rác khác (component/theme, vd `src/extension/message-renderers.ts`): `CustomEditor`, `AssistantMessageComponent`, `DynamicBorder`, `getMarkdownTheme`, `ToolExecutionComponent`, `UserMessageComponent`, `Theme` — `dist/index.d.ts:36-37`.

Dynamic hard-require của live-session path (`src/runtime/model/runtime-resolver.ts:52`): `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager` — tất cả vẫn export (:19-22 barrel).

### 1.4 G2 anchor — `DefaultResourceLoader` + `extensionsOverride` (điểm lo ngại lớn nhất, an toàn)

`live-session-runtime.ts:704-733` dựng loader với `cwd/agentDir/noPromptTemplates/noThemes/noContextFiles/systemPromptOverride/appendSystemPromptOverride` và — với role không được phép MCP — `extensionsOverride: stripMcpExtensions`. **Mọi option đó vẫn còn nguyên trong 1.0.0** `dist/core/resource-loader.d.ts:84,87,109,110,123` (zero-diff file). Detector degrade sẵn có (`task.mcp_enforcement_degraded`, `live-session-runtime.ts:734-755`) tiếp tục là runtime tripwire nếu SDK tương lai bỏ loader.

### 1.5 G22 UI guards — vẫn đúng vì feature-detect

`src/ui/pi-ui-compat.ts` bọc theo dạng "có hàm mới gọi, không có thì no-op":
- `setExtensionWidget` → `ctx.ui.setWidget` (:40-52; 1.0.0 `types.d.ts:101-104`, 2 overload như cũ),
- `showCustom` → `ctx.ui.custom` (:70-90; 1.0.0 `types.d.ts:121-131`, overlay options không đổi; additive cho phép factory trả `Promise`),
- `setStatusFallback` → `ctx.ui.setStatus` (:91-97; 1.0.0 `types.d.ts:84`).

Vì guard là name-based feature-detect trên object runtime, zero-diff types.d.ts ⇒ guards giữ nguyên giá trị, đường no-op không kích hoạt.

### 1.6 `pi.on` events (19/19 còn)

`session_start, session_shutdown, session_before_switch, session_before_compact, session_compact, context, resources_discover, before_provider_request, after_provider_response, before_agent_start, agent_settled, turn_end, message_end, tool_execution_start, tool_execution_end, tool_call, tool_result, model_select, thinking_level_select` — tất cả trong block event types 1.0.0 `types.d.ts:1145-1182`. Trang đăng ký tham khảo: `hook-registration.ts:65,95,121`, `lifecycle-handlers.ts:186-275`, `prompt-runtime.ts:835-1098`, `surface-worker.ts:661-707`, v.v.

### 1.7 `registerMcpServer` / `McpExposure`

1.0.0 vẫn export (`dist/index.d.ts:11,31`; union `McpExposure = "codemode"|"deferred"|"direct"|"hidden"` tại `mcp-servers.d.ts:16`). pi-crew **0 call-site** (grep src = 0 hits) — phù hợp khuyến nghị KEEP-STATUS-QUO của design review E1 ngày 2026-10-02 (`docs/mcp-exposure-design-review-2026-10-02.md`). Không phải mục rủi ro bump.

---

## 2. M2 — child-pi spawn flags

Nguồn truth pi-crew: `buildPiWorkerArgs` (`src/runtime/model/pi-args.ts:258-398`). Đối chiếu 1.0.0 `docs/cli.md`:

| Flag pi-crew build | pi-args.ts | 1.0.0 cli.md | Trạng thái |
|---|---|---|---|
| `--mode json` + `-p` | :265 | :44-48 | OK — `-p` = chạy prompts → stdout → exit, như cũ |
| `--no-session` | :266 | :96-98 | OK |
| `--model <id[:thinking]>` | :269-273 | :63-73 | OK — vẫn nhận `provider/id` + suffix `:thinking` |
| `--thinking <lvl>` | :275-277 | :70 | OK — 1.0.0 thêm level `max` (additive; whitelist của pi-args dừng ở `xhigh` → one-way safe) |
| `--no-tools` | :290 | :125-126 | OK |
| `--tools <csv>` | :307 | :120 | OK — vẫn là allowlist thay thế |
| `--exclude-tools <csv>` | :315 | :121 | OK |
| `--extension <path>` (lặp lại; gồm `builtin:mcp`) | :318,334 | :184-186 | OK — `builtin:` scheme + `-e builtin:mcp` vẫn documented |
| `--no-skills` | :336 | :190 | OK |
| `--skill <path>` | :337 | :188,190-191 | OK |
| `--system-prompt` / `--append-system-prompt <file>` | :347 | :212-219 | OK |
| `@<taskfile>` positional | :364 | :8, :50-52 | OK — chỉ RPC mode từ chối `@file`; pi-crew dùng json mode |
| Env `PI_CREW_*` / `PI_TEAMS_*` (KIND/DEPTH/ROLE/INHERIT_*/MAX_OUTPUT) | :371-391 | — | pi-crew đọc, không phải pi — không liên quan |

**`--provider`**: 1.0.0 đổi thành fail khi thiếu `--model` (`docs/cli.md:63-64`, CHANGELOG Fixed #10236 — trước đó silently ignore). pi-crew **không truyền flag này ở bất kỳ đâu** (grep src = 0 hits, ≥3 shards độc lập) → non-issue.

**`-p`/print semantics**: không đổi (`docs/cli.md:44-48` so sánh trực tiếp 0.99.2 docs — cùng bảng, cùng mô tả).

Lưu ý cấu trúc: `pi-args.ts:259-264` comment đã ghi rõ **không được thêm argv flag lạ** — pi dùng strict option parser reject unknown flags. Điều này đúng ở cả 2 version.

---

## 3. M3 — codemode semantics

Hai câu hỏi, hai câu trả lời no-op:

1. **`typeof tools.X` → `"X" in tools`** (CHANGELOG 1.0.0 Changed, áp cho codemode scripts): grep toàn `src/ test/ scripts/ skills/ agents/ index.ts` của pi-crew = **0 occurrences** `typeof tools` (4 shards convergent; match duy nhất là CHANGELOG/notes, không phải code). pi-crew cũng **không bao giờ bật codemode/tool_search** (grep = 0; CONTROL_TOOLS chỉ gồm `ask/delegate/message`, `pi-args.ts:286`). → Không cần migrate gì.

2. **MCP exposure mới** (`searchTools`/`describeNamespace`/`mcp_servers` system prompt section — cơ chế có từ 0.99.x, tinh gọn thêm ở 1.0.0): chỉ kích hoạt khi có MCP server connect. G2 strip MCP extension **ở resource-loader, trước khi load code/connect** (`mcp-proxy.ts:152-154` — match chính xác `builtin:mcp` + path chứa `pi-mcp-adapter`; `:195-208` filter). Với role bị strip: không extension MCP → không server → không section, không searchTools → **no-op xác nhận**. `builtin:mcp` vẫn là id hợp lệ trong 1.0.0 (`docs/cli.md:186`; `dist/core/source-info.js:1`).

Residual (không phải delta 1.0.0, ghi nhận lại): denylist theo TÊN nên một adapter MCP đổi tên sẽ lọt — documented limitation tại `mcp-proxy.ts:145-151`, root fix là allowlist (backlog SDD-2 §13).

---

## 4. M4 — TUI fullscreen default

- **Thay đổi**: `tuiMode` default `regular` → `fullscreen` (`docs/settings.md:94` — verify trực tiếp; CHANGELOG 1.0.0 "Changed" #1). Escape hatch: `"tuiMode": "regular"` trong `~/.pi/agent/settings.json` hoặc `--tui-mode regular` cho host session (`docs/cli.md:221-222`).
- **pi-crew src: 0 tham chiếu** `tuiMode`/`fullscreen` (grep 2 shards). Worker luôn `--mode json -p` (`pi-args.ts:265`) → không TUI trong worker process.
- Mọi surface pi-crew đều mode-agnostic: crew widget qua `setWidget` placement `aboveEditor`/`belowEditor` (`src/ui/widget/index.ts:455-523`), 8 overlay page qua `custom({overlay:true})` (`src/extension/registration/ui.ts:86-116`; `viewers.ts:60,113,175`; `commands/dashboard.ts:55,158`; `commands/shared.ts:143`; `ui/inline-panel/index.ts:151`), resize qua SIGWINCH/stdout (`widget/index.ts:104-113`).
- **Hành động**: KHÔNG code change; KHÔNG set tuiMode trong code pi-crew (đó là preference của user host — pi-crew không được enforce). Việc cần làm nằm ở harness: T10/T13 dùng tmux `capture-pane` — fullscreen alt-screen đổi nội dung capture → có thể phải điều chỉnh **harness** (không phải source), và chạy T5/T6/T10 ở **cả hai tuiMode** khi bump (docs của pi cũng khuyến nghị test extension ở cả hai mode, `docs/tui.md:112`).

---

## 5. M5 — MCP auth/config

- 1.0.0 thêm: `oauth.authServerMetadataUrl` (`docs/mcp.md:152-159`, CHANGELOG Added #10172), Radius `auth: { provider: "radius" }` (CHANGELOG), RFC 9207 `iss` checks, **credentials lưu per server name+URL** — creds cũ lưu theo URL-only được **host tự migrate** sang server đầu dùng nó (CHANGELOG Changed #10252; `docs/mcp.md:119-121`).
- pi-crew **không đọc/ghi mcp.json** (grep: chỉ comment). G2 strip keyed theo *tên extension* (`builtin:mcp`, `pi-mcp-adapter`), không theo schema mcp.json → **worker loadout không cần chỉnh gì**.
- `pi-mcp-adapter` vẫn là replacer được document (`docs/mcp.md:242`) → strip path-segment match tiếp tục đúng.
- Việc duy nhất: sau bump, chạy lại G2 battery (T4/T8 live-session path) để xác nhận strip còn hiệu lực trên host 1.0.0 thật.

---

## 6. M6 — Bump plan

### 6.1 Quyết định deps

| Mục | Khuyến nghị | Lý do (evidence) |
|---|---|---|
| peerDependencies | **Giữ `"*"`** | `package.json:132-138` + optional meta `:159-172`; pi-crew chỉ import root entry; exports map 1.0.0 identical ⇒ không có lý do siết |
| devDependencies | **Bump `^0.99.1` → `^1.0.0` ×4 đồng bộ** (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) | `package.json:150-153`; pi-coding-agent 1.0.0 tự phụ thuộc các sibling `^1.0.0` → bump lệch sẽ gây dual-version |
| Exports map / subpath | **Không đổi tình trạng** | `./client` + `./experimental/plugin` vẫn `source`-condition-only ở CẢ 2 bản → Phase D note "0.99 chặn require subpath" vẫn đúng như cũ ở 1.0.0, và pi-crew 0 subpath import (`peer-dep.ts:33-70`) |
| Node | OK | SDK engines `>=22.19.0`; pi-crew `node>=22`; Node hiện tại 22.23.1 |

### 6.2 Gate ladder (5 phase, theo skill real-test-pi-crew)

- **Phase 0 — chuẩn bị (đóng G-A + tripwire)**: fetch tarball `@earendil-works/pi-tui@1.0.0`, diff d.ts cho 12 symbol pi-crew import (5 là runtime value: `Text`, `matchesKey`, `visibleWidth`, `truncateToWidth`, `Markdown` — sites: `ui/key-utils.ts`, `ui/mascot.ts`, `ui/rail.ts`, `ui/inline-panel/*`, `ui/tool-renderers/index.ts`, `utils/visual.ts`, `extension/message-renderers.ts`). Tripwire rẻ: `diff` 4 file d.ts (`index.d.ts`, `core/extensions/types.d.ts`, `core/resource-loader.d.ts`, `core/sdk.d.ts`) 0.99.x vs bản host. Runtime detector `task.mcp_enforcement_degraded` đã sẵn (`live-session-runtime.ts:734-755`).
- **Phase 1 — bump**: sửa 4 dòng devDeps `package.json:150-153` → `^1.0.0`, giữ peer `*`; `npm install` trong pi-crew repo.
- **Phase 2 — static gates**: `npm run typecheck` (`tsc --noEmit`) + `npm run lint` + `npm run test:critical`. ⚠️ Chạy unit gate **trong pi-crew worker** phải scrub `PI_CREW_*` env trước (gotcha đã biết — một số test assert absence sẽ fail 5/14 nếu không scrub).
- **Phase 3 — bundle**: `npm run build:bundle`. **Bắt buộc** — live session load `dist/index.mjs`, không load src; đổi deps mà không rebuild = không thấy gì xảy ra.
- **Phase 4 — real-test ladder**: T1 (critical) → T2 (kill-switch) → T3 (bundle+md5) → T4/T8 (live-session sync = G2 path) → T5/T6 (theme probes, **cả hai tuiMode**) → T10 (panes/tmux) → T13 (UI render real-run) → T7 (smoke run).
- **Phase 5 — release**: theo pre-commit runbook (CHANGELOG, `npm version patch`, full gates, `git add -f dist/` khi commit bundle, publish + release).

---

## 7. Breaking thực tế vs không ảnh hưởng

**Số thay đổi 1.0.0 thực sự break pi-crew: 0.** Bốn thay đổi hành vi lớn và lý do từng cái miss:

| Thay đổi 1.0.0 | Vì sao không chạm pi-crew |
|---|---|
| TUI fullscreen mặc định (settings.md:94) | Worker headless (`-p --mode json`, pi-args.ts:265); src 0 tham chiếu tuiMode; chỉ ảnh hưởng UX/verify host-side |
| `typeof tools.X` → `"X" in tools` (codemode) | pi-crew 0 occurrences; codemode/tool_search không bao giờ bật trong worker |
| `--provider` không có `--model` → fail (cli.md:63-64) | pi-crew không truyền `--provider` (grep 0 hits) |
| MCP OAuth creds per-server + migration | Host-side; pi-crew không đụng mcp.json; G2 strip theo tên extension |

Additive an toàn: `+QuietStartup` (index.d.ts:22), `+authServerMetadataUrl` (mcp-servers.d.ts), `+--thinking max` (cli.md:70), `+createCodemodeExtension`/`createToolSearchExtension` exports mới (index.d.ts:29-33) — pi-crew không dùng cái nào.

---

## 8. Open gaps (phải mang theo khi bump)

- **G-A (CAO — gap #1): pi-tui 1.0.0 chưa verify.** Không có tarball trong `/tmp/pi100`. 22 file pi-crew import `@earendil-works/pi-tui` (12 symbol, 5 runtime value). Vì pi-tui là **bundle-external** (`scripts/build-bundle.mjs:64-69` — "consumers' Pi versions resolve naturally"), host Pi 1.0.0 (phụ thuộc pi-tui `^1.0.0`) sẽ load UI code pi-crew trên pi-tui **1.0.0 ở runtime bất kể devDeps pi-crew**. Mitigation: Phase 0 fetch-and-diff; nếu không làm được, chấp nhận `tsc` (sau bump, d.ts pi-tui 1.0.0 được typecheck) + T5/T6/T10 làm gate bù.
- **G-B (MED): diff mới ở cấp export-name, chưa diff member-by-member từng interface.** Gate bù: `tsc --noEmit` ở Phase 2 chính là kiểm tra này.
- **G-C (MED): render thật dưới fullscreen alt-screen chưa kiểm chứng** (widget visibility, nội dung `capture-pane` tmux ở T10/T13). Gate bù: chạy T5/T6/T10 ở cả hai tuiMode; chỉnh harness nếu cần (harness, không phải source pi-crew).
- **G-D (LOW): model-generated content** có thể sinh script probing `typeof tools` — nhưng worker không bật codemode → lý thuyết.
- **G-E (LOW, pre-existing):** G2 denylist theo tên bỏ lỡ adapter đổi tên (`mcp-proxy.ts:145-151`) — không phải delta 1.0.0, giữ nguyên residual.
- **G-F (LOW):** nghiên cứu giả định `/tmp/pi100/package` docs/d.ts là authoritative cho binary pi thật trên máy user. Nếu host binary khác, chỉ ảnh hưởng độ khẩn cấp (urgency), không ảnh hưởng verdict API.

---

## 9. Verification log (writer)

Đã re-verify trực tiếp trong run này (không tin report mù):

- `diff` quan sát: `dist/index.d.ts:22` (1.0.0) chứa `type QuietStartup` trong settings-manager export block; `:2` getAgentDir, `:19` DefaultResourceLoader, `:20` createBashTool/createAgentSession, `:31` McpExposure — khớp shard.
- `CHANGELOG.md` 1.0.0: xác nhận 4 thay đổi hành vi + các mục additive (đọc trực tiếp :1-60).
- `docs/settings.md:94` — hàng `tuiMode` default `"fullscreen"` (đọc trực tiếp, đếm dòng).
- `docs/cli.md:40-69` — bảng `-p`/`--mode` semantics, `--provider` "It requires `--model`", RPC từ chối `@file`.
- `pi-crew/src/extension/pi-api.ts:25-42` — seam 7 type + 2 runtime export.
- `pi-crew/package.json:132-172` — peer `*` ×5 + optional meta; devDeps `^0.99.1` ×4 tại :150-153.
- `pi-crew/src/runtime/live-session/live-session-runtime.ts:690-760` — G2 loader + `extensionsOverride: stripMcpExtensions` + event `task.mcp_enforcement_degraded`.
- `pi-crew/src/runtime/model/pi-args.ts:258-312` — `--mode json -p`, `--no-session`, `--model`, `--thinking`, `--no-tools`, `--tools`, CONTROL_TOOLS.
- `pi-crew/src/runtime/mcp-proxy.ts:145-208` — isMcpExtensionPath (`builtin:mcp` exact + `pi-mcp-adapter` contains), g2EnforcementDegradationReason, stripMcpExtensions.
- `pi-crew/src/ui/pi-ui-compat.ts:36-97` — 3 guard feature-detect.
- `pi-crew/scripts/build-bundle.mjs:64-69` — pi-tui trong danh sách external.

Claims grep-based (0 hits `typeof tools` / `--provider` / `tuiMode` trong src / `registerMcpServer`; 22 file import pi-tui; exports map identical) = convergent ≥2 shards độc lập + synthesis re-check; verifier step nên re-run như drift tripwire.

**Changed files của step này**: chỉ `pi-crew/docs/pi-1.0.0-compat-research-2026-10-02.md` (file này). Không sửa source, không npm install.
