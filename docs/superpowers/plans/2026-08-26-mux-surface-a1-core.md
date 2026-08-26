# MuxSurface A1 Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workers pi-crew chạy trong pane tmux/herdr thật (auto-detect, fallback headless tuyệt đối) — A1 scope của spec MuxSurface v0.7 §14.

**Architecture:** `SurfaceProvider` interface 5 primitive với 2 backend (tmux CLI, herdr Socket API NDJSON); worker spawn trong pane qua launch script 0600 (không còn stdio JSON pipe) — events đi qua worker-side recorder vào per-agent `agents/{taskId}/events.jsonl` (nguồn agent-view đã có) + 3 terminal events lên run-level; degrade → headless + resume khi pane chết. Xem spec §13 sequence diagrams.

**Tech Stack:** TypeScript strip-types; node:test; tmux CLI (`split-window/send-keys/capture-pane/list-panes/kill-pane`); herdr unix socket NDJSON (`~/.config/herdr/herdr.sock`).

**Spec:** `docs/superpowers/specs/2026-08-26-mux-surface-design.md` (v0.7). **Điều kiện tiên quyết:** plan `2026-08-26-loadout-nesting-messaging.md` đã xong (spawn args/layout mới là nền).

## Global Constraints

- Detect **fail-closed**: mọi lỗi mux → headless, KHÔNG bao giờ throw làm chết run (spec §3).
- Pi từ chối argv flag lạ — signal surface bằng ENV (`PI_CREW_SURFACE`, `PI_CREW_SURFACE_PANE`, `PI_CREW_AUTO_EXIT`, `PI_CREW_PARENT_PID`, `PI_CREW_PARENT_START_TIME`).
- Surface pane **chỉ tier-1**: `PI_CREW_DEPTH > 0` → headless (2 lớp guard: resolve-surface + launch-script builder, spec §3).
- Async runs force headless ở A1 (spec §3, §14).
- Hằng số: TTL script 60s; classify timeout 2s; SIGTERM grace 3s; cap pane A1 = 6 (`MAX_SURFACE_WORKERS` constant); parent-guard poll 5s.
- Terminal worker events (`worker.started|completed|error`) KHÔNG bị rate-limit (spec §5.3).
- Test runner: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 <file>`; sau mỗi task `npm run typecheck`.
- Commit conventional + `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: SurfaceProvider interface + types

**Files:**
- Create: `src/runtime/surface/surface-provider.ts`
- Test: `test/unit/runtime/surface/types.test.ts`

**Interfaces (Produces — mọi task sau consume):**

```typescript
export interface SurfaceDetection { ok: boolean; kind?: "tmux" | "herdr"; reason?: string }
export interface SurfaceSpawnOpts { cwd: string; command: string; title?: string }
export interface SurfaceExitReasonMap {}
export type SurfaceExitReason = "pane-closed" | "mux-dead" | "detached";
export interface SurfaceHandle {
	id: string; kind: "tmux" | "herdr";
	onExit(cb: (reason: SurfaceExitReason) => void): void;
	dispose(): void;
}
export interface SurfaceProvider {
	kind: "tmux" | "herdr";
	detect(): SurfaceDetection;
	createSurface(name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle>;
	attach(id: string): SurfaceHandle | null;          // A2 — trả null ở A1 trừ tmux/herdr implement được dễ
	readScreen(handle: SurfaceHandle, lines?: number): Promise<string>;
	closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void>;
	// rebalance(): void — A2 defer (spec §4 đánh dấu; không implement ở A1)
}
```

- [ ] **Step 1: Failing test** — type-only test (compile guard): import mọi export, assert `const d: SurfaceDetection = { ok: false, reason: "x" }` hợp lệ; `SurfaceExitReason` union đúng 3 giá trị.
- [ ] **Step 2: Run** → FAIL (module chưa có).
- [ ] **Step 3: Viết file** — đúng block trên + JSDoc 1 dòng/type (tham chiếu spec §4).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** `git add src/runtime/surface/ test/unit/runtime/surface/ && git commit -m "feat(surface): provider interface + types (spec §4)"`

---

### Task 2: resolveSurface — detect matrix fail-closed

**Files:**
- Create: `src/runtime/surface/resolve-surface.ts`
- Test: `test/unit/runtime/surface/resolve-surface.test.ts`

**Interfaces:**
- Consumes: `SurfaceProvider` (Task 1), `PiTeamsConfig` (`runtime.surface.mode|visibleAgents` — có từ plan loadout Task 6).
- Produces: `export function resolveSurface(env, config, role: string, livePaneCount: number, opts?: { tmuxBin?: string; herdrBin?: string; pingSocket?: (p: string) => boolean }): SurfaceProvider | null` + `export const MAX_SURFACE_WORKERS = 6`.

- [ ] **Step 1: Failing test** (matrix đủ 7 ô — spec §3):

```typescript
test("matrix: depth>0 → null", ...);                       // env PI_CREW_DEPTH=1 + TMUX set
test("matrix: TMUX + binary → tmux provider", ...);          // opts.tmuxBin trỏ script giả exit 0
test("matrix: HERDR_ENV + binary + socket sống → herdr", ...); // pingSocket → true
test("matrix: cả hai → tmux (innermost)", ...);
test("matrix: không gì cả → null", ...);
test("surface.mode 'off' → null luôn; 'tmux' ép + detect fail → null (fail-closed ép cũng không chết)", ...);
test("livePaneCount >= MAX_SURFACE_WORKERS → null", ...);
test("visibleAgents [] → null; ['executor'] + role 'executor' → provider; role khác → null", ...);
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — binary check qua `execFileSync("sh", ["-c", \`command -v ${bin}\"])` trong try/catch (cache kết quả như `hasCommand` của amos tmux.ts); herdr ping = `net.connect` socket path với timeout 500ms; async-run guard: env `PI_CREW_ASYNC_RUN === "1"` → null (child-pi-spawn Task 7 sẽ set). Provider instances: import từ Task 3/4 (trong task này stub qua DI `opts.providers` để test độc lập — signature thêm `providers?: { tmux?: SurfaceProvider; herdr?: SurfaceProvider }`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): resolveSurface fail-closed matrix (spec §3)`.

---

### Task 3: tmux-provider

**Files:**
- Create: `src/runtime/surface/tmux-provider.ts`
- Test: `test/unit/runtime/surface/tmux-provider.test.ts`

**Interfaces:** Produces `export function createTmuxProvider(deps?: { tmux?: (args: string[]) => string; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> }): SurfaceProvider` — deps.tmux thay `execFileSync("tmux", args)` (test inject giả).

- [ ] **Step 1: Failing test** — fake `tmux` function bắt args: `createSurface` gọi `["split-window","-d","-h","-P","-F","#{pane_id}","-t",parentPane]` trả `"%12"` → handle.id `"%12"`; `sendCommand` qua `send-keys -t %12 -l <text>` + `send-keys -t %12 Enter`; `readScreen` qua `capture-pane -p -t %12 -S -50`; `closeSurface(force)` → force ? `kill-pane -t %12` : ghi nhận 2 bước (SIGTERM path gọi deps.killTree pid → verify thứ tự bằng spy); `onExit` với fake interval: khi tmux args `list-panes -F #{pane_dead} #{pane_id}` trả `1 %12` → cb("pane-closed") một lần.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — port logic từ `tmux.ts` của pi-interactive-subagents (đã có trong memory nghiên cứu: `split-window -d -h -P -F '#{pane_id}' -t $TMUX_PANE`; `send-keys -l`; script-file cho command dài — nhận sẵn `command` từ caller Task 5, chỉ `send-keys` chuỗi `bash <path>`; `capture-pane -p -S -N`; interval 2s `list-panes -F '#{pane_dead} #{pane_id}'` — match id → bắn `pane-closed`; tmux binary mất đột ngột (exec throw ENOENT) → bắn `mux-dead`). `title` → `select-pane -t <id> -T <title>`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): tmux provider (port pi-interactive-subagents surface)`.

---

### Task 4: herdr-provider (Socket API NDJSON)

**Files:**
- Create: `src/runtime/surface/herdr-provider.ts`
- Test: `test/unit/runtime/surface/herdr-provider.test.ts`

**Interfaces:** Produces `export function createHerdrProvider(deps?: { connect?: (path: string) => { write(line: string): void; onLine(cb: (line: string) => void): void; close(): void }; env?: NodeJS.ProcessEnv }): SurfaceProvider`. Socket path resolve: `env.HERDR_SOCKET_PATH` ?? `~/.config/herdr/herdr.sock`.

- [ ] **Step 1: Failing test** — fake socket bắt dòng JSON: request `{"id":"req-1","method":"pane.split","params":{...}}` → trả `{"id":"req-1","result":{"pane_id":"w1:p3"}}` → handle.id `"w1:p3"`; `events.subscribe` với filter pane.closed + push event `{"id":"ev-1","event":{"type":"pane.closed","pane_id":"w1:p3"}}` → onExit bắn `pane-closed`; `pane.read`/`pane.close` method names đúng; server đóng socket (onLine nhận EOF) → `mux-dead`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — NDJSON client: mỗi request 1 dòng, id tăng dần `req-N`, Promise map theo id; `detect()` = connect + `ping` (timeout 500ms); `createSurface` = `pane.current` lấy pane cha → `pane.split { direction: "right", from }` → `pane.send_text { pane_id, text: command }`; `readScreen` = `pane.read { pane_id, source: "recent", lines }`; `closeSurface` = SIGTERM pid (từ `pane.read` metadata nếu có — A1 đơn giản: `pane.close { pane_id }` force, graceful = `pane.send_text` Ctrl-C không đáng tin cậy → dùng report `pane.close` sau SIGTERM pid worker từ manifest khi có).
- [ ] **Step 4: Run** → PASS + chạy `herdr api schema --json | head -50` nếu máy có herdr để đối chiếu tên field (nếu không có herdr: ghi chú trong file header "field names theo docs herdr.dev/docs/socket-api — verify khi cài").
- [ ] **Step 5:** commit `feat(surface): herdr socket-api provider`.

---

### Task 5: launch-script builder + TTL registry (depth-guard lớp 2)

**Files:**
- Create: `src/runtime/surface/launch-script.ts`
- Test: `test/unit/runtime/surface/launch-script.test.ts`

**Interfaces:**
- Produces: `export function buildLaunchScript(input: { taskId: string; env: Record<string,string>; command: string; cwd: string; baseDir: string }): string` (trả path script) + `export function sweepLaunchScripts(registry: Map<string, number>, now: number): number` (trả số đã xóa).

- [ ] **Step 1: Failing test** — script tồn tại, mode 0o600, nội dung chứa `export PI_CREW_SURFACE=` + dòng lệnh + `rm -f -- "$0"` cuối; env có đủ 5 biến surface (SURFACE, SURFACE_PANE placeholder, AUTO_EXIT, PARENT_PID, PARENT_START_TIME); `PI_CREW_DEPTH > 0` trong env input → **throw** `SurfaceDepthGuardError`; sweep xóa entry cũ >60s, giữ entry mới.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — path `{baseDir}/pi-crew-launch-{taskId}-{process.pid}.sh`; shellEscape `'` → `'\''` bọc `'...'`; write qua `atomicWriteFile` (mode 0o600); registry Map module-level + export cho test.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): launch script builder + TTL sweep + depth guard L2`.

---

### Task 6: worker-events-channel terminal events (bypass rate-limit)

**Files:**
- Modify: `src/prompt/worker-events-channel.ts:46-53` (interface) + `:135-178` (emit)
- Test: extend qua file test mới `test/unit/prompt/worker-events-terminal.test.ts`

**Interfaces:** Produces thêm trên `WorkerEventsChannel`: `emitTerminal(type: string, data: Record<string, unknown>): boolean` — giống emit nhưng **không** qua sliding-window (schema check + FIFO buffer vẫn giữ).

- [ ] **Step 1: Failing test** — channel với `maxEventsPerWindow: 1`; emit 50 lần thường → 49 dropped-rate; `emitTerminal` 50 lần → tất cả accepted (burst >30 vẫn qua).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — tách nhánh: `emitTerminal` bỏ block `windowStarts` check, còn lại dùng chung `write`/pending queue.
- [ ] **Step 4: Run** → PASS + regression `test/unit/prompt/worker-events-channel*.test.ts` (grep tên file thật).
- [ ] **Step 5:** commit `feat(events): emitTerminal — terminal worker events bypass rate limit (spec §5.3)`.

---

### Task 7: Surface spawn branch trong child-pi pipeline

**Files:**
- Modify: `src/runtime/child-pi/child-pi-spawn.ts` (điểm build spawn options ~:137-176 + env :256-366)
- Modify: `src/runtime/model/pi-args.ts` (`buildPiWorkerArgs` nhận `input.surfacePane?: string` — khi có: bỏ `--mode json -p`, KHÔNG thay gì khác)
- Test: `test/unit/runtime/child-pi/child-pi-surface.test.ts`

**Interfaces:**
- Consumes: `buildLaunchScript` (Task 5), `SurfaceProvider.createSurface` (Task 3/4), `resolveSurface` (Task 2).
- Produces: khi team-runner quyết định surface → spawn flow: `resolveSurface` → `buildLaunchScript` (env đầy đủ + PARENT_PID + PARENT_START_TIME đọc `/proc/<ppid>/stat` field 22) → `provider.createSurface` → sendCommand `bash <script>` → trả `{ mode: "surface", provider, handle, paneId }` thay vì ChildProcess. Env thêm `PI_CREW_ASYNC_RUN` khi async-runner spawn (guard Task 2).

- [ ] **Step 1: Failing test** — hàm `prepareSurfaceSpawn(input)` (export mới từ child-pi-spawn hoặc module `surface-spawn.ts` nếu file quá dài): với fixture provider fake + env TMUX → trả command script chứa `pi --model` (KHÔNG chứa `--mode json`); depth 1 → throw guard; livePaneCount 6 → fallback headless flag; script bị đăng ký TTL registry.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm param surface vào SpawnOptions; nhánh: nếu surface provider resolve được → build script (PARENT_START_TIME: `readFileSync("/proc/" + process.pid + "/stat")` split whitespace lấy field 22; non-Linux → chuỗi rỗng + ghi chú) → createSurface → sendCommand. Giữ nguyên flow headless làm default.
- [ ] **Step 4: Run** → PASS + regression test child-pi-env hiện có.
- [ ] **Step 5:** commit `feat(surface): spawn branch — worker boots in pane via launch script`.

---

### Task 8: prompt-runtime — recorder + auto-exit + parent-guard (D7 + §5.2)

**Files:**
- Modify: `src/prompt/prompt-runtime.ts` (3 block mới trong init)
- Test: `test/unit/prompt/surface-runtime.test.ts` (create)

**Interfaces:**
- Consumes: `pi.on("session_shutdown")` pattern có sẵn (:928); `emitTerminal` (Task 6); `appendCrewAgentEvent` format `{seq,time,event}` — worker-side phải tự ghi cùng format (không dùng host helper — module khác process): ghi thẳng `fs.appendFileSync(agentsDir/events.jsonl, JSON.stringify({seq, time, event}) + "\n")` với seq đếm nội bộ + đọc `PI_CREW_AGENT_EVENTS_PATH` (env mới do spawn set = `<stateRoot>/agents/<taskId>/events.jsonl`).
- Produces: env contract `PI_CREW_AGENT_EVENTS_PATH`, hành vi: (a) `PI_CREW_SURFACE` set → recorder subscribe session events (message/toolResult/usage — dùng cùng event stream mà stdout bridge đang ăn: `pi.on("*")` hoặc JSON event hook — **verify**: grep trong event-stream-bridge.ts xem host bọc event nào, dùng cùng shape); (b) turn kết thúc stopReason done/end_turn && không ask pending && không delegate đang chạy && không steer pending → `emitTerminal("worker.completed", { result: lastAssistantText, usage, stopReason })` → gọi shutdown pi session (API: đối chiếu `subagent-done.ts` pi-interactive-subagents — repo ngoài; fallback: `process.exit(0)` sau flush nếu pi extension API không expose shutdown — **verify 1 lần, ghi kết quả vào ADR**); (c) parent-guard: interval 5s — `process.kill(parentPid, 0)` throw HOẶC starttime mismatch (đọc `/proc/<pid>/stat` field 22 so `PI_CREW_PARENT_START_TIME`) → emitTerminal("worker.parent-lost") → shutdown như (b).

- [ ] **Step 1: Failing test** — pure-function parts: `shouldAutoExit({ stopReason, askPending, delegatesRunning, steersPending })` (export) → bảng 4 case; `parentAlive(pid, startTime, readStat)` (export, inject readStat) → 3 case: sống khớp / chết / pid-reuse (stat khác starttime). Recorder: fake pi events → file events.jsonl có dòng `{seq:1,...}` + `{seq:2,...}` đúng thứ tự.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement 3 block** trong prompt-runtime init (mỗi block gate bằng env riêng — SURFACE / AUTO_EXIT / PARENT_PID).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): worker recorder + auto-exit (flush-before-shutdown) + parent-guard w/ starttime`.

---

### Task 9: EventLogTailSource + WorkerEventSource wiring

**Files:**
- Create: `src/runtime/event-log-tail-source.ts`
- Modify: `src/runtime/child-pi/child-pi.ts` (điểm consume stdout stream — tìm `registerStreamBridge`/`event-stream-bridge.ts` usage)
- Test: `test/unit/runtime/event-log-tail-source.test.ts`

**Interfaces:**
- Consumes: `watchWithErrorHandler` (src/utils/fs-watch.ts:28), `RunWatcherRegistry` (src/utils/run-watcher-registry.ts:38).
- Produces:

```typescript
export interface WorkerEventSource { readonly sourceType: "stdout" | "event-log"; onEvent(cb: (e: StreamBridgeEvent) => void): void; close(): void }
export class StdoutJsonEventSource implements WorkerEventSource { constructor(child: { stdout: NodeJS.Readable }) }
export class EventLogTailSource implements WorkerEventSource {
	constructor(input: { eventsPath: string })   // tail per-agent agents/{taskId}/events.jsonl
	// watcher callback → tự giữ byte offset → đọc incremental (stat size shrink → reset về 0)
}
```

- [ ] **Step 1: Failing test** — ghi file 2 lần (append 1 dòng JSON `{seq,time,event:{...}}` mỗi lần) sau khi start source → callback nhận đúng 2 event theo thứ tự; truncate file (size shrink) → offset reset, event kế tiếp vẫn nhận; close() dừng watcher.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `fs.watch` (qua watchWithErrorHandler) trên file, đổi sự kiện → `fs.statSync` size > offset → `fs.readSync` từ offset; map dòng JSON → truyền `line.event` vào callback (đúng shape bridge). Trong `child-pi.ts`: spawn surface → dùng `EventLogTailSource({ eventsPath: agentsEventsPath })` thay `StdoutJsonEventSource`; headless giữ nguyên.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): EventLogTailSource — host tail per-agent event log (spec §5.3)`.

---

### Task 10: Broker — active-run check + revokeTaskToken

**Files:**
- Modify: `src/runtime/broker/crew-broker.ts` (handleHello ~:665-720; token registry class gần đó)
- Test: extend `test/unit/runtime/broker/wait-request-broker.test.ts`

**Interfaces:**
- Produces: (a) hello với token không match NHƯNG runId active (manifest status running) + taskId match → hiện A1: vẫn reject (re-issue là A2) nhưng error `stale-token` thay vì generic auth; (b) `revokeTaskToken(taskId)` — method trên broker instance: đánh dấu token của task invalid; request kế tiếp từ token đó → reject `revoked`.

- [ ] **Step 1: Failing test** — start broker (fixture có sẵn trong file test) → hello token đúng → ok; revokeTaskToken(taskId) → hello lại token cũ → error chứa `revoked`; hello sau run manifest status completed → error `stale-token`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — Set<string> revokedTokenHash trong registry; hello path check revoked + run status.
- [ ] **Step 4: Run** → PASS (cả 12 test cũ).
- [ ] **Step 5:** commit `feat(broker): revokeTaskToken + stale-token error for terminal runs`.

---

### Task 11: team-runner — degrade flow + lockout + manifest surface state

**Files:**
- Modify: `src/runtime/team-runner.ts` (dispatch site — executeTeamRun :332-1119; thêm module nhỏ nếu file quá dài: `src/runtime/surface/degrade.ts`)
- Modify: `src/state/stores/manifest-io.ts` hoặc state-store (field `surface`)
- Test: `test/unit/runtime/surface/degrade.test.ts` (create)

**Interfaces:**
- Consumes: `SurfaceHandle.onExit` (Task 1), `revokeTaskToken` (Task 10), `EventLogTailSource` (Task 9), scratchpad restore + pendingSteers replay có sẵn (child-executor.ts:619-630).
- Produces: `export function classifyOnExit(handle, waitForCompleted: (ms: number) => Promise<boolean>): Promise<"completed" | "degraded">` (2s timeout); `export function nextLockoutCounts(prev: { pane: number; mux: number }, cause: "pane-closed" | "mux-dead"): { pane: number; mux: number }` (mux-dead batch = +1 mux MỘT lần cho N pane); manifest type:

```typescript
interface ManifestSurfaceState {
	provider: "tmux" | "herdr" | null;
	panes: Record<string, string>;
	workerPids: Record<string, number>;
	sessionPaths: Record<string, string>;
	lockout?: { since: string; counts: { pane: number; mux: number } };
}
```

- [ ] **Step 1: Failing test** — classifyOnExit: completed đến 1.5s → "completed"; không đến sau 2s → "degraded" (dùng fake timers/injectable clock). nextLockoutCounts: N pane cùng mux-dead → mux = prev+1 (không +N). spawn-fail counter: 3 fail liên tiếp → surfaceOffUntilRunEnd = true; 1-2 fail → false (không đếm vào lockout degrade).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — pure functions trong degrade.ts + wiring team-runner: tại dispatch gọi resolveSurface (Task 2) + spawn-fail try/catch (retry headless ngay + counter); onExit handler → classify → degrade path: event `surface.degraded` (qua worker-events? không — host ghi event run bình thường qua appendEvent hiện có trong team-runner) → revokeToken → lockout update manifest → re-dispatch headless với PI_CREW_SCRATCHPAD_RESTORE + pendingSteers + sessionPath resume prompt.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** commit `feat(surface): degrade flow — classify timeout, cause-group lockout, spawn-fail lockout, headless resume`.

---

### Task 12: zombie-scanner + doctor surface fields

**Files:**
- Modify: `src/runtime/zombie-scanner.ts` (hoặc file chứa — grep `PI_CREW_KIND` trong src/runtime) — interface `ZombieSubagent` thêm `surface?: "tmux"|"herdr"; surfacePaneId?: string`
- Modify: doctor output (grep "zombies" trong extension/team-tool)
- Test: extend test zombie hiện có (grep test/unit zombie)

- [ ] **Step 1: Failing test** — fixture /proc environ giả chứa `PI_CREW_SURFACE=tmux` + `PI_CREW_SURFACE_PANE=%12` → scan result có 2 field mới; doctor cleanup với pane có sẵn (fake provider) → gọi closeSurface với đúng id.
- [ ] **Step 2: Run** → FAIL → **Step 3: Implement** (parse 2 env thêm; doctor liệt kê pane id trong output text).
- [ ] **Step 4: Run** → PASS. **Step 5:** commit `feat(doctor): zombie surface fields + orphan pane cleanup`.

---

### Task 13: E2E system test trong tmux thật

**Files:**
- Create: `test/system/surface-tmux.e2e.test.ts`

**Interfaces:** Consumes mọi task trước. Skip điều kiện: `process.env.CI || !process.env.TMUX` → `t.skip` (chỉ chạy local trong tmux).

- [ ] **Step 1: Viết test** — script giả `pi` (bash script echo JSON events + exit 0) đặt trong temp bin; chạy 1 run scaffold→surface với tmux thật: assert (1) pane được tạo (`tmux list-panes` chứa id trả về), (2) script chạy trong pane (sentinel file xuất hiện), (3) pane đóng sau exit, (4) run hoàn thành không lỗi. Test thứ 2: kill-pane giữa chừng → task degrade headless (worker giả headless chạy tiếp) → run vẫn done.
- [ ] **Step 2: Run trong tmux** (`tmux new -d -s pitest 'node --experimental-strip-types --test ...'`) → PASS. Nếu fail: sửa theo đúng tinh thần spec §3 (fail-closed) — không bỏ test.
- [ ] **Step 3:** commit `test(surface): E2E tmux spawn + degrade`.

---

### Task 14: Docs — TEST_MATRIX + ADR

**Files:**
- Create: `docs/decisions/2026-08-26-mux-surface-a1.md` (ADR: process ownership đổi — worker là con của mux server; parent-guard; depth-guard 2 lớp; loadout đảo)
- Modify: `docs/TEST_MATRIX.md` (hàng mới mọi cơ chế A1 theo spec §14)

- [ ] **Step 1:** Viết ADR (context → decision → consequences, style theo ADR-5 hiện có trong docs/decisions/).
- [ ] **Step 2:** `npm test` full — không fail mới.
- [ ] **Step 3:** commit `docs: mux-surface A1 ADR + test matrix`.
