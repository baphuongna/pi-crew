# MuxSurface — Design Spec

Ngày: 2026-08-26 · Phiên bản: **v0.7** · Trạng thái: chờ user duyệt · Phạm vi: A1 → A2 (live panes)

> Changelog v0.2: auto-exit TUI worker (D7), worker-side event recorder (§5.3), graceful kill escalation (§5.1), pid self-report `worker.started` (§5.1), session path self-report (§5.2), token TTL sweep + run-id verify (§5.2), `limits.maxSurfaceWorkers` (§8), ANSI strip readScreen (§4), surface re-attach (§7), broker revoke khi degrade (§7), sensitive mark (§6), zombie-scanner surface fields (§5.1).
>
> Changelog v0.3: re-issue token qua broker hello response; flush-before-shutdown + classify timeout; sanitizer OSC riêng; sensitive mark đúng chỗ `config-schema.ts`; cap semantics; §12 data contracts; §13 sequence diagrams.
>
> Changelog v0.4: depth > 0 → force headless; parent-guard worker-side; herdr remote fail-closed; attach() stability scope; spawn-fail ≠ flap; multi-run per-run cap; sensitive reject guard; §9 test matrix mở rộng; formalize terminal statuses / classify timeout / UsageSummary.
>
> Changelog v0.5 (vòng 4 — regression + finalgate + YAGNI): **parent-guard chống PID-reuse** — thêm `PI_CREW_PARENT_START_TIME` (starttime `/proc/<pid>/stat`), poll verify exists && starttime khớp (Critical regression); **depth-guard defense-in-depth** — delegate grandchild spawn đi thẳng `runChildPi` không qua dispatch, nên guard thứ hai tại launch-script builder: depth > 0 → từ chối build surface (Critical regression); **spawn-fail lockout riêng** — 3 spawn-fail liên tiếp trong run → surface OFF hết run (chống mux half-dead retry chậm vô hạn); **mux-dead batch counting** — 1 sự kiện mux-dead = 1 lockout count per-run (không N per-pane), `surface.degraded` thêm `cause`; định nghĩa "pane đã chạy" = broker đã nhận hello/`worker.started`; sensitive `get` hiển thị effective value + source metadata; **§14 mới — Phạm vi A1 vs A2** theo YAGNI review: defer re-attach + token re-issue, sanitizer, rebalance, `maxSurfaceWorkers` config (A1 hardcode 6) sang A2; **async runs force headless ở A1** (điều kiện an toàn khi chưa có re-attach); GIỮ ở A1 (từ chối cắt, có lý do): parent-guard (chống cháy token sau Ctrl-C), recorder (agent-view đọc chính file nó ghi — không có recorder thì trống), `worker.started` (sessionPath cho resume + pid cho SIGKILL). §11 bổ sung 5 residual của finalgate thành verify items cụ thể.
>
> Changelog v0.5.1: mở rộng D5 fullSession (bỏ --no-extensions + --no-skills + role tools override khi flag bật).
>
> Changelog v0.6 (chốt user — đảo chính sách loadout & nesting): **D5 đảo: full session là MẶC ĐỊNH** — worker = pi session đầy đủ như main session, không cắt xén: không `--no-extensions` (extensions + MCP discovery theo đúng cơ chế trust của pi), không `--no-skills`, không role tools override. Restriction thành **opt-in per-agent**: chỉ khi agent `.md` khai explicit `tools:` mới lock (kèm auto-add control tools). Xóa config `surface.fullSession` → **bỏ luôn toàn bộ sensitive machinery** (sanitize mark, set-scope guard — không còn field sensitive, §8 đơn giản còn 2 keys). **D8 mới — nested spawning mở**: `delegate` tool đăng ký cho MỌI worker (bỏ gate role executor-class + bỏ `config.nesting.enabled`), child tạo được child của chính nó — depth cap nâng default 2 → 4 (config 1-10 giữ), nested-slot budget giữ (chống bùng nổ đồng thời). Surface pane vẫn chỉ tier-1 (depth > 0 → headless, §3 giữ). Threat model §5.4 viết lại: biên giới an ninh chuyển từ tool-lockdown sang **depth cap + nested-slot budget + maxTurns + taskTimeoutMs + usage budget**.
>
> Changelog v0.7 (học giao tiếp từ pi-interactive-subagents): **D9 + §15 mới — worker messaging**: `message` tool worker-side (dormant-until-env `PI_CREW_MSG_ENABLED`, backed broker `msg.send`/`msg.inbox` CÓ SẴN — trước giờ chỉ thiếu tool đăng ký) cho notify parent phi blocking + DM sibling + group; **wake pattern** — notify parent inject thành steer vào orchestrator-session (adaptive planner) thay vì mọi câu hỏi đổ lên human; rate-limit chống spam vòng lặp. Hợp nhất host-side 1 action `message` 3 trạng thái (steer/answer/resume — pattern `subagent_message` của amos) → A2. Điều tra: `ask`/steer/resume đã ngang hoặc hơn amos (replyDeadline, priority, mid-turn inject) — gap duy nhất là worker không có kênh phi-blocking và DM.

## 1. Bối cảnh & mục tiêu

pi-crew điều phối workers là process `pi` headless (`--mode json -p`, stdio JSON pipe). Observability tối đa mà kiến trúc "interactive subagents" (amosblomqvist / HazAT) chứng minh là **agent sống trong một pane multiplexer thật**: người nhìn thấy TUI đầy đủ của agent, gõ trực tiếp vào pane, pane tồn tại độc lập host. Video "Pi Setup After 6 Months" + repo `pi-interactive-subagents` (tmux-only) là tham chiếu; herdr (herdr.dev) là multiplexer có Socket API event-driven sát nhu cầu pi-crew hơn tmux.

**Mục tiêu:** workers của pi-crew có thể chạy trong pane tmux hoặc herdr khi môi trường cho phép, **tuyệt đối không phá vỡ hành vi hiện tại** ở môi trường không có multiplexer.

**Nguyên tắc bất biến:** surface chỉ quyết định *nơi process sống*. Scheduler, task graph, mailbox, broker, steering, crash-recovery, budget, retry giữ nguyên. State trên đĩa luôn là nguồn sự thật.

## 2. Quyết định đã chốt (cùng user)

| # | Quyết định | Lựa chọn |
|---|---|---|
| D1 | Hành vi mặc định khi chưa config | **auto-detect**: thấy tmux/herdr (theo quy tắc Section 3) là dùng pane; không thấy → headless như hiện tại. Tắt hẳn bằng `surface.mode: "off"` |
| D2 | Ngữ nghĩa "đang chạy trên herdr" | **Chỉ khi pi nằm trong herdr pane** (`HERDR_ENV=1` + binary + socket sống). Socket herdr sống nhưng pi ở ngoài → coi như không có herdr |
| D3 | Pane chết giữa chừng | **Hạ cấp headless + resume** session worker (scratchpad restore + pendingSteers replay + session resume). Không đếm vào retry budget |
| D4 | Kiến trúc | **Attachment bọc runtime**: surface là thuộc tính của dispatch sau khi `resolveTaskRuntimeKind` chọn `child-process`; không phải runtime mode thứ 4 |
| D5 | Loadout worker | **Full session MẶC ĐỊNH — không cắt xén gì**: worker là pi session đầy đủ như main session (extensions + MCP + skills + full toolset + AGENTS.md theo cwd + session persistence). Restriction là **opt-in per-agent**: agent `.md` khai explicit `tools:` mới lock (auto-add control tools `ask`/`delegate`); role-tools config không còn áp mặc định. *(Đảo chính sách so với pi-crew hiện tại — breaking, ghi ADR)* |
| D6 | Số pane giới hạn | **A1: hardcode 6** (constant `MAX_SURFACE_WORKERS` trong resolve-surface.ts). A2: config `limits.maxSurfaceWorkers` (số pane đang sống per-run); vượt → headless |
| D7 | Vòng đời TUI worker | **Auto-exit extension-side**: prompt-runtime shutdown session khi task terminal (không có "done tool"). **Thứ tự bắt buộc: ghi + fsync `worker.completed` TRƯỚC khi shutdown** (fsync có sẵn — `atomic-write.ts` durability full) |
| D8 | Nested spawning | **Mở cho mọi worker**: `delegate` tool có ở MỌI role — worker gọi child, child gọi child của chính nó (đệ quy tới depth cap). Default `maxDepth` nâng 2 → 4; config 1-10 giữ; nested-slot budget giữ. Bỏ gate `config.nesting.enabled`. Surface pane chỉ tier-1 (depth > 0 → headless) |
| D9 | Worker messaging | **`message` tool worker-side** (§15): notify parent phi blocking + DM sibling + group — backed broker `msg.send` có sẵn. Wake pattern: notify có thể đánh thức orchestrator-session thay vì đổ lên human. Rate-limit chống loop |

Quy tắc kỹ thuật phái sinh: worker depth > 0 → force headless — surface pane chỉ tier-1 (§3, kèm guard thứ hai §5.2); parent-guard worker-side chống PID-reuse (§5.2); async runs force headless ở A1 (§14); delegate tool mọi role — đệ quy tới depth cap (D8).

## 3. Phát hiện môi trường (fail-closed)

Tại tầng dispatch, sau khi runtime kind = child-process:

```typescript
function resolveSurface(
  env: NodeJS.ProcessEnv,          // process.env của host (hoặc fixture test)
  config: PiTeamsConfig,           // full config — đọc runtime.surface (+ limits ở A2)
  role: string,                    // agent name (match visibleAgents)
  livePaneCount: number,           // số pane đang sống của RUN NÀY (D6)
): SurfaceProvider | null;
```

| Điều kiện | Kết quả |
|---|---|
| **`PI_CREW_DEPTH > 0`** (bản thân là worker/grandchild) | **null → headless** — không pane-in-pane |
| Async run (background-runner) — **A1** | **null → headless** (§14: chưa có re-attach) |
| `TMUX` set + binary `tmux` trên PATH | **tmux** |
| `HERDR_ENV=1` + binary `herdr` + socket sống (connect + ping) | **herdr** |
| Cả hai (pi trong tmux, tmux trong herdr pane) | **tmux** — innermost wins |
| Không khớp ô nào | **null → headless**, code path hiện tại, không đụng tới |

Mọi bước check fail (binary thiếu, socket chết, ping timeout) đều hạ ô kế tiếp, kết thúc ở headless. **Không bao giờ throw vì thiếu multiplexer.** `surface.mode: "tmux"|"herdr"` ép target; ép mà detect fail → headless + warning event. `livePaneCount >= MAX_SURFACE_WORKERS` → null. Thứ tự check mỗi ô: **binary trước, env sau**.

**Depth-guard là 2 lớp (sửa Critical regression vòng 4)**: lớp 1 — `resolveSurface` check `PI_CREW_DEPTH` (chính); lớp 2 — **launch-script builder từ chối build khi depth > 0** (defense-in-depth: delegate grandchild spawn qua `delegate-spawn.ts` gọi `runChildPi` trực tiếp, không đi qua dispatch — nếu ai thêm surface vào path đó, builder chặn). Surface spawn chỉ hợp lệ từ team-runner dispatch.

## 4. SurfaceProvider interface

File mới `src/runtime/surface/surface-provider.ts`:

```typescript
export interface SurfaceDetection {
  ok: boolean;
  kind?: "tmux" | "herdr";        // khi ok
  reason?: string;                // khi !ok — cho doctor/log
}

export interface SurfaceSpawnOpts {
  cwd: string;                    // working dir của worker (worktree khi có)
  command: string;                // launch command ĐÃ BUILD SẴN (bash <script-path>)
  title?: string;                 // pane title: "crew:{runId}:{taskId}"
}

export interface SurfaceProvider {
  readonly kind: "tmux" | "herdr";
  detect(): SurfaceDetection;
  createSurface(name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle>;
  /** Nhận lại pane đang tồn tại theo id (re-attach — A2) — null nếu pane đã mất. */
  attach(id: string): SurfaceHandle | null;
  /** Plain text sau strip. Throw khi handle không còn hợp lệ. */
  readScreen(handle: SurfaceHandle, lines?: number): Promise<string>;
  /** force=false: SIGTERM cây process trong pane; force=true: kill-pane/pane.close ngay. */
  closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void>;
  /** Cân kích thước panes (debounced) — A2, A1 không gọi. */
  rebalance(handle?: SurfaceHandle): void;
}

export interface SurfaceHandle {
  id: string;                                       // "%12" | "w1:p3"
  kind: "tmux" | "herdr";
  onExit(cb: (reason: SurfaceExitReason) => void): void;  // event, không poll màn hình
  dispose(): void;
}

/** pane-closed: pane riêng lẻ đóng; mux-dead: multiplexer server chết; detached: host chủ động dispose. */
export type SurfaceExitReason = "pane-closed" | "mux-dead" | "detached";
```

**Stability của pane id**: id ổn định **trong khi mux server sống**. Server restart → id cũ vô nghĩa → handle bắn `mux-dead`, không re-attach theo id cũ.

**tmux-provider**: port `tmux.ts` — `split-window -d -h -P -F '#{pane_id}'` target `$TMUX_PANE`; `send-keys -l`; lệnh dài qua script file; `capture-pane -p` cho readScreen. `onExit`: interval 2s check `list-panes -F '#{pane_dead} #{pane_id}'`. `closeSurface` graceful: SIGTERM pid trong pane → 3s → force `kill-pane`.

**herdr-provider**: unix socket `~/.config/herdr/herdr.sock` (tôn trọng `HERDR_SOCKET_PATH`/`HERDR_SESSION`), NDJSON: `pane.split` (right) từ `pane.current` + `pane.send_text`; `pane.read`; `pane.close`; `onExit` qua `events.subscribe` filter `pane.closed`. Remote thin-client: socket không resolve locally → detect fail-closed → headless.

**Multi-run cùng mux server**: mỗi run quản pane của mình theo manifest; rebalance (A2) áp lên window chứa pane cha — 2 run chia window thì layout là best-effort (đã có try/catch; chấp nhận; khuyến nghị mỗi pi một window).

**Screen sanitizer — A2**: chỉ cần khi render `readScreen` (mirror — A2). `ANSI_PATTERN` hiện có chỉ strip CSI; khi triển khai mirror phải viết `stripTerminalSequences` (CSI + OSC + private-mode) và mọi render đi qua nó. A1 không render readScreen.

Ghi chú màn hình nhỏ: 6 pane trên 80 cols → ~13 cols/pane chấp nhận cho theo dõi. Terminal hẹp → A2 có config cap. Auto-switch layout = YAGNI.

## 5. Spawn trong pane & luồng event

### 5.1 Process ownership đổi — hệ quả lớn nhất

Worker trong pane là **con của mux server** — không chết theo host như headless. Năm cơ chế:

| Cơ chế hiện tại | Dựa vào | Surface mode |
|---|---|---|
| Nhận events | stdout JSON stream | `EventLogTailSource` — tail per-agent `agents/{taskId}/events.jsonl` (§5.3) |
| Kill/timeout | `killProcessTree` (SIGTERM → 3s → SIGKILL) | Cùng escalation: SIGTERM theo pid → 3s → `closeSurface({force})` → SIGKILL. Pid từ `worker.started` |
| Phát hiện chết | child `close` | `SurfaceHandle.onExit` + heartbeat 60s secondary |
| Transcript per-agent | host ghi từ stdout | worker-side recorder (§5.3) |
| Chết theo host | quan hệ cha-con | parent-guard worker-side (§5.2) |

`zombie-scanner` mở rộng `ZombieSubagent` fields `surface?`, `surfacePaneId?` (env `PI_CREW_SURFACE`, `PI_CREW_SURFACE_PANE`) → doctor hiển thị + cleanup pane mồ côi qua `closeSurface` (backstop).

### 5.2 Launch script & vòng đời TUI worker

`buildPiWorkerArgs` surface variant **chỉ bỏ `--mode json -p`**. KHÔNG thêm argv flag mới (Pi từ chối flag lạ, `pi-args.ts:260`). Host viết launch script:

- **Path**: `getPiTempBase()/pi-crew-launch-{taskId}-{pid}.sh`, 0600, symlink-safe.
- **TTL registry**: in-memory `Map<path, createdAt>`; sweep trước mỗi spawn + khi run kết thúc, xóa script cũ hơn 60s.
- **Depth guard lớp 2**: builder từ chối sinh script khi `PI_CREW_DEPTH > 0` (§3).

```bash
#!/bin/bash
export PI_CREW_RUN_ID=... PI_CREW_TASK_ID=... PI_CREW_BROKER_SOCKET=... \
       PI_CREW_BROKER_TOKEN=... PI_CREW_STEERING_FILE=... PI_CREW_EVENTS_PATH=... \
       PI_CREW_SURFACE=tmux PI_CREW_SURFACE_PANE=%12 PI_CREW_AUTO_EXIT=1 \
       PI_CREW_PARENT_PID=<pid host> PI_CREW_PARENT_START_TIME=<starttime host>
cd <cwd>
pi --model X:medium \
   --extension <prompt-runtime-path> --append-system-prompt <file> \
   "Task: ..."
rm -f -- "$0"
```

(Ví dụ trên là loadout mặc định full — không `--no-extensions`/`--tools`/`--no-skills`, §6. Agent `.md` khai `tools:` thì mới thêm `--tools <khai-báo>+control-tools`. `--mode json -p` vẫn bị bỏ — đó là chế độ chạy chứ không phải cắt xén loadout.)

- Task là positional arg — pi TUI mở trong pane, submit task làm turn đầu.
- **Session path: không phụ thuộc CLI flag** — prompt-runtime self-report qua `worker.started`.
- **Broker hello**: hello gửi `{protocol, runId, taskId, token}` sẵn — token match → accept; mismatch + run active + taskId khớp → re-issue token trong response (**A2**; A1 async force headless nên pane re-attached không xuất hiện). Run terminal (status ∈ {completed, cancelled, failed}) → reject `stale-token` (worker-role hello; orchestrator in-process miễn — late-steer sau run end là legitimate).
- **Auto-exit (D7)**: env `PI_CREW_AUTO_EXIT=1` → prompt-runtime subscribe session lifecycle; turn kết thúc stopReason `done`/`end_turn` và không còn ask pending / delegate chạy / steer pending → **ghi + fsync `worker.completed`** → session shutdown. *(Verify API shutdown ở plan; tham chiếu `subagent-done.ts` của pi-interactive-subagents.)*
- **Parent-guard worker-side (chống PID-reuse — sửa Critical vòng 4)**: prompt-runtime poll mỗi 5s: parent chết khi **pid không tồn tại HOẶC starttime khác `PI_CREW_PARENT_START_TIME`**. Starttime = field 22 của `/proc/<pid>/stat` (clock ticks từ boot — không đổi theo pid reuse; host ghi lúc spawn). Parent chết thật → ghi `worker.parent-lost` → shutdown theo D7 → pane tự đóng. SIGSTOP host: pid còn + starttime khớp → không kill nhầm. macOS fallback: chỉ pid check + ghi chú hạn chế (doctor cảnh báo). Async run: background-runner là parent sống tiếp → không kích hoạt.
- Loadout mặc định full session (§6) — áp cả headless lẫn surface; `--tools` chỉ xuất hiện khi agent `.md` khai explicit.

### 5.3 Event flow — worker-side recorder (giữ ở A1)

```typescript
export interface WorkerEventSource {
  readonly sourceType: "stdout" | "event-log";
  onEvent(cb: (event: StreamBridgeEvent) => void): void;
  close(): void;
}
// StdoutJsonEventSource — headless (giữ nguyên)
// EventLogTailSource (MỚI) — tail agents/{taskId}/events.jsonl:
//   watcher callback → tự giữ byte offset → đọc incremental
//   (run-watcher-registry CHỈ báo change — caller quản position)
```

**Worker-side recorder (mới, trong prompt-runtime)**: subscribe full event stream của session pi (message/tool/usage) → ghi **per-agent** `agents/{taskId}/events.jsonl` đúng dòng `{seq, time, event}` đang có (đã verify `crew-agent-records.ts:100-102,607`). Đây là nguồn dữ liệu cho agent-view overlay (nó disk-tail file này) — **không có recorder thì UI trống trong surface mode**, nên giữ ở A1.

- Dashboard / sidebar / agent-view hoạt động không đổi (cùng file, cùng schema).
- Run-level `events.jsonl`: `worker.*` rate-limited 30/60s + **terminal events không rate-limit**: `worker.started` (pid + sessionPath — cần cho SIGKILL fallback + degrade resume), `worker.completed`, `worker.error` (schemas §12.2) — map thành shape stdout source đang phát.
- Recorder active khi `PI_CREW_SURFACE` set; headless vẫn stdout.
- File growth: giống độ lớn file hiện tại (host ghi từ stdout) — bounded bởi task lifecycle; rotation defer.

### 5.4 Ask / steer / delegate / human typing — không đổi + threat model

ask/steer/delegate dựa file + broker. Human gõ pane và steering file là 2 kênh song song — không xung đột.

**Threat model (viết lại theo D5/D6/D8 — không còn tool lockdown mặc định)**: người gõ pane là chủ terminal; input là lời user. Worker full-power như main session — prompt injection có toàn quyền như user chính chủ trong main session. Biên giới an ninh giờ là **vòng fences tài nguyên & độ sâu**: (1) depth cap — đệ quy spawn dừng ở `maxDepth` (default 4); (2) nested-slot budget — giới hạn delegate đồng thời; (3) maxTurns/graceTurns + taskTimeoutMs — task không chạy vô hạn; (4) usage budget — warning 0.8 / abort 0.95 toàn run (roll-up cả grandchild, cơ chế sẵn có); (5) broker token per-run — spam cross-run bị chặn. Đây là đánh đổi có chủ đích của user: agent đáng tin như chính user, giới hạn bằng ngân sách chứ không bằng khóa công cụ.

## 6. Loadout — full session mặc định (D5, đảo chính sách)

**Worker = pi session đầy đủ như main session.** Spawn mặc định KHÔNG truyền: `--no-extensions`, `--no-skills`, `--tools`, `--exclude-tools`. Nghĩa là:

- **Extensions + MCP discovery** hoạt động y main session — kể cả project-local extensions theo đúng cơ chế trust/approve của pi (không thêm lớp trust riêng của pi-crew).
- **Skills discovery** hoạt động.
- **Full default toolset** built-in + extension tools.
- **AGENTS.md/CLAUDE.md** theo cwd (pi core load; `inheritProjectContext` của agent điều khiển rewrite như hiện tại).
- **Session persistence** mặc định có (như hiện tại).
- `--extension prompt-runtime` vẫn append mọi lúc (ask/steer/delegate/broker — hạ tầng phối hợp, không phải "cắt xén").

**Restriction opt-in per-agent**: agent `.md` khai explicit `tools:` mới lock — `--tools` = khai báo + auto-add control tools (`ask`, và `delegate` ở depth cho phép) — không bao giờ khóa mất kênh phối hợp (pattern `buildSubagentToolAllowlist` index.ts:809-811 của pi-interactive-subagents). Role-tools config (`ROLE_TOOL_CONFIGS`) không còn áp mặc định — chỉ còn tài liệu tham khảo profile (deprecate dần). Builtin agents hiện khai `tools:` hẹp sẽ giữ nguyên hành vi lock cho chính chúng (chúng là explicit declaration) — team có thể nới từng agent bằng cách bỏ dòng `tools:`.

**Đổi guard an ninh (thay tool-lockdown)**: biên giới mới = depth cap (D8) + nested-slot budget + maxTurns/graceTurns + taskTimeoutMs + usage budget (warning 0.8 / abort 0.95) + broker auth. Đầy đủ chi tiết ở §5.4.

Env `PI_CREW_SURFACE_MODE` chỉ user shell set được — không vector từ repo.

## 7. Pane chết → hạ cấp headless + resume (D3)

**Định nghĩa**: *classify timeout* = chờ `worker.completed` tối đa 2s sau `onExit` (trần cho tmux onExit interval 2s; event flow fs.watch <100ms). *"Pane đã chạy"* = broker đã nhận hello/`worker.started` từ pane đó (phân biệt với spawn-fail).

```
SurfaceHandle.onExit(reason)
   ├─ Chờ worker.completed ≤ 2s (classify timeout; D7 fsync-before-shutdown
   │   đảm bảo pane-closed-bình-thường luôn kịp có event)
   │    ├─ có event   → cleanup, giải phóng slot pane
   │    └─ không có   → degrade:
   │         1. Ghi surface.degraded {taskId, paneId, reason, ts,
   │            cause: "pane-closed" | "mux-dead"} vào run events.jsonl
   │         2. Broker revokeTaskToken(taskId)
   │         3. Anti-flap — đếm PER-RUN THEO CAUSE-GROUP (sửa vòng 4):
   │            1 sự kiện mux-dead = 1 count dù N pane degrade đồng thời
   │            (surface.degraded vẫn ghi đủ N entry cùng cause để debug);
   │            đếm ≥1 → surface OFF phần còn lại run (manifest lockout
   │            {since, counts: {pane, mux}}; doctor hiển thị; reset ở run sau)
   │         4. Dispatch lại unit CHẾ ĐỘ HEADLESS:
   │              prompt gốc + scratchpad restore + pendingSteers replay
   │              + session resume (theo sessionPath từ manifest)
   │                + resume prompt "continue from where you left off"
   │              (4 thành phần độc lập)
   │         5. Không đếm retry budget; attempt # ghi reason: "surface-lost"
```

**Spawn-fail ≠ flap, nhưng có lockout riêng (sửa vòng 4)**: `createSurface`/`sendCommand` fail lúc spawn (mux half-dead: binary + socket có nhưng treo/timeout) → đơn vị retry headless ngay không đếm degrade lockout; nhưng **3 spawn-fail liên tiếp trong run → surface OFF hết run** (chống retry chậm vô hạn từng unit). Spawn-fail có timeout cụ thể cho `createSurface` (không treo vô hạn — §11 verify giá trị).

Mux chết toàn cục: mọi handle bắn `mux-dead` → degrade song song (1 cause-group); dispatcher re-detect ở dispatch kế tiếp.

**Surface re-attach (async + host restart) — A2** (§14). A1: async runs force headless nên không tồn tại pane re-attach.

**SSH drop**: pi chạy trong mux trên remote — SSH client chết không giết gì (mux giữ); user attach lại. Không code mới.

Trục bền vững: pane/mux/host chết bất kỳ — state trên đĩa + crash-recovery là nguồn sự thật.

## 8. Cấu hình & team-settings

### 8.1 Schema (`CrewRuntimeConfig` mở rộng)

```jsonc
{
  "runtime": {
    "surface": {
      "mode": "auto",            // auto | tmux | herdr | off
      "visibleAgents": []        // exact-match agent/role name; ["*"] = tất cả
                                 // default: [] trong A1 → ["*"] A2 GA
    }
  }
  // A2 thêm: "limits": { "maxSurfaceWorkers": 6 }
  // A1: MAX_SURFACE_WORKERS = 6 (constant resolve-surface.ts)
  // KHÔNG còn fullSession — full là mặc định (D5, §6)
  // maxDepth (D8): nesting.maxDepth — default 4, range 1-10
  //   (implementation truth: key sống trong khối `nesting` của PiTeamsConfigSchema
  //   cạnh nesting.enabled/maxSlots — ADR-5 §10, không phải `runtime.maxDepth`)
}
```

### 8.2 team-settings (bắt buộc — mọi key phải quản lý được qua slash command)

`handle-settings.ts` cập nhật đồng bộ:

1. `KNOWN_KEYS` thêm 2 key `runtime.surface.mode`, `runtime.surface.visibleAgents` (A2 thêm `limits.maxSurfaceWorkers`) + cập nhật default `nesting.maxDepth: 4` → `schema`, `get`, `set`, `list`; `suggestConfigKey` tự gợi ý.
2. `EFFECTIVE_DEFAULTS` thêm `runtime.surface.mode: "auto"`, `runtime.surface.visibleAgents: []`, cập nhật `nesting.maxDepth: 4` (đổi từ 2).
3. `src/config/config-validation.ts`: `parseSurfacePolicy` — enum mode, mảng string visibleAgents.
4. `src/config/config-schema.ts`: mirror schema (không còn field sensitive nào của surface — fullSession đã bỏ).

Scope khi `set`: `updateConfig` hỗ trợ scope, default user (`config.ts:415` — đã verify). Không còn sensitive guard cần làm cho surface (đơn giản hóa so với v0.5).

### 8.3 Manifest

```typescript
interface ManifestSurfaceState {
  provider: "tmux" | "herdr" | null;
  panes: Record<string, string>;       // taskId → paneId
  workerPids: Record<string, number>;  // từ worker.started
  sessionPaths: Record<string, string>;// từ worker.started
  lockout?: { since: string; counts: { pane: number; mux: number } };
}
```

Manifest field mới backward-compatible (plain JSON parse — đã verify). Doctor hiển thị provider/pane map/lockout.

## 9. Testing

Hàng đánh dấu **(A2)** thuộc giai đoạn 2. Chi tiết test case do implementation plan định nghĩa.

| Tầng | Nội dung | Cách |
|---|---|---|
| Unit | `resolveSurface` matrix (§3: depth, async-A1, TMUX, HERDR, both, none) + cap hardcode | env fixtures + livePaneCount |
| Unit | 2 provider (create/read/close; attach null) | herdr fake NDJSON socket; tmux wrapper binary |
| Unit | closeSurface graceful escalation | SIGTERM → 3s → force → SIGKILL (mock, verify thứ tự) |
| Unit | launch script | env đủ (kể PARENT_PID/START_TIME), shellEscape, 0600, `rm "$0"`, **builder từ chối depth > 0** |
| Unit | TTL sweep | script >60s xóa khi spawn/run-end; <60s còn |
| Unit | auto-exit | không pending → completed (fsync) → shutdown; **có pending → KHÔNG shutdown** |
| Unit | parent-guard | pid chết → shutdown + worker.parent-lost; **pid reuse (pid sống + starttime khác) → vẫn shutdown**; SIGSTOP (pid + starttime khớp) → không shutdown |
| Unit | recorder | per-agent `{seq, time, event}` đúng; terminal events không rate-limit (burst >30 vẫn qua) |
| Unit | EventLogTailSource | watcher change → incremental read đúng offset (2+ write liên tiếp) |
| Unit | broker (A1) | hello match → accept; run terminal → stale-token; revokeTaskToken → hello lại reject |
| Unit | broker re-issue **(A2)** | mismatch + active + taskId khớp → `reissuedToken` |
| Unit | classify timeout | completed chậm 1.5s → bình thường; 3s không có → degrade |
| Unit | spawn-fail lockout | 3 fail liên tiếp → OFF hết run; 1-2 fail → retry headless không lockout |
| Unit | batch counting | mux-dead N pane → lockout counts.mux = 1 |
| Unit | Loadout mặc định | args diff: worker mặc định KHÔNG có `--no-extensions`/`--no-skills`/`--tools`; agent `.md` khai `tools:` → `--tools` khai báo + auto-add control tools; builtin agents khai tools giữ lock của chính chúng |
| Unit | Nested spawning | `delegate` có ở mọi role; depth 1→2→3→4 OK, depth 4 → block rõ ràng; nested-slot budget giới hạn đồng thời; bỏ `config.nesting.enabled` không còn gate |
| Unit | `message` tool | notify parent → broker msg.send + event + (có orchestrator-session parked) inject steer; DM sibling → inbox pickup ở turn boundary (fenced); group broadcast; rate-limit 10/phút vượt → warning; `from` do broker ghi đè từ token (không mạo danh) |
| Unit | team-settings | get/set/list/schema 2 key surface + maxDepth default 4 |
| Unit | zombie-scanner | surface/surfacePaneId từ env |
| Unit | sanitizer **(A2)** | CSI + OSC 1337/133 + private-mode strip |
| Unit | rebalance **(A2)** | debounce, layout call |
| Integration | E2E tmux thật | pattern `docs/real-test` |
| Integration | E2E herdr | cài herdr nếu có; không thì fake-socket |
| System | degrade | kill pane → headless + 4 thành phần resume + revoke + lockout |
| System | Ctrl-C host | foreground surface + Ctrl-C → panes tự đóng (parent-guard, kể cả pid-reuse simulation) |
| System | async run | background run → force headless (A1) |
| System | re-attach **(A2)** | kill host giữa async surface run → mở lại → nhận pane + token re-issue |
| System | fallback matrix | ngoài mux → hành vi như hiện tại |

Docs: `docs/TEST_MATRIX.md` + ADR (process ownership + parent-guard + depth-guard).

## 10. Files dự kiến đụng

Hàng **(A2)** chỉ làm giai đoạn 2.

| File | Việc |
|---|---|
| `src/runtime/surface/surface-provider.ts` | mới — interface (§12.1) |
| `src/runtime/surface/tmux-provider.ts` | mới — core (không rebalance A1) |
| `src/runtime/surface/herdr-provider.ts` | mới — core |
| `src/runtime/surface/resolve-surface.ts` | mới — matrix + depth + async-guard + cap hardcode |
| `src/runtime/surface/launch-script.ts` | mới — script 0600 + TTL + depth-guard lớp 2 |
| `src/runtime/surface/screen-sanitizer.ts` **(A2)** | mới — khi có render mirror |
| `src/runtime/model/pi-args.ts` | surface variant bỏ `--mode json -p`; **loadout full mặc định** (bỏ --no-extensions/--no-skills/role tools; opt-in theo frontmatter `tools:` + auto-add control); `DEFAULT_MAX_CREW_DEPTH` 2 → 4 |
| `src/runtime/child-pi/child-pi-spawn.ts` + `child-pi.ts` | nhánh surface spawn; WorkerEventSource |
| `src/runtime/event-log-tail-source.ts` (mới) | tail per-agent events.jsonl |
| `src/prompt/worker-events-channel.ts` | 3 terminal events |
| `src/prompt/prompt-runtime.ts` | recorder; auto-exit; parent-guard (+starttime); **delegate tool đăng ký mọi role** (bỏ gate executor-class); **`message` tool + inbox poll mở rộng** (§15) |
| `src/runtime/delegate-spawn.ts` (+ spawn-policy) | bỏ gate role/nesting.enabled — chỉ giữ depth + slot budget |
| `src/runtime/broker/crew-broker.ts` (+ client) | active-run check; revokeTaskToken; **re-issue (A2)** |
| `src/config/types.ts`, `config-validation.ts`, `config-schema.ts` | surface schema (2 keys) + maxDepth default 4 (không còn sensitive mark) |
| `src/extension/team-tool/handle-settings.ts` | 2 keys + defaults + maxDepth default |
| `src/runtime/team-runner.ts` | resolveSurface tại dispatch; degrade; anti-flap cause-group; spawn-fail lockout; classify timeout |
| `src/runtime/async-runner.ts` **(A2)** | re-attach trigger |
| `src/state/stores/manifest-io.ts` (hoặc state-store) | ManifestSurfaceState |
| `src/runtime/zombie-scanner.ts` (+ doctor) | surface fields; cleanup; lockout display |

## 11. Rủi ro & cần verify ở bước plan

1. **Auto-exit API**: pi extension có session-shutdown hook? Tham chiếu `subagent-done.ts` — port. *Assumption: khả thi.*
2. **Recorder API surface**: extension hook full event stream (message/tool/usage) — xác nhận; **fallback cụ thể: prompt-runtime tail chính session file pi ghi** (đường đã tồn tại) thay vì subscribe API.
3. `pi --session-file` — optional (self-report là chính).
4. `sensitive: true` mark — TypeBox pattern chính xác.
5. tmux `send-keys` vào TUI pi: ký tự đặc biệt; shell startup delay — có cần wait-ready (pattern `PI_SUBAGENT_SHELL_READY_DELAY_MS`)? Xác nhận + chọn giá trị.
6. herdr Socket API schema — `herdr api schema --json` fixture.
7. herdr remote thin-client — xác nhận không có case socket resolve được nhưng pane spawn sai chỗ.
8. Windows — fail-closed headless. Không làm gì thêm.
9. `createSurface` timeout cụ thể (spawn-fail path) — chọn giá trị (đề xuất 5-10s).
10. `/proc/<pid>/stat` starttime đọc cross-platform + format truyền qua env (chuỗi) — xác nhận layout stat trên các kernel pi-crew hỗ trợ; macOS fallback chỉ-pid + doctor cảnh báo.

Đã verify OK: fsync có sẵn; broker client không strict-parse; manifest plain JSON; updateConfig scope; hello đã gửi runId.

**Prerequisite đã giải quyết (2026-08-26, verify ask)**: `broker.waitMethodsEnabled` từng default `false` — ADR-0 ghi "then flipped to true" nhưng chưa ai flip → mọi ask thật bị reject `policy-disabled` (worker chưa từng gọi thành công, 0 event park trong state cũ). **Đã flip default → `true`** (`defaults.ts` + test pin) **+ user config `~/.pi/pi-crew.json`** (bật cho bản dist đang cài) **+ prompt guidance** "never guess, call ask" trong `coordinationBridgeInstructions` (prompt-builder.ts). §15 (message tool + wake) kế thừa gate này — không còn rủi ro ngủ yên.

## 12. Data contracts

### 12.1 Surface (đầy đủ ở §4)

### 12.2 Worker event schemas (run-level, terminal — không rate-limit)

```typescript
interface WorkerStartedEvent {
  type: "worker.started";
  runId: string; taskId: string;
  data: { pid: number; sessionPath?: string;
          surface?: "tmux" | "herdr"; surfacePaneId?: string };
}
interface WorkerCompletedEvent {
  type: "worker.completed";
  runId: string; taskId: string;
  data: { result: string; usage: UsageSummary; stopReason: string };
}
interface WorkerErrorEvent {
  type: "worker.error";
  runId: string; taskId: string;
  data: { errorMessage: string; usage?: UsageSummary };
}
// UsageSummary: reuse shape từ usage-tracker hiện có — plan xác nhận import path.
```

### 12.3 Manifest — `ManifestSurfaceState` (§8.3)

### 12.4 Broker extensions

- Error mới: `{ error: "stale-token", detail: "run {id} is terminal" }` (worker-role hello; orchestrator in-process miễn — late-steer sau run end là legitimate); method `revokeTaskToken(taskId)`.
- **(A2)** Hello response `reissuedToken?: string`.

## 13. Sequence diagrams

### 13.1 Spawn (surface mode)

```
dispatch ─▶ resolveSurface(env, config, role, livePaneCount)
              │ ok (depth=0, run foreground, detect ok, cap chưa đầy)
              ▼
        launch-script.ts: write 0600 script (depth guard) + TTL-registry
              ▼
        provider.createSurface(cwd, command="bash <script>", title)  [timeout §11.9]
              ├─ tmux:  split-window -d -h → %N
              └─ herdr: pane.split → w1:pN
              ▼
        sendCommand → bash script → pi TUI mở, task = turn 1
              ▼
   [worker-side] broker hello → accept
        worker.started {pid, sessionPath} → manifest
        recorder → per-agent events.jsonl
        parent-guard poll (pid + starttime) 5s
              ▼
   [host] EventLogTailSource → dashboard/sidebar như cũ
```

### 13.2 Hoàn thành & degrade

```
worker turn kết thúc (không pending)
   ▼
worker.completed → fsync → session shutdown → pane đóng
   ▼
host onExit → chờ completed ≤ 2s?
   ├─ CÓ  → cleanup, giải phóng slot
   └─ KHÔNG → surface.degraded {cause} → revokeToken
              → lockout counts (cause-group) → dispatch headless
              (prompt + scratchpad + steers + session resume)
```

### 13.3 Re-attach — **(A2)**

```
host mới / async-runner resume → thấy run active + panes trong manifest
   ▼
provider.attach(paneId) (không spawn, không qua cap)
   ▼
hello mismatch → run active + taskId khớp → re-issue token → chạy tiếp
   ▼
pane mất → degrade (13.2); mux đã restart → attach null → degrade
```

### 13.4 Host chết (foreground Ctrl-C) — A1

```
host Ctrl-C / crash
   ▼
parent-guard (worker, 5s): pid chết HOẶC starttime khác
   ▼
worker.parent-lost → shutdown (D7 thứ tự) → pane tự đóng
   ▼
(async run: background-runner sống tiếp — guard không kích hoạt)
```

## 14. Phạm vi A1 vs A2 (YAGNI — vòng 4)

### A1 — CORE (làm ngay)

| Cơ chế | Lý do giữ ở A1 |
|---|---|
| Detect matrix (§3) + depth-guard 2 lớp | Req (b) + chống pane-in-pane |
| Provider create/read/close + onExit | Req (c) — nền tảng |
| Auto-exit D7 + classify timeout | Req (e) — không nó thì pane treo |
| Degrade flow + resume 4 thành phần | Req (c), (e) |
| Parent-guard + starttime | Chống cháy token sau Ctrl-C (worker không chết theo host) |
| Worker-side recorder + EventLogTailSource | Agent-view đọc file nó ghi — không recorder = UI trống |
| 3 terminal events (started/completed/error) | sessionPath (resume) + pid (SIGKILL) + classify |
| Graceful kill escalation | Req (c) |
| async runs **force headless** | Chưa có re-attach → không để pane vô chủ |
| Config 2 keys surface.* + team-settings | Req (a), (d) — không còn sensitive guard (đơn giản hóa v0.6) |
| **Loadout full mặc định (D5)** + nested spawning mở (D8) | Req user: "đầy đủ như main session, child tạo được child" — breaking change, có ADR riêng |
| Zombie-scanner surface fields + doctor cleanup | Backstop pane mồ côi |
| Spawn-fail lockout (3 fail → OFF run) | Chống mux half-dead loop |
| `message` tool + wake pattern (§15) | Worker nhắn phi blocking + nhìn thấy agents trò chuyện trong panes — giá trị cốt lõi của surface mode |

### A2 — DEFERED (làm sau, thiết kế đã có trong spec)

| Cơ chế | Lý do defer |
|---|---|
| Re-attach + token re-issue + async-runner trigger | Phức tạp nhất; async surface là edge case — A1 chặn bằng force headless |
| `maxSurfaceWorkers` config (A1 hardcode 6) | Tuning — constant đủ cho A1 |
| Dashboard readScreen mirror + screen sanitizer | Render mới — chỉ khi render mới cần strip |
| Rebalance layout | Cosmetic; layout mặc định ổn với ≤6 pane |
| visibleAgents default `["*"]` (GA default) | Sau khi A1 ổn định trong dùng thật |
| Unified host action `message` (3-trạng-1) | Refactor UX — sau khi core ổn; `/team-follow-up`/`team-respond`/`team-resume` giữ làm alias |

## 15. Worker messaging (D9 — học từ pi-interactive-subagents)

### 15.1 Vấn đề

Worker-side hiện chỉ có 2 kênh lên trên: `ask` (câu hỏi **blocking** — park task chờ) và `delegate` (spawn child). Broker đã có methods `msg.send`/`msg.inbox` và mailbox có kind `message`/`group_join` — **hạ tầng đầy đủ, chỉ thiếu tool đăng ký cho worker**. Hệ quả: worker không thể *báo cáo tiến độ*, *cảnh báo sớm*, *nhắn sibling* mà không tự treo mình chờ trả lời. Trong surface mode điều này quan trọng gấp đôi: giá trị của pane thật là **nhìn thấy agents trò chuyện với nhau** — đúng tinh thần demo của amos.

### 15.2 `message` tool

Dormant-until-env (pattern như `PI_CREW_ASK_ENABLED` — spawn set `PI_CREW_MSG_ENABLED=1` cho mọi role):

```typescript
interface MessageToolInput {
  to: "parent" | string | "group";  // "parent" | taskId (sibling DM) | "group"
  kind: "notify" | "message";       // notify = fire-and-forget; message = chờ hiện trong inbox
  subject?: string;
  body: string;                      // markdown; kết quả/tool-result fenced chống injection
  priority?: "urgent" | "normal" | "low";
}
// Trả về ngay (không park task như ask). Delivery: broker msg.send;
// fallback mailbox file khi broker mất (cơ chế fallback sẵn có).
```

- **`to: "parent"`** — notify lên orchestrator: widget + notifier + event `worker.message`; **wake pattern**: nếu run có orchestrator-session đang chờ (adaptive planner parked) → inject thành steer message cho session đó — LLM orchestrator **tự quyết định phản hồi** thay vì mọi thứ đổ lên human qua `/team-respond`. Giảm điểm nghẽn human, đúng mô hình "chain of command" của amos.
- **`to: <taskId>`** — DM sibling: ghi inbox mailbox của task đó; worker nhận thêm **inbox poll** (mở rộng poll của ask — cùng cadence, chung 1 vòng) và message hiện ra như fenced context ở turn boundary kế tiếp.
- **`to: "group"`** — broadcast mọi worker đã `group_join` (cơ chế mailbox sẵn có, nay worker dùng được).
- **Rate-limit**: 10 messages/phút/task (chống 2 worker nhắn nhau vòng lặp); vượt → tool trả warning. Event đủ vết (events.jsonl) để audit.

### 15.3 Bảo mật

`body` của message từ worker khác được **fence như dependency-context** khi inject (chống prompt-injection giữa agents — cùng xử lý `<delegate-result>` ADR-5 §1). Worker không mạo danh được: broker gắn taskId nguồn từ token auth — trường `from` do broker ghi đè, không tin input.

### 15.4 So sánh với amos (đã điều tra)

`ask`/steer/resume của pi-crew **đã ngang hoặc hơn** `ask_question`/`subagent_message` (replyDeadline, priority, interrupt/next_turn, mid-turn inject). Gap duy nhất chính là kênh phi-blocking + DM — §15 lấp bằng hạ tầng có sẵn. A1 làm `message` tool + wake pattern; hợp nhất host-side 3 lệnh thành 1 action `message` để A2.
