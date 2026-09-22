# Story Backlog

Candidate stories for future pi-crew development.

> **Full technical specs for every open item: [`docs/specs/`](../specs/README.md)**
> (22 specs: problem + measured evidence, `file:line` anchors, acceptance
> criteria, mutation-test plan). The tables below are the index; the specs
> are the implementation packets.

## Epic: Review 2026-09-17 remediation (RR-010 → RR-019)

Nguồn: `docs/archive/2026-09-17-pi-crew-review.md` (20 phát hiện, đã xác minh
độc lập ở `docs/archive/2026-09-17-pi-crew-review-verification.md`).
Kế hoạch: `docs/superpowers/plans/2026-09-17-review-remediation.md`.

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| RR-010 | F01 — Hợp đồng snapshot/cleanup worktree | high-risk | P0 | completed (ADR đã ghi) |
| RR-011 | F02 — Quyền sở hữu run lock theo async context | high-risk | P0 | completed (ADR đã ghi) |
| RR-012 | F03+F16 — Vòng đời delegation (cwd + promote grandchild) | high-risk | P0 | completed (ADR đã ghi) |
| RR-013 | F04 — Bảo toàn execution result qua ranh giới branch | high-risk | P0 | completed (ADR đã ghi) |
| RR-014 | F15 — Semaphore có thể abort | high-risk | P1 | completed (ADR đã ghi) |
| RR-015 | F05+F18+F19+F20 — Tính toàn vẹn test/CI harness | normal | P0 | completed |
| RR-016 | F08+F09+F10 — Tính đúng của state/config | normal | P1 | completed |
| RR-017 | F06+F07 — Chi phí persistence và retrieval | normal | P1 | completed |
| RR-018 | F11+F12+F13 — Quyền sở hữu tài nguyên theo session | normal | P1 | completed |
| RR-019 | F14+F17 — Idle render và chất lượng verification | normal | P2 | completed |

## Epic: Reliability

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| [US-001](../specs/US-001.md) ✅ | Lock-free event log rotation (lock-scope reduction) | normal | P2 | planned (verify-close) |
| [US-002](../specs/US-002.md) ✅ | Structured run-level lock cleanup | normal | P2 | planned |
| [US-003](../specs/US-003.md) ✅ | Dead letter queue for permanently failed tasks | normal | P3 | planned |

## Epic: Performance

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| [US-010](../specs/US-010.md) ✅ | Replace sleepSync busy-wait with proper async | normal | P3 | planned |
| [US-011](../specs/US-011.md) | Stream-based event log for large runs | normal | P3 | closed (ST-11 hot paths + bounded-heap guard; 3 cold residuals recorded) |
| [US-012](../specs/US-012.md) ✅ | Cache available models across runs | tiny | P3 | planned |

## Epic: DX (Developer Experience)

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| [US-020](../specs/US-020.md) | Interactive run dashboard in TUI | normal | P2 | planned |
| [US-021](../specs/US-021.md) ✅ | Run comparison (before/after) | normal | P3 | planned |
| [US-022](../specs/US-022.md) | Export run report as markdown | tiny | P3 | closed (pinned exportedAt + Cost/model/duration) |

## Epic: Integration

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| [US-030](../specs/US-030.md) | Webhook notifications on run completion | normal | P3 | planned |
| [US-031](../specs/US-031.md) | GitHub Actions integration (report results as PR comment) | normal | P3 | planned |

## Deferred — performance deep-dive 2026-09-18 (auto-prune / bundle / CI)

Nguồn: phân tích hiệu năng sau battery (bench b3/b4/b7/b11–b13 + đo live từ run
`team_20260917165008_454201b2cf4aea1a`). Chi tiết: 2/6 điểm nghẽn cũ bị rút lại
(debris tự chữa qua `lifecycle-handlers.ts:466-489`; run-dir "biến mất" = auto-prune
keep=10 ở mỗi extension load, xác nhận qua `prune.jsonl` 1.436 entries):

- [x] **[DP-01](../specs/DP-01.md) Auto-prune retention guards** → **DONE** (`e01ee7d7`): age-floor (không xóa run finished <24h dù ngoài top-10) + `PI_CREW_AUTO_PRUNE_KEEP` env (default 10) + rotation/size-cap cho `audit/prune.jsonl` (đã 720KB/1.436 entries, không giới hạn) + ghi `intent`/session attribution cho auto-prune entries (`src/extension/run-maintenance.ts:112`, `src/extension/registration/lifecycle-handlers.ts:466-489`) — chứng cứ: battery evidence (T7 smoke + review run dirs) bị auto-prune trước khi kịp commit
- [x] **[DP-02](../specs/DP-02.md) Dist slim** → **DONE** (`de7b486c`, −52%: 3.44MB→1.65MB, bỏ map 8.3MB + build-meta 785KB khỏi git): bật `minify: true` trong `scripts/build-bundle.mjs` (ước moi 30–40%, giảm cả worker boot — 55% của 2.5s boot là bundle load theo b7) + bỏ `index.mjs.map` (8.3MB) và `build-meta.json` (785KB) khỏi git tracking (chỉ ship ở GitHub Release) — bundle hiện 3.44MB/3.5MB budget (98.4%), git dist thực tế 12.3MB
- [ ] **[DP-03](../specs/DP-03.md) CI test sharding**: matrix chia 4 shard theo thư mục (mỗi job FS riêng) — KHÔNG tăng `--test-concurrency` (bị clamp =2 tại `scripts/test-runner.mjs:158-171` vì Windows EPERM/EBUSY + macOS tmp contention flake storm từ Round 13/14); suite 8.012 tests sắp phá budget 1500s nếu không shard
- [x] **[DP-04](../specs/DP-04.md) fast-fix auto-suggest singleAgent** → **DONE**: goal ngắn (<N tokens) → default workflow trả 3 context setup (smoke 7.6–9k tokens cho goal trivial); thêm hint/auto-switch sang `singleAgent: true` hoặc chain 2 bước (engine đã hỗ trợ, chỉ là routing default)
- [x] **SKILL rule (real-test battery)**: archive/export run-dir evidence TRƯỚC khi restart session — auto-prune keep=10 xóa bằng chứng ở lần load kế tiếp → **DONE** (SKILL.md đã có hướng dẫn export-immediately; phần product-side nằm ở DP-01)

## Deferred — review-round 2026-09-17 (run team_20260917150642)

Verdict FIX_THEN_SHIP; 2 MAJOR đã vá ngay (xem TEST_MATRIX 2 hàng "Review-round"). Còn lại ghi đây, xử lý theo lô sau:

- [x] MINOR 1: shadow-task discriminator `agent === "delegate"` là heuristic — team user đặt role tên "delegate" sẽ bị loại khỏi DAG im lặng → **FIXED RR-020**: đổi sang discriminator cấu trúc `stepId === undefined` (`src/runtime/broker/delegate/shadow-lifecycle.ts`); shadow broker mint không có stepId, mọi task scheduler có. Không cần schema change.
- [x] **[RM-01](../specs/RM-01.md)** MINOR 2: `peekPendingCoalescedWrite` trả by-reference → **DONE** (`787eeda8`) → shallow-copy lúc serve trong `readCrewAgents` (`src/state/atomic-write.ts:1161`, `src/runtime/crew-agent-records.ts:310`) — callers hiện tại thuần đọc, an toàn (chưa làm)
- [x] SEC LOW: pin `fallow@<x.y.z>` trong `.github/workflows/ci.yml` — **FIXED RR-020**: `fallow@3.27.0` qua env `FALLOW_VERSION`, inline (không thêm devDependency)
- [x] **[RM-02](../specs/RM-02.md)** MINOR 8: benchmark `parseAndValidateCommand` whitespace-split → **DONE** (`af65b95e`) phá quoted args (`src/benchmark/benchmark-runner.ts`) — fixtures hiện không dùng quote (WIP khác đang đụng cùng file: `inconclusive` + siết allowlist)
- [x] **[RM-03](../specs/RM-03.md)** MINOR 3/4/6/7: doc-notes → **PARTIAL** (`9dd9d4d4`; MINOR 4 done, 3/6/7 không tái lập được) (terminal durable-fsync trong coalesced path; lastWrittenStatus single-writer assumption; sweep-before-cap; semaphore dead comment) — gộp vào lần doc sweep kế tiếp
- [x] **[RM-04](../specs/RM-04.md)** F05 smoke "mutation-verified" → **DONE** (`8b72ffe5`; mutation 6/13 RED tái lập): reviewer chỉ đọc pattern, chưa tái tạo mutation — verify khi chạy smoke tuần tới

## Epic: Session residuals 2026-09-21/22 (spec'd)

Nguồn: session phát triển + battery real-test + điều tra RCA. Spec:
[`docs/specs/`](../specs/README.md).

| ID | Title | Lane | Priority | Status |
|----|-------|------|----------|--------|
| [SR-01](../specs/SR-01.md) | GL-1b part C — pre-try failures mark turn manifest failed | normal | P2 | **done** (`dad41423`) |
| [SR-02](../specs/SR-02.md) | Worker prompt diet (token/run −30%) | normal | P1 | planned |
| [SR-03](../specs/SR-03.md) ✅ | Test-flake remediation (2 flakes) | normal | P2 | planned |

Create story packets from `docs/templates/story.md` when work is selected.
