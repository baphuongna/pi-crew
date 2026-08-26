# Perf Round 3 Probe — retrieval single-pass trên monorepo my_pi (2026-08-26)

**Branch:** `perf/round3-retrieval` (T1 `842219e3` + T2 `ae98dab9` + T3 `0b325bba`/`2677d184` + T4 `17010a21`)
**Probe input:** goal + step thật của run `team_20260826002634` (real test 9-tier 2026-08-26), cwd `/home/bom/source/my_pi` — 77.2k file qua `rg --files`, ~57k sau filter `RELEVANT_EXTS`.
**Method:** `node --experimental-strip-types -e` gọi trực tiếp `runRetrievalCycle` (cold sau `__test_resetDiscoveredCache()`, warm = cùng cwd + keywords khác để ép discovery-cache hit + re-score), 4 lần chạy.

## Kết quả

| Metric (my_pi monorepo, real run input) | Baseline (trước round 3) | Sau round 3 (median 4 runs) | Delta |
|---|---|---|---|
| `runRetrievalCycle` cold | 5266 ms | **1613 ms** (1552–1639) | **−69%** |
| warm, keywords mới (discovery cache hit) | 4278 ms | **258 ms** (256–264) | **−94%** |
| keywords từ tokenize(goal+task) | 25 | **17** | −32% |
| duplicate paths trong top-10 | tối đa 3× cùng file | **0** | — |
| rg spawns per retrieval | 3 | **1** cold / **0** warm | — |

Note: target trong plan ghi warm ≤250ms — đo được 256–264ms (chênh ~4%, ổn định qua 4 lần chạy, do scoring 17 keywords × 57k file còn lại). Không điều chỉnh gì để "khớp số" — ghi đúng số đo.

## b13 bench (ngữ cảnh khác — repo pi-crew nhỏ)

`bench/b13-retrieval-latency.bench.ts` đo trên chính repo pi-crew (~5k relevant files): **cold 83 ms / cache-hit 8 ms**, budgets 2000/400ms, 2/2 PASS, deterministic qua 3 lần chạy. **Đây là smoke guard trên workload nhỏ** — một regression quay lại hành vi 3-cycle (~3× cold) vẫn dưới budget ở quy mô này; số monorepo (1613ms) ở bảng trên là ngữ cảnh đo thật, không phải cái b13 guard. Guard có teeth hơn cần optional field `discoveredFromCache` trên `RetrievalResult` — filed as follow-up (mâu thuẫn interface-freeze constraint của plan này).

## Root cause (3 câu)

Loop tối đa 3 cycles chạy vô điều kiện vì cổng hội tụ đòi score ≥0.7 trong khi path-only scoring (content luôn `""`) chạm tối đa 0.64 — mỗi cycle re-spawn `rg --files` và re-score cùng ~57k file với 25 keywords gồm filler verbs. Evaluations tích lũy trùng path giữa các cycles (cùng file tối đa 3 lần trong top-10). Không có memo discovery theo cwd — `stableIOCache` của prompt-builder key theo `(cwd, step.task)` nên mỗi task miss.

Fix: single-pass + dedupe theo absolute path (T1), STOPWORDS mở rộng giữ path-words (T2), discovery cache per-cwd TTL 60s cap 32 (T3).

## Tác động lên prompt-pipeline per task

Baseline real test: 6–8s/task (trong đó retrieval 5.3s). Sau round 3: cold ~1.6s (task đầu), warm ~0.26s (task sau trong cùng run, cùng cwd). Cùng với RSS: mảng evaluations ~170k objects×cycles không còn phình — kỳ vọng hết cảnh báo `rss_leak` monotonic của sampler (cần real test tiếp theo để xác nhận).
