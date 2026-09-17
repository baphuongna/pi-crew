# Test Tiering — Phase 1 (WI-1.5, 2026-09-10)

> Spec ref: `pi-crew-upgrade-spec.md` §5 M1a WI-1.5. Mục tiêu: nhãn fast/slow + target `test:fast` <60s + bảng phân bổ thời lượng. Phase 2 (per-file timing, nightly) = M3/WI-3.0.

## Labels

| Tier | Định nghĩa | Files |
|---|---|---|
| **fast** | Chạy trong `npm run test:fast` (~15s) | 14 file `test:critical` (9 broker + parity golden + session-utils + config-schema-sync + env-spread) + `test/unit/bundle-load.test.ts` |
| **slow** | Mọi thứ còn lại của `test:unit/**` | ~800 file còn lại (chưa per-file timing — Phase 2 M3) |
| **integration/system** | `test:integration`, `test:system`, `test:smoke`… | giữ nguyên targets riêng |

## Duration đo thực (2026-09-10, Node v22.23.1, bom-Inspiron-7559, load avg 8–10)

| Target | Thời lượng | Ghi chú |
|---|---|---|
| `test:fast` (= test:critical + test:bundle) | **14.8s** — 104 test, 100% pass | ✅ đạt AC <60s |
| `test:critical` | 14.6s — 102/102 pass | tái lập sau 1 lần flaky (xem note) |
| `test:bundle` | 15.9s (lần đầu, bundle load + import) / gộp trong test:fast | |
| `test:unit` (full) | **>900s — KHÔNG xong trong 15 phút** trên máy load cao | PARTIAL: số chính xác + per-file = M3/WI-3.0 (cần đo trên máy idle / CI runner định nghĩa) |
| `test:integration` | chưa đo | M3/WI-3.0 |

## Note quan trọng — flaky timeout dưới tải máy

Lần chạy `test:critical` đầu sau bench (05:0xZ) bị **2 cancelled** (`crew-broker-handshake`, `crew-broker-mailbox-observer` — testTimeoutFailure 30s) khi load avg ~10. Chạy đơn lẻ và chạy lại full set sau đó: **102/102 pass, 14.6s**. Kết luận: load-induced flake, không phải regression từ M1 changes. Hàm ý cho M3: timeout 30s của test:critical quá sát trên máy tải cao — cân nhắc bump lên 60s hoặc retry-once policy trong WI-3.1.

## Cách dùng

- Gate nhanh hằng ngày / giữa các slice M4: `npm run test:fast`
- Gate đầy đủ không full-suite: `npm run ci:fast` (đã gồm test:critical + 13 check + build + bundle-size + pack dry-run)
- Full `npm test` vẫn là gate release (hiện >15 phút trên máy load cao — M3 sẽ đưa về <10 phút theo done-gate)
