# Phase 3 Refactor Plan — Port utilities & patterns from `source/`

> Xuất xứ: review sâu `source/pi-subagents` và `source/pi-mono/packages/coding-agent` (28/04/2026).
> Mục tiêu: port các utility/pattern còn thiếu/yếu trong pi-crew để tăng độ ổn định, quan sát, và bảo trì.
> Phase 2 (#17–#25) đã hoàn tất, baseline: tsc 0 errors, 176 unit + 21 integration pass.

## Quy ước chung
- Không phá vỡ public API hiện tại. Mọi thay đổi nội bộ.
- Sau mỗi task: `npx tsc --noEmit` + `npm run test:unit` (+ `test:integration` nếu liên quan watcher/IO).
- Không thêm dependency runtime mới trừ khi task ghi rõ.
- Mỗi task = 1 commit độc lập có thể revert. Đặt tên test bám sát hành vi.

## Trạng thái cập nhật
- [x] Task #26 — `completion-dedupe` (đã hoàn tất)
- [x] Task #27 — `jsonl-writer` (đã hoàn tất)
- [x] Task #28 — `post-exit-stdio-guard` (đã hoàn tất)
- [x] Task #29 — `sleep` (đã hoàn tất)
- [x] Task #30 — `timings` (đã hoàn tất)
- [x] Task #31 — `fs-watch` (đã hoàn tất)
- [x] Task #32 — `result-watcher` (đã hoàn tất)
- [x] Task #33 — `parallel-utils` (đã hoàn tất)
- [x] Task #34 — `artifact-cleanup` (đã hoàn tất)
- [x] Task #35 — `team-doctor` (đã hoàn tất)
- [x] Task #37 — `hosted-git-info` cho team config git URL (đã hoàn tất)
- [ ] Task #36 — `proper-lockfile` (đã tạm hoãn, giữ `locks.ts` nội bộ)

---

## Batch A — Low-risk utility ports (ưu tiên cao)

Mục tiêu: 6 file mới + 2 file điều chỉnh. Risk thấp, tách rõ, dễ test riêng. Ước tính: 1–2h.

### Task #26 — Port `completion-dedupe.ts`
**Source**: `source/pi-subagents/completion-dedupe.ts`
**Đích**: `pi-crew/src/utils/completion-dedupe.ts`

**Lý do**: Pi-crew chưa có TTL seen-map. Khi `result-watcher`/mailbox được restart hoặc `primeExistingResults` chạy đồng thời với event mới, có thể double-emit. TTL map + key xây từ `(sessionId, agent, timestamp, taskIndex, totalTasks, success)` đảm bảo idempotent trong khoảng TTL.

**API export**:
```typescript
export function buildCompletionKey(data: CompletionDataLike, fallback: string): string;
export function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void;
export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean;
export function getGlobalSeenMap(storeKey: string): Map<string, number>;
```

**Acceptance**:
- File copy nguyên vẹn (chỉ điều chỉnh import paths nếu cần).
- Unit test `test/unit/completion-dedupe.test.ts`: cover 4 case
  - `buildCompletionKey` với `id` ưu tiên cao nhất
  - `buildCompletionKey` với meta fallback (no id)
  - `markSeenWithTtl` trả về `true` lần thứ 2 trong TTL
  - `pruneSeenMap` xoá entry expired
- Tích hợp: callsite mới sẽ làm trong Task #27.

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep completion-dedupe`

---

### Task #27 — Port `jsonl-writer.ts` + tích hợp event-log
**Source**: `source/pi-subagents/jsonl-writer.ts`
**Đích**: `pi-crew/src/state/jsonl-writer.ts`

**Lý do**: Pi-crew `events.jsonl` không có cap; run dài có thể grow vô hạn. JSONL writer của pi-subagents có:
- Backpressure (`source.pause()`/`resume()` khi `stream.write()` trả false)
- Max bytes hardcap (default 50MB) — drop silently sau threshold
- Best-effort error handling (try/catch quanh `createWriteStream`)

**Tích hợp**:
1. `event-log.ts` hiện tại append synchronous via `fs.appendFileSync`. Đổi sang `createJsonlWriter` sẽ phải async writes → cần xem xét impact với `appendEvent` callsites.
2. Phương án ít rủi ro: KHÔNG đổi `event-log.ts` đường nóng synchronous. Thay vào đó:
   - Thêm size check trong `appendEvent`: trước khi append, `fs.statSync(eventsFile)` → nếu > `MAX_EVENTS_BYTES` (default 50MB) → log warning + drop.
   - Hoặc rotation: rename `events.jsonl` → `events.jsonl.1` khi vượt threshold.

**API export**:
```typescript
export function createJsonlWriter(filePath: string | undefined, source: DrainableSource, deps?: JsonlWriterDeps): JsonlWriter;
```

**Acceptance**:
- File copy với điều chỉnh path imports.
- Unit test `test/unit/jsonl-writer.test.ts`: cover 4 case
  - Writes line + newline
  - Drops line khi vượt `maxBytes`
  - Pause/resume source khi backpressure
  - `close()` flush stream
- Tích hợp `event-log.ts`: thêm size guard (KHÔNG đổi sync→async). Nếu `events.jsonl` > `MAX_EVENTS_BYTES`, log internal-error + skip append (giữ nguyên runtime).

**Risk**: Thay đổi `event-log.ts` là đường nóng. Test integration `live-mailbox-flow` để đảm bảo không regress.

**Verification**: `npx tsc --noEmit` + `npm run test:unit` + `npm run test:integration`

---

### Task #28 — Tách `post-exit-stdio-guard` thành module riêng
**Source**: `source/pi-subagents/post-exit-stdio-guard.ts`
**Đích**: `pi-crew/src/runtime/post-exit-stdio-guard.ts`

**Lý do**: `child-pi.ts` hiện inline 60+ dòng quản lý timer post-exit. Tách module → tái dùng cho subagent + worker, dễ unit test.

**API export**:
```typescript
export function attachPostExitStdioGuard(
  child: ChildWithPipedStdio,
  options: { idleMs: number; hardMs: number },
): () => void;
export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean;
```

**Tích hợp**:
- Trong `child-pi.ts`:
  - Thay block `postExitGuard = setTimeout(...)` + `child.stdout?.destroy()` bằng `attachPostExitStdioGuard(child, { idleMs: POST_EXIT_STDIO_GUARD_MS, hardMs: HARD_KILL_MS })`.
  - Cleanup function được gọi trong `settle()`.
- Giữ logic `noResponseTimer` + `finalDrainTimer` riêng (chúng là khác semantics — pre-exit, không phải post-exit).

**Acceptance**:
- `runChildPi` test hiện có vẫn pass.
- Thêm unit test `test/unit/post-exit-stdio-guard.test.ts`: simulate child exit + dangling stdout → verify destroy gọi sau idleMs.
- Behaviour: khi child không exit nhưng stdio idle → KHÔNG destroy (chỉ destroy sau exit).

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep child-pi` + `npm run test:unit -- --grep post-exit`

---

### Task #29 — Port `utils/sleep.ts`
**Source**: `source/pi-mono/packages/coding-agent/src/utils/sleep.ts`
**Đích**: `pi-crew/src/utils/sleep.ts`

**Lý do**: Abortable sleep helper. Hữu ích cho retry/backoff trong `model-fallback.ts`, `task-runner.ts`, `subagent-manager.ts` (`scheduleStuckBlockedNotify`).

**API export**:
```typescript
export function sleep(ms: number, signal?: AbortSignal): Promise<void>;
```

**Tích hợp** (không bắt buộc lần đầu, chỉ port file):
- Quét `setTimeout(...{}, ms)` patterns trong `model-fallback.ts` để đánh giá có thay không. Mặc định KHÔNG đổi callsite trong task này — file utility độc lập.

**Acceptance**:
- File copy nguyên vẹn.
- Unit test `test/unit/sleep.test.ts`: 3 case
  - Resolve sau ms
  - Reject ngay nếu signal đã abort
  - Reject khi abort trong lúc đợi + clear timeout

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep sleep`

---

### Task #30 — Port `core/timings.ts` (PI_TIMING profiler)
**Source**: `source/pi-mono/packages/coding-agent/src/core/timings.ts`
**Đích**: `pi-crew/src/utils/timings.ts`

**Lý do**: Pi-crew register nhiều slash command/widget/extension hooks. Khi user báo "khởi động chậm", hiện tại không có cách nhanh để đo. `PI_TIMING=1` env → in breakdown từng giai đoạn.

**API export**:
```typescript
export function resetTimings(): void;
export function time(label: string): void;
export function printTimings(): void;
```

**Tích hợp**:
- Trong `index.ts` / `src/extension/register.ts`:
  - Đầu file: `import { time, printTimings, resetTimings } from "./utils/timings.js"`.
  - Sau từng bước register lớn (load config, register tools, register slash commands, register widgets, init runtime resolver): `time("step-name")`.
  - Cuối: gọi `printTimings()` (no-op nếu không bật env).

**Acceptance**:
- File copy nguyên vẹn.
- Unit test minimal: gọi `time` + `printTimings` không throw.
- Smoke: `PI_TIMING=1 node --experimental-strip-types -e "import('./pi-crew/index.ts')"` in ra `--- Startup Timings ---`.

**Verification**: `npx tsc --noEmit` + manual smoke với `PI_TIMING=1`.

---

### Task #31 — Port `utils/fs-watch.ts`
**Source**: `source/pi-mono/packages/coding-agent/src/utils/fs-watch.ts`
**Đích**: `pi-crew/src/utils/fs-watch.ts`

**Lý do**: Wrapper an toàn cho `fs.watch` với:
- `closeWatcher(watcher)`: nuốt error khi close
- `watchWithErrorHandler(path, listener, onError)`: try/catch quanh `watch()`, tự gọi `onError` nếu throw, attach `error` listener

**API export**:
```typescript
export const FS_WATCH_RETRY_DELAY_MS: number;
export function closeWatcher(watcher: FSWatcher | null | undefined): void;
export function watchWithErrorHandler(path: string, listener: WatchListener<string>, onError: () => void): FSWatcher | null;
```

**Tích hợp** (không bắt buộc lần đầu, chỉ port file):
- Khi viết `result-watcher` (Task #32 Tier 2), dùng wrapper này.

**Acceptance**:
- File copy.
- Unit test `test/unit/fs-watch.test.ts`: 2 case
  - `closeWatcher(null)` không throw
  - `watchWithErrorHandler` gọi `onError` khi `watch()` throw (mock fs)

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep fs-watch`

---

## Batch B — Pattern lớn hơn, cần thiết kế

Mục tiêu: 3 task có thiết kế. Risk trung bình. Ước tính: 3–4h.

### Task #32 — Result watcher auto-restart pattern
**Source**: `source/pi-subagents/result-watcher.ts`
**Đích**: `pi-crew/src/runtime/result-watcher.ts` (mới) HOẶC tích hợp vào mailbox/event-log nếu phù hợp.

**Lý do**: Khi `fs.watch` báo error (filesystem bị unmount, network drive disconnect), pi-crew hiện không tự khôi phục. Pattern: bắt error → setTimeout 3s → mkdir + start lại watcher.

**Phụ thuộc**: Task #31 (fs-watch), Task #26 (completion-dedupe).

**API export**:
```typescript
export function createResultWatcher(input: {
  resultsDir: string;
  onResult: (file: string) => Promise<void>;
  state: ResultWatcherState;
  completionTtlMs: number;
}): {
  start: () => void;
  primeExisting: () => void;
  stop: () => void;
};
```

**Acceptance**:
- Unit test:
  - Watcher emits scheduled file → `onResult` được gọi.
  - Watcher error → 3s sau tự restart (dùng fake timers).
  - Dedupe: 2 events cùng file trong TTL → `onResult` chỉ gọi 1 lần.
- Integration test với fixture `tmp/results/`: write file → onResult chạy → file unlink.

**Risk**: Pi-crew có thể chưa có "result file producer" pattern (results đang qua mailbox in-process). Đánh giá: nếu KHÔNG có async result file pattern, **bỏ qua task này**.

**Verification**: `npm run test:unit` + `npm run test:integration`

---

### Task #33 — Port `parallel-utils` (mapConcurrent + aggregateParallelOutputs)
**Source**: `source/pi-subagents/parallel-utils.ts`
**Đích**: `pi-crew/src/runtime/parallel-utils.ts`

**Lý do**:
- `concurrency.ts` chỉ tính toán số concurrent, không có helper map.
- `parallel-research.ts` hiện viết riêng worker pool. Có thể đơn giản hoá.
- `aggregateParallelOutputs` chuẩn hoá format kết quả (FAILED/SKIPPED/EMPTY OUTPUT) — pi-crew có thể tận dụng cho task summary.

**API export**:
```typescript
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]>;
export interface ParallelTaskResult { agent: string; taskIndex?: number; output: string; exitCode: number | null; error?: string; ... }
export function aggregateParallelOutputs(results: ParallelTaskResult[], headerFormat?: ...): string;
export const MAX_PARALLEL_CONCURRENCY: number;
```

**Tích hợp**:
- Refactor `parallel-research.ts` dùng `mapConcurrent` (giữ behaviour).
- Xét dùng trong `task-graph-scheduler.ts` cho batches ready tasks.

**Acceptance**:
- Unit test `test/unit/parallel-utils.test.ts`:
  - `mapConcurrent` tôn trọng limit (counter pending max).
  - `mapConcurrent([], 4, fn)` trả `[]`, không gọi fn.
  - `mapConcurrent` propagate exception.
  - `aggregateParallelOutputs` format đúng cho 4 case (success/failed/skipped/empty).

**Verification**: `npm run test:unit -- --grep parallel-utils`

---

### Task #34 — Artifact cleanup với daily marker
**Source**: `source/pi-subagents/artifacts.ts` (hàm `cleanupOldArtifacts`)
**Đích**: bổ sung vào `pi-crew/src/state/artifact-store.ts`

**Lý do**: Pi-crew `<crewRoot>/state/artifacts/` (`<crewRoot>` = `.crew/` mới hoặc `.pi/teams/` legacy) không có TTL → run cũ tích lũy mãi. Pattern subagents:
- File `.last-cleanup` chứa timestamp.
- Nếu marker mới hơn 24h → skip (không scan dir lớn mỗi extension load).
- Nếu cần scan: xoá file mtime > `maxAgeDays * 24h`.

**API mới trong artifact-store.ts**:
```typescript
export function cleanupOldArtifacts(artifactsRoot: string, maxAgeDays: number): void;
```

**Tích hợp**:
- Gọi 1 lần khi extension activate, sau khi resolve `artifactsRoot`.
- Default: `maxAgeDays = 7` (config qua `defaults.ts`).
- Xét cleanup `events.jsonl` cũ tương tự (có rotation pattern Task #27).

**Acceptance**:
- Unit test `test/unit/artifact-cleanup.test.ts`:
  - Tạo files với mtime cũ + mới → cleanup chỉ xoá cũ.
  - Marker mới (< 24h) → skip cleanup.
  - Marker cũ (> 24h) → scan + update marker.
  - Dir không tồn tại → no-op.
- Tích hợp test (optional): activate extension 2 lần liên tiếp → lần 2 không scan.

**Verification**: `npm run test:unit -- --grep artifact-cleanup`

---

### Task #35 — Build `team doctor` action
**Source**: `source/pi-subagents/doctor.ts`
**Đích**: `pi-crew/src/extension/team-tool/doctor.ts` (mới) + register trong team-tool.

**Lý do**: Pi-crew thiếu lệnh diagnostic 1-liên-1. Format report của subagents có cấu trúc:
- Runtime (cwd, async, session)
- Filesystem (state/artifacts/runs dirs)
- Discovery (agents, teams, workflows count theo source)
- Configuration validation status
- Optional: intercom/extension status

**API**:
```typescript
export function buildTeamDoctorReport(input: {
  cwd: string;
  config: ResolvedConfig;
  ...
}): string;
```

**Tích hợp**:
- Thêm action `doctor` trong `team-tool` action handler.
- Slash command `/team-doctor` (nếu phù hợp với UX).

**Acceptance**:
- Unit test:
  - Report có heading đúng.
  - Filesystem section hiển thị "ok" cho dir tồn tại, "missing" cho không.
  - Discovery counts khớp với fixture builtin/user/project.
  - Khi exception trong section → in `failed — <error>` thay vì throw.
- Manual: chạy `team` action `doctor` → verify output text.

**Verification**: `npm run test:unit -- --grep doctor`

---

## Tier 3 — Library swaps (cân nhắc, không bắt buộc Phase 3)

### Task #36 (optional) — Đánh giá `proper-lockfile`
**Bối cảnh**: `source/pi-mono/packages/coding-agent/package.json` đã dùng `proper-lockfile`. Pi-crew tự viết `locks.ts` với O_EXCL + retry.

**Quyết định**:
- Nếu phát hiện flake/race trong `npm run test:integration` (đặc biệt `locks-race.test.ts`) → adopt.
- Nếu hiện tại pass ổn định → giữ `locks.ts` để zero-dep.

**Action nếu adopt**:
1. `npm install proper-lockfile @types/proper-lockfile`.
2. Replace `locks.ts` `acquireLock`/`releaseLock` bằng `lockfile.lock(filePath, { retries: ..., stale: ... })`.
3. Re-run `locks-race.test.ts` 100 iterations để xác nhận no regress.

**Verification**: full CI.

---

### Task #37 (optional) — `hosted-git-info` cho team config git URL
**Bối cảnh**: Khi pi-crew hỗ trợ `team: git+https://github.com/org/teams-repo` → dùng `parseGitUrl` của coding-agent.

**Trạng thái**: Đã triển khai cho runtime discover/validate: `ResourceSource` mở rộng thành `git`, `TeamConfig.sourceUrl` được ghi, parser `parseGitUrl` đã chuẩn hóa `git+` và hỗ trợ `#` ref.

---

## Tracking template (sao chép vào commit message)

```
Phase 3 #NN — <short title>

Source: source/pi-subagents/<file>.ts (or pi-mono/...)
Target: pi-crew/src/<dir>/<file>.ts
Risk: low | medium | high
Tests added: test/unit/<file>.test.ts
Verification: tsc --noEmit OK; test:unit OK; test:integration <OK|N/A>

Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>
```

---

## Thứ tự gợi ý thực hiện

1. **Tuần 1 — Batch A (low-risk)**: #29 → #30 → #31 → #26 → #28 → #27
   - Bắt đầu bằng `sleep`/`timings`/`fs-watch` (đơn lẻ, no callsite change).
   - Tiếp `completion-dedupe` (file độc lập).
   - Cuối `post-exit-stdio-guard` (chỉnh `child-pi.ts`) và `jsonl-writer` (chỉnh `event-log.ts`).
2. **Tuần 2 — Batch B (mid-risk)**: #33 → #34 → #35 → (#32 nếu áp dụng).
3. **Tuần 3 — Tier 3 nếu cần**: #36/#37 only on demand.

Toàn bộ Phase 3 ước tính 4–6h focus work, không thêm runtime dep ngoại trừ tuỳ chọn `proper-lockfile`.
