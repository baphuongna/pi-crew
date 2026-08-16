# Báo cáo Deep-Dive: pi-crew — RLM/scratchpad và cơ hội phát triển

> **Ngày:** 2026-08-12
> **HEAD:** `9354f546` (v0.9.67)
> **Pi cài đặt:** 0.84.1 (node v22.23.1)
> **Phương pháp:** đọc source trực tiếp, probe engine thật 24/24 case, inspect 83 runs, verify API claims, typecheck pass
> **Ngôn ngữ báo cáo:** Việt Nam (theo convention pi-crew)

> **⚠️ Cập nhật sau verification (cùng ngày):** Báo cáo gốc đã được verify độc lập bằng 4 agent song song (đọc source + reproduce bug thật trên EngineManager + chạy lại các metric commands). Phần lớn claims **CONFIRMED**. Ba chỗ đã được sửa cho đúng fact:
> 1. **§2.1** số dòng tổng: `~2 321` → `2 451` (mâu thuẫn nội bộ với chính bảng per-file).
> 2. **§2.3** global shadow poisoning: bug **THẬT** (đã reproduce), nhưng framing về pi-rlm sai — pi-rlm cũng không protect Node globals nên cũng có bug; thêm nữa poisoning xảy ra cả **trong single session**, không chỉ sau restore.
> 3. **§3.2 / §5.1A** luận điểm setActiveTools: chỉ đúng ở *technical sub-claim*; **conclusion/actionable sai cơ chế**. Fix đúng để phá 0-adoption là sửa `role-tools.ts` (bỏ `bash`), không cần `setActiveTools`/`pi-api.ts`/`child-pi-spawn.ts`.
>
> Chi tiết sửa inline tại từng section.

---

## Mục lục

1. [Tóm tắt đầu](#1-tóm-tắt-đầu)
2. [RLM/scratchpad engine — đánh giá kỹ thuật](#2-rlmscratchpad-engine--đánh-giá-kỹ-thuật)
   - 2.1 [Kiến trúc (đã port đúng)](#21-kiến-trúc-đã-port-đúng)
   - 2.2 [Empirical probe — 24/24 case](#22-empirical-probe--2424-case)
   - 2.3 [Bug nghiêm trọng: Global shadow poisoning qua restore](#23-bug-nghiêm-trọng-global-shadow-poisoning-qua-restore)
   - 2.4 [Bug nhỏ: Stack trace không có source map](#24-bug-nhỏ-stack-trace-không-có-source-map)
   - 2.5 [Pattern matrix status (22 patterns)](#25-pattern-matrix-status-22-patterns)
3. [Vấn đề adoption — 0 cell trên 83+ runs](#3-vấn-đề-adoption--0-cell-trên-83-runs)
   - 3.1 [Dữ liệu](#31-dữ-liệu)
   - 3.2 [setActiveTools và root cause 0-adoption (verify)](#32-setactivetools-và-root-cause-0-adoption-verify)
   - 3.3 [Decision gate chưa được kích hoạt](#33-decision-gate-chưa-được-kích-hoạt)
4. [Cross-agent state — leverage chưa khai thác](#4-cross-agent-state--leverage-chưa-khai-thác)
5. [Cơ hội phát triển — xếp theo value/effort](#5-cơ-hội-phát-triển--xếp-theo-valueeffort)
   - 5.1 [HIGH VALUE](#51-high-value--khai-thác-rlm-đúng-cách)
   - 5.2 [MEDIUM VALUE](#52-medium-value--hardening--debt-closure)
   - 5.3 [LOW VALUE](#53-low-value--maintenance)
6. [Đánh giá tổng thể](#6-đánh-giá-tổng-thể)
7. [Bước tiếp đề xuất](#7-bước-tiếp-đề-xuất)
8. [Phụ lục](#8-phụ-lục)

---

## 1. Tóm tắt đầu

| Khía cạnh | Trạng thái | Bằng chứng |
|---|---|---|
| RLM engine (scratchpad) | **Kỹ thuật ổn, 1 bug nghiêm trọng** | probe 24/24 pass, nhưng global shadow poisoning qua restore |
| Adoption | **0 cell trên 83+ runs** | 0 snapshot artifacts, 0 scratchpad.cell events, 0 transcript calls |
| Root cause 0-adoption | **`bash` được thêm có chủ ý vào `role-tools.ts`** | `setActiveTools` có sẵn nhưng không cần; `--tools` flag đã wired; model luôn chọn `bash` (xem §3.2 đã sửa) |
| HMAC helper | **Dead code** | 161 dòng, 11 test, 0 call site production |
| host_request | **Dead protocol surface** | khai báo ở protocol.ts:48, không có handler |
| Cross-agent state | **Text-serialized, mất cấu trúc** | structuredResults = opportunistic JSON parse của text output |
| Version drift | devDeps `^0.83.0` vs installed `0.84.1` | typecheck pass nhưng test chống version cũ |
| Typecheck | ✅ pass | `tsc --noEmit` + strip-types import ok |
| Test suite | 795 files, 28 skip/env-gated | `npm test` timeout 580s (roadmap target < 600s) |

---

## 2. RLM/scratchpad engine — đánh giá kỹ thuật

### 2.1 Kiến trúc (đã port đúng)

pi-crew port `@shift-labs/pi-rlm` (Bun) sang Node thuần:

```
EngineManager (host, trong worker process)
  └─ spawn(node --experimental-strip-types guest.ts) + fd3 + nonce
     └─ guest: with(SCOPE proxy) + AsyncFunction + v8.serialize
```

**Cấu trúc module** (`src/runtime/scratchpad/`):

| File | Dòng | Vai trò |
|---|---|---|
| `engine.ts` | 648 | EngineManager host — spawn guest, queue execute, snapshot/restore, kill |
| `guest.ts` | 409 | Namespace proxy, with(SCOPE), v8.serialize, sh() helper, abort |
| `transform.ts` | 363 | esbuild strip + acorn parse, decl→assignment, trailing-expr→setResult |
| `protocol.ts` | 88 | fd3 + nonce + envelope, line-JSON |
| `snapshot-hmac.ts` | 167 | HMAC helper — **DEAD CODE, 0 call site** |
| `snapshot-lookup.ts` | 74 | find latest snapshot by mtime (crash-resume) |
| `index.ts` | 22 | barrel |
| `README.md` | — | Phase 1-3 design doc |

**Plus** `src/prompt/scratchpad-lifecycle.ts` (680 dòng): tool registration, execute handler, snapshot debounce, shutdown flush, restore validation.

**Tổng footprint:** 2 451 dòng source (tổng 8 file trong bảng trên + `scratchpad-lifecycle.ts`) + 20 test files.

> *(Sửa sau verify: bản gốc ghi `~2 321`, nhưng chính các con số per-file trong bảng trên cộng lại = 2 451 — đây là mâu thuẫn nội bộ, không phải đo lường sai.)*

**Port Node quan trọng (không Bun):**

| pi-rlm (Bun) | pi-crew (Node) | Xác nhận |
|---|---|---|
| `bun:jsc serialize/deserialize` | `node:v8 serialize/deserialize` | ✅ snapshot/restore round-trip |
| `Bun.Transpiler` (DCE off) | `esbuild transformSync` + acorn | ✅ trailing-expr không bị drop |
| `Bun.inspect` | `node:util inspect` | ✅ |
| `spawn("bun", ["run", guest])` | `spawn(process.execPath, ["--experimental-strip-types", guest])` | ✅ |
| `Bun.$` guard | `sh(cmd, args[])` guest-local (I6) | ✅ shipped v0.9.67 |
| `Atomics.wait` backoff | giữ nguyên (shared memory OK) | ✅ |
| `AsyncLocalStorage` | `node:async_hooks` — Node native | ✅ |

### 2.2 Empirical probe — 24/24 case

Tôi viết probe trực tiếp spawn EngineManager thật (`/tmp/rlm-probe/probe.ts`), chạy 24 cell shape:

| # | Case | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | Basic assign | ✅ `a=2` | namespace persist đúng |
| 2 | Compounding | ✅ `a*21=42` | cell 2 dùng biến cell 1 |
| 3 | Object destructuring | ✅ `x+y=3` | |
| 4 | Array destructuring | ✅ `p*q=12` | |
| 5 | for-of-loop | ✅ `sum=6` | |
| 6 | **Mid-cell failure binding survival** (pattern 05) | ✅ `survives='yes'` | throw giữa chừng, biến trước throw sống |
| 7 | Top-level await | ✅ `typeof mod.platform='function'` | |
| 8 | Async function decl | ✅ `f()=7` | |
| 9 | Class decl | ✅ `new K().v=5` | |
| 10 | **sh() helper** (I6) | ✅ `r.stdout.trim()='hi'` | structured return `{exitCode,stdout,stderr}` |
| 11 | **sh() nullish guard** (pattern 12) | ✅ throw trước spawn | `arg[1] is null/undefined` |
| 12 | TS type stripping | ✅ `z.a=9` | esbuild strip đúng |
| 13 | Generator | ✅ `[1,2]` | |
| 14 | Labeled break | ✅ `'ok'` | |
| 15 | Export forbidden | ✅ SyntaxError | `export statements are not supported in cells` |
| 16 | Using declarations | ✅ | |
| 17 | Cyclic value | ✅ `'made'` | |
| 18 | Map/Set/Date | ✅ `m.size+s.size=2` | v8.serialize giữ đúng |
| 19 | Shadow global | ✅ (nhưng xem bug §2.3) | |
| 20 | Big buffer (1KB) | ✅ `1024` | |
| 21 | **Doctrine worked example** (I4) | ✅ cell1=`2`, cell2=`['t1','t3']` | đúng verbatim từ doctrine |
| 22 | Sync infinite loop → abort | ✅ `aborted` sau 1705ms | grace 500ms + detection |
| 23 | Ping sau wedge | `null` (engine chết) | by design — cần spawn mới |
| 24 | Snapshot/restore round-trip | ✅ 17 vars restored, 6 failed | functions/classes/modules không serialize |

**Kết luận kỹ thuật:** engine hoạt động đúng semantic REPL notebook. 2 invariant quyết định (binding survive mid-cell failure, namespace revive across process) đều pass.

### 2.3 Bug nghiêm trọng: Global shadow poisoning qua restore

**Mức: HIGH — silent corruption, không có detect mechanism.**

**Probe:**

```js
// cell 1: cell ghi đè global
const process = 'poisoned'; const Buffer = 'poisoned2'; 'set'
// → snapshot → kill → restore (engine mới, process mới)
// cell 2: sau restore
typeof process.env    // → 'undefined' (string 'poisoned' không có .env)
Buffer.alloc ? 'real' : 'poisoned'  // → 'poisoned'
```

**Root cause:** `installBootstrapBindings()` (`guest.ts:231`) chỉ re-install `sh` sau restore — không re-install **Node globals** (`process`, `Buffer`, `console`, `setTimeout`, v.v.). Do proxy `get` trap (`guest.ts:128-131`) check namespace **trước** globalThis, bất kỳ global nào bị cell shadow trong namespace sẽ thắng global thật sau restore.

> *(Sửa sau verify — bản gốc quả quyết pi-rlm "re-install **tất cả** bootstrap bindings nên stale value không thể shadow" là **misleading**. Thực tế pi-rlm chỉ re-install `{rlm, Bun, tools}` (Bun-specific), cũng **không** include Node globals — nên `const process='poisoned'` sẽ poison pi-rlm **giống hệt**. Khác biệt thật hẹp hơn: pi-rlm protect global `Bun` (flagship của nó), pi-crew chỉ protect `sh`. Bug này không phải regression của port.)*

**Quan trọng (thêm sau verify):** poisoning **không chỉ xảy ra sau restore** — nó xảy ra ngay trong **single session** vì `namespace` là module-level singleton chia sẻ cross-cell. Cell 1 viết `const process='poisoned'` (transform.ts đổi decl→assignment → gán vào namespace) thì cell 2 trong cùng engine đã thấy shadow rồi. Restore chỉ khiến poisoning tồn tại qua restart; bản thân fix phải cover cả 2 path.

**Tác động thực tế:**
- Model viết `const process = ...` (hoặc `const console = ...`, `const Buffer = ...`) trong cell 1.
- Cell 2 trong **cùng session** đã dùng shadow value thay vì Node global thật (namespace singleton).
- Cell sau **restore** (engine mới) tiếp tục dùng shadow nếu shadow value *serializable* (string/number/plain object/array). *(Nuance sau verify: shadow chứa function/class — vd `const console={log:...}` — fail `v8.serialize`, nên không tồn tại qua restart, chỉ poison trong session.)*
- **Không có error, không có notice** — silent corruption.
- Doctrine bullet "re-verify variables before using them" không đủ vì model không biết `process` đã bị shadow (nó không phải biến model tạo có chủ ý, nó là global bị vô tình ghi đè).

**Fix đề xuất (2 lựa chọn):**

1. **Clear shadowed globals trong namespace trước re-install** — trong `installBootstrapBindings()`, sau restore, xóa các key trùng với Node globals khỏi namespace:
   ```ts
   const PROTECTED_GLOBALS = ["process", "Buffer", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "globalThis", "AbortController"];
   for (const name of PROTECTED_GLOBALS) {
     if (namespace[name] !== undefined && INTERNAL_BINDINGS.get(name) === undefined) {
       delete namespace[name];
     }
   }
   ```

2. **Set trap refuse shadow** — trong `makeScopeProxy`, `set` trap refuse ghi vào namespace nếu key trùng với protected global:
   ```ts
   set(target, prop, value) {
     if (PROTECTED_GLOBALS.includes(prop)) {
       throw new TypeError(`Cannot shadow global '${prop}' in scratchpad namespace`);
     }
     ...
   }
   ```

Lựa chọn 1 ít xâm nhập hơn (cho phép shadow trong session, chỉ clear khi restore). Lựa chọn 2 an toàn hơn nhưng restrictive.

### 2.4 Bug nhỏ: Stack trace không có source map

**Mức: MINOR — model vẫn đọc được error message, chỉ line number bị offset.**

Error stack hiển thị:
```
    at Proxy.deep (eval at runCell (file:///.../guest.ts:260:19), <anonymous>:4:9)
    at eval (eval at runCell (file:///.../guest.ts:260:19), <anonymous>:6:55)
```

Line `4:9` là relative đến cell đã transform, không phải source gốc. esbuild hỗ trợ `sourcemap: true` nhưng `transform.ts` không bật.

**Fix:** bật `sourcemap: 'inline'` trong `esbuild.transformSync()` options, rồi parse source map để remap line/column trong error stack trước khi trả về model. Effort: 0.5 ngày.

### 2.5 Pattern matrix status (22 patterns)

| Status | Patterns | Ghi chú |
|---|---|---|
| ✅ Shipped | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 16, 17, 19, 20 | High quality: fd3+nonce, abort grace 500ms, ping-before-execute, 65536 chars/channel cap, D10 TOCTOU re-validation, D6 two-sided caps, D13 base64 round-trip, kill-process-group |
| ⚠️ Partial | **13** (dormant activation), **14** (prompt replacement) | 13: dormant-arming shipped. Tool-collapse sub-pattern bị design doc reject với *một* technical claim sai ("không có cơ chế surface collapse" — sai, vì `--tools` flag có sẵn), NHƯNG conclusion của báo cáo gốc (dùng `setActiveTools` để ép) cũng sai cơ chế — xem §3.2 đã sửa. 14: doctrine đã fix I1-I4 trong v0.9.67 |
| ❌ Gap → filled | **12** (shell guard) | I6 shipped v0.9.67 — `sh(cmd, args[])` guest-local, nullish guard |
| ⏸ Deferred by design | **15** (host bridge) | `host_request` declared at `protocol.ts:48` nhưng không có engine handler — dead protocol surface |
| ⏸ Correctly skipped | 18, 21 (rendering) | Worker runs `--mode json`, không TUI |
| ⚠️ Consequence unhandled | **22** (design philosophy) | Kept-toolbox decision → 0 adoption; xem §3 |

---

## 3. Vấn đề adoption — 0 cell trên 83+ runs

### 3.1 Dữ liệu

| Metric | Giá trị | Nguồn |
|---|---|---|
| Tổng runs trong `.crew/state/runs` | 83 | `ls .crew/state/runs \| wc -l` |
| Runs thật (team_*) | 15 | 10 từ 2026-08-10, 5 từ 2026-06-08 |
| Runs scaffold/test | 68 | ledger_real_*, ck_real_*, test-decay-*, test-perf-* |
| Snapshot artifacts | **0** | `find .crew -path '*scratchpad*' \| wc -l` |
| scratchpad.cell events | **0** | `grep -rh 'scratchpad.cell' .crew/state/runs/*/events.jsonl \| wc -l` |
| Transcript scratchpad calls | **0** | `grep -rl '"toolName":"scratchpad"' .crew/artifacts/*/transcripts/*.jsonl \| wc -l` |
| Runs sau v0.9.67 (I1-I7 fix) | **0 thật** | 08-12 perf reports là scaffold (0 token, no transcript) |
| Doctrine cost | **~342 tokens/turn** | 7 bullets, 1366 chars (tăng từ ~246 sau I-batch) |
| Armed roles | executor, verifier, test-engineer | `role-tools.ts` (`scratchpad: true`) |

**Tất cả 15 runs thật đều dùng `fast-fix` team** (explore → execute → verify, one-shot). Không có run nào có multi-step parse-then-analyze data flow — đúng loại task scratchpad tồn tại cho.

### 3.2 setActiveTools và root cause 0-adoption (verify)

`rlm-apply-pi-crew.md` §4.3 reject tool-collapse (pattern 13 phần `setActiveTools(["execute"])`) với lý do:

> "worker spawn qua CLI không có cơ chế surface collapse; model worker mặc định rẻ hơn → tool-box cổ điển hiệu quả hơn '1 tool'"

**Phần đúng:** design doc có *đúng một* technical sub-claim sai về fact ("worker spawn qua CLI không có cơ chế surface collapse"). Nhưng **conclusion của chính báo cáo này (phiên bản gốc) cũng sai cơ chế** — xem correction bên dưới. Tôi verify trực tiếp:

```bash
# pi 0.84.1 đã cài đặt
$ pi --version
0.84.1

# setActiveTools tồn tại trong ExtensionAPI
$ grep -n "setActiveTools" .../examples/extensions/tools.ts
35:    pi.setActiveTools(Array.from(enabledTools));

# pi-crew's pi-api.ts KHÔNG liệt kê setActiveTools — nhưng không cần (xem bên)
$ grep "setActiveTools" src/extension/pi-api.ts
# (no output — chưa được khai báo, nhưng API có sẵn)
```

`pi.setActiveTools()` / `getAllTools()` / `getActiveTools()` **đúng là có** trong pi 0.84.1 (khai báo ở `dist/core/extensions/types.d.ts:948-950`) và được dùng trong official examples (`tools.ts:35`, `plan-mode/index.ts:108`, `preset.ts:161`). Technical claim của design doc ("không có cơ chế surface collapse") **đúng là sai về fact**.

> **⚠️ Correction sau verify — conclusion của báo cáo gốc cũng sai cơ chế.** Phiên bản gốc của section này kết luận "pi-crew chỉ cần thêm khai báo trong `pi-api.ts`" và §5.1A gợi ý gọi `setActiveTools` trong `child-pi-spawn.ts`. **Cả hai đều sai:**
>
> 1. **Không cần khai báo `pi-api.ts`.** `pi-api.ts` đã re-export cả interface `ExtensionAPI`; `setActiveTools` là method trên interface đó nên đã accessible type-level. `scratchpad-lifecycle.ts:642` nhận `pi: ExtensionAPI` sẵn — `pi.setActiveTools()` đã gọi được ngay.
> 2. **`child-pi-spawn.ts` là sai call site.** File đó chạy ở **parent process**, không có `pi` object của child worker.
> 3. **Đã có cơ chế đơn giản hơn đang hoạt động.** `pi-args.ts:buildPiWorkerArgs` đã wired `--tools` / `--exclude-tools` CLI flag để kiểm soát tool surface của child worker. Và chính pi-crew **đã dùng tool-collapsing** ở live-session path (`live-session-runtime.ts:1097`: `setActiveToolsByName(["submit_result"])`).
>
> **Root cause 0-adoption thật** không phải "thiếu setActiveTools" — mà là **`bash` được thêm có chủ ý vào `role-tools.ts`** cho các armed roles (`verifier`, `test-engineer` có `bash` trong `tools[]`; `executor` không restrict gì), cộng thêm design decision Pattern 22 (tool-box > 1-tool cho model rẻ). Model có cả `bash` + `scratchpad` → luôn chọn `bash` (quen hơn, không token overhead).

**Lưu ý (reframe mechanism):** Path vừa phải để ép adoption **không phải `setActiveTools`** — mà là **sửa `role-tools.ts`** bỏ `bash` khỏi `tools[]` (hoặc thêm vào `excludeTools[]`) của armed roles. Khi đó model gets `scratchpad` + `read` + `edit` + `write` + `ls` + `grep` + `find` nhưng KHÔNG `bash` — shell operations phải qua `sh()` → trả structured value → cell 2 reuse được. Xem §5.1A (đã sửa).

### 3.3 Decision gate chưa được kích hoạt

Improvement plan 2026-08-11 §5 định nghĩa decision gate:

| Điều kiện | Kết luận |
|---|---|
| ≥1 cell / ~5 armed-role runs, có qualifying retry measurably shortens attempt 2 | Premise holds → proceed to J3 (shape-based arming), consider J2 (host bridge) |
| ≥1 cell nhưng không có qualifying retry / không measurable | DEFER — adoption happened but value unproven. Extend window, target retry tasks |
| Still ~0 cells AND task-shape precondition met | Remove feature (or move behind `PI_CREW_SCRATCHPAD_EXPERIMENT=1`), record ADR |
| Still ~0 cells but precondition NOT met | DEFER — restart with shape-diverse runs |

**Trạng thái hiện tại:** gate **không thể kết luận** trên sample hiện tại:
- 15 runs thật đều `fast-fix` (one-shot, không multi-step)
- 0 runs sau v0.9.67 (I1-I7 fix chưa được test trên task thật)
- Retries "essentially never fire today" (0 tasks trong history có >1 attempt) — crash-resume (Phase 2, giá trị chính của scratchpad) chưa bao giờ được test trên retry thật

---

## 4. Cross-agent state — leverage chưa khai thác

### Hiện trạng

Inter-agent handoff trong pi-crew = **text serialization với truncation + compaction**:

```
upstream task result (text)
  → collectDependencyOutputContext (task-output-context.ts:399)
    → resultSummary = resultText (raw text)
    → truncate (MAX_RESULT_INLINE_BYTES)
    → compaction pipeline (7 stages):
        ANSI strip → blank collapse → deduplicate → head-snap → tail-capture → truncation → bounded-tail
    → inject vào downstream prompt
  → structuredResults = tryParseJson(resultText)  // opportunistic, best-effort, không guaranteed
```

**Vấn đề:** RLM "compounds, not repeats" chỉ được khai thác **trong 1 worker namespace**. Giữa agents, mọi thứ re-serialize thành text, mất cấu trúc. Downstream worker re-read + re-parse text mà upstream đã parse xong.

### Cơ hội

Pass scratchpad snapshot giữa dependency-linked tasks:
- Upstream worker snapshot namespace (đã có: `scratchpad/<taskId>.attempt-<i>.snapshot.json`)
- Downstream worker restore snapshot upstream → start với parsed data structures (Map, Set, parsed JSON objects) thay vì re-read + re-parse text
- Token saving compound theo chain (3-task chain: explore → analyze → write, mỗi task reuse data của task trước)

**Trust boundary:** same-uid team worker đã viết artifacts (đã chấp nhận). Snapshot restore đã có validation (D10 TOCTOU, D6 caps, D13 base64 round-trip). Cần thêm: cross-task lookup (hiện tại snapshot-lookup chỉ tìm cùng taskId, cần mở rộng tìm dependency taskIds).

**Effort:** L (3-5 ngày). **Risk:** high (new inter-process state passing). **Blocked on:** adoption metric >0 trước (để chứng minh scratchpad có giá trị trong 1 worker trước khi mở rộng cross-agent).

---

## 5. Cơ hội phát triển — xếp theo value/effort

### 5.1 HIGH VALUE — khai thác RLM đúng cách

#### A. Tool-surface narrowing (không full collapse)

- **Vấn đề:** scratchpad compete với `bash` và thua mỗi lần. `bash` quen hơn, không có token cost overhead, model default chọn `bash`.
- **Giải pháp:** thay vì collapse xuống `["scratchpad"]` (risky), demote `bash` khỏi armed roles khi scratchpad active. Model gets `scratchpad` + `read` + `edit` + `write` + `ls` + `grep` + `find` nhưng KHÔNG `bash`. Shell operations phải qua `sh()` → trả structured value `{exitCode, stdout, stderr}` → cell 2 reuse được.
- **Cần (sửa sau verify — bỏ cơ chế `setActiveTools` sai):**
  1. Sửa `src/config/role-tools.ts`: bỏ `"bash"` khỏi `tools[]` của `verifier` và `test-engineer`; với `executor` (hiện không restrict), thêm `"bash"` vào `excludeTools[]`. Đây là cơ chế `--tools`/`--exclude-tools` CLI flag đã wired trong `pi-args.ts:buildPiWorkerArgs`.
  2. Doctrine update: hướng dẫn model dùng `sh()` thay vì `bash` cho shell commands.
  3. *(Không cần)* khai báo `setActiveTools` trong `pi-api.ts` (đã accessible qua `ExtensionAPI`) và *(không gọi)* trong `child-pi-spawn.ts` (sai process) — đây là gợi ý sai của bản gốc.
- **Effort:** **0.5 ngày** (bản gốc ghi 1-2 ngày vì tưởng phải thêm API). **Risk:** low–medium (thay đổi tool surface model nhìn thấy).
- **Đây là lever duy nhất có thể phá 0-adoption** mà không cần full collapse.

#### B. Cross-agent namespace passing

- Xem §4. Leverage lớn nhất nhưng cần adoption >0 trước.
- **Effort:** 3-5 ngày. **Risk:** high. **Blocked on:** adoption metric.

#### C. Shape-based arming (J3)

- **Vấn đề:** mọi `executor` / `verifier` / `test-engineer` worker trả ~342 tokens/turn dù task có multi-step data flow hay không.
- **Giải pháp:** arm scratchpad chỉ cho multi-file / multi-step / parse-then-analyze tasks. Predicate trên task packet trong `child-pi-spawn.ts` trước khi set `PI_CREW_SCRATCHPAD=1`.
- **Effort:** 0.5-1 ngày. **Risk:** low.

### 5.2 MEDIUM VALUE — hardening + debt closure

#### D. Fix global shadow poisoning (§2.3)

- Bug thật, silent corruption. Xem §2.3 cho fix chi tiết.
- **Effort:** 0.5 ngày. **Risk:** low.

#### E. HMAC: wire hoặc delete (J1)

- 161 dòng dead crypto (`snapshot-hmac.ts`), 11 test green, 0 production call site.
- Wire cần trả lời: `writeArtifact` redaction survive inline signature prefix? HMAC over raw V8 bytes vs base64 envelope? `SNAPSHOT_MAX_BYTES` apply cho envelope hay bare payload?
- Nếu không clean → **delete** thay vì để 161 dòng decorative crypto.
- **Effort:** 1 ngày. **Risk:** medium.

#### F. Minimal host bridge (J2)

- `tools.read` + `tools.grep` trong guest namespace. Data enters namespace **không qua transcript** → token saving thật (pi-rlm's core value proposition).
- `host_request` đã khai báo ở `protocol.ts:48`, chỉ cần engine-side dispatcher + guest handles.
- **Blocked on:** adoption metric >0 (không thêm surface cho tool nobody calls).
- **Effort:** 2-3 ngày. **Risk:** medium-high (new host-side execution path với cell's abort signal).

#### G. Version drift fix

- devDeps pin `^0.83.0`, installed pi `0.84.1`. Extension runs against newer API than tested.
- Bump devDeps → `^0.84.0`, test chống 0.84.x API.
- **Effort:** 0.5 ngày. **Risk:** low.

#### H. Stack trace source map (§2.4)

- Bật esbuild `sourcemap: 'inline'` trong `transform.ts`, remap line/column trong error stack.
- **Effort:** 0.5 ngày. **Risk:** low.

### 5.3 LOW VALUE — maintenance

#### I. team-runner.ts split (J4)

- 2660 dòng, last god file. Roadmap R1-1 đã start (merge-gate extracted).
- Tiếp tục extract `dispatchUnit` closure theo `merge-gate.ts` precedent.
- **Effort:** 2-3 ngày phased. **Risk:** medium.

#### J. Event-type registry enforcement (J5)

- 72 unregistered types, `TeamEvent.type` vẫn là `string` thay vì union.
- Flip report → enforce, then type union.
- **Effort:** 1 ngày. **Risk:** high (type flip).

#### K. Test suite split (R1-3)

- `npm test` timeout 580s. Tách fast/slow tiers.
- **Effort:** 1 ngày. **Risk:** low.

---

## 6. Đánh giá tổng thể

### RLM technique có ổn không?

**Kỹ thuật: có, port chất lượng cao.**

- 16/22 pattern shipped đúng.
- 2 invariant quyết định (binding survive mid-cell failure, namespace revive across process) đều pass empirical probe.
- `sh()` nullish guard (I6) hoạt động.
- Crash-resume wiring (Phase 2) đúng: spawn-time scan → env hint → READ-time re-validation → fail-open.
- Atomic write (temp + rename), caps hai phía (4 MiB), O_NOFOLLOW, lstat checks, base64 round-trip check.
- Kill-and-restore (Phase 3) works via existing F3 quit-path.

**Thương mại: chưa chứng minh được, và có 1 bug.**

- 0 adoption trên 83+ runs.
- Design doc reject tool-collapse với một technical claim sai (`setActiveTools` có sẵn), nhưng root cause 0-adoption thật là `bash` được thêm vào `role-tools.ts` (xem §3.2).
- Doctrine cost tăng 342 tokens/turn mà không có cell nào được gọi.
- Global shadow poisoning là bug thật cần fix.
- Retries essentially never fire → crash-resume (giá trị chính) chưa được test trên retry thật.

**Điểm leverage chưa khai thác lớn nhất:** cross-agent namespace passing. RLM "compounds, not repeats" chỉ hoạt động trong 1 worker. Giữa agents, pi-crew vẫn re-serialize text, mất cấu trúc. Đây là nơi RLM có thể tạo differentiator thật nhưng chưa được thiết kế.

---

## 7. Bước tiếp đề xuất

Theo ưu tiên (value × feasibility):

| # | Hành động | Effort | Gate |
|---|---|---|---|
| 1 | **Fix global shadow poisoning** (§2.3) | 0.5 ngày | — |
| 2 | **Shape-based arming** (§5.1C) | 0.5 ngày | — |
| 3 | **Tool-surface narrowing** — demote bash (§5.1A) | 0.5 ngày (sửa `role-tools.ts`) | — |
| 4 | **Chạy shape-diverse tasks** — kích hoạt decision gate §5 với tasks multi-step thật | — | Cần task qualify |
| 5 | **Đọc adoption metric** — ≥1 cell / ~5 runs? | — | Sau bước 3-4 |
| 6 | Nếu adoption >0 → **Cross-agent namespace passing** (§5.1B) | 3-5 ngày | Adoption >0 |
| 7 | Nếu adoption >0 → **Minimal host bridge** (§5.2F) | 2-3 ngày | Adoption >0 |
| 8 | **HMAC wire hoặc delete** (§5.2E) | 1 ngày | — |
| 9 | **Version drift fix** (§5.2G) | 0.5 ngày | — |
| 10 | **Stack trace source map** (§5.2H) | 0.5 ngày | — |

**Nếu sau bước 3-4 mà adoption vẫn ~0 AND task-shape precondition met:** remove feature, record ADR (negative result về well-executed port là worth keeping).

---

## 8. Phụ lục

### 8.1 Probe script

File: `/tmp/rlm-probe/probe.ts` — 24 case test EngineManager thật.
File: `/tmp/rlm-probe/probe2.ts` — doctrine worked example + global shadow poisoning + wedge detection.

### 8.2 Source files đã đọc

| File | Dòng | Vai trò |
|---|---|---|
| `src/runtime/scratchpad/engine.ts` | 648 | EngineManager host |
| `src/runtime/scratchpad/guest.ts` | 409 | Namespace proxy, sh(), v8.serialize |
| `src/runtime/scratchpad/transform.ts` | 363 | esbuild + acorn transform |
| `src/runtime/scratchpad/protocol.ts` | 88 | fd3 + nonce |
| `src/runtime/scratchpad/snapshot-hmac.ts` | 167 | DEAD CODE |
| `src/runtime/scratchpad/snapshot-lookup.ts` | 74 | mtime-based lookup |
| `src/runtime/scratchpad/README.md` | — | Phase 1-3 design |
| `src/prompt/scratchpad-lifecycle.ts` | 680 | Tool registration, execute handler, snapshot flush |
| `src/config/role-tools.ts` | — | Scratchpad opt-in per role |
| `src/runtime/child-pi/child-pi-spawn.ts` | — | Scratchpad env wiring |
| `src/runtime/handoff-manager.ts` | — | Inter-agent handoff |
| `src/runtime/task-output-context.ts` | — | Dependency output context |

### 8.3 Docs đã đọc

- `docs/improvement-plan-2026-08-11.md` (37 851 dòng) — RLM/scratchpad adoption batch (I1-I7, J1-J6, decision gate)
- `docs/ROADMAP-2026-Q3.md` — Q3 roadmap (4 phases)
- `docs/improvement-plan-2026-08-09.md` — maintainability inventory
- `docs/improvement-plan-2026-08-10.md` — G1-G13, H1-H9 batch
- `rlm-apply-pi-crew.md` — 22-pattern matrix + FLAGSHIP design
- `pi-rlm-report.md` — pi-rlm v0.2.0 deep-dive report
- `rlm-patterns/` — 22 pattern docs

### 8.4 Validation đã chạy

| Gate | Kết quả |
|---|---|
| `npm run typecheck` | ✅ pass (tsc --noEmit + strip-types import) |
| Probe engine 24/24 case | ✅ 24 pass, 0 fail |
| Probe global shadow poisoning | ❌ BUG — process/Buffer shadowed sau restore |
| Probe wedge detection | ✅ abort 1705ms, ping null sau wedge |
| `find .crew -path '*scratchpad*'` | 0 artifacts |
| `grep scratchpad.cell events.jsonl` | 0 events |
| `grep '"toolName":"scratchpad"' transcripts` | 0 calls |
| `pi --version` | 0.84.1 |
| `grep setActiveTools pi examples` | ✅ tồn tại |
| `grep setActiveTools src/extension/pi-api.ts` | ❌ không liệt kê (nhưng đã accessible qua re-export `ExtensionAPI` — không cần thêm) |

### 8.5 Test file inventory (scratchpad)

| File | Trong `test:unit` glob? |
|---|---|
| `test/unit/scratchpad-lifecycle.test.ts` | ✅ |
| `test/unit/scratchpad-artifact.test.ts` | ✅ |
| `test/unit/scratchpad-restore-lifecycle.test.ts` | ✅ |
| `test/unit/scratchpad-restore-lookup.test.ts` | ✅ |
| `test/unit/scratchpad-shutdown.test.ts` | ✅ |
| `test/unit/scratchpad-tool-gating.test.ts` | ✅ |
| `test/unit/scratchpad-perf-metric.test.ts` | ✅ |
| `test/unit/runtime/scratchpad/protocol.test.ts` | ✅ |
| `test/unit/runtime/scratchpad/transform.test.ts` | ✅ |
| `test/unit/runtime/scratchpad/guest-sh.test.ts` | ✅ |
| `test/unit/runtime/scratchpad/snapshot-hmac.test.ts` | ✅ |
| `test/unit/role-tools-scratchpad.test.ts` | ✅ |
| `test/unit/agents/agent-config-scratchpad.test.ts` | ✅ |
| `test/unit/runtime/child-pi/scratchpad-env-wiring.test.ts` | ✅ |
| `test/integration/scratchpad-resume.test.ts` | ❌ (integration) |
| `test/integration/scratchpad-worker.test.ts` | ❌ (integration) |
| `test/runtime/scratchpad/engine.spike.test.ts` | ❌ (spike, không trong glob) |
| `test/runtime/scratchpad/guest-zombie.test.ts` | ❌ (spike) |
| `test/runtime/scratchpad/restore-e2e.spike.test.ts` | ❌ (spike) |
| `test/runtime/scratchpad/sigterm-kill-restore.spike.test.ts` | ❌ (spike, gated `PI_CREW_TEST_REAL_MODEL=1`) |

**14/20** scratchpad test files chạy trong `npm run test:unit`. 4 spike tests chạy riêng per README runbook. 2 integration tests chạy trong `npm run test:integration`.

### 8.6 Verification độc lập (4 agent song song — cùng ngày)

Báo cáo gốc được verify lại bằng 4 agent đọc source + reproduce bug thật trên EngineManager + chạy lại mọi metric command.

| Cluster | Verdict | Ghi chú |
|---|---|---|
| §2.1–2.2 Kiến trúc & probe | ✅ chính xác (1 minor) | 8/8 file line counts **exact match**; port claims, export-forbidden, sh() helper đều CONFIRMED. Chỉ số dòng tổng `~2321` sai (thực 2451 — mâu thuẫn nội bộ, đã sửa) |
| §2.3 Global shadow poisoning | ✅ **CONFIRMED, reproduced** | 2 probe spawn EngineManager thật: `const process='poisoned'` → `typeof process.env='undefined'` cả trong-session lẫn sau restore. **Nhưng** framing pi-rlm sai (đã sửa) |
| §3.2 setActiveTools (luận điểm trung tâm) | ⚠️ **PARTIALLY TRUE** | Technical sub-claim của design doc đúng là sai; nhưng conclusion/actionable của báo cáo gốc cũng sai cơ chế (đã sửa §3.2 + §5.1A). Fix đúng = sửa `role-tools.ts` |
| §3.1 + dead code + drift + sourcemap | ✅ **19/19 CONFIRMED** | 83 runs / 15 team / 0 artifacts / 0 events / 0 tool calls; HMAC 0 prod call site; host_request 0 handler; devDep `^0.83.0` vs `0.84.1`; sourcemap absent |

**Tổng:** báo cáo chất lượng cao, bug-finding và metrics chính xác. 3 nhóm sai sót đã được sửa inline: số dòng (§2.1), framing pi-rlm + in-session poisoning (§2.3), và mechanism setActiveTools/role-tools (§3.2 + §5.1A). Các recommendation được giữ nhưng §5.1A/#3 được reframe sang cơ chế đúng (sửa `role-tools.ts`, effort giảm 1-2 ngày → 0.5 ngày).

---

*Hết báo cáo.*
