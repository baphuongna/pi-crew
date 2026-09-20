# Stories

Story-sized work packets for pi-crew development.

## Status Values

| Status | Meaning |
|--------|---------|
| planned | Accepted, not started |
| in_progress | Actively being worked |
| completed | Done with evidence |
| blocked | Waiting on external input |

## Active Stories

| ID | Title | Lane | Status |
|----|-------|------|--------|
| US-DEPS-major-upgrade | Nâng cấp deps major (diff 5→9, TypeScript 7) | normal | planned |
| RR-010 | F01 — Hợp đồng snapshot/cleanup worktree | high-risk | completed (local evidence) |
| RR-011 | F02 — Quyền sở hữu run lock theo async context | high-risk | completed (local evidence) |
| RR-012 | F03+F16 — Vòng đời delegation (cwd + promote grandchild) | high-risk | completed (local evidence) |
| RR-013 | F04 — Bảo toàn execution result qua ranh giới branch | high-risk | completed (local evidence) |
| RR-014 | F15 — Semaphore có thể abort | high-risk | completed (local evidence) |
| RR-015 | F05+F18+F19+F20 — Tính toàn vẹn test/CI harness | normal | completed (local evidence) |
| RR-016 | F08+F09+F10 — Tính đúng của state/config | normal | completed (local evidence) |
| RR-017 | F06+F07 — Chi phí persistence và retrieval | normal | completed (local evidence) |
| RR-018 | F11+F12+F13 — Quyền sở hữu tài nguyên theo session | normal | completed (local evidence) |
| RR-019 | F14+F17 — Idle render và chất lượng verification | normal | completed (local evidence) |
| RR-020 | BR-01…BR-12 — Điểm nghẽn backlog: layout parity, no-op materialization, cache/cursor/shadow | normal | implemented (A0 + C/D-lite); high-risk items deferred |

Chương trình khắc phục review 2026-09-17 (RR-010 → RR-019). Kế hoạch đầy đủ:
[`docs/superpowers/plans/2026-09-17-review-remediation.md`](../superpowers/plans/2026-09-17-review-remediation.md).
RR-020 khởi nguồn từ [`docs/archive/2026-09-18-backlog-bottlenecks-review.md`](../archive/2026-09-18-backlog-bottlenecks-review.md)
+ đánh giá phản biện 3 nhánh; packet: [`RR-020.md`](./RR-020.md).

Story `high-risk` dùng folder 4 file (`overview.md`, `design.md`, `exec-plan.md`,
`validation.md`); story `normal` dùng packet một file.

**2026-09-17 (cuối ngày): toàn bộ 10 story đã được triển khai** sau phê duyệt
"fix all" — mỗi finding có bằng chứng RED→GREEN (xem cột Evidence trong
`docs/TEST_MATRIX.md`). "local evidence" = full unit 8012 tests + integration
130/0/4 + bundle 2/2 + toàn bộ gate-local pass trên Linux; **CI 3-OS còn
pending push**. Decision record cho 5 story high-risk nằm trong `docs/decisions/`
(index ở `docs/decisions/README.md`).

## Completed Stories (from review rounds)

| ID | Title | Lane | Result |
|----|-------|------|--------|
| RR-001 | Depth guard for nested live-session | normal | commit 2640d5e |
| RR-002 | Windows EBUSY retry | normal | commit ceb8c60 |
| RR-003 | Harden live-session resource management | normal | commit c7bd455 |
| RR-004 | Stale task/agent repair | normal | commit d6d466d |
| RR-005 | Async runner child-process enforcement | high-risk | commit 2486051 |
| RR-006 | Live-session resource leak fix | normal | commit 7a25644 |
| RR-007 | Double cleanupTempDir guard | tiny | commit 5f47e92 |
| RR-008 | Review round 8 (8 issues) | normal | commit 4e75ba8 |
| RR-009 | Review round 9 (5 issues) | normal | commit f3d29cc |
