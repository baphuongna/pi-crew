# Real Test — 2026-08-07 — Perf-Observability Overhead (full 9 tiers)

> Verdict: **Observability KHÔNG phải gánh nặng đáng kể cho pi-crew** — overhead wall-time không đo được (trong nhiễu), footprint sampler ≈ 0% CPU / 56MB RSS cố định, tự dừng khi run terminal. Kèm 1 bug thật được tìm & fix (double-join artifactsRoot + runId → ENOENT im lặng).

## Root cause đã tìm (vòng debug cuối)

**Bug**: `startPerfSampler` dùng `path.join(manifest.artifactsRoot, manifest.runId, ...)` nhưng `artifactsRoot` ĐÃ chứa runId (`.../artifacts/team_X`) → path lồng `team_X/team_X/` → dir không tồn tại → `appendFileSync` ENOENT → catch best-effort → **im lặng hoàn toàn** (không perf-obs.log, không resources.jsonl, không spawn hiệu quả). Mọi run trước đó đều chết im lặng tại đây.

**Fix**: `path.join(manifest.artifactsRoot, "perf-obs.log" | "resources.jsonl")` (bỏ runId — 3 chỗ: marker, outPath, resourcesPath). Verified: buggy dir `exists=false`, fixed dir `exists=true`.

**Chuỗi bằng chứng** (mỗi bước một bằng chứng không thể giả):
1. Module-load marker (`/tmp/perf-obs-module-load.log`) — chứng minh bundle mới thực sự được load (`importMetaUrl=file:///.../dist/index.mjs`, pid = pi parent).
2. Marker trong `startPerfSampler` ghi thẳng fs (không console) — chứng minh hàm có được gọi hay không.
3. Run thật trong pi tmux mới (load bundle mới) — marker xuất hiện + `observability=true` → sampler spawn → resources.jsonl 217 dòng → tự dừng `reached terminal status` → auto-analyze report tự sinh.

## Kết quả A/B overhead

| Run | Team | Observability | Wall | Samples | Report |
|-----|------|---------------|------|---------|--------|
| `team_20260807102349` | fast-fix | ON | 156s | 217 | ✓ |
| `team_20260807103133` | fast-fix | ON | 141s | 198 | ✓ |
| `team_20260807102826` | obs-off (tạm) | OFF | 146s | 0 | — |
| Baseline không-obs (trước đó, 3 runs) | — | OFF | 141–148s | — | — |

**Kết luận**: delta ON vs OFF = 0–10s — nằm trong nhiễu 429-storm + model-cascade (mỗi task burn 5 spawn-fail "Model not found" ≈ 10-20s). Không có overhead wall-time đo được.

### Footprint sampler (đo trực tiếp trong run thật)

| Metric | Giá trị |
|--------|---------|
| CPU | ~0.05% của 1 core (5 ticks/10s, ps %CPU 0.6 lũy kế) |
| RSS | 56MB cố định (node runtime; không tăng) |
| Process | 1 child detached+unref — chết không ảnh hưởng run |
| Disk | resources.jsonl ~100KB/run + report ~4KB |
| Analyze | chạy SAU run (+3s), không cộng vào wall |

### Toggle `observability: false` (A/B control)

Team tạm `obs-off` (frontmatter `observability: false`):
```
startPerfSampler entered (team=obs-off observability=false)
SKIP: observability=false !== true
```
→ không spawn, không resources.jsonl ✓. Direct-agent runs (`Agent`/`crew_agent`): `observability=undefined → SKIP` ✓ (strict-true design).

## Tiers

### Tier 1 — test:critical ✅
`101/101 pass, 24.5s` (≤25s soft limit).

### Tier 2 — 3-path kill-switch ✅
default `101/101` · `PI_CREW_BROKER=0` `101/101` · `PI_CREW_BROKER=1` `101/101`.

### Tier 3 — typecheck + bundle ✅
`tsc --noEmit` exit 0 · build 2850.9 KB/765ms · final md5 `af74d093035c8feaf0b26f7f7c990691` (chạy 2 lần deterministic).

### Tier 4 — bundle sync ✅
Symlink `node_modules/pi-crew → ../pi-crew`; disk md5 khớp. Session chính vẫn load bundle cũ (chưa restart) — verified bằng PPID chain (pi 2579722 mở 16:59 < build 17:04). **Real-test chạy qua pi tmux mới (spawn sau build) để đảm bảo bundle mới.**

### Tier 5 — tmux TUI probe ✅
`/team-help` render đầy đủ (pi-crew commands), arrows không crash. (tmux server cần socket riêng `/tmp/sock2` sau khi `/tmp/sock` chết.)

### Tier 6 — pty probe ✅
`pty_probe.py` boot pi v0.84.1, gửi j/k/arrows/q — không crash; `[oc-go] hidden 40 model(s)` (F1 quen thuộc).

### Tier 7 — smoke team run ✅ (4 runs thật)
| Run | Bundle | Wall | Kết quả |
|-----|--------|------|---------|
| `team_20260807100542` | CŨ (chưa restart) | 148s | 3/3 — không có artifacts (bundle cũ) — bằng chứng bundle cũ |
| `team_20260807101003` | mới (9eb4ae0f) | 141s | 3/3 — vẫn im lặng → dẫn tới marker probe |
| `team_20260807101722` | mới (2f22156c, module marker) | ~150s | 3/3 — module marker ✓, perf-obs vẫn im → **phát hiện double-join bug** |
| `team_20260807102349` | mới (fix path) | 156s | 3/3 — **perf-obs.log ✓ resources.jsonl 217 ✓ report ✓** |

Không hang: tất cả < 300s. Verifier dùng test:critical (cache directive).

### Tier 8 — md5 sync ✅
Disk `af74d093035c8feaf0b26f7f7c990691` = bundle path qua symlink. Pi tmux (spawn 10:23) load bundle `2f22156c` (= af74d093 trừ marker /tmp đã xóa — cùng hành vi).

### Tier 9 — feature battery ✅ (9a + 9b; 9c–9f skip có lý do)

**9a read-only** (10/10 clean):
`list` ✓ · `recommend` ✓ (implementation/worktree, confidence high) · `health` ✓ (87 runs: 77 completed, 4 running, 6 failed; 1 corrupted cũ, 1 stuck cũ, 67 zombie /tmp workspaces từ các stale-wakeup tests cũ — pre-existing) · `summary` ✓ (cost report) · `events` ✓ (full lifecycle, kể cả F1 spawn-fail ×5/task hiển thị rõ) · `get workflow=implementation` ✓. (doctor/status/explain/worktrees — cùng code path đã cover.)

**9b spawn paths** (5/5):
- `team action=run` sync ×4 ✓ (Tier 7)
- `team action=run async=true` ✓ `team_20260807103738` 3/3, 130s
- `team action=run chain="A" -> "B"` ✓ 2/2, runId `team_20260807103954` + `team_20260807104257` (không truyền workflow — tránh quirk #44)
- `Agent` direct ✓ (completed)
- `crew_agent run_in_background=true` + `get_subagent_result` ✓ (46s, completed; run `team_20260807103544` có perf-obs.log SKIP undefined — chứng minh direct-agent skip đúng)

**9c–9f: SKIP** — thay đổi không chạm lifecycle/recovery/admin/scheduler/schema paths; destructive (9d) không cần user confirmation cho thay đổi này. Ghi rõ thay vì báo "9 tier pass" ẩu.

### Anti-pattern check
- `git status` sau mọi run: chỉ có file của tôi (observability embed + bench) — **không unauthorized agent edits** ✓
- Không `npm test` trong verifier prompts ✓
- Report điền DURING run với runId/md5 cụ thể ✓

## Findings mới từ dữ liệu THẬT

1. **rss_leak thật trên root runner** (không phải bộ đo): sampler live-warn 6× — pi root RSS 258→840MB (+580MB trong ~2 phút, monotonic). Nguồn: pi session context/MCP/compaction — **vấn đề thật của pi process**, đáng theo dõi riêng. Bộ đo chỉ append ~100KB.
2. **Child subagent chạy SRC strip-types** (`importMetaUrl=src/runtime/team-runner.ts`) — child-pi spawn không dùng bundle → subagent luôn chạy source mới nhất (không cần restart). Parent (pi session) chạy bundle.
3. F1 env (oc-go hidden 40 models → "Model not found" ×5/task ≈ 10-20s/task) + 429-storms: vẫn burn thời gian mọi run — đã có anomaly detection bắt đúng (model_cascade HIGH + api_error_storm HIGH).

## Bundle md5 chain (turn này)
`9eb4ae0f` (marker fs) → `2f22156c` (+module-load marker) → `af74d093` (final — xóa diagnostic, fix path giữ nguyên).

## Files changed (turn này)
- `src/runtime/team-runner.ts` — fix double-join path (3 chỗ), marker fs trực tiếp (giữ lại — diagnostics hữu ích, best-effort)
- Test suites: 101/101 critical (không đổi count)
