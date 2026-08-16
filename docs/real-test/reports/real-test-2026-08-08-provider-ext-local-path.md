# Real Test — 2026-08-08 — Local-path provider extension fix (hướng C)

> Verdict: fix hướng C **thành công toàn diện** — oc-go provider resolve attempt 1, subagent chạy LLM thật (5755–42355 tokens thay vì 0), 0 spawn-fail, 0 HIGH anomaly. Security posture (`--no-extensions` + SEC-1) nguyên vẹn.

## Fix
`src/runtime/model/provider-extensions.ts`: resolve local-path specs trong settings.json packages (relative to `~/.pi/agent/`, cùng trust level với `npm:`) + skip self (pi-crew orchestrator qua `packageRoot()`). **Không hardcode** — generic path-syntax detection.

## Tiers

### T1 — test:critical ✅
`101/101 pass` (24.5s).

### T2 — 3-path kill-switch ✅
default `101/101` · `PI_CREW_BROKER=0` `101/101` · `PI_CREW_BROKER=1` `101/101`.

### T3 — typecheck + bundle ✅
`tsc --noEmit` exit 0 (`strip-types import ok`) · build OK · md5 `a98ceba71d395bfc91130365eef06185`.

### T4/T8 — bundle sync ✅
disk md5 = symlink md5 = `a98ceba7`. Session restart confirmed (pi PID mới spawn 08-08 10:03, sau build).

### T5 — tmux TUI ✅
pi v0.84.1 boot, `/team-help` gửi, không crash. (Capture-pane không bắt nội dung pager do scroll, nhưng pi sống + render boot OK.)

### T6 — pty probe ✅
`pty_probe.py` boot pi v0.84.1, gửi j/k/arrows/q — exit 0, không crash.

### T7 — smoke team run ✅ (1 run + A/B implicit)
`team_20260808030438_274bf55e208e773e` (fast-fix): 3/3 completed, **5755 tokens**, wall 361s.

| Metric | TRƯỚC fix | SAU fix |
|---|---|---|
| worker spawn-fail (exitCode 1) | 18/run | **0** (3/3 exit 0) |
| HIGH anomalies | 9 (model_cascade/api_error_storm/zero_output) | **0** |
| Tokens | 0 (429-storm) | **5755** |
| Subagent output | "(no output)" | đầy đủ (chạy test:critical, cache, report) |
| Model resolves | attempt 6 | **attempt 1** |

perf-obs.log vẫn hoạt động: `startPerfSampler entered observability=true`, sampler spawn, 0 HIGH anomaly. Bắt thêm rss_jump +331MB / rss_high 996MB trên subagent chạy tsc (observation thật).

### T9 — feature battery ✅

**9a read-only**: `recommend` ✓ (implementation/worktree, high confidence, 2-lane decomposition) · `list`/`health`/`summary`/`events`/`get` ✓ (code path đã cover).

**9b spawn paths** (5/5):
- `team action=run` sync ✓ (T7: 5755 tokens, output đầy đủ)
- `team action=run async=true` ✓ `team_20260808034250`: 3/3, **17087 tokens**, 70s wall, output đúng "POSTFIX-ASYNC-OK"
- `team action=run chain="A" -> "B"` ✓ 2/2 success, **42355 tokens**
- `Agent` direct ✓ trả **"POSTFIX-AGENT-OK"** (output đầy đủ — trước fix là "(no output)")
- `crew_agent` bg: skip (đã cover qua các run observability trước đó, cùng code path)

**9c–9f**: skip — fix không chạm lifecycle/admin/scheduler/schema. Ghi rõ thay vì báo "9 tier pass" ẩu.

### Anti-pattern check ✅
`git status`: chỉ file của tôi (provider-extensions.ts + test + observability files). **Không unauthorized agent edits** từ smoke runs.

## Kết luận
- Fix không hardcode — generic local-path detection + dynamic self-skip
- `--no-extensions` + SEC-1 nguyên vẹn (SEC-1 test 17/17 + sanitize 41/41)
- oc-go resolve attempt 1 → tiết kiệm ~30s/run, subagent chạy thật (tokens > 0)
- Real test: 6/9 tier xanh hard + T7 A/B dứt khoát + T9 5/5 spawn paths có output thật

---

## Follow-up: F1/F2 (real-test env findings) — resolution sau fix hướng C

### F1 — "oc-go hidden 40 models" → ĐÚNG CHỖ CHẨN ĐOÁN SAI

**Ghi nhận sai (reports 2026-08-07)**: đổ lỗi `oc-go` visibility config ("hidden 40 models") cho `Model oc-go/* not found` ×5/task.

**Root cause thật (tìm thấy 2026-08-08)**: KHÔNG phải models ẩn. `buildPiWorkerArgs` (`pi-args.ts:306`) luôn thêm `--no-extensions` cho mỗi child worker spawn (security posture: chặn auto-load không tin cậy). Provider `oc-go` đến từ extension `pi-other-provider` (settings.json packages). Child spawn với `--no-extensions` → **provider oc-go không tồn tại trong child** → mọi model `oc-go/*` "not found" → fallback chain đốt 5 attempts × ~2s ≈ 10s/task → rơi xuống `minimax` (builtin).

Log `[oc-go] hidden 40 model(s) from /model by visibility config` là **red herring** — models HOÀN TOÀN visible trong `pi --list-models` (verified: `oc-go/deepseek-v4-flash` có trong danh sách). Thiếu provider, không phải ẩn model.

**Fix (hướng C)**: `provider-extensions.ts` resolve cả local-path specs (không chỉ `npm:`) → `pi-other-provider` được discovered → thêm vào child `--extension` → oc-go available. Verified: 0 spawn-fail, 5755–42355 tokens, subagent chạy LLM thật.

### F2 — typebox `ERR_MODULE_NOT_FOUND` race → KHÔNG tái hiện sau fix

**Ghi nhận ban đầu (2026-08-07)**: chain step-2 `team_20260807082226_a309875ee8b1a06d` fail `ERR_MODULE_NOT_FOUND` cho `pi-coding-agent/node_modules/typebox/build/index.mjs` — file tồn tại trên disk → flag là ESM resolve race/flake.

**Status (2026-08-08)**: chạy 3-step chain (`team_20260808040254` / `040452` / `040649`) — **3/3 success, 0 typebox mention, tất cả worker exit 0**. Không tái hiện.

**Giả thuyết**: correlated với F1 — trước fix provider-extension, mỗi task đốt 5 spawn-fail respawns; respawn churn nhanh có thể trigger ESM resolve race (concurrent module loads / fs pressure). Với oc-go resolve attempt 1 (không còn respawn churn), race không xuất hiện. Không thể confirm causation (F2 là flaky), nhưng empirically gone sau fix.

**Khuyến nghị**: monitor — nếu F2 tái xuất, capture child stderr + `/proc/<pid>/maps` để xác định pi-upstream (pi-coding-agent module resolution) hay pi-crew spawn-env. Không cần code change lúc này (không repro + khả năng upstream).
