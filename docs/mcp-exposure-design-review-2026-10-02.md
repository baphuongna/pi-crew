# E1 Design Review — Expose MCP cho pi-crew worker: (A) broker-RPC proxy vs (B) `registerMcpServer`

**Ngày**: 2026-10-02
**Status**: PROPOSED — chờ user quyết các câu hỏi mở (§7)
**Scope**: READ-ONLY design review. Không thay đổi code. Mọi evidence trong doc đã được verify trực tiếp tại repo/env ngày 2026-10-02 (xem Phụ lục).
**Refs**:
- pi-crew-sdd-2026-09-30-buoi1.md (SDD-2 execution record): :428-446 (3 remediation options), :496-545 (HIGH residual + gates), :660-686 (queue SDD-5)
- src/runtime/mcp-proxy.ts (G2/E1 module), src/runtime/live-session/live-session-runtime.ts:694-755, src/runtime/model/pi-args.ts:282-335
- SDK `@earendil-works/pi-coding-agent` 0.99.2: CHANGELOG, dist/core/mcp-servers.d.ts, dist/extensions/mcp/index.d.ts, docs/mcp.md

---

## TL;DR

**Khuyến nghị: KEEP-STATUS-QUO (có điều kiện).** Không build E1 (Option A) và không tích hợp
`registerMcpServer` (Option B) ở thời điểm này. Lý do cốt lõi: **A và B giải hai bài toán khác
nhau** — A là cơ chế *chia sẻ có mediation* (credentials/connections ở parent), B là cơ chế
*curate/khai báo server vào session* (child tự connect) — trong khi leak thực tế còn tồn (đường
CLI) là bài toán thứ ba: **chưa có cơ chế nào chặn extension auto-discovery**, và fix rẻ
nhất cho nó là settings denylist (0 dòng code pi-crew), không phải A hay B. Option B thêm rủi ro
SDK-drift cao (API ra mắt 0.99.0 ngày 2026-09-29 — **3 ngày trước ngày review này**, và exposure
semantics đã đổi một lần trong chính 0.99.0→0.99.2).

Điều kiện kèm và trigger chuyển hướng: xem §5. Open questions cho user: §7.

---

## 1. Bối cảnh hiện tại (đã verify 2026-10-02)

### 1.1 G2 đã làm gì — và ở đâu

- **G2 (role MCP gate) đã land nhưng CHƯA release**: nằm trong CHANGELOG `[Unreleased]` trên
  đầu 0.11.5 (pi-crew/CHANGELOG.md:3-21), thuộc số 33 local commit chưa push (user-gated,
  SDD log :686). Cơ chế: với role không được phép MCP (read-only/unknown/undefined —
  default-deny), extension MCP bị **strip tại resource-loader** qua
  `DefaultResourceLoader({ extensionsOverride: stripMcpExtensions })` — không load code, không
  connect server (`live-session-runtime.ts:694-755`, `mcp-proxy.ts` → `stripMcpExtensions`).
- **Chỉ áp cho đường SDK live-session** (opt-in `runtime.preferLiveSession`,
  `live-session-runtime.ts:712-713`). F1 denylist (`agent.excludeExtensions`) KHÔNG áp đường
  live-session — documented limitation, không phải bug im lặng (`live-session-runtime.ts:708-711`).
- **Fail-open có cảnh báo**: nếu SDK ngừng export `DefaultResourceLoader` (version drift),
  runtime phát event `task.mcp_enforcement_degraded` thay vì im lặng
  (`live-session-runtime.ts:738-754`, helper `g2EnforcementDegradationReason`).
- Remediation hardening kế tiếp: `shareMcp` phải **explicit `true`**, `false`/`undefined` đều
  deny (pi-crew/CHANGELOG.md `[Unreleased]` mục 1; pin bởi 15/15 test trong
  `test/unit/runtime/core/mcp-proxy.test.ts`).

### 1.2 E1 (proxy thật) chưa build

- `mcp-proxy.ts` header tự ghi: *"E1 (real parent→child proxying) is unbuilt"*.
- `createMcpProxyTools()` là stub **trả `[]`** ("will be enhanced when we add inter-process MCP
  call forwarding").
- `buildMcpProxyConfig` / `buildMcpProxyFromSession` **0 production call-site** (CHANGELOG
  `[Unreleased]`: "The two `mcp-proxy` config helpers had no production call sites"). Toàn bộ
  wiring mới cho E1 là new-surface.

### 1.3 Đường CLI (default cho team runs) là residual HIGH — WI-4

Team runs mặc định spawn worker qua child-pi CLI; đường này:

- D5: loadout mặc định = **full session** — `--no-extensions`/`--tools` chỉ xuất hiện khi
  agent `.md` khai explicit; extension discovery hoạt động như main session
  (`pi-args.ts:288-334`).
- F1 `excludeExtensions` chỉ lọc **declared** extensions (sau SEC-1 strip) — **auto-discovery
  không bị lọc** (`pi-args.ts:326-335`).
- Hệ quả (SDD log :496-511, HIGH của security-reviewer, tái xác nhận): (a) MCP extension vẫn
  **LOAD+CONNECT** với mọi role kể cả khi tool surface bị `--tools` allowlist lọc; (b) role
  unknown/custom không khai `tools:` frontmatter → **full MCP surface**.

### 1.4 Hiện trạng env này (quan trọng — đã correction so với handoff trước)

Explorer report cũ claim "pi-mcp-adapter KHÔNG được install trong env này". **Sai** — verify
trực tiếp ngày 2026-10-02:

| Sự thật | Evidence |
|---|---|
| `npm:pi-mcp-adapter` **đang configure** trong packages của host | `~/.pi/agent/settings.json` → `packages` |
| Adapter **đã install** | `~/.pi/agent/npm/node_modules/pi-mcp-adapter/` (tồn tại) |
| Config sống với **~15 server kèm credentials** (firecrawl, zai-mcp, web-search-prime, hostinger×4, …) | `~/.pi/agent/mcp-adapter.json`; "15 server" theo SDD log :428-429 |
| **KHÔNG có** `mcp.json` sống (chỉ `.bak` 2026-08) | `~/.pi/agent/mcp.json.bak.*` |
| Settings **đã có** `"extensions": ["-builtin:mcp"]` | `~/.pi/agent/settings.json` |

Hệ quả phân tích: vector MCP thực tế trong env này là **replacer package** (pi-mcp-adapter),
không phải `builtin:mcp`. Entry `-builtin:mcp` hiện có **không nhắm đúng vector** — SDK docs
nói rõ: extension đăng ký `/mcp` (như pi-mcp-adapter) **thay thế** built-in MCP support cho
session, và `-builtin:mcp` chỉ tắt built-in (SDK docs/mcp.md §"Replace the built-in MCP
support"). Nghĩa là: remediation (a) của SDD-2 **như-đã-áp-dụng chưa đóng** residual leak trên
đường CLI — xem §4.

### 1.5 Denylist theo tên bị bypass được

`isMcpExtensionPath` là name-based denylist (`builtin:mcp` + path chứa `pi-mcp-adapter`).
Replacer **đổi tên** thì thoát strip trên đường live-session — đã được ghi nhận in-code là
KNOWN LIMITATION; root-fix là extension filter dạng allowlist (backlog SDD-2 §13).

### 1.6 SDK surface cho Option B — mới 3 ngày tuổi

- Phiên bản cài: `@earendil-works/pi-coding-agent` **0.99.2** (2026-09-30). pi-crew khai
  peer-dep `"*"` (optional) + devDeps `^0.99.1` (pi-crew/package.json).
- `pi.registerMcpServer()` + MCP-as-builtin-extension + `McpExposure` ra mắt **0.99.0 —
  2026-09-29** (SDK CHANGELOG), tức **3 ngày** trước ngày review này.
- Exposure semantics **đã đổi** ngay trong 0.99.0→0.99.2 (default `codemode` không còn hiện
  trong codemode description; đổi naming `mcp__<server>__<tool>` với `-`→`_` — SDK CHANGELOG
  0.99.2, #10212/#10239). Bề mặt API đang còn di chuyển.
- 0 occurrence của `registerMcpServer|RegisteredMcpServer|McpServerRegistry` trong
  `pi-crew/src/` (grep kép độc lập của explorer + analyst) → B là tích hợp hoàn toàn mới.

---

## 2. Nhận định trọng tâm: A và B giải hai bài toán khác nhau

Làm rõ trước một hiểu nhầm trong cách đặt vấn đề: **đăng ký server vào HOST session (goal's
framing của B) không expose gì cho worker** — worker là process riêng với session riêng; nó
không thấy servers mà host đăng ký. Dạng hữu dụng của B cho worker-exposure là **đăng ký trong
session của CHILD** — chính là E1-B trong log SDD-2 (:441), carrier tự nhiên là prompt-runtime
extension mà pi-crew đã inject vào mọi child (`--extension PROMPT_RUNTIME_EXTENSION_PATH`,
`pi-args.ts:322`).

| | Option A — broker-RPC proxy | Option B — `registerMcpServer` (E1-B) |
|---|---|---|
| **Bài toán giải** | *Chia sẻ có mediation*: worker gọi MCP qua channel tới parent; credentials + connections **chỉ ở parent**; per-call audit qua event log; custom tools che được **cả hai đường** (thay thế hoàn toàn MCP extension trong child). | *Curate/khai báo*: extension trong child khai đúng server subset role được dùng; **child tự connect** (trừ server child-local); kiểm soát fine-grained qua `McpExposure`/`toolExposure` (`hidden`/`codemode`/`deferred`/`direct`). |
| **Cơ chế SDK** | Không phụ thuộc API MCP của SDK — chỉ cần `customTools` + channel worker→parent (precedent: `irc-tool.ts` side-channel). | SDK core "chỉ validate + store registrations"; extension xử lý `mcp_servers_change` mới connect (SDK `mcp-servers.d.ts` header). Tool pipeline + permission hooks áp như tool thường (SDK `extensions/mcp/index.d.ts`). |

Điểm mấu chốt cho quyết định: **cả A lẫn B đều KHÔNG tự đóng leak đường CLI.** Leak đó tồn tại
vì extension auto-discovery (packages từ settings) không bị lọc trên đường CLI. A và B là cơ
chọn-lựa-nội-dung; đóng leak cần cơ chế **chặn-khỏi-khám-phá** (denylist/filter) — xem §4. Ai
gộp hai bài toán này sẽ ra khuyến nghị sai.

---

## 3. Bảng so sánh A vs B — 5 trục

| Trục | A — broker-RPC proxy | B — `registerMcpServer` | Evidence |
|---|---|---|---|
| **Độ phức tạp** | **Cao nhất.** Cần: RPC bridge mới trong protocol (MCP là multi-round: list/call/resources, timeout, cancellation), proxy tool cho từng parent server, wiring call-site hoàn toàn mới (hiện 0 call-site). Stub hiện tại tự nhận "can't forward MCP calls without the parent's MCP manager reference" (`mcp-proxy.ts` → `createMcpProxyTools`). Precedent channel có (`irc-tool.ts` worker→parent) nhưng chỉ cho side-channel nhỏ. | **Thấp hơn.** Một call `pi.registerMcpServer(name, config)` từ extension trong child (prompt-runtime đã inject mọi child); SDK lo connect, naming `mcp__<server>__<tool>`, exposure. Việc còn lại: per-role policy + config plumbing + truyền credentials xuống child. | `mcp-proxy.ts` (stub + header); `pi-args.ts:322`; SDK docs/mcp.md §"Add servers from extensions"; `src/runtime/custom-tools/irc-tool.ts`; `src/runtime/broker/` (protocol/inbox/delegate đã ổn định, crew-broker.ts ~2.3k dòng — explorer-verified) |
| **Rủi ro regression** | Cao: chạm spawn-path + protocol + child tool surface → theo decision table real-test là **T7 + T9b-W + pinned suites**; surface RPC mới = mặt tấn công mới (broker perms). Cơ hội tốt: proxy helpers đã hardened default-deny + 15 test pin sẵn. | Trung bình: thay đổi chủ yếu **additive** trong prompt-runtime; không đụng spawn args. Rủi ro thật là **SDK-drift fail-open** — đúng pattern mà `g2EnforcementDegradationReason` sinh ra để phát hiện. Nếu làm B buộc phải kèm degradation-event tương tự. | `skills/real-test-pi-crew/SKILL.md` (mcp-proxy/pi-args/live-session → T7+T9b-W); `mcp-proxy.test.ts` (15 tests); `live-session-runtime.ts:738-754` (precedent degradation event) |
| **Lợi ích least-privilege** | **Mạnh nhất.** Credentials/connections không bao giờ xuống child; audit per-call ở parent; che được cả đường CLI lẫn live-session (custom tools thay thế MCP extension). Là lựa chọn duy nhất khi policy là "worker không được giữ credential". | **Trung bình.** Fine-grained nhất về *surface* (`toolExposure` per-tool, `hidden`, `deferred` — SDK mcp-servers.d.ts), permission hooks áp như tool thường. NHƯNG: stdio/http creds phải xuống child process (`env`/`headers` trong config); và **không tắt auto-discovery** — child vẫn thấy adapter servers trừ khi có thêm lever chặn (B là curation, không phải denial). | SDK `mcp-servers.d.ts` (`McpExposure`, `toolExposure`); SDK `extensions/mcp/index.d.ts` ("Every call runs through pi's tool pipeline"); §1.3-1.4 (auto-discovery không lọc trên CLI) |
| **Chi phí duy trì** | Cao nhất: phiên bản protocol, timeout/streaming, server lifecycle, per-server proxy mapping — toàn bộ owned by pi-crew. | Thấp–trung: phần nặng do SDK sở hữu; mỗi breaking change SDK MCP = phải theo. | — |
| **Tương thích SDK 0.99+** | **An toàn nhất** — không dùng API MCP SDK nào; chỉ dựa customTools + channel đã có. | **Rủi ro cao nhất**: API debut 0.99.0 (2026-09-29, 3 ngày tuổi lúc review); peer-dep `"*"` lỏng; exposure semantics đã đổi 0.99.0→0.99.2. Cần version-floor + gate khi chọn. | SDK CHANGELOG (0.99.0 ngày 2026-09-29; 0.99.2 "Changed" MCP entries); pi-crew/package.json (peer `*`, optional) |

---

## 4. Leak đường CLI là bài toán trực giao — và fix rẻ nhất không phải A hay B

Ba remediation đã được SDD-2 ghi (:432-443, không code trong vòng đó):

1. **(a) Settings denylist** `extensions: ["-builtin:mcp"]` — 0 dòng code pi-crew
   (SDK `package-manager.js:736-743`).
2. **(b) E1-B** `registerMcpServer()` (Option B ở §2-3).
3. **(c) Ops populate `mcp.json`**.

**Đánh giá lại trong env hiện tại (mới so với SDD-2):**

- (a) **đã nằm trong settings** nhưng chỉ tắt `builtin:mcp` — trong khi env này không có
  `mcp.json` sống và MCP đến từ **pi-mcp-adapter replacer**. SDK docs: replacer đăng ký `/mcp`
  thì "replaces the built-in MCP support for sessions" → `-builtin:mcp` không tắt được nó.
  Vậy (a) như-đã-áp-dụng là **no-op với vector thực** của env này.
- Fix rẻ nhất **thực sự** phụ thuộc 2 điều chưa verify (→ Q4, Q5 §7): settings denylist có nhận
  được entry nhắm **package extension** (`-pi-mcp-adapter`/path-form, kể cả project-scope cho
  workspace my_pi) không; và pi CLI có flag exclude-extension khi spawn không. Nếu một trong hai
  = có → đóng leak cho **mọi role trên đường CLI** bằng 1 dòng config hoặc vài dòng pi-args —
  rẻ hơn hẳn A và B cho đúng bài toán leak.
- Lưu ý tradeoff của denylist toàn cục: nó tắt MCP cho cả **host session** nếu đặt user-scope;
  dạng mong muốn là **per-role/per-project** (project settings của workspace chứa runs, hoặc
  inject theo role lúc spawn — đúng hướng root-fix mà 2 reviewer SDD-2 đã đề xuất, SDD log
  :497-499).
- (c) chỉ có nghĩa khi migrate từ replacer về builtin — không phải tình huống hiện tại.

---

## 5. Khuyến nghị

### KEEP-STATUS-QUO — với điều kiện

**Không** build E1 (A), **không** tích hợp B ngay. Cụ thể:

1. **Giữ nguyên** G2 enforcement + degradation event + hardened defaults (đã land, chờ release
   cùng 33 commit local).
2. **Đóng leak CLI bằng lever trực giao** (không phải A/B): verify Q4/Q5 (§7) rồi áp denylist
   nhắm đúng replacer package — project-scope hoặc per-role inject. Đây là follow-up work item
   riêng (đúng escalation của SDD-2 §13), scoped nhỏ, không đụng protocol.
3. **Defer E1 đến demand-signal thực** (Q1 §7). Không có use case worker-cần-MCP thì A/B đều là
   surface không ai dùng — y hệt bài học 0-call-site của proxy helpers hiện tại.
4. **Gate B trên API maturity**: chỉ cân nhắc B khi `registerMcpServer`/`McpExposure` ổn định
   **≥ 1 minor cycle** của SDK (semantic không đổi qua ≥1 minor) **và** đã có quyết định
   version-floor (Q2 §7). Hiện peer-dep `"*"` + API 3 ngày tuổi + semantics đã đổi 1 lần trong
   patch-cycle = điều kiện chưa đạt.
5. Khi B được chọn: **bắt buộc** kèm degradation-event pattern (precedent
   `g2EnforcementDegradationReason`) để SDK-drift không fail-open im lặng.

### Trigger chuyển hướng (điều kiện tái mở)

| Trigger | Hướng mở | Lý do |
|---|---|---|
| Policy: worker **không được giữ credential MCP** (audit/mediation yêu cầu) | **A** | A là cơ chế duy nhất giữ creds ở parent (§3, trục least-privilege). |
| Demand-signal thực + SDK API ổn định + version-floor chốt + replacer interop verify (Q3) | **B** | B là chi phí thấp nhất cho curation per-role. |
| Không trigger nào trong 1-2 chu kỳ phát triển | Giữ status-quo; chỉ đóng leak bằng denylist | Tránh new-surface chết. |

### Ghi chú công bằng (không rubber-stamp)

B **thắng rõ** ở chi phí triển khai và fine-grained surface control (`toolExposure` per-tool là
thứ A không có sẵn); nếu SDK ổn định và demand chỉ là "worker role X được dùng server Y", B là
đúng hướng và A là over-engineering. A chỉ trở nên đúng khi yêu cầu mediation/credentials-ở-
parent là bắt buộc. Khuyến nghị KEEP hôm nay đứng trên: (i) chưa có demand-signal, (ii) API B
quá mới, (iii) leak thật giải được bằng lever rẻ hơn — không phải trên "B xấu".

---

## 6. Migration sketch — chỉ kích hoạt khi trigger §5 nổ

*(Recommendation là KEEP-STATUS-QUO nên KHÔNG có migration. Phần này là activation sketch ngắn
để queue không phải nghiên cứu lại từ đầu.)*

Chung cho mọi hướng (ràng buộc repo): TAB indent · node:test · 0 dependency mới ·
loop-review 2 vòng liên tiếp CLEAN (0 MAJOR) trước checkpoint (PHASE RUNBOOK) · real-test
decision table: chạm `mcp-proxy.ts`/`pi-args.ts`/`live-session-runtime.ts` → **T7 + T9b-W +
giữ 15/15 mcp-proxy tests xanh** · chạy test trực tiếp qua `node scripts/test-runner.mjs`,
không qua worker test-engineer.

- **Bước 0 (bắt buộc, cả A lẫn B)**: lever chặn discovery cho CLI path (Q4/Q5) — không có nó,
  B chỉ *thêm* servers curated cạnh adapter servers full (tệ hơn về độ phức tạp nhận thức),
  còn A vẫn để adapter connect dù model không thấy tool.
- **B (nếu trigger)**: phase 1 — policy per-role trong config (server subset + exposure); phase
  2 — gọi `registerMcpServer` trong prompt-runtime theo policy + degradation event khi API
  thiếu; phase 3 — curation cho permitted roles trên live-session (thay strip bằng curated
  set). Kèm version-floor SDK trong peerDependencies + CI gate.
- **A (nếu trigger)**: phase 1 — thiết kế RPC op trong protocol (timeout/cancel/streaming
  semantics) qua review-loop; phase 2 — proxy tool sinh từ `discoverMcpToolNames` của parent +
  forwarding qua channel (mở rộng `createMcpProxyTools` từ stub); phase 3 — wiring call-site tại
  spawn (live-session + CLI custom-tool injection). Khối lượng lớn nhất; chỉ mở khi mediation
  là requirement cứng.

---

## 7. Câu hỏi mở — cần user quyết

1. **Demand-signal (Q1 — quyết định chính)**: use case cụ thể nào cần worker dùng MCP? (VD:
   research worker cần web-search/firecrawl?) Hay mục tiêu chỉ là đóng security gap? Nếu chỉ
   security → KEEP + denylist là đủ, A/B đều chưa cần.
2. **Version-floor (Q2)**: nếu chọn B, có chấp nhận raise SDK floor (peer `"*"` → minimum
   cụ thể, bỏ optional nếu cần runtime API) không? Ai owns việc này (pi-crew maintainer vs
   user ops)?
3. **Replacer interop (Q3 — kỹ thuật, chặn B)**: pi-mcp-adapter có xử lý
   `mcp_servers_change` (servers do extension khác đăng ký) không? SDK core chỉ store;
   extension xử lý event mới connect. Adapter đã 0.99-aware (imports `RegisteredMcpServer`,
   gate `typeof pi.registerMcpServer === "function"` — `pi-mcp-adapter/index.ts`) nhưng việc
   nó connect servers của extension khác **chưa verify**. Nếu không → B không hoạt động khi
   replacer đang install.
4. **Denylist cho package extension (Q4 — chặn fix rẻ nhất)**: settings `extensions` có nhận
   entry nhắm package (`-pi-mcp-adapter`/path-form) không, và có áp được **project-scope**
   (đóng cho children trong workspace này mà host session vẫn giữ MCP) không? Verify: grep
   call-sites `isEnabledByOverrides` trong SDK `package-manager.js`.
5. **CLI flag (Q5)**: pi CLI có `--exclude-extension` (hoặc tương đương) để pi-crew inject theo
   role lúc spawn? Verify: `pi --help`. Nếu có → root-fix per-role vài dòng trong `pi-args.ts`.
6. *(Nhắc nhẹ, ngoài scope)*: 2 high transitive advisories npm audit (brace-expansion, fast-uri)
   — quyết định riêng đã ghi SDD-2 §13, không thuộc review này.

---

## 8. Liên kết roadmap / queue (SDD-5)

Từ pi-crew-sdd-2026-09-30-buoi1.md:680-686 — queue còn: W-E (G19→G7→B1 sweep) · W-G phần còn ·
W-I · **E1 design review (doc này)** · **bug analyze-run.mjs:706** · **handoff-inflation**
(synthesize 5243 tok = 3.1× explore; ứng viên work-item "handoff context budget/cap-distill").
Ghi chú vận hành: 33 commit local user-gated; doc này là additive thuần (file mới, 0 conflict).

Bài học handoff-drift ghi nhận trong run này (để knowledge): explorer/analyst report sai 2 điểm
env — (1) "pi-mcp-adapter không installed" (thực: installed + active, §1.4), (2) "G2 shipped
v0.11.5" (thực: `[Unreleased]`, §1.1) — writer phải verify primary source trước khi ghi fact
vào doc quyết định.

---

## Phụ lục — Evidence index (verify trực tiếp 2026-10-02)

| # | Claim | Evidence |
|---|---|---|
| E1 | G2 strip + degradation event, chỉ đường live-session, opt-in | `src/runtime/live-session/live-session-runtime.ts:694-755` |
| E2 | E1 unbuilt; stub `createMcpProxyTools()` trả `[]`; 0 production call-site | `src/runtime/mcp-proxy.ts` (header, stub); pi-crew/CHANGELOG.md `[Unreleased]` |
| E3 | Hardened default-deny `shareMcp`; write-roles-only | `src/runtime/mcp-proxy.ts` (`buildMcpProxyConfig`, `mcpPermittedForRole`); `test/unit/runtime/core/mcp-proxy.test.ts` (đếm trực tiếp: 15 tests) |
| E4 | CLI path: D5 full loadout, F1 chỉ lọc declared, discovery như main session | `src/runtime/model/pi-args.ts:282-335` |
| E5 | Residual HIGH 2 tầng (load+connect dù surface-filter; role không allowlist → full surface) | pi-crew-sdd-2026-09-30-buoi1.md:496-511 |
| E6 | 3 remediation options + `-ne` breaker (mất 15 server + gãy provider oc-go) | pi-crew-sdd-2026-09-30-buoi1.md:428-446 |
| E7 | Env: adapter installed + configured; settings có `-builtin:mcp`; ~15 servers có credentials; không có mcp.json sống | `~/.pi/agent/settings.json`; `~/.pi/agent/npm/node_modules/pi-mcp-adapter/`; `~/.pi/agent/mcp-adapter.json`; `~/.pi/agent/mcp.json.bak.*` |
| E8 | Settings denylist mechanism `-builtin:mcp` | SDK `dist/core/package-manager.js:736-743`; SDK docs/mcp.md §"Replace the built-in MCP support" |
| E9 | API B: `McpExposure`/`toolExposure`/`RegisteredMcpServer`/`McpServerRegistry`; core chỉ store, extension connect; tool pipeline áp | SDK `dist/core/mcp-servers.d.ts:16-114`; `dist/extensions/mcp/index.d.ts`; docs/mcp.md §"Add servers from extensions", §"Permissions" |
| E10 | API B 3 ngày tuổi; semantics đổi trong 0.99.x; peer-dep `*` | SDK CHANGELOG (0.99.0 = 2026-09-29; 0.99.2 Changed-MCP; #10212/#10239); pi-crew/package.json (peerDependencies) |
| E11 | Name-denylist bypass; allowlist là root-fix backlog | `src/runtime/mcp-proxy.ts` (`isMcpExtensionPath` KNOWN LIMITATION); SDD-2 §13 |
| E12 | Queue SDD-5 + 33 commit user-gated | pi-crew-sdd-2026-09-30-buoi1.md:680-686 |
| E13 | Real-test tiers cho thay đổi MCP/spawn-path | `skills/real-test-pi-crew/SKILL.md` (decision table) |

---

## Phụ lục leader (2026-10-02, sau review)

Verify nhanh Q4/Q5 bởi leader:

- **Q5 = KHÔNG**: `pi --help` không có flag nào dạng `--exclude-extension` /
  per-role MCP inject qua CLI. Đường per-role inject lúc spawn (pi-args.ts) hiện
  chỉ có env `PI_CREW_*` và resource-loader override đường SDK.
- **Q4 = KHÔNG rõ có denylist package**: settings `extensions` là danh sách
  paths (allowlist sources) — không tìm thấy cơ chế deny nhắm package name.
  Hướng khả thi nhất cho "đóng leak CLI" là **project-scope settings**: workspace
  của team không cài adapter ở project scope → worker (cwd=workspace) không thấy,
  host vẫn giữ global. Cần prototype nhỏ để xác nhận settings-inheritance thật.

→ Không thay đổi khuyến nghị KEEP-STATUS-QUO; nhánh fix rẻ nhất bị thu hẹp còn
"project-scope isolation" (verify khi làm, ~S size). Q1 (demand-signal) vẫn là
câu quyết định chính dành cho user.
