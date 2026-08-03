# Performance Review — pi-crew v0.9.17 (2026-07-02)

> Deep-dive review toàn bộ codebase (~434 file TS, ~82.7k dòng) tập trung vào hiệu năng.
> Mọi phát hiện đều có file:line cụ thể và đã được xác minh trực tiếp trên source.
> Bổ sung cho `docs/perf/final-report-2026-05.md` và `docs/archive/optimization-plan.md` (các vòng tối ưu trước).
>
> **Cập nhật sau pull v0.9.17**: ban đầu review trên v0.9.16, sau đó user pull 40 commits mới
> (`1418fa7..22a8e72`, ~20k dòng thay đổi trong `src/`). Mọi phát hiện đã được re-verify trên
> code mới. Xem thêm [§5 — Delta v0.9.17](#5-delta-v0917--những-gì-đã-fix-và-regressed).

## 1. Đánh giá tổng quan

### Điểm mạnh (đã làm tốt)

| Hạng mục | Bằng chứng |
|---|---|
| Render path zero-fs-IO | `register.ts:1744+` — renderTick chỉ đọc từ frame preload, không chạm disk |
| Snapshot cache 2 tầng (TTL 1.5s + stamp mtime/size) | `run-snapshot-cache.ts:21-25, 79-97` — tail-read 32KB, không bao giờ parse full events.jsonl |
| Event tail đọc theo byte-offset | `utils/incremental-reader.ts:23` — `readJsonlSince` dùng openSync/readSync từ offset |
| Concurrency có hard cap | `config/defaults.ts:46-56` — hardCap 8, per-workflow 2-4, enforced qua `mapConcurrent` |
| Capture stdout/stderr bounded | `child-pi.ts:53` — tail cap 512KiB, có backpressure soft watermark 256KiB |
| Timer nền đều `unref()` | auto-repair, temp-reconcile, notifier — không giữ event loop |
| Watcher bounded theo active runs | `register.ts:1690-1706` — reconcile watcher chỉ O(active runs) |
| Lazy import có kỷ luật | `// LAZY:` markers + `npm run check:lazy-imports` |

Kiến trúc 3 layer rõ ràng, defensive coding tốt (CAS, lock, terminal-state guard). Vấn đề hiệu năng chủ yếu KHÔNG nằm ở thuật toán mà ở **tần suất lặp lại của I/O đồng bộ nhỏ** trên hot path.

### Điểm yếu tổng quát

1. **State layer ghi-toàn-file + fsync per-event**: mỗi thay đổi status của 1 task ghi lại toàn bộ tasks.json (pretty-printed), mỗi event append kèm 1 fsync + 1 atomic write sidecar.
2. **Cache tồn tại nhưng tự vô hiệu hóa**: manifest cache bị global-generation invalidation, discovery cache TTL 500ms, config hoàn toàn không cache.
3. **Sync I/O chặn event loop**: `execFileSync` (git), `withRunLockSync` + `sleepSync`, `statSync` chuỗi — chạy trong extension host của Pi, chặn cả UI.
4. **Hạ tầng batching/coalescing đã viết nhưng không được dùng**: `appendEventBuffered`, `saveRunTasksCoalesced` đều 0 call site.

---

## 2. Phát hiện chi tiết theo layer

### 2.1 State layer

#### F1 — HIGH: Global generation counter phá cache của TẤT CẢ runs
- `src/state/state-store.ts:73, 125-128`
```ts
let manifestCacheGeneration = 0;
function invalidateRunCache(stateRoot: string): void {
    manifestCache.delete(stateRoot);
    manifestCacheGeneration++;   // <-- vô hiệu hóa MỌI entry, không chỉ run này
}
```
- Cache hit yêu cầu `cached.generation === manifestCacheGeneration` (`:589, :685`). Mỗi `saveRunTasks`/`saveRunManifest` của BẤT KỲ run nào đều bump counter, nên khi có 1 run active, hit-rate của cache sụp về ~0. Mỗi miss = 2 statSync + 2 readFileSync + JSON.parse trong retry loop tối đa 5 vòng (`:617-631`).
- **Fix đề xuất**: generation counter per-stateRoot (`Map<string, number>`) thay vì global. Mtime/size check đã đủ chống spoof cho từng entry.

#### F2 — HIGH: `persistSingleTaskUpdate` — sync CAS loop tối đa 100 vòng, mỗi vòng đọc lại full state
- `src/runtime/task-runner/state-helpers.ts:28-110`, gọi tại `task-runner.ts:233, 424, 538, 617, 1347` (mỗi lần task đổi status/checkpoint)
```ts
return withRunLockSync(manifest, () => {
    retryLoop: for (let attempt = 0; attempt < 100; attempt++) {
        const latest = loadRunManifestById(manifest.cwd, manifest.runId)?.tasks ?? fallbackTasks;
        // ... 3x statSync mtime check ...
```
- Toàn bộ sync, dưới `withRunLockSync` (poll bằng `sleepSync` chặn event loop). Kết hợp F1 (cache lạnh) nghĩa là mỗi checkpoint = lock + full read manifest.json + tasks.json + full rewrite tasks.json.
- **Fix đề xuất**: (a) đã cầm run lock thì mtime-CAS 3 lần stat là thừa — lock loại trừ writer khác cùng process-tree, chỉ cần 1 lần đọc + 1 lần ghi; (b) chuyển sang async variant; (c) giữ tasks in-memory per-run và chỉ ghi diff-triggered.

#### F3 — HIGH → PARTIALLY FIXED (v0.9.17): Mỗi event append = fsync + atomic-write sidecar `.seq`
- `src/state/event-log.ts:583-611` (sync path không đổi)
```ts
fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
const fd = fs.openSync(eventsPath, "r+");
fs.fsyncSync(fd); ...
persistSequence(eventsPath, seq);   // full atomicWriteFile của .seq mỗi event
```
- **Đã fix một phần (v0.9.17)**: `appendEventBuffered` giờ đã có call site — `task.progress` trong
  `task-runner.ts:395` và `team-runner.ts:1054` đi qua buffered path (coalesce 20ms, 1 lock acquire).
  Bench trong code comment: p95 producer giảm từ ~13µs → ~0µs. Tuy nhiên:
  - Các event terminal/vài event khác vẫn đi `appendEvent`/`appendEventAsync` → per-event fsync + `.seq` sidecar.
  - `persistSequence` vẫn ghi sidecar per event (trong batch, gọi tuần tự trong lock nhưng mỗi event 1 lần).
- **Fix đề xuất còn lại**: chỉ fsync cho terminal events (`TERMINAL_EVENT_TYPES`); persist `.seq` theo batch
  hoặc mỗi N events (recovery scan đã tự sửa được khi sidecar tụt hậu); mở rộng `appendEventBuffered`
  cho thêm các event loại informational (`task.checkpoint`, `worker.lifecycle`, ...).

#### F4 — HIGH → REGRESSED (v0.9.17): tasks.json ghi lại toàn bộ, pretty-printed, mỗi thay đổi + fsync data+dir
- `state-store.ts:365-377` → `atomicWriteJson` dùng `JSON.stringify(value, null, 2)` (`atomic-write.ts:523`).
- Task graph chứa attempts, verification, usage, diagnostics per task → file lớn dần trong run dài; stringify + write cost tỉ lệ O(tổng state) cho MỖI thay đổi 1 field.
- **REGRESSED (v0.9.17, commit `13f4490`)**: `atomicWriteFile` giờ thêm `fs.fsyncSync(fd)` trên data file
  (`atomic-write.ts:384`) **và** `fs.fsyncSync(dirFd)` trên parent directory (`:410`, POSIX only).
  Mỗi `atomicWriteJson` call = write + fsync(data) + fsync(dir) + rename. Comment trong code ước lượng
  "~1ms per write" nhưng thực tế trên Windows fsync đắt hơn nhiều; CI timeout đã phải bump 600s→900s
  chính vì overhead này (`9bbeb45`). `persistSingleTaskUpdate` (F2) gọi `saveRunTasks` ~5 lần mỗi task,
  mỗi lần giờ tốn thêm 2× fsync.
- `saveRunTasksCoalesced` (50ms debounce) đã có tại `state-store.ts:428` nhưng **vẫn 0 call site** (v0.9.17 xác nhận).
- **Fix đề xuất**: bỏ pretty-print cho tasks.json (giữ cho manifest nếu cần đọc tay), wire `saveRunTasksCoalesced`
  vào checkpoint path (checkpoint là informational, mất 50ms cuối khi crash chấp nhận được vì đã có crash-recovery);
  cân nhắc fsync chỉ trên terminal write (manifest final), không phải mỗi checkpoint.

#### F5 — MEDIUM: `isSymlinkSafePath` walk toàn bộ ancestor chain, chạy 2 lần mỗi atomic write
- `atomic-write.ts:43-56, 287, 359-361`: mỗi write = 2 × (lstatSync per path level đến root). Với path sâu điển hình `.crew/state/runs/{runId}/` là ~10+ lstat × 2 mỗi write, nhân với mọi finding ở trên.
- `withFileLockSync` còn gọi lại check này MỖI vòng retry (`locks.ts:319`).
- **Fix đề xuất**: cache kết quả validate theo (dirname, generation) trong process — thư mục cha của state root không đổi trong suốt run; chỉ re-validate khi ghi vào path mới.

#### F6 — HIGH → REGRESSED (v0.9.17): Mailbox — mỗi message = 2 lock + full rewrite delivery.json + lstat chain × 3 + fsync data+dir
- `src/state/mailbox.ts:380-430`: `mailboxFile(...)` tính lại 3 lần (mỗi lần re-run lstat validation), `writeDeliveryState` (`:353`) sort đến 10k entries + atomic rewrite toàn bộ pretty-printed delivery.json cho MỖI message.
- **REGRESSED (v0.9.17)**: `atomicWriteFile` giờ fsync data + parent dir (commit `13f4490`), nên mỗi delivery.json rewrite tốn thêm 2× fsync. CI flake mailbox-replay chính là lý do commit này tồn tại, nhưng代价 là mọi write path đều nặng hơn.
- Reads: `safeReadMailboxFile` (`:246`) readdirSync tìm archive MỖI lần đọc; `readAllMessages` (`:321`) O(tasks × dir entries); `updateMailboxMessageReply` (`:463`) quét mọi mailbox file, mỗi file full read + full rewrite.
- **Fix đề xuất**: delivery state chuyển sang append-only JSONL + compaction (giống events), hoặc ít nhất coalesce write; cache danh sách archive theo mtime của dir; chỉ fsync khi reply/terminal, không phải mỗi informational message.

#### F7 — MEDIUM/HIGH: active-run-registry O(N runs) full manifest parse mỗi register/unregister
- `active-run-registry.ts:249-344`: `filterAliveEntries` đọc + parse manifest.json của từng run, 2× existsSync + 2× symlink walk + `process.kill(pid,0)` per entry; `registerActiveRun` gọi 2 lần; `unregisterActiveRun` chạy trên MỖI terminal transition (`state-store.ts:508`). Registry còn ghi 2 định dạng (JSON + binary mirror) = 4 temp-file ops mỗi update (`:183`).
- **Fix đề xuất**: liveness chỉ cần pid probe + heartbeat stat, không cần parse manifest; bỏ dual-format write nếu binary mirror không còn consumer.

### 2.2 Runtime / process layer

#### F8 — HIGH: Worktree prep = 5-6 git subprocess `execFileSync` tuần tự + full checkout, chặn event loop
- `src/worktree/worktree-manager.ts:1,30,331-425`: mỗi task cần worktree chạy lần lượt `rev-parse --show-toplevel`, `status --porcelain` trên leader repo (O(repo size)), `worktree list --porcelain`, `worktree prune`, `rev-parse --verify`, `worktree add -b ... HEAD`. Tất cả `execFileSync` → dù tasks chạy "song song" qua `mapConcurrent`, phần chuẩn bị worktree bị serialize và chặn toàn bộ extension host (UI đơ theo).
- Reuse path vẫn tốn `worktree list` + `status` + leader `status` lần 2. Cleanup gọi lại `findGitRoot` 3 lần (tới 6 git spawn).
- **v0.9.17 note**: M6 coalesce (`coalesceMicroTasks`) giảm số spawn cho workflow có nhiều task nhỏ read-only (3 task → 1 child + 1 worktree), nhưng bản thân worktree prep vẫn sync. Khi M6 mở rộng sang mutating roles, vấn đề sẽ tái xuất.
- **Fix đề xuất**: (a) chuyển sang `execFile` async (promisify) — thay đổi cục bộ, tác động lớn nhất; (b) cache `findGitRoot`/`assertCleanLeader` per (repo, batch) — leader status chỉ cần check 1 lần mỗi batch chứ không phải mỗi task; (c) cân nhắc `git worktree add --no-checkout` + sparse checkout cho task chỉ đọc một phần repo.

#### F9 — HIGH: `ChildPiLineObserver` giữ mảng không giới hạn trong suốt run
- `child-pi.ts` (~:528): `rawTextEvents` push mọi fragment assistant-text KHÔNG cap ("RAW (uncapped)"), chỉ dùng entry cuối qua `getRawFinalText()`. `intermediateFindings` cũng push-only, chỉ trim khi đọc (`slice(-20)`).
- Run dài + worker nói nhiều = memory tăng tuyến tính theo output, nhân với số worker song song.
- **Fix đề xuất**: giữ tối đa N entry cuối ngay khi push (ring buffer), vì consumer chỉ cần tail.

#### F10 — MEDIUM: Double JSON.parse mỗi dòng stdout + sync transcript write per line
- Mỗi JSON line từ child bị parse 2 lần (`emitLine` → `extractText` và `compactChildPiLine`).
- `appendTranscript` (`child-pi.ts:387-414`): mỗi dòng = realpath validation + openSync/writeSync/closeSync. Nên parse 1 lần rồi truyền object; giữ fd mở per-task (mở 1 lần, đóng khi task kết thúc) và validate path 1 lần.

#### F11 — MEDIUM: `appendBoundedTail` rebuild chuỗi O(cap) mỗi dòng
- `child-pi.ts:53, 927, 1121`: `current + chunk` rồi slice với cap 512KiB → copy ~512KB mỗi dòng khi buffer đầy. Fix: array-of-chunks + tổng byte, chỉ join khi đọc.

#### F12 — MEDIUM: Latency floor 5s mỗi task thành công (final-drain)
- `finalDrainMs = 5000` (`defaults.ts:13`): sau final assistant event, chờ 5s rồi mới SIGTERM child. Workflow 5 task tuần tự cộng thêm ~25s chết. Fix: khi đã nhận `message_end` + stopReason=stop, rút xuống 1-1.5s, hoặc drain kết thúc sớm khi stdout im lặng >300ms.

#### F13 — MEDIUM: Interrupt guard poll 250ms sync fs suốt đời background run
- `background-runner.ts:144`: existsSync + readFileSync + JSON.parse foreground-control.json mỗi 250ms, per background run (4 Hz × N runs). Fix: `fs.watch` file cha + fallback poll thưa (2s), hoặc chỉ stat mtime trước khi read.

#### F14 — MEDIUM: Temp-reconcile parse cùng manifest tới 4 lần mỗi tick
- `stale-reconciler.ts:516-700`: tick 5 phút, batch 50 dirs, nhưng mỗi dir parse manifest.json + tasks.json rồi re-scan thêm tối đa 3 pass cho TOCTOU check. Fix: đọc 1 lần, truyền parsed object qua các pass, chỉ re-stat mtime để phát hiện thay đổi.

#### F15 — MEDIUM: Discovery cache TTL 500ms gần như vô dụng ở steady state
- `discover-agents.ts:453`: TTL 500ms → scheduler loop re-scan 4 thư mục (readdir + readFile + ~12 regex pass sanitize mỗi file .md) ~2 lần/giây. `discoverTeams`/`discoverWorkflows` **không có cache nào**.
- **Fix đề xuất**: nâng TTL lên 5-10s kèm invalidation theo mtime của các dir gốc (stat dir rẻ hơn nhiều so với scan), dùng chung 1 cache module cho cả agents/teams/workflows.

### 2.3 Extension / UI layer

#### F16 — HIGH: `loadConfig()` không có cache, bị gọi trên mọi hot path
- `config/config.ts:1358-1425`: mỗi lần gọi = tới 4 file (legacy, user, `.crew/config.json`, `.pi/pi-crew.json`) × (existsSync + statSync + readFileSync + JSON.parse với reviver) + full TypeBox `Value.Check` + nhiều pass sanitize/merge.
- Caller trên hot path:
  - Preload tick: `register.ts:1684` — 1 Hz idle, ~6 Hz khi có run active
  - **Mỗi write/edit tool_result**: `register.ts:2088` (`perWriteValidation` check)
  - Mỗi subagent completion (`register.ts:265`), mỗi notification
- **Fix đề xuất (quick win lớn nhất)**: cache mtime+TTL giống pattern `manifest-cache.ts` đã có sẵn trong repo. Stat 4 file (~4 syscall) thay vì parse + validate lại. Ước lượng loại bỏ hàng nghìn parse/validate mỗi phiên.

#### F17 — HIGH: Powerbar re-scan toàn bộ workflows tới ~5 lần/giây khi run active
- `ui/powerbar-publisher.ts:215`:
```ts
const workflows = allWorkflows(discoverWorkflows(run.cwd));
```
- Chạy trong `updatePiCrewPowerbar` (coalesce 200ms). `discoverWorkflows` = 2× readdirSync × 3 roots + readFileSync + regex-parse mọi `.workflow.md`, không cache. Fix: TTL cache 5-10s như F15, hoặc chỉ resolve workflow 1 lần khi run bắt đầu (workflow của run không đổi giữa chừng).

#### F18 — MEDIUM: Preload loop không bao giờ nghỉ khi idle
- `register.ts:1727-1741`: tick 1 Hz kể cả khi 0 run, mỗi tick gọi `loadConfig` (F16) + `manifestCache.list(20)` (list-cache TTL chỉ 500ms tại `manifest-cache.ts:36` → readdirSync + statSync per manifest gần như mỗi tick). Fix: khi N tick liên tiếp không có run active và không có event bus activity, giãn xuống 5-10s hoặc dừng hẳn, đánh thức bằng event-bus/`run` action.

#### F19 — MEDIUM: `mailboxStamp` O(N task dirs) statSync mỗi lần check stale
- `run-snapshot-cache.ts:110-129`: mỗi refresh check = readdirSync(mailbox/tasks) + 2 statSync per task dir, sync trên UI path. Code đã từng bỏ per-agent output stamp vì lý do này (comment `:604-608`) nhưng mailbox stamp còn giữ pattern cũ. Fix: 1 stamp file tổng do writer touch, hoặc dựa vào event-bus invalidation (đã có) và bỏ stamp mailbox.

#### F20 — LOW/MEDIUM: `delivery.json` parse 2 lần, `outbox.jsonl` tail-read 2 lần mỗi snapshot rebuild
- `run-snapshot-cache.ts:484, 507`. Fix: đọc 1 lần, chia sẻ kết quả giữa `mailboxFrom` và `groupJoinsFrom`.

#### F21 — MEDIUM: `async-notifier` full `readEvents` mỗi 5s cho run nghi ngờ chết
- `async-notifier.ts:74`: `markDeadAsyncRunIfNeeded` đọc + parse toàn bộ events.jsonl (tới 50MB). Fix: dùng `readEventsCursor` với byte offset lưu lại, hoặc chỉ cần tail vài KB cuối để tìm terminal event.

---

## 3. Kế hoạch tối ưu đề xuất (ưu tiên theo tác động / rủi ro)

### Đợt 1 — Quick wins (thay đổi cục bộ, rủi ro thấp, tác động lớn)

| # | Việc | File | Tác động |
|---|---|---|---|
| 1 | Cache `loadConfig` theo mtime+TTL (2s) | config.ts | Loại bỏ nguồn CPU lặp lại lớn nhất ở extension layer (F16) |
| 2 | Generation counter per-stateRoot | state-store.ts | Khôi phục hit-rate manifest cache khi run active (F1) |
| 3 | TTL cache cho `discoverWorkflows`/`discoverTeams`, nâng TTL agents lên 5-10s + mtime dir check | discover-*.ts | Diệt 5 Hz scan của powerbar (F17) + steady-state scan (F15) |
| 4 | Bỏ pretty-print cho tasks.json | atomic-write.ts caller | Giảm ~40-60% byte ghi mỗi update (F4) |
| 5 | Ring-buffer cho `rawTextEvents`/`intermediateFindings` | child-pi.ts | Chặn memory growth run dài (F9) |
| 6 | Giảm `finalDrainMs` 5000 → 1500 (config đã có sẵn override) | defaults.ts | Bớt 3.5s/task latency (F12) |
| 7 | Đọc delivery.json/outbox 1 lần mỗi snapshot rebuild | run-snapshot-cache.ts | (F20) |

### Đợt 2 — Batching và giảm fsync (cần chạy lại integration tests)

| # | Việc | Tác động |
|---|---|---|
| 8 | Wire `appendEventBuffered` cho event không-terminal; fsync chỉ terminal events; persist `.seq` mỗi N events | Giảm mạnh syscall/fsync per event (F3), hạ tầng đã viết sẵn |
| 9 | Wire `saveRunTasksCoalesced` vào checkpoint path của task-runner | Gộp burst checkpoint writes (F4) |
| 10 | Đơn giản hóa `persistSingleTaskUpdate`: bỏ mtime-CAS khi đã cầm run lock, chuyển async | Bỏ 3× statSync + retry loop 100 vòng (F2) |
| 11 | Cache kết quả `isSymlinkSafePath` theo dirname trong process | Bỏ 2× ancestor lstat walk mỗi write (F5) |
| 12 | Idle backoff cho preload loop + nâng list-cache TTL khi idle | (F18) |

### Đợt 3 — Cấu trúc (cần thiết kế, test kỹ)

| # | Việc | Tác động |
|---|---|---|
| 13 | Chuyển worktree-manager sang async `execFile`, cache leader-status per batch | Hết chặn event loop khi fanout, worktree prep song song thật (F8) |
| 14 | Mailbox delivery-state append-only + compaction; archive-list cache | (F6) |
| 15 | Registry liveness không cần parse manifest; bỏ dual-format write | (F7) |
| 16 | In-memory task state per active run (write-through), disk chỉ là bản persist | Về lâu dài loại bỏ read-modify-write cycle hoàn toàn (F1/F2/F4) |
| 17 | `readEvents` mặc định đi qua cursor/tail; notifier dùng offset | (F21, F6 read path) |

### Cách đo và nghiệm thu

- Repo đã có `src/benchmark/` — thêm micro-bench cho: `loadConfig` (trước/sau cache), `persistSingleTaskUpdate` (thời gian/syscall mỗi checkpoint), `appendEvent` throughput (events/s), worktree prep wall-time với N task song song.
- Đo end-to-end: `time` của 1 run `fast-fix` scaffold-mode (loại bỏ nhiễu model) trước/sau từng đợt.
- Windows là môi trường nhạy nhất (fsync, spawn, stat đều đắt hơn) — benchmark trên Windows trước.
- Sau mỗi đợt: `npm run typecheck` + `npm test` + `npm run check:lazy-imports`.

### Ước lượng tác động tổng

- Đợt 1: giảm rõ CPU nền khi idle (config parse 1 Hz → 0), powerbar scan (5 Hz → ~0), latency mỗi task -3.5s, memory ổn định cho run dài.
- Đợt 2: giảm 5-10× số syscall/fsync trên đường ghi state trong run active (mỗi task hiện tốn ~5 checkpoint × [lock + 2 read + 3 stat + full rewrite] + ~10-20 event × [fsync + sidecar write]).
- Đợt 3: hết hiện tượng UI đơ khi fanout worktree trên repo lớn; state layer scale theo số run/task.

---

## 4. Ghi chú không phải hiệu năng (quan sát thêm)

- `PluginRegistry` builtin trong team-runner.ts được register nhưng chưa có integration point (chính comment trong code thừa nhận) — dead weight nhỏ.
- Nhiều file lớn >1500 dòng (register.ts 79KB, team-runner.ts 69KB) — không phải vấn đề runtime nhưng làm chậm typecheck/test và khó review; đã có xu hướng tách (`team-tool/*.ts`), nên tiếp tục.
- Sync lock với `sleepSync` (locks.ts:244, event-log.ts:143) chặn event loop khi contention — Đợt 2/3 nên ưu tiên các async variant đã có sẵn.

---

## 5. Delta v0.9.17 — những gì đã fix và regressed

> 40 commits pulled (`1418fa7..22a8e72`), ~20k dòng thay đổi trong `src/`.
> Re-verify từng phát hiện trên code mới. Bảng tổng hợp:

### 5.1 Đã cải thiện (positive)

| Commit | Thay đổi | Tác động hiệu năng |
|---|---|---|
| `task-runner.ts:395`, `team-runner.ts:1054` | `appendEventBuffered` wired cho `task.progress` | **F3 partial fix** — event tần suất cao nhất giờ coalesce 20ms, 1 lock acquire. p95 producer ~0µs (bench trong comment). Terminal events vẫn per-fsync. |
| `21ac434` M6 coalesce micro-tasks | `coalesceMicroTasks` workflow flag + `coalesce-tasks.ts` | Giảm số child process spawn khi workflow có nhiều task nhỏ read-only (3 task → 1 spawn). Trực tiếp giảm F8/F9/F12 cho workload phù hợp. |
| `0543966` M5 serialize on write-path overlap | `path-overlap.ts` | Tránh conflict khi 2 task song song ghi cùng file. Không phải tối ưu tốc độ nhưng giảm retry/conflict overhead. |
| `48aae01` L4 trim dependency output | `task-output-context.ts` + `MAX_TOTAL_DEP_INLINE_BYTES` | Giảm context size truyền cho child → giảm prompt build cost + model input tokens. |
| `8a68825`+`06f16d7` Bundle as default entry | `dist/index.mjs` 2.9MB, esbuild | **Cold-start −31.6%** (2509ms → 1717ms p50, bench `scripts/bench-cold-start.mjs`). Tác động lớn nhất đến latency khởi động. |
| `5281074` Split register.ts | `registration/{lifecycle,observability,ui}.ts` + LAZY markers | Giảm module-graph warmup cost; lazy import boundary rõ hơn. |
| `cbaa572` Drop withRunLock from catch path | `team-runner.ts` | Sửa closeout lock race (run.completed rồi run.failed 500ms sau). Không phải perf nhưng sửa 1 nguồn spurious failed run → giảm retry waste. |

### 5.2 Đã regressed (negative)

| Commit | Thay đổi | Tác động |
|---|---|---|
| `13f4490` fsync data + parent dir | `atomic-write.ts:384,410` | **F4 + F6 regressed** — mỗi `atomicWriteFile` giờ thêm `fs.fsyncSync(fd)` + `fs.fsyncSync(dirFd)` (POSIX). CI timeout phải bump 600s→900s (`9bbeb45`). `persistSingleTaskUpdate` gọi ~5 lần mỗi task × 2 fsync = +10 fsync/task. Trên Windows fsync đặc biệt đắt. |
| `test:integration` timeout 120s→300s | `22a8e72` | Phản ánh tổng overhead tăng do fsync + bundle + M6. |

### 5.3 Không đổi (xác nhận vẫn còn trên v0.9.17)

| Finding | Trạng thái | Bằng chứng |
|---|---|---|
| F1 — global generation counter | **Vẫn còn** | `state-store.ts:132` `manifestCacheGeneration++` |
| F2 — persistSingleTaskUpdate 100-iteration sync CAS | **Vẫn còn** | `state-helpers.ts:57` `attempt < 100` |
| F4 — saveRunTasksCoalesced 0 caller | **Vẫn còn** | grep toàn src, chỉ definition tại `state-store.ts:428` |
| F5 — isSymlinkSafePath ancestor walk ×2 | **Vẫn còn** | `atomic-write.ts` không đổi logic validate |
| F8 — worktree execFileSync | **Vẫn còn** | `worktree-manager.ts:1,33` — `execFileSync` unchanged |
| F9 — rawTextEvents unbounded | **Vẫn còn** | `child-pi.ts:600` `private readonly rawTextEvents: string[] = []` |
| F12 — finalDrainMs 5000 | **Vẫn còn** | `defaults.ts:13` `finalDrainMs: 5000` |
| F15 — discovery cache TTL 500ms | **Vẫn còn** | `discover-agents.ts:493` `DISCOVERY_CACHE_TTL_MS = 500` |
| F16 — loadConfig không cache | **Vẫn còn** | `config.ts` không có configCache (grep confirmed) |
| F17 — discoverWorkflows không cache, gọi ~5Hz | **Vẫn còn** | `powerbar-publisher.ts:284` `discoverWorkflows(run.cwd)` — không cache trong discover-workflows.ts (grep confirmed) |
| F21 — async-notifier full readEvents | **Vẫn còn** | `async-notifier.ts:90` `readEvents(run.eventsPath)` |

### 5.4 Khuyến nghị cập nhật cho Đợt 1

Sau v0.9.17, thứ tự ưu tiên Đợt 1 cần điều chỉnh:

1. **F4 fsync mitigation** (NEW urgent): thêm tham số `durability: "full" | "best-effort"` cho `atomicWriteJson`.
   Checkpoint/informational writes dùng `best-effort` (bỏ fsync data+dir, chỉ rename). Terminal/manifest writes giữ `full`.
   Đây là fix nhanh nhất cho regression `13f4490` mà không mất durability cho data quan trọng.
2. **F16 loadConfig cache** (giữ #1): vẫn là quick win lớn nhất, không bị ảnh hưởng bởi pull.
3. **F1 generation per-stateRoot** (giữ #2): không đổi.
4. **F3 expand buffered events** (nâng hạng): đã có hạ tầng, chỉ cần mở rộng cho thêm event types.
5. Các mục #3-#7 còn lại trong Đợt 1 không đổi.

### 5.5 Ghi chú thêm

- `atomic-write-v2.ts` đã xuất hiện (file mới, `fs.fsyncSync` tại `:30`) nhưng grep `atomic-write-v2` trên toàn `src/` trả về **0 import** — có vẻ là work-in-progress hoặc dead code. Cần xác minh xem có plan migrate không.
- Bundle entry (`dist/index.mjs`) là default từ v0.9.17. Nếu `dist/` không tồn tại (dev clone), fallback sang strip-types. Bundle giảm cold-start nhưng **không ảnh hưởng** đến các hot-path I/O findings trong review này.
- `coalesceMicroTasks` (M6) hiện MVP, chỉ hoạt động cho `READ_ONLY` roles. Khi mở rộng sang mutating roles, cần chú ý F8 (worktree prep cho coalesced group vẫn sync).
