# Microbenchmarks — SYNTHETIC component isolation tests

> ⚠️ **Đây là số PHÒNG THÍ NGHIỆM (synthetic), KHÔNG phải số sử dụng thật.**
> Để xem số THẬT từ một run pi-crew, chạy:
> ```bash
> node scripts/analyze-run.mjs <runId>
> # → docs/perf-report-<runId>.md  +  bench/results/<runId>.json
> ```

## b1–b8 đo cái gì?

Các file `b1-*.bench.ts` … `b8-*.bench.ts` trong `bench/` (cấp cha của thư mục
này) đo từng **component riêng lẻ trong môi trường cô lập**. Chúng KHÔNG gọi
LLM, KHÔNG chạy workflow thật, KHÔNG phát sinh token cost hay độ trễ model.

| File | Component cô lập | Đo |
|------|------------------|----|
| `b1-child-spawn.bench.ts` | Child-Pi spawn (cold start) | Thời gian spawn 1/5/10 children, RSS, event-loop blocking |
| `b2-broker-roundtrip.bench.ts` | Broker handshake + round-trip | Latency 1/100/1000 msgs, throughput |
| `b3-state-store-jsonl.bench.ts` | State store JSONL write/read | 10/100/1000 entries |
| `b4-event-log.bench.ts` | Event-log append + retention | 100/1000/10000 events |
| `b5-deep-tracking.bench.ts` | Run-graph / observation-store | 1/10/50 subagents (cost tracking) |
| `b6-usage-tracking.bench.ts` | Usage / token tracking overhead | Overhead theo dõi token |
| `b7-startup.bench.ts` | Startup (load dist/index.mjs) | Module init time |
| `b8-artifact-worktree.bench.ts` | Artifact + worktree ops | FS operations |

## Khác biệt với số thật (analyze-run)

| Khía cạnh | Microbench (b1–b8) | Run thật (analyze-run) |
|-----------|--------------------|------------------------|
| LLM calls | ❌ Không có | ✅ Có — độ trễ model, token, cost |
| Workflow overhead | ❌ Không có | ✅ Phase guards, retries, leader loop |
| Token/cost | ❌ N/A | ✅ Từ transcript usage thật |
| Ý nghĩa | **Cận dưới / chi phí unit** của mỗi component | **Hiệu năng thực tế** end-to-end |

Số microbench là **giới hạn dưới** (lower bound) — chi phí unit của từng thành
phần khi chạy riêng. Trong run thật, chi phí bị chi phối bởi độ trễ LLM, số
token, và workflow logic, nên tổng thời gian luôn lớn hơn nhiều.
