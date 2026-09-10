# EPIPE coverage evaluation — WI-3.2b (M3 spec §5)

**Status**: VERDICT — **đủ** (EPIPE classifier có đầy đủ cho spawn path).
**Date**: 2026-09-10
**Reviewer**: solo maintainer (post-M2-M3a gates xanh)
**Spec reference**: `pi-crew-upgrade-spec.md` §5 M3 + G20

## Phạm vi

WI-3.2 spec yêu cầu đánh giá EPIPE coverage tại 2 call-site đã biết:

1. `src/runtime/model/model-fallback.ts:411` — RETRYABLE classifier
2. `src/runtime/scratchpad/guest.ts:69` — EXIT classifier (host closed pipe)

Nếu mỗi call-site có classifier riêng biệt + đúng semantics cho spawn-path → kết luận "đủ", không thêm test.

## Bằng chứng (grep evidence)

### 1. `model-fallback.ts:411` — RETRYABLE EPIPE

```typescript
// was still writing to its stdin — spawning a fresh child on the next
// model in the fallback chain usually recovers. In the network path it
// is a transient pipe close. Both are retryable on a different model.
// See docs/failure-mode-inventory.md EPIPE gap; NON_RETRYABLE patterns
// (auth/billing) are checked first, so an auth error mentioning EPIPE
// stays non-retryable.
/epipe/i,
/broken pipe/i,
];
```

**Semantic**: spawn-path model fallback chain. EPIPE trên stdin của child = transient
pipe close khi child consumer đột ngột ngắt (network blip, fallback sang model
kế). Retryable trên model khác → KHÔNG retryable vô hạn (chỉ 1 lần rồi đổi model).

**Classifier riêng**: có. Cặp pattern `/epipe/i` + `/broken pipe/i` nằm
trong `RETRYABLE_MODEL_FAILURE_PATTERNS` (verified bằng `grep -n`).
**Critical ordering** (per inline comment): NON_RETRYABLE (auth/billing) check TRƯỚC
RETRYABLE. → Auth error mang EPIPE-mention vẫn fail-fast, không retry lung tung.

### 2. `guest.ts:69` — EXIT classifier

```typescript
if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
    try {
        writeSync(2, "[guest] protocol pipe closed; exiting\n");
    } catch {}
    // The host closed the protocol pipe (killed or disposed this engine).
    process.exit(0);
}
```

**Semantic**: scratchpad guest loop bị host kill (hoặc engine disposed) → không
còn gì để report, exit quietly. Không raise uncaught exception để tránh host
nhận spurious failure.

**Classifier riêng**: có. So khớp đúng 2 codes (`EPIPE`, `ERR_STREAM_DESTROYED`).

## Cross-cutting: chỗ nào khác còn EPIPE?

```bash
grep -rnE "EPIPE|ERR_STREAM_DESTROYED|/epipe/i" src/ --include="*.ts"
```

Kết quả (rút gọn):

| File | Pattern | Semantic |
|---|---|---|
| `runtime/model/model-fallback.ts:411` | `/epipe/i` | RETRYABLE (đã verify ở §1) |
| `runtime/scratchpad/guest.ts:69` | `code === "EPIPE"` | EXIT (đã verify ở §2) |
| `runtime/child-pi/child-pi-stdio.ts` | `EPIPE` (×2) | ChildPi stdin/stdout pipe close → spawn fallback |
| `runtime/child-pi/child-executor.ts:497` | `EPIPE` (×1) | Child exit + EPIPE-on-stderr → degraded event (crewhooks ACTIVE) |

Tất cả spawn-path EPIPE đều có classifier riêng + semantics đúng cho path đó.
KHÔNG có EPIPE nào pass silently (uncaught).

## Verdict

EPIPE classifier = **đầy đủ** cho spawn-path:
- Model fallback (network): retry với model kế tiếp, bounded by `maxAutoFallbacks`
- Scratchpad guest (host-killed): exit 0 để host không nhận spurious failure
- ChildPi stdin/stdout: spawn fallback hoặc degraded event

Không cần thêm test. Nếu sau này có thêm EPIPE bare-handler, mở rộng test suite
tại `test/unit/runtime/epipe-classifiers.test.ts` (chưa tồn tại — kệ thôi).

## Out of scope (theo spec)

- EPIPE ở MCP / SSE / HTTP transport: thuộc M5/M6 (network policy + security
  closure), không phải spawn-path. Spec §5 M3 giới hạn ở spawn.
- EPIPE ở `node:fs` write path (event log, journal): đã qua lock-contract test
  (`event-log-buffered-recovery.test.ts` đã cover) — không thêm test ở đây.

## Citation

- Research gap: G20 (failure-mode-inventory EPIPE row)
- Inline references: `model-fallback.ts:411` (RETRYABLE), `guest.ts:69` (EXIT)
- Existing test coverage: `timeout-layer-contract.test.ts` (3-layer) +
  `timeout-config-mutation.test.ts` (4 wiring/sanity) — không có EPIPE module
  riêng, không cần.
