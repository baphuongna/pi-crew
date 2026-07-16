# Pi-Crew Communication-Layer Optimization Plan

**Created**: 2026-07-16
**Scope**: Tối ưu hóa hot-path truyền thông (child-pi transcript, JSON parse, event-log I/O, polling loops)
**Basis**: Code-verified review (xem `docs/optimization-findings-2026-07.md`)

## Mục tiêu & Nguyên tắc

- **Behavior-preserving**: mỗi fix không đổi output quan sát được. Regression net là test hiện có + benchmark before/after.
- **An toàn trước**: fix bảo mật (redaction) chỉ động khi benchmark chứng minh bottleneck, vì rò rỉ secret > chậm.
- **Build constraint**: sau mỗi phase chạy `npm run build:bundle` (bundle `dist/index.mjs` mới có hiệu lực). Test dùng `PI_CREW_USE_BUNDLE=0` để chạy source trực tiếp.
- **Indent**: TABS (theo `.crew/knowledge.md`).

## Thứ tự phase (theo effort/risk)

| Phase | Fix | Effort | Risk | Gate |
|-------|-----|--------|------|------|
| 1 | #6 Dead code | Trivial | Thấp | test green |
| 2 | #1 Double parse | Nhỏ | Thấp | benchmark + test green |
| 3 | #2 Transcript batching | TB | TB | integration transcript tests green |
| 4 | #3 Event-log async migration | TB | TB | event-ordering tests green |
| 5 | #4a fs.watch pollRunToTerminal | TB | TB | stuck-blocked tests green |
| 6 | #4b Coalesce steer+control poll | Cao | TB | live-session tests green |
| 7 | #5 Redaction trust-boundary | TB | **CAO** | chỉ khi benchmark chứng minh; security review |
| 8 | Build bundle + full suite | — | — | `npm test` + rebuild |

---

## Phase 0 — Baseline & benchmark setup

**Mục đích**: có số liệu "before" để chứng minh win & phát hiện regression.

**Tasks**:
1. Viết micro-benchmark `bench/child-pi-parse.bench.mjs`:
   - Feed 200 JSON event dòng (mix message/tool_result/message_end) qua `ChildPiLineObserver`.
   - Đo: wall-time, JSON.parse count (wrap tạm để count), syscall count (via `strace -c` hoặc process I/O counters).
2. Chạy `PI_CREW_USE_BUNDLE=0 npm test` baseline → lưu output vào `bench/baseline.txt`.
3. Ghi nhận: parse count/event, transcript syscalls/100-events, p95 appendEvent latency.

**Gate**: có file `bench/baseline.txt` commit.

---

## Phase 1 — Fix #6: Xóa dead code `drainIrcMessages`

**Files**: `src/runtime/live-agent-manager.ts`

**Why first**: trivial, giảm noise trước khi refactor vùng code lân cận.

**Changes**:
- Xóa hàm `drainIrcMessages` (line ~497-503).
- Verify không có import/export nào tham chiếu (grep đã confirm 0 caller).
- Giữ `pendingMessages` array (vẫn dùng cho bookkeeping + cap shift) — chỉ xóa hàm drain không dùng.

**Tests**:
- `test/unit/live-agent-manager.test.ts` (nếu có) vẫn pass.
- `npm test`.

**Risk**: Không. Dead code.
**Rollback**: git revert 1 file.

---

## Phase 2 — Fix #1: Double `JSON.parse` → parse 1 lần

**Files**: `src/runtime/child-pi.ts`

**Root cause**: `emitLine()` parse raw (line 743) rồi `compactChildPiLine(line)` parse lại (line 654).

**Changes**:

1. Sửa signature `compactChildPiLine`:
   ```ts
   function compactChildPiLine(line: string, preParsed?: unknown): {
     persistedLine: string;
     event?: unknown;
     displayLine?: string;
     json: boolean;
   } {
     let parsed = preParsed;
     if (parsed === undefined) {
       try { parsed = JSON.parse(line); }
       catch { return { json: false, persistedLine: line, displayLine: line }; }
     }
     const compact = compactChildPiEvent(parsed);
     return {
       json: true,
       event: compact,
       persistedLine: compact ? JSON.stringify(compact) : "",
       displayLine: displayTextFromCompactEvent(compact),
     };
   }
   ```

2. Sửa `emitLine` parse **một lần** rồi truyền xuống cả 2 path:
   ```ts
   private emitLine(line: string): void {
     if (!line.trim()) return;
     let parsed: unknown;
     try { parsed = JSON.parse(line); } catch { parsed = undefined; }
     // path 1: raw assistant text extraction (dùng parsed)
     if (parsed !== undefined) {
       const rawTexts = extractText(parsed);
       if (rawTexts.length > 0) { /* push ring buffer — giữ nguyên logic */ }
     }
     // path 2: compact (nhận parsed, KHÔNG parse lại)
     const compact = compactChildPiLine(line, parsed);
     /* rest unchanged */
   }
   ```

**Tests**:
- `test/unit/child-pi-hardening.test.ts`, `raw-final-text.test.ts`, `child-pi-timeout.test.ts` — phải green không đổi.
- Thêm `test/unit/child-pi-emit-line.test.ts`: feed cùng 50 dòng → assert output persistedLine/displayLine/event giống hệt version cũ (snapshot). Thêm assert: parse count = 1/dòng (instrument tạm).
- Benchmark Phase 0 re-run → expect ~40-50% giảm wall-time hot-path.

**Gate**: snapshot match + benchmark improvement + `npm test` green.

**Risk**: Thấp. Pure refactor. Edge case: non-JSON line (parsed=undefined → fallback path giữ nguyên behavior).
**Rollback**: git revert.

---

## Phase 3 — Fix #2: Transcript batching (bỏ open/write/close mỗi dòng)

**Files**: `src/runtime/child-pi.ts`

**Approach**: **Option A (batched buffer)** — thấp risk nhất, dùng lại cơ chế `pendingTranscriptWrites` Set + `flushPendingTranscriptWrites`.

**Changes**:

1. Module-scoped batch buffer keyed by path:
   ```ts
   const transcriptBatches = new Map<string, string[]>();
   let transcriptFlushTimer: ReturnType<typeof setTimeout> | undefined;
   const TRANSCRIPT_FLUSH_MS = 50;
   ```

2. `trackTranscriptWrite` thêm vào buffer thay vì open/close ngay:
   ```ts
   function trackTranscriptWrite(safePath: string, line: string): void {
     let batch = transcriptBatches.get(safePath);
     if (!batch) { batch = []; transcriptBatches.set(safePath, batch); }
     batch.push(`${redactJsonLine(line)}\n`);
     scheduleTranscriptFlush();
   }
   ```

3. `scheduleTranscriptFlush` (debounced 50ms) gộp toàn bộ batch thành **một** open/write/close:
   ```ts
   function scheduleTranscriptFlush(): void {
     if (transcriptFlushTimer) return;
     transcriptFlushTimer = setTimeout(() => {
       transcriptFlushTimer = undefined;
       void flushTranscriptBatches();
     }, TRANSCRIPT_FLUSH_MS);
     transcriptFlushTimer.unref?.();
   }
   async function flushTranscriptBatches(): Promise<void> {
     const entries = [...transcriptBatches.entries()];
     transcriptBatches.clear();
     await Promise.allSettled(entries.map(async ([path, lines]) => {
       const content = lines.join("");
       // một open/write/close cho cả batch
       const fd = await fs.promises.open(path, O_WRONLY|O_NOFOLLOW|O_CREAT|O_APPEND, 0o600);
       try { await fd.write(content); } finally { await fd.close(); }
     }));
   }
   ```

4. `flushPendingTranscriptWrites` (drain lifecycle) → gọi thêm `flushTranscriptBatches()` và await cả timer.

**Critical invariants phải giữ**:
- `O_NOFOLLOW | O_CREAT | O_APPEND` security flags không đổi.
- `redactJsonLine` vẫn áp per-line (trước khi push).
- Integration tests đọc transcript ngay sau `await observer.flush()` (phase3/phase4) → `flush()` phải drain buffer synchronously-enough. Test kỹ.
- Max batch size cap (vd 1000 dòng) để chatty worker không giữ buffer vô hạn giữa các flush.

**Tests**:
- `test/integration/phase3-runtime.test.ts`, `phase4-runtime.test.ts` — đọc transcript sau flush, phải thấy full content.
- Thêm `test/unit/transcript-batch.test.ts`: emit 100 dòng → flush → assert file có đúng 100 dòng, đúng thứ tự, content redacted.
- Benchmark: syscalls/100-events giảm từ ~300 → ~3.

**Gate**: integration transcript tests green + ordering preserved.
**Risk**: TB. Ordering (A_APPEND đảm bảo order per-fd; batch join giữ thứ tự). Crash giữa buffer & flush = mất ≤50ms dữ liệu (acceptable: transcript là telemetry best-effort, code comment đã nói rõ).
**Rollback**: git revert.

---

## Phase 4 — Fix #3: Migrate sync `appendEvent` → async (bỏ `sleepSync` busy-wait)

**Scope**: 94 sync `appendEvent` callers. **KHÔNG migrate tất cả** — triage.

**Triage rules**:
- **Giữ sync** cho: terminal events (task.completed/failed), signal handlers (SIGTERM/SIGINT trong background-runner — cần write đồng bộ trước exit), crash-recovery. Lý do: đảm bảo thứ tự + write-before-exit.
- **Migrate async** cho: progress/non-critical/high-frequency events. Lý do: bỏ busy-wait, unblock abort.

**Audit output** (cần sinh ra): bảng `file:line → keep-sync | migrate-async | reason`.

**Files chính cần migrate** (hot path, non-terminal):
- `src/runtime/task-runner.ts`: `task.progress` đã dùng `appendEventBuffered` ✓. Audit các appendEvent còn lại.
- `src/runtime/adaptive-plan.ts` (6 calls): đa số non-terminal → migrate `appendEventFireAndForget` hoặc `appendEventAsync`.
- `src/runtime/attention-events.ts`: progress-style → migrate.

**Changes per caller**:
```ts
// before
appendEvent(eventsPath, { type: "task.needs_attention", ... });
// after (non-critical)
appendEventFireAndForget(eventsPath, { type: "task.needs_attention", ... });
```

**Tests**:
- `test/unit/event-log-*.test.ts` + `test/integration/event-ordering*.test.ts` (nếu có, nếu không thì thêm).
- Thêm test: phát `MaxListenersExceededWarning` / unhandledRejection không xuất hiện sau migrate.
- Benchmark: p95 appendEvent latency dưới contention giảm.

**Gate**: event-ordering tests green (đặc biệt terminal events vẫn đúng thứ tự) + no new warnings.
**Risk**: TB. Ordering của non-critical events có thể xê dịch vài ms (acceptable). **PHẢI** giữ sync cho terminal + signal-handler paths.
**Rollback**: per-file revert.

**Sub-gate**: sau Phase 4, review lại xem `withEventLogLockSync`/`sleepSync` còn dùng ở đâu — nếu chỉ còn cho terminal events, cân nhắc document rõ.

---

## Phase 5 — Fix #4a: `pollRunToTerminal` → fs.watch

**Files**: `src/runtime/subagent-manager.ts`, reuse `src/utils/run-watcher-registry.ts` + `src/utils/fs-watch.ts`

**Current**: `pollRunToTerminal` while-loop + `setTimeout(pollIntervalMs=1000)` đọc disk mỗi giây/subagent.

**Changes**:
1. Thay vì poll, subscribe manifest change:
   ```ts
   // trong SubagentManager, inject dependency watchManifest(cwd, runId, cb)
   private async pollRunToTerminal(cwd, record) {
     // fallback poll giữ làm safety-net (ví dụ fs.watch không reliable trên NFS)
     const pollFallback = ...;
     const watcher = watchManifestFile(cwd, record.runId, () => this.checkTerminal(cwd, record));
     // checkTerminal đọc manifest 1 lần, xử lý chuyển trạng thái
   }
   ```
2. Giữ **fallback poll với interval dài hơn** (vd 5s) cho FS không hỗ trợ fs.watch (NFS, Docker macOS bind mount).

**Reuse**: `watchWithErrorHandler` (fs-watch.ts) đã handle SIGTERM/retry/error.

**Tests**:
- `test/unit/subagent-manager.test.ts` (stuck-blocked notify) — phải vẫn fire đúng timeout.
- Thêm test: manifest write → callback fire trong <100ms (vs 1000ms poll cũ) trên FS hỗ trợ watch.
- Test fallback: force `fs.watch` throw → fallback poll vẫn hoạt động.

**Gate**: stuck-blocked notify tests green + latency cải thiện.
**Risk**: TB. fs.watch không portable (macOS Docker, NFS). **Fallback poll bắt buộc**.
**Rollback**: git revert.

---

## Phase 6 — Fix #4b: Coalesce steer + control poll (live-session)

**Files**: `src/runtime/live-session-runtime.ts`, `src/prompt/prompt-runtime.ts`

**Current**: mỗi live agent có `pollControl` 500ms (control JSONL) + mỗi worker có `pollSteering` 500ms (steer JSONL). 2 loop độc lập.

**Changes**:
1. Unified `AgentTick` 500ms đọc cả steering + control file cùng lúc (per agent).
2. `prompt-runtime.ts` (worker side, cross-process) — KHÔNG gộp được (khác process). Chỉ gộp được phần in-process `pollControl`.
3. Giảm từ 2 interval/agent → 1 interval/agent.

**Tests**: live-session runtime tests.
**Gate**: steer/follow-up/control latency không tăng + interval count giảm 50%.
**Risk**: TB. Phải đảm bảo control request không bị trễ do gộp tick.
**Rollback**: git revert.

> **Đánh giá**: Phase 6 win nhỏ (1 interval/agent giảm). Cân nhắc **skip** nếu benchmark Phase 0 cho thấy I/O polling không phải bottleneck chính.

---

## Phase 7 — Fix #5: Redaction chỉ ở trust boundary (DEFER)

**⚠️ RỦI RO CAO — chỉ làm nếu Phase 0-6 benchmark chứng minh redaction là bottleneck.**

**Current**: `redactSecrets(fullEvent)` mỗi event-log write + `redactJsonLine(line)` mỗi transcript line.

**Risk**: Bỏ redact ở nhầm chỗ = leak secret ra artifact/log. **Bắt buộc security review** (skill `security-review`) trước khi merge.

**Proposed (nếu cần)**:
- Đánh dấu event đã redact (flag `__redacted: true`), skip re-redact.
- Chỉ redact khi content cross process boundary (artifact write, cross-process message).
- In-process event-log: trust source (event produce trong same process) → skip.

**Gate**: security-review skill pass + secret-leak test (feed fake API key, assert không xuất hiện ở output).
**Rollback**: immediate revert nếu leak detected.

---

## Phase 8 — Build bundle + full verification

1. `npm run build:bundle` (rebuild `dist/index.mjs`).
2. `git add -f dist/` (bundle gitignored nhưng commit lịch sử).
3. `npm test` full suite (bundle mode).
4. `PI_CREW_USE_BUNDLE=0 npm test` (source mode) — confirm cả 2 mode green.
5. Re-run benchmark Phase 0 → so sánh before/after, viết `bench/after.txt`.
6. Update CHANGELOG + version bump (theo `AGENTS.md` pre-commit checklist).

**Final gate**: benchmark improvement documented + full suite green + CHANGELOG updated.

---

## Rủi ro tổng & mitigation

| Rủi ro | Mitigation |
|--------|-----------|
| Transcript ordering vỡ (Phase 3) | O_APPEND + join giữ thứ tự; integration test assert order |
| Terminal event xê thứ tự (Phase 4) | Giữ sync cho terminal; test ordering |
| fs.watch không portable (Phase 5) | Fallback poll bắt buộc |
| Secret leak (Phase 7) | Security review skill + leak test; DEFER unless needed |
| Bundle stale (toàn bộ) | Rebuild + commit `dist/` mỗi phase merge |

## Thứ tự đề nghị thực thi

**Sprint 1 (an toàn, win nhanh)**: Phase 0 → 1 → 2 → 8(partial)
**Sprint 2 (I/O win)**: Phase 3 → 4 → 8
**Sprint 3 (polling, tùy benchmark)**: Phase 5 → (6 optional)
**Sprint 4 (chỉ nếu cần)**: Phase 7

## Verification checkpoints (mỗi phase)

- [ ] `PI_CREW_USE_BUNDLE=0 npm test` green
- [ ] Benchmark so với baseline không regression
- [ ] Code review (skill `review`) cho diff
- [ ] Update `bench/baseline.txt`/`after.txt`
- [ ] Commit riêng per-phase (git history sạch)

## Phụ lục: skill nên dùng

- `verify-before-complete`: mỗi phase phải có evidence trước khi claim done.
- `review`: review diff trước merge.
- `security-review`: bắt buộc cho Phase 5/7.
- `tdd`: Phase 2-5 nên red-green (viết test snapshot trước, refactor sau).
