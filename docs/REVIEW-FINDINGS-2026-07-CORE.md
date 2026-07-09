# pi-crew — Core Engine Review (2026-07)

Review **bộ core** (scheduler, vòng đời child process, state durability/concurrency, worktree isolation, conflict detection) — KHÔNG phải lớp ngoài (lint/deps/hygiene, xem `docs/REVIEW-FINDINGS-2026-07.md`).

- Phiên bản: **v0.9.28** · Node **v22.14.0** · Windows (win32 10.0.22631)
- Phạm vi đọc sâu (~9K dòng core): `runtime/team-runner.ts`, `runtime/task-runner.ts`, `runtime/child-pi.ts`, `runtime/live-session-runtime.ts`, `runtime/background-runner.ts`, `runtime/goal-loop-runner.ts`, `runtime/stale-reconciler.ts`, `state/state-store.ts`, `state/event-log.ts`, `state/atomic-write.ts`, `state/mailbox.ts`, `worktree/worktree-manager.ts`, `worktree/cleanup.ts`, `utils/conflict-detect.ts`, `config/config.ts`.
- Phương pháp: 4 luồng deep-read song song + **verify trực tiếp** từng finding trọng yếu bằng đọc lại source (trích dẫn file:line).

## Legend

| Ký hiệu | Nghĩa |
|---------|-------|
| ✅ Verified | Đã đọc trực tiếp source, xác nhận cơ chế + file:line |
| 🔬 Cần repro | Cơ chế hợp lý qua đọc code, **chưa kết luận** — cần dựng test repro để chốt |
| 🔴 HIGH · 🟡 MEDIUM · ⚪ LOW | Mức nghiêm trọng |

---

## Nhóm A — Findings đã VERIFY trực tiếp trên source

### C1 🔴 ✅ Conflict không phát hiện được trên file CRLF (Windows)

- **File:** `src/utils/conflict-detect.ts:190, 101, 202`
- **Bằng chứng:** scanner `const lines = text.split("\n");` (190); so khớp chính xác `if (line === SEPARATOR)` với `SEPARATOR = "======="` (26/101); `matchMarker` yêu cầu `if (line.charCodeAt(prefix.length) !== 32 /* space */) return null;` (202). Trên file CRLF, git ghi `=======\r\n` → sau `split("\n")` thành `"=======\r"` ≠ `"======="`; closer `>>>>>>>​\r` có `charCodeAt(7)===13` (CR) ≠ 32.
- **Bất đối xứng chứng minh:** hàm write-path (`expandContentTokens`) tại dòng 429 *có* strip CR: `const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;` — nhưng scanner (190) thì không.
- **Tác động:** conflict trong file CRLF không được phát hiện (false negative) → agent tưởng merge sạch và commit code còn `<<<<<<<`/`=======`/`>>>>>>>`. Project có target Windows (CI matrix + nhiều xử lý Windows) nên đây là lỗi thực tế.
- **Fix đề xuất:** strip trailing `\r` mỗi dòng trong scanner (mirror dòng 429), giữ CR khi re-splice để round-trip byte-accurate. Có thể mở rộng match ≥7 ký tự marker (`^<{7,}(\s|$)`) để chịu `merge.conflictMarkerSize > 7`.
- **Verify:** unit test feed buffer conflict với `\r\n` → assert 1 block đúng `startLine/separatorLine/endLine`; test LF cũ vẫn pass.

### C2 🔴 ✅ Run toàn task lỗi vẫn bị đánh dấu `completed`

- **File:** `src/runtime/stale-reconciler.ts:66-71`
- **Bằng chứng:** `checkResultFile` tính `allTerminal` gồm cả `failed`/`cancelled`; khi true: `manifest.status = "completed"; saveRunManifest(manifest);` — gán trực tiếp, bỏ qua `canTransitionRunStatus`.
- **Tác động:** run crash mà mọi task `failed`/`cancelled` vẫn được stamp `completed` → báo thành công sai, UI/logic downstream key theo `status==="completed"` hiểu nhầm.
- **Fix đề xuất:** suy ra status cuối từ outcome task: `completed` chỉ khi không có task `failed`; ngược lại `failed` (hoặc `cancelled` nếu toàn cancelled); đi qua `updateRunStatus`/`canTransitionRunStatus`.
- **Verify:** test `reconcile` với toàn task `failed` → manifest `failed`; mixed failed+completed → `failed`.

### C3 🔴 ✅ Crash-recovery ghi state KHÔNG atomic

- **File:** `src/runtime/stale-reconciler.ts:496, 504`
- **Bằng chứng:** nhánh quét orphan-temp dùng `fs.writeFileSync(tasksPath, JSON.stringify(result.repairedTasks, null, 2))` (496) và `fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2))` (504) — không temp+rename, không fsync, không lock. Phần còn lại của state layer dùng `atomicWriteJson`.
- **Tác động:** crash/đọc-đồng-thời giữa lúc ghi → `manifest.json`/`tasks.json` rách → `JSON.parse` fail → run vĩnh viễn không đọc được. Chính đường phục hồi lại corrupt state.
- **Fix đề xuất:** dùng `atomicWriteJson`/`saveRunManifest`/`saveRunTasks` và bọc read-modify-write trong `withRunLockSync`.
- **Verify:** test inject mid-write crash (mock `writeFileSync` throw sau N byte) → assert manifest vẫn parse được; assert dùng temp+rename (không để lại `.tmp`).

### C4 🔴 ✅ Mất dữ liệu khi reuse worktree "dirty"

- **File:** `src/worktree/worktree-manager.ts:626-637`
- **Bằng chứng:**
  ```ts
  const dirtyStatus = git(worktreePath, ["status", "--porcelain"]);
  if (dirtyStatus.trim()) {
      logInternalError("worktree.reused.dirty", ...);
      git(worktreePath, ["checkout", "--", "."]);
      git(worktreePath, ["clean", "-fd"]);   // xóa cả file chưa track
  }
  ```
- **Tác động:** reuse worktree (vd resume sau crash) **hard-discard** thay đổi chưa commit + file untracked, chỉ `logInternalError`, **không có force gate**. Trái AGENTS.md "Worktree cleanup must preserve dirty worktrees unless `force`".
- **Fix đề xuất:** trước khi discard, commit-to-branch/stash (như `cleanup.ts`) hoặc yêu cầu `force`/opt-in; tối thiểu snapshot diff artifact.
- **Verify:** test reuse worktree có file untracked + tracked edit → assert thay đổi còn khôi phục được (branch/stash/artifact), không mất trắng.

### C5 🟡 ✅ Rò rỉ worktree + branch khi setup-hook/seed lỗi

- **File:** `src/worktree/worktree-manager.ts:650-682` (async: 790-821)
- **Bằng chứng:** `let worktreeCreated = false;` (650) được set `true` (662) nhưng **không bao giờ đọc**. `runSetupHook(...)` (682) + `overlaySeedPaths` chạy *sau* khi worktree/branch đã tạo; catch chỉ dọn khi `git worktree add` fail. `runSetupHook` throw khi hook lỗi; `normalizeSeedPaths` throw khi seed path traversal/absolute/symlink.
- **Tác động:** hook/seed lỗi để lại worktree dir + branch `pi-crew/<run>/<task>` mồ côi → lần sau vướng guard "already checked out", buộc `cleanup force=true`.
- **Fix đề xuất:** bọc `runSetupHook`/`linkNodeModules`/`overlaySeedPaths` trong try/catch, khi lỗi chạy `git worktree remove --force` + `git branch -D` (best-effort) trước khi rethrow, gate bằng `worktreeCreated`.
- **Verify:** test `setupHook` exit non-zero → `prepareTaskWorkspace` throw AND `git worktree list` không còn path, branch bị xóa.

### C6 🟡 ✅ `worktree.seedPaths` bị nuốt (tính năng chết)

- **File:** `src/config/config.ts:734-745`
- **Bằng chứng:** `parseWorktreeConfig` chỉ build `setupHook`, `setupHookTimeoutMs`, `linkNodeModules`. `seedPaths` không được parse dù có trong type (`config/types.ts` `seedPaths?: string[]`) và schema (`schema/config-schema.ts`). `worktree-manager` đọc `loadedConfig.config.worktree?.seedPaths ?? []` → luôn `[]`. `updateConfig` re-serialize `parseConfig(current)` → xóa cả `seedPaths` sửa tay.
- **Tác động:** seedPaths cấu hình toàn cục không bao giờ được overlay vào worktree; feature im lặng không hoạt động.
- **Fix đề xuất:** thêm `seedPaths: parseStringList(obj.seedPaths)` (validated array) vào `parseWorktreeConfig` + đưa vào điều kiện "some defined".
- **Verify:** unit `parseConfig({ worktree: { seedPaths: ["a","b"] } })` trả đúng; integration copy seed vào worktree.

### C7 🟡 ✅ `withEventLogLockAsync` phá mutual-exclusion

- **File:** `src/state/event-log.ts:383-394` (và cleanup `asyncQueues` ~591-609)
- **Bằng chứng:**
  ```ts
  const prev = asyncLocks.get(queueKey) ?? Promise.resolve();
  const next = prev.then(async () => { await fn(); });
  asyncLocks.set(queueKey, next);
  try { await next; } finally { asyncLocks.delete(queueKey); }  // xóa vô điều kiện
  ```
- **Tác động:** khi ≥3 flush chồng lấn, `finally` của caller cũ `delete(queueKey)` xóa nhầm `next` mới (tail đang chờ); caller kế đọc `undefined` → chạy song song với batch trước → `appendEventBatchInsideLock` xen kẽ: trùng `seq`, rotation đua append → mất event. Reachable khi buffered throughput cao.
- **Fix đề xuất:** compare-and-delete: `if (asyncLocks.get(queueKey) === next) asyncLocks.delete(queueKey);` — áp dụng cả cleanup `asyncQueues`.
- **Verify:** test bắn 3+ flush chồng lấn với `fn` đo "in critical section" counter → assert ≤1 và `seq` unique/monotonic.

### C8 🟡 ✅ Steer "wrap up" qua stdin là dead code + log spam

- **File:** `src/runtime/child-pi.ts:388, 1139-1166`
- **Bằng chứng:** spawn `stdio: ["ignore", "pipe", "pipe"]` (388) → `child.stdin` là `null`; block `if (child.stdin?.writable) { ... child.stdin.write(steerPayload) }` (1139-1146) không bao giờ chạy; nhánh `else` `logInternalError("child-pi.steer-not-writable", ...)` (1165) log **mỗi lần** chạm soft-limit.
- **Tác động:** soft-limit steer không tới worker → worker luôn chạy tới `maxTurns+graceTurns` rồi hard-abort (lãng phí turn/token, mất cơ hội wrap-up); log nhiễu.
- **Fix đề xuất:** hoặc spawn `stdio:["pipe","pipe","pipe"]` + xử lý backpressure/EPIPE nếu muốn steer qua stdin; hoặc xóa block stdin, chỉ dựa file-based steering (`PI_CREW_STEERING_FILE`) + hard-abort và bỏ log `steer-not-writable`.
- **Verify:** test assert (a) steer được ghi khi soft-limit, hoặc (b) không có log `steer-not-writable`.

### C9 🟡 ✅ `cleanup` auto-commit dirty không cần `force`

- **File:** `src/worktree/cleanup.ts:130-207`
- **Bằng chứng:** nhánh `if (dirty)` luôn chạy `git add -A` → `git commit` → `git branch` → `["worktree","remove","--force",...]` bất kể `options.force`; chỉ nhánh non-dirty mới `if (options.force) args.push("--force")`.
- **Tác động:** `team cleanup runId=X` (không force) stage mọi file untracked (`-A`) và commit vào branch mới → rủi ro commit secrets/build artifacts; trái contract "preserve dirty unless force".
- **Fix đề xuất:** gate commit-and-remove-dirty sau `options.force` (hoặc option `commitDirty`); khi không force → giữ worktree + chỉ emit diff artifact.
- **Verify:** test `cleanupRunWorktrees(manifest, { force: false })` trên worktree dirty → assert được preserve (không commit/remove) và nằm trong `result.preserved`.

---

## Nhóm B — Cần dựng test repro trước khi kết luận (🔬)

Cơ chế đã đọc thấy nhưng **chưa chốt**; mỗi item kèm kế hoạch repro.

| ID | Mức | File:line | Nghi vấn | Repro plan |
|----|-----|-----------|----------|------------|
| B1 | 🔴 | `runtime/team-runner.ts:773-786` | catch downgrade dựa `refreshTaskGraphQueues(input.tasks)`; nếu `input.tasks` là snapshot start (còn `queued`) → late-throw ghi đè task đã `completed` thành `failed` | Run 2 task: A completed+persist; ép `executeTeamRunCore` throw trước khi return; assert `tasks.json` giữ A `completed` |
| B2 | 🟡 | `runtime/task-runner.ts:667-691` | model-fallback re-resolve tính `alt` nhưng loop thoát → không bao giờ thử alt model | Chain 1 model trả 429 retryable + re-resolve ra candidate mới → assert `runChildPi` gọi lần 2 với alt |
| B3 | 🟡 | `runtime/team-runner.ts:1400-1408` | retry re-chạy `runTeamTask` lần `maxAttempts+1` khi task *throw* | Mock `runTeamTask` luôn throw → assert gọi đúng `maxAttempts` lần, task trả `failed` |
| B4 | 🟡 | `runtime/child-pi.ts:1461-1518` | post-exit stdio guard gắn trong handler `exit` → listener không chạy → guard no-op → risk treo | Fake ChildProcess với stdout/stderr không emit `end/close`; emit `exit`; assert `destroy` được gọi trong `hardMs` |
| B5 | 🟡 | `runtime/child-pi.ts:985` | `AbortSignal` đã aborted trước gọi vẫn spawn child | Gọi `runChildPi` với signal đã abort → assert không spawn, kết quả `cancelled` |
| B6 | 🟡 | `runtime/child-pi.ts:88-113` | `taskkill` (Windows) spawn không có listener `error` → uncaught crash parent | Windows: stub PATH để `taskkill` không resolve → assert log internal error, không crash |
| B7 | 🟡 | `state/event-log.ts` (sync vs async) | 2 đường append cùng `events.jsonl` dùng lock khác nhau, cross-process không lock → trùng `seq`/torn lines | 2 process hammer `appendEventAsync`/`appendEvent` payload >4KB → assert mọi line parse, `seq` unique |
| B8 | 🟡 | `state/mailbox.ts:475` | rotation chạy ngoài append lock → truncate mất message | Stress 2 loop `appendMailboxMessage` vượt ngưỡng rotate → assert đọc lại đúng số message |
| B9 | 🟡 | `state/atomic-write.ts:266-276` | Windows `unlink(dest)` trước `rename` mở cửa sổ ENOENT/mất manifest | Windows: reader lặp trong lúc overwrite → assert không thấy ENOENT; giả lập rename fail sau unlink → file cũ còn nguyên |
| B10 | 🟡 | `state/state-store.ts:565-599` | `updateRunStatus` check-then-write không lock → lost update | 2 `updateRunStatus` từ cùng base manifest → assert đúng 1 thành công, transition hợp lệ |
| B11 | 🟡 | `worktree/worktree-manager.ts:601-620` | `sanitizeBranchPart` va chạm (vd `foo.bar` vs `foo-bar`) → 2 task dùng chung worktree | 2 task ID khác nhau 1 ký tự bị strip → assert worktree/branch khác nhau hoặc lỗi rõ ràng |
| B12 | 🟡 | `worktree/worktree-manager.ts:410-430` | vài lệnh git (`for-each-ref`, `worktree prune`) không dùng `gitEnv()` sanitize → rò rỉ secrets | Assert child env của các call site không có `GIT_*`/secret vars |

---

## Ưu tiên đề xuất

1. **P0 (correctness / mất dữ liệu):** C1, C4, C3, C2.
2. **P1 (đúng đắn / rò rỉ):** C7, C5, C6, C9, B1.
3. **P2:** C8, nhóm child-pi lifecycle (B4/B5/B6), mailbox/atomic-write Windows (B8/B9).

**Fix đầu tiên đã chọn: C1 (CRLF conflict false-negative).** Phác thảo: trong `scanFileForConflictsSync`/`scanConflictLines`, strip trailing `\r` mỗi dòng trước khi so khớp marker/separator (mirror logic dòng 429), và giữ `\r` khi ghi lại để round-trip byte-accurate; thêm unit test CRLF + giữ test LF cũ pass; chạy `npm run typecheck` + `test/unit/conflict-detect.test.ts` + `delta-conflict.test.ts`.

> Nhóm B: theo quyết định 2026-07, sẽ **dựng test repro** để xác nhận trước khi kết luận/sửa. Chưa treat như confirmed.
