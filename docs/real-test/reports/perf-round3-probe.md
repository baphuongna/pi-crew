# Perf Round 3 Probe — retrieval single-pass trên monorepo my_pi (2026-08-26)

**Branch:** `perf/round3-retrieval` (T1 `842219e3` + T2 `ae98dab9` + T3 `0b325bba`/`2677d184` + T4 `17010a21` + T5 `37ca8bf2`)
**Probe input:** goal **nguyên văn** từ `.crew/state/runs/team_20260826002634_c76db11d778daa64/manifest.json` (real test 9-tier 2026-08-26) + step.task của workflow fast-fix (`"Find the likely source of the issue: {goal}"`), cwd `/home/bom/source/my_pi` — 77.2k file qua `rg --files`, ~57k sau filter `RELEVANT_EXTS`.
**Method:** `node --experimental-strip-types -e` gọi trực tiếp `runRetrievalCycle`. Cold = process mới + `__test_resetDiscoveredCache()`; warm = cùng cwd + keywords khác để ép discovery-cache hit + re-score. Baseline đo trên worktree checkout `745cf9f1` (code trước round 3) với ĐÚNG input trên — mọi so sánh cùng input. Số median của 3-4 runs.

> Erratum: bản report đầu tiên của round này ghi số đo trên một biến thể goal RÚT GỐN (14 keywords) nhưng mô tả là "goal thật" — final review bắt lại. Bảng dưới là bộ số đo lại đồng nhất goal nguyên văn; các con số cũ (5266/4278/25) thuộc biến thể rút gọn và đã thay thế.

## Kết quả (goal nguyên văn, monorepo my_pi)

| Metric | Trước round 3 (`745cf9f1`) | Sau round 3 | Delta |
|---|---|---|---|
| `runRetrievalCycle` cold | 7055 ms (7039–7258) | **1980 ms** (1911–2165) | **−72%** |
| warm, keywords mới (discovery cache hit) | 3335 ms (3248–3911) | **275 ms** (257–289) | **−92%** |
| keywords từ tokenize(task+goal) | 55 | **41** | −25% |
| duplicate paths trong top-10 | tối đa 3× cùng file¹ | **0** | — |

¹ Quan sát ×3 lấy từ run thật `team_20260826002634` (workload đầu tiên của round này). Với input probe hiện tại, baseline cho max dupe = 1 — top-10 baseline gồm 10 file score 0.531 khác nhau, stable sort giữ các bản sao cycle 2/3 khỏi lọt vào slice; cơ chế tích lũy trùng path giữa cycles vẫn đúng (đó là động cơ dedupe của T1), chỉ là magnitude phụ thuộc phân bố score của workload.
| rg spawns per retrieval | 3 | **1** cold / **0** warm | — |

## b13 bench (ngữ cảnh khác — repo pi-crew nhỏ)

`bench/b13-retrieval-latency.bench.ts` đo trên chính repo pi-crew (~5k relevant files), GOAL là biến thể rút gọn (14 keywords, cố định trong bench): **cold 83 ms / cache-hit 8 ms**, budgets 2000/400ms, 2/2 PASS, deterministic qua 3 lần chạy. **Đây là smoke guard trên workload nhỏ** — một regression quay lại hành vi 3-cycle (~3× cold) vẫn dưới budget ở quy mô này; số monorepo ở bảng trên là ngữ cảnh đo thật, không phải cái b13 guard. Guard có teeth hơn cần optional field `discoveredFromCache` trên `RetrievalResult` — filed as follow-up (mâu thuẫn interface-freeze constraint của plan này).

## Root cause (3 câu)

Loop tối đa 3 cycles chạy vô điều kiện vì cổng hội tụ đòi score ≥0.7 trong khi path-only scoring (content luôn `""`) chạm tối đa 0.64 — mỗi cycle re-spawn `rg --files` và re-score cùng ~57k file với 55 keywords gồm filler verbs. Evaluations tích lũy trùng path giữa các cycles (cùng file tối đa 3 lần trong top-10). Không có memo discovery theo cwd — `stableIOCache` của prompt-builder key theo `(cwd, step.task)` nên mỗi task miss.

Fix: single-pass + dedupe theo absolute path (T1), STOPWORDS mở rộng giữ path-words (T2), discovery cache per-cwd TTL 60s cap 32 (T3).

## Tác động lên prompt-pipeline per task

Trước round 3, khoảng 6-8s/task của prompt pipeline gồm ~5-7s retrieval (tùy độ dài goal) + ~0.15s workspace tree + phần render/write còn lại. Sau round 3, retrieval còn 2.0s cold (task đầu) / 0.28s warm (task sau cùng cwd). Phần pipeline ngoài retrieval chưa được đo lại end-to-end — sẽ xác nhận bằng real test tiếp theo, cùng với kỳ vọng hết cảnh báo `rss_leak` monotonic của sampler (mảng evaluations ~57k×3 objects×cycles không còn phình).
