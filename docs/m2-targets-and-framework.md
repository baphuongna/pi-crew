# M2a — Targets, Framework & Candidates (2026-09-10)

> Spec ref: `pi-crew-upgrade-spec.md` §5 M2. Bài học từ baseline mới (WI-1.1) **đã lật đổ nhiều giá trị kỳ vọng** của M2 — mọi target phải re-derive từ baseline này, KHÔNG kế thừa số v0.9.62.

## 1. Re-derived targets (tính lại từ baseline 2026-09-10)

| Metric | Old (v0.9.62, 2026-08-06) | New baseline (3 runs p50) | M2 target (re-derived) | Lý do |
|---|---|---|---|---|
| **b4 sync append per-event** | ~14 ms/ev | **0,57–0,78 ms/ev** (n100: 77.7ms/100ev; n1000: 572.7ms/1000ev) | buffered p50 ≤ 0,6 ms/ev amortized cho site non-terminal convert được | Win thật chỉ ~25–35% chứ không phải 50×. Tuy nhiên buffered giảm fsync calls + giảm I/O burst — đo trên bench trước khi commit effort |
| **b1 cold boot** | ~1,27s/worker | **~400ms/worker** (n1: 403.8ms; n5: 399.5ms) | **WI-2.3 ADR: chấp nhận baseline; không đụng trừ khi regression >10%** | Stretch metric đã đạt (xem ADR `2026-09-10-wi-2-3`) |
| **M2 effort estimate** | 5–8 ngày | (vẫn 7–11 sau R2) | giữ nguyên | Surface 79 site / 31 file không đổi; chỉ delta kỳ vọng mỗi site nhỏ hơn |
| **Noise floor cho ±10% gate** | chưa định nghĩa | spread từ baseline (xem §3) | gate = baseline_p50 ± spread_p50 của metric đó | Bench protocol M1 cho số liệu falsifiable |

### Quy trình target-re-derive cho M2 PR mở màn (ghi vào PR đầu tiên)

1. Chạy `npm run bench` ×1 trên branch trước khi sửa → record p50 per metric.
2. Với mỗi metric trong bảng trên, target = `baseline_p50 × (1 - noise_floor_factor)`. Ví dụ b4 buffered target ≤ 0,6 ms/ev khi baseline sync p50 = 0,78 ms/ev (factor ~0,77 — giảm ~23%, hợp lý với delta thật).
3. Không được hard-code target từ số v0.9.62.
4. Bench ×1 sau convert; chỉ ship PR khi delta đạt target HOẶC có ADR giải thích tradeoff.

## 2. Conversion Framework — test-first, lock-contract, reject-policy

Áp dụng cho **MỌI call-site convert sync `appendEvent` → `appendEventBuffered`**. Đây là behavior change trên durability (kill -9 trong buffer window 20ms có thể mất event non-terminal), KHÔNG phải refactor cơ học.

### 2.1 Test-first (bắt buộc trước khi convert)

Với MỖI call-site convert, viết 4 recovery scenarios TRƯỚC khi sửa code:

1. **Kill trong buffer window** — giả lập process bị SIGKILL giữa enqueue và flush (20ms); verify call-site không treo + số event mất bounded ≤ bufferMs × event-rate.
2. **Overflow truncate** (>1000 entry queue) — verify oldest drop có reject reason rõ ràng, không silent loss.
3. **Lock-timeout reject** — verify `.catch` handler xử lý được, không unhandled rejection rơi vào `uncaughtException` (event-log.ts:1258 re-throws → process chết).
4. **Happy-path flush** — event land trong log đúng thứ tự, fingerprint/seq đúng.

Test placement: `test/unit/runtime/event-log/buffered-recovery.test.ts` (centralized) — tránh per-site test sprawl với 79 site. Mỗi scenario là một test case; convert từng site thêm 1 case "site emits X correctly via buffered path".

### 2.2 Lock-contract compliance (MỖI conversion)

Theo `sequence-cache.ts:154-175`:
- **L1(run lock) → L2(event-log family: .mkdirlock/.alock) → L3(.seqlock)** ordering BẮT BUỘC.
- **TUYỆT ĐỐI KHÔNG merge `.mkdirlock` + `.alock`** — tái tạo v0.9.26 deadlock (sync retry sleepSync starves async path's event-loop acquire).
- `.seqlock` là PURE-SYNC SHORT critical section (~2 atomic writes). **NEVER acquire L1/L2 while holding L3**.

Checklist mỗi conversion (ghi vào PR description):
- [ ] Caller không acquire L1 (run-level lock) trước khi gọi appendEventBuffered.
- [ ] Caller không acquire `.seqlock` rồi gọi appendEventBuffered.
- [ ] Buffered + sync không cùng file cùng eventsPath với merge logic — family split OK.

### 2.3 Reject policy (CẤM floating promise)

Mỗi call-site buffered phải có 1 trong 2 reject policy:

| Policy | Pattern | Khi nào |
|---|---|---|
| **A. log-and-continue** | `appendEventBuffered(path, ev).catch(e => logInternalError("event-log.buffered", e, ...))` | Site KHÔNG critical (lifecycle/progress/diagnostic), mất event OK trong window |
| **B. fallback sync** | `appendEventBuffered(path, ev).catch(async () => appendEvent(path, ev))` | Site vẫn cần durability — fallback sync sẽ chậm hơn nhưng không mất |

**CẤM** `void appendEventBuffered(...)` không có `.catch` (event-log.ts:1258 re-throw unhandled rejection → kill orchestrator).

### 2.4 Per-site template (cho M2a executor)

```ts
// BEFORE
appendEvent(eventsPath, { type: "x.y", runId, data: {...} });

// AFTER (policy A — non-critical)
appendEventBuffered(eventsPath, { type: "x.y", runId, data: {...} })
    .catch((e) => logInternalError("goal-loop.buffered", e, "type=x.y"));

// AFTER (policy B — needs durability)
appendEventBuffered(eventsPath, { type: "x.y", runId, data: {...} })
    .catch(() => appendEvent(eventsPath, { type: "x.y", runId, data: {...} }));
```

## 3. Noise floor (gate falsifiability)

Từ baseline M1a 3-run data (xem `docs/perf-report.md` BASELINE 2026-09-10):
- **b4 n100**: spread 7,7% → gate ±10% = baseline_p50 × (1 ± 0,1)
- **b4 n1000**: spread 2,9% → gate ±5% = baseline_p50 × (1 ± 0,05)
- **b1 cold boot**: spread 5–53% (cao ở n10) → không dùng single-run làm gate, lấy median ≥3 runs

## 4. M2 re-scoping checkpoint decision (đã chốt)

Census: **79 sync sites > ngưỡng 20 → split M2a/M2b**.

- **M2a** = top-7 file-group theo event-volume (theo census §5):
  1. `runtime/goal-workflow/goal-loop-runner.ts` (13 sync, all NON-TERMINAL)
  2. `runtime/background-runner.ts` (11 sync)
  3. `runtime/recovery/crash-recovery.ts` (7 sync) — chia sẻ với M7 sleepSync, tuần tự
  4. `runtime/finalize-run.ts` (3 sync) — và các file cùng nhóm
  5. `runtime/goal-workflow/dynamic-workflow-runner.ts` (6 sync)
  6. `extension/team-tool/api/{mailbox,task-claims,agent-control,plan-approval,heartbeat}.ts` cluster (11 sync / 5 file)
  7. (còn lại trong top-7 theo total event-volume)

- **M2b** = 25 site còn lại (cut-able theo §13).

## 5. Status M2a execution

| Việc | Trạng thái (2026-09-10) |
|---|---|
| Re-derived targets | ✅ done (mục 1) |
| Framework doc (test-first + lock-contract + reject policy) | ✅ done (mục 2) |
| Noise floor protocol | ✅ done (mục 3) |
| M2a/M2b split decision | ✅ done (mục 4) |
| **Actual conversions (M2a top-7 file-groups)** | **TODO — yêu cầu focused session với test-first từng site** |
| Bench before/after per file-group | TODO (sau conversions) |
| WI-2.2: coalesce manifest/tasks save expansion | **Candidate list (xem mục 6)** |
| WI-2.3: cold boot ADR | ✅ done (`docs/decisions/2026-09-10-wi-2-3...`) |

## 6. WI-2.2 — coalesce manifest/tasks save expansion candidates

`atomicWriteJsonCoalesced` API đã có sẵn (atomic-write.ts T8, 2026-08-25) — chỉ cần mở rộng caller. Site KHÔNG coalesced hiện tại:

| Site | Pattern | Risk nếu không coalesce | Mức ưu tiên |
|---|---|---|---|
| `state/stores/plan-store.ts:77` | `atomicWriteJson(planFilePath(manifest), file)` | write mỗi plan update → fsync per write | P1 |
| `state/stores/ownership-map.ts:121` | `atomicWriteJson(ownershipMapPath(manifest), fresh, { compact: true })` | tương tự | P1 |
| `state/stores/state-store.ts:505` | `atomicWriteJson(manifestPath, manifest)` | write mỗi state update | **P0** (manifest hot path) |
| `state/stores/state-store.ts:536` | `await atomicWriteJsonAsync(manifestPath, manifest)` | async path, không coalesced | P1 |
| `state/stores/manifest-io.ts:162,169` | `atomicWriteJson(tasksPath, reconstructed, ...)` | write sau reconstruct | P1 |
| `state/stores/manifest-io.ts:227,233` | `await atomicWriteJsonAsync(tasksPath, reconstructed, ...)` | async path | P1 |

Lưu ý: site 709 (`state-store.ts`) ĐÃ coalesced — đó là template để copy cho 6 site trên.

Effort ước tính: ~2–3 ngày (mechanical conversion, có test mẫu từ site 709).

## 7. Điều kiện resume M2a execution

Cần 1 phiên tiếp theo (team run hoặc direct) với:
- Per-site test-first theo §2.1 (4 recovery scenarios trong 1 centralized test file)
- Per-conversion lock-contract checklist (§2.2)
- Per-conversion reject policy selection (§2.3) — pin lựa chọn vào PR
- Bench before/after per file-group
- Tạo PR theo group, không gộp

Khuyến nghị: team run với concurrency thấp (≤2) để tránh lặp lại sự cố SIGTERM của run M1.
