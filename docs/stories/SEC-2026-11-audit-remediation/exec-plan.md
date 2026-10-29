# SEC-2026-11 — Exec plan

Thực thi theo 12 wave (overview §3), mỗi wave 1 executor agent + regression test, chạy theo 3 batch:

- Batch A: w2, w3, w4a, w4b (runtime core) — DONE
- Batch B: w1b, w5a, w5b DONE; w1a chạy qua pi-crew run nội bộ (attempt-2 active, validation cuối)
- Batch C: w6, w7a, w7b, w8 (locks/render/misc/ci) — DONE

Sau mỗi batch: `npm run typecheck` + chạy test các wave. Cuối cùng: `npm test` full + fix fallout + commit per wave.

## Commit mapping (điền khi xong)
| Wave | Commit | Note |
|---|---|---|
| w1a | TBD | |
| w1b | TBD | |
| w2 | TBD | |
| w3 | TBD | |
| w4a | TBD | |
| w4b | TBD | |
| w5a | TBD | |
| w5b | TBD | |
| w6 | TBD | |
| w7a | TBD | |
| w7b | TBD | |
| w8 | TBD | |
