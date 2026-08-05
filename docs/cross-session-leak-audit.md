# pi-crew Cross-Session Information Leak Audit

> **Ngày:** 2026-08-05
> **Phiên bản pi:** 0.83.0 (`@earendil-works/pi-coding-agent`)
> **Triệu chứng:** Chạy 2 pi session song song trên cùng 1 project → thông tin subagent/run của session A bị rò rỉ sang session B.

> ⚠️ **Trạng thái xác minh (re-check độc lập, 2026-08-05):** 5 verifier agent đã cold-check toàn bộ 2 lỗi gốc + 13 vector đối chiếu source thật (pi 0.83.0 runtime, đọc `ExtensionRunner.createContext()` tại `dist/core/extensions/runner.js:456-541`).
> - **Lỗi gốc #1, #2: CONFIRMED.**
> - **12/13 vector CONFIRMED.** **Vector #3 REFUTED** — filter hỏng *ngược chiều* (over-filtered, không leak); xem §5.
> - **Mitigation audit understate (đã bổ sung):** `isInProjectScope` giới hạn #1/#2 ở **cùng-repo** (không global cross-project); `hasRecentLifeEvidence` check **cả** `updatedAt` **OR** `heartbeat.json`; #7 chỉ notify, user phải **accept manual**.
> - **Citation drift đã sửa:** vài đường dẫn file (`registration/` không tồn tại; `socket-path.ts` ở `src/utils/`) + line numbers (xem chi tiết từng vector).
> - **Severity re-rank:** #6 (purge, global+auto) và #5 (reconcile, auto 60s) là **CRITICAL**; #4 (subagent, zero ownership check) là **HIGH**.
>
> Chi tiết từng đính chính nằm trong note **"⚠️ Re-verify"** ngay tại vector tương ứng.

---

## Mục Lục

1. [Tóm tắt nguyên nhân](#1-tóm-tắt-nguyên-nhân)
2. [Lỗi gốc #1 — `extractSessionId()` hỏng](#2-lỗi-gốc-1--extractsessionid-hỏng-trên-pi-0830)
3. [Lỗi gốc #2 — State dùng chung không session scope](#3-lỗi-gốc-2--state-dùng-chung-không-session-scope)
4. [Bảng tổng hợp 13 vector (12 leak + 1 REFUTED)](#4-bảng-tổng-hợp-13-vector-leak)
5. [Chi tiết từng vector](#5-chi-tiết-từng-vector)
6. [Các bề mặt đã đúng (không phải leak)](#6-các-bề-mặt-đã-đúng-không-phải-leak)
7. [Đề xuất fix](#7-đề-xuất-fix)
8. [Phụ lục: Inventory state files](#8-phụ-lục-inventory-state-files)

---

## 1. Tóm tắt nguyên nhân

Có **2 lỗi gốc** kết hợp gây ra leak:

| Lỗi gốc | Mô tả | Số vector affected |
|---------|-------|--------------------|
| **#1** | `extractSessionId(ctx)` đọc `ctx.sessionId` (own property) — không tồn tại trên pi 0.83.0 | 2 vector trực tiếp (#1, #2); #3 dùng accessor khác (cast trực tiếp) |
| **#2** | State files per-project/global không có session component trong path/key | 10 vector |

**Luồng leak điển hình:**

```
Session A spawn subagent → ghi .crew/state/subagents/{id}.json (per-project, không session)
                         → ghi .crew/state/runs/{runId}/manifest.json (ownerSessionId = A)
                         → ghi ~/.pi/.../active-run-index.json (global, không filter)

Session B context event (mỗi LLM call)
  → extractSessionId(ctx) = undefined  ← LỖI GỐC #1
  → collectInFlightRuns(cwd, undefined) = TẤT CẢ in-flight runs cùng project (không filter session; còn filter isInProjectScope cùng-repo — xem §5/#1)
  → ambient status inject run IDs + goals của session A vào context của B  ← LEAK
```

---

## 2. Lỗi gốc #1 — `extractSessionId()` hỏng trên pi 0.83.0

### Vấn đề

```ts
// src/utils/session-utils.ts:67-80
export function extractSessionId(ctx: unknown): string | undefined {
    if (typeof ctx !== "object" || ctx === null) return undefined;
    let raw: unknown;
    try {
        raw = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
        //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
        //         pi 0.83.0 ExtensionContext KHÔNG có property "sessionId"
        //         → raw = undefined → return undefined
    } catch {
        return undefined;
    }
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    return raw;
}
```

### Pi 0.83.0 ExtensionContext — không có `sessionId`

Đã xác nhận bằng cách đọc type declarations:

```
// node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:209-249
export interface ExtensionContext {
    ui: ExtensionUIContext;
    mode: ExtensionMode;
    hasUI: boolean;
    cwd: string;
    sessionManager: ReadonlySessionManager;  // ← chỉ có getter, không có field sessionId
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    scopedModels: readonly ScopedModel[];
    thinkingLevel?: ThinkingLevel;
    isIdle(): boolean;
    isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
    // KHÔNG có sessionId: string
}
```

Session ID chỉ truy cập được qua `ctx.sessionManager.getSessionId()`.

### 3 accessor session ID — chỉ 1 hỏng

| Accessor | File:line | Cách lấy | pi 0.83.0 | Dùng ở đâu |
|----------|-----------|----------|-----------|------------|
| `extractSessionId(ctx)` | `utils/session-utils.ts:67` | `Object.getOwnPropertyDescriptor(ctx, "sessionId")` | **`undefined`** ❌ | ambient status, compaction-guard, health filter |
| `extractBrokerSessionId(ctx)` | `utils/session-utils.ts:98` | `ctx.sessionManager?.getSessionId()` → fallback descriptor | **đúng** ✅ | broker, orphan cleanup |
| `withSessionId(ctx)` | `extension/team-tool/context.ts:25` | `ctx.sessionManager?.getSessionId()` | **đúng** ✅ | team-tool, subagent-tools, commands |

### Tại sao `extractSessionId` tách riêng và dùng descriptor?

Comment trong file giải thích:

```ts
// utils/session-utils.ts:86-96
// Broker-only session id extractor.
// ... It is INTENTIONALLY a separate function from `extractSessionId`,
// which is called on every `context` event (before every LLM call) from
// `context-status-injection.ts` — extending that hot path with method calls
// was observed to freeze the TUI (dashboard opens but is unresponsive,
// footer does not render) during smoke testing, so it stays on the trivial
// property lookup.
```

→ Tác giả cố tình tránh gọi `sessionManager.getSessionId()` trên hot path vì từng freeze TUI. Nhưng trên pi 0.83.0, property lookup không hoạt động → filter không bao giờ fire.

### Hậu quả downstream

Khi `extractSessionId` trả về `undefined`:

```ts
// compaction-guard.ts:121-127
export function collectInFlightRuns(cwd: string, currentSessionId?: string): TeamRunManifest[] {
    return listRecentRuns(cwd, MAX_ARTIFACT_INDEX_RUNS).filter((run) => {
        if (!IN_FLIGHT_RUN_STATUSES.has(run.status)) return false;
        if (!isInProjectScope(run, cwd)) return false;
        if (currentSessionId === undefined) return true; // ← BACK-COMPAT: trả ALL runs
        return run.ownerSessionId === currentSessionId;  // ← strict: không bao giờ đến đây
    });
}
```

`isInProjectScope` chỉ filter theo repo root — 2 session cùng project → pass → trả tất cả runs.

---

## 3. Lỗi gốc #2 — State dùng chung không session scope

### Inventory state files

| Đường dẫn | Scope | Session key? | Ghi chú |
|-----------|-------|-------------|---------|
| `.crew/state/runs/{runId}/` | per-project | Không (documented shared) | Manifest có `ownerSessionId` nhưng filter hỏng |
| `.crew/state/subagents/{id}.json` | per-project | **Không** | ID collision-prone |
| `.crew/state/notifications/{date}.jsonl` | per-project | Không | Write-only audit sink |
| `~/.pi/.../state/runs/active-run-index.json` | **machine-global** | Không | Merged vào mọi listing |
| `~/.pi/.../state/runs/active-run-index.bin` | machine-global | Không | Binary mirror |
| `~/.pi/.../state/orphan-workers.json` | machine-global | Có (sessionId field) | Đúng |
| Broker socket `pi-crew-<sha256(sessionId)[0:8]>.sock` | **per-session** | Có | Đúng |

### Subagent record ID collision

```ts
// runtime/subagent-manager.ts:241
id: `agent_${Date.now().toString(36)}_${(++this.counter).toString(36)}`,
```

`counter` là per-instance field, reset về 0 mỗi process. Hai session spawn subagent trong cùng millisecond → cùng ID → ghi đè file.

### Global active-run registry merged vào mọi listing

```ts
// extension/run-index.ts:92-96
function collectActiveRuns(cwd?: string): TeamRunManifest[] {
    // cwd parameter được nhận nhưng KHÔNG BAO GIỜ dùng
    return activeRunEntries()
        .map((entry) => readManifest(entry.manifestPath))
        .filter((manifest): manifest is TeamRunManifest => manifest !== undefined);
}

// :104-107
export function listRecentRuns(cwd: string, max = 20, signal?: AbortSignal): TeamRunManifest[] {
    const roots = scopedRunRoots(cwd);
    return mergeRuns([...roots.map((root) => collectRuns(root, max, signal)), collectActiveRuns()], max);
    //                                                                       ^^^^^^^^^^^^^^^^^^
    //                                                                       Global, không filter
}
```

`activeRunEntries()` đọc `~/.pi/.../state/runs/active-run-index.json` — machine-global, không có cwd/session predicate.

Tương tự `manifest-cache.ts`:

```ts
// manifest-cache.ts:129-135
function listRunRoots(cwd: string): string[] {
    const roots = new Set<string>();
    roots.add(path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir));  // ← user-global
    const projectRoot = findRepoRoot(cwd);
    if (projectRoot) roots.add(path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir));
    return [...roots];
}

// manifest-cache.ts:238-245
const parsedEntries = [
    ...roots.flatMap((root) => collectRoots(root)),
    ...activeRunEntries().map((entry) => ({ runId: entry.runId, path: entry.manifestPath })),
    //  ^^^^^^^^^^^^^^^^^^ global, không filter
];
```

---

## 4. Bảng tổng hợp 13 vector (12 leak + 1 REFUTED)

| # | Điểm leak | File:line | Scope key | Hậu quả |
|---|-----------|-----------|-----------|---------|
| 1 | Ambient status injection | `context-status-injection.ts:182` | `extractSessionId` → undefined | Mỗi LLM call: session B nhận run IDs + goals của A trong context |
| 2 | Compaction resume directive | `compaction-guard.ts:233,258,285` | `extractSessionId` → undefined | Compaction B inject resume directive cho runs của A; triggerContinuation bảo B tiếp tục work của A |
| 3 ⚠️ **REFUTED** | Health notification filter | `lifecycle-handlers.ts:613` | cast `sessionId` (broken) | **Không phải leak.** Filter hỏng *ngược*: owned runs bị DROP (notifications không fire); chỉ ownerless lọt. Bug LOW, hướng khác audit. |
| 4 | Subagent persisted records | `subagent-manager.ts:74` + `subagent-tools.ts:274` | cwd only, no session | `get_subagent_result` đọc output của A; ID collision ghi đè; `resultConsumed=true` triệt tiêu notification của A |
| 5 | `reconcileAllStaleRuns` | `crash-recovery.ts:608` | NONE | Session B mark run của A là failed → terminate live agents |
| 6 | `purgeStaleActiveRunIndex` | `crash-recovery.ts:400` | NONE (global registry) | Session B shutdown cancel runs của A (updatedAt >5min) |
| 7 | `detectInterruptedRuns` | `crash-recovery.ts:107` | NONE | Session B prompt recovery → user reset tasks của A về queued |
| 8 | Dashboard refreshRuns | `run-dashboard.ts:517` | Filter discard sau frame 1 | Dashboard hiển thị mọi run; mở transcript/output của session khác |
| 9 | Widget component render | `widget/index.ts:273` + `widget-model.ts` | workspaceId không truyền vào component | Widget repaint không filter; fallback lấy ownerSessionId của run đầu tiên |
| 10 | Powerbar/footer | `powerbar-publisher.ts:230` | NONE | Footer gộp counts, tokens, model name của cả 2 session |
| 11 | Async notifier + session summary | `async-notifier.ts:136,154` + `session-summary.ts:6-20` | NONE | Toast notification + session-start summary liệt kê runs của session khác |
| 12 | DeliveryCoordinator.activate | `delivery-coordinator.ts:36` | sessionId bị discard | Queued results flush vào session mới (in-process session switch) |
| 13 | `isOwnerSessionCurrent` | `subagent-manager-setup.ts:73` | Process-local integer counter | 2 process có cùng generation → không cách ly cross-process |

---

## 5. Chi tiết từng vector

### Vector #1 — Ambient status injection (MỖI LLM CALL)

**File:** `src/extension/context-status-injection.ts:170-184`

```ts
export function registerContextStatusInjection(pi: ExtensionAPI, opts: { enabled?: boolean } = {}): void {
    if (opts.enabled === false) return;
    pi.on("context", (event: ContextEvent, ctx: unknown): AmbientContextResult | undefined => {
        const cwd = /* ... */;
        const sessionId = extractSessionId(ctx);  // ← UNDEFINED trên pi 0.83.0
        return handleContextEvent(event, cwd, sessionId);
    });
}
```

**Luồng:**

```
Pi fire "context" event (trước mỗi LLM call)
  → extractSessionId(ctx) = undefined
  → handleContextEvent(event, cwd, undefined)
  → collectInFlightRuns(cwd, undefined) = TẤT CẢ in-flight runs cùng project
  → formatAmbientStatus(runs) = "[pi-crew ambient status] 2 runs in flight: ..."
  → insert vào messages trước last message
  → LLM của session B thấy run IDs + goals của session A
```

**Tần suất:** Mỗi LLM call — đây là leak thường xuyên nhất, xảy ra liên tục.

**Hậu quả cụ thể:** LLM của session B có thể tự ý gọi `team status` hoặc `team wait` trên run của session A, hoặc nhầm run của A là của mình.

**⚠️ Re-verify — mitigation bị understate:** `collectInFlightRuns` còn filter qua `isInProjectScope(run, cwd)` (`compaction-guard.ts:93-113`) so sánh `findRepoRoot(run.cwd) === findRepoRoot(queryCwd)`. Vậy leak #1 bị giới hạn ở **cùng repo**, KHÔNG global cross-project. Code comment (:99-113) ghi rõ đây là defense khi session-id filter không fire. Severity: **MEDIUM** (cùng-repo), không HIGH.

---

### Vector #2 — Compaction resume directive

**File:** `src/extension/registration/compaction-guard.ts:233-291`

```ts
// startCompact (proactive)
const sessionId = extractSessionId(ctx);  // ← undefined
const customInstructions = buildCompactionInstructions(ctx.cwd, sessionId);
const inFlight = collectInFlightRuns(ctx.cwd, sessionId);  // ← ALL runs
if (inFlight.length > 0) {
    pi.appendEntry("crew:resume-directive", {
        reason,
        runs: inFlight.map((r) => ({ runId: r.runId, status: r.status, team: r.team, ... })),
    });
}
// onComplete:
const runs = collectInFlightRuns(ctx.cwd, extractSessionId(ctx));  // ← ALL runs
triggerContinuation(pi, ctx, runs);
```

`triggerContinuation` gửi `sendUserMessage`:

```ts
// compaction-guard.ts:248-262
export function buildContinuationPrompt(runs: TeamRunManifest[]): string {
    const lines = ["[pi-crew] Context was compacted while crew tasks were still in-flight. Continue the work — do not wait for me."];
    for (const run of runs) {
        lines.push(`- runId=${run.runId} (status=${run.status}, team=${run.team}): ${run.goal}`);
    }
    // ...
}
```

**Hậu quả:** Session B sau compaction nhận directive tiếp tục work của session A. Agent của B sẽ gọi `team status` / `team wait` trên run của A, hoặc restart work đã hoàn thành.

**⚠️ Re-verify — severity & mitigation:** Cùng mitigation `isInProjectScope` (cùng-repo) như #1. Nhưng #2 **nặng hơn #1** vì `triggerContinuation` chủ động `sendUserMessage` → drive một agent turn với directive "continue the work" liệt kê goal của run khác (không chỉ inject context thụ động). Severity: **HIGH** (cùng-repo, chủ động trigger turn).

---

### Vector #3 — Health notification filter

**File:** `src/extension/registration/lifecycle-handlers.ts:613-618`

```ts
const currentSessionId = ctx.currentCtx
    ? (ctx.currentCtx as { sessionId?: string }).sessionId  // ← BROKEN: undefined
    : undefined;
const sessionManifests = manifests.filter(
    (run) =>
        !run.ownerSessionId ||                                          // :616 ← ownerless: pass
        run.ownerSessionId === currentSessionId ||                       // :617 ← string === undefined: false
        (run as unknown as Record<string, unknown>).ownerSessionGeneration === currentSessionGen,  // :618 ← field không tồn tại
);
```

Phân tích từng clause:
- `!run.ownerSessionId` → `true` cho runs không có owner (legacy) → **pass**
- `run.ownerSessionId === currentSessionId` → `"uuid-A" === undefined` → **false**
- `run.ownerSessionGeneration === currentSessionGen` → `ownerSessionGeneration` **không phải field trên `TeamRunManifest`** (chỉ có ở `SubagentRecord`) → **undefined === number** → **false**

**⚠️ Re-verify — REFUTED:** Kết luận ban đầu "filter pass ALL runs" là **SAI**. Xem lại: với run **CÓ `ownerSessionId`** (case bình thường), cả 3 clause đều `false` → run bị **DROP** khỏi `sessionManifests` — kể cả run của chính session hiện tại. Filter hỏng theo chiều **quá hạn chế** (over-filtered), KHÔNG phải under-filtered.

Net thực tế:
- Run **ownerless** (legacy) → clause 1 pass → **đi tiếp** (leak rất hẹp, chỉ edge case).
- Run **có ownerSessionId** (A hoặc B) → cả 3 clause false → **bị DROP** → health notification **không bao giờ fire** cho owned runs.

**Hậu quả (sửa):** Đây **KHÔNG phải leak cross-session**. Feature health-notification bị **vô hiệu hóa** cho owned runs (warnings không fire). Chỉ ownerless runs mới lọt qua — leak rất hẹp. Bug thật nhưng hướng khác hẳn mô tả ban đầu; severity **LOW**.

**Fix đúng hướng:** (a) bỏ clause 3 dead-code (`ownerSessionGeneration` không tồn tại trên manifest), (b) clause 2 đổi sang accessor đúng `ctx.sessionManager?.getSessionId()` thay vì cast `sessionId`. Kết quả: filter từ "drop all owned" → "pass only own session".

---

### Vector #4 — Subagent persisted records (SUBAGENT-SPECIFIC LEAK)

**File:** `src/runtime/subagent-manager.ts:72-74`

```ts
function persistedSubagentPath(cwd: string, id: string): string {
    return path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir, `${id}.json`);
    //         ^^^^^^^^^^^^^^^^^^^^  per-project, KHÔNG có session component
}
```

**Đọc không ownership check:**

```ts
// subagent-tools.ts:274-280 (get_subagent_result tool)
const inMemory = subagentManager.getRecord(p.agent_id);
const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
//                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                Đọc file của session A từ disk, không check ownership
```

**ID collision:**

```ts
// subagent-manager.ts:241
id: `agent_${Date.now().toString(36)}_${(++this.counter).toString(36)}`,
//     ^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//     Per-millisecond             Per-process counter (reset mỗi process)
```

Hai session spawn trong cùng ms → cùng `agent_<base36-ms>_1` → ghi đè file.

**resultConsumed suppression:**

```ts
// subagent-tools.ts:326-327
if (current.status !== "running" && current.status !== "queued" && current.status !== "blocked") {
    current.resultConsumed = true;
    savePersistedSubagentRecord(ctx.cwd, current);  // ← Ghi resultConsumed=true lên file chung
}
```

```ts
// subagent-manager-setup.ts:71-73 (completion coalescer)
const p = readPersistedSubagentRecord(ctx.currentCtx.cwd, agentId);
if (p?.resultConsumed) return false;  // ← Session B đọc resultConsumed=true → triệt tiêu notification của A
```

**Hậu quả cụ thể:**
1. Session B gọi `get_subagent_result(agent_id="<A's agent>")` → đọc output của A
2. Session B ghi `resultConsumed=true` → session A không nhận completion notification
3. ID collision → session B's write clobbers session A's record → A mất record

---

### Vector #5 — `reconcileAllStaleRuns` (SESSION B KILLS SESSION A'S WORK)

**File:** `src/runtime/recovery/crash-recovery.ts:608-660`

```ts
export function reconcileAllStaleRuns(cwd: string, manifestCache: ManifestCache, now = Date.now()): ReconcileResult[] {
    const runIds = manifestCache
        .list(50)
        .filter((m) => m.status === "running" || m.status === "blocked")
        .map((m) => m.runId);
    //     ^^^^^^^^ KHÔNG filter theo ownerSessionId
```

Sau đó gọi `reconcileStaleRun` kiểm tra PID liveness + heartbeat staleness. Nếu async PID dead HOẶC heartbeat >5min stale → mark **failed** + `terminateLiveAgentsForRun`.

**Trigger paths:**
- `lifecycle-handlers.ts` — `runDeferredSessionCleanup` gọi khi session_start (session B start → quét A)
- `widget-model.ts:42-48` — `reconcileAllStaleRuns` gọi mỗi 60s từ widget render path

**Hậu quả:** Session B khởi động → `setTimeout(0)` → `reconcileAllStaleRuns` → nếu run của A có foreground (no-PID) + LLM generation dài (>5min không heartbeat) → B mark failed + terminate live agents của A.

**Intended vs bug:** Intended cho crash recovery của session chết. **Bug** khi 2 session sống song song — không phân biệt được "A đang chạy" vs "A crash để lại stale state".

---

### Vector #6 — `purgeStaleActiveRunIndex` (GLOBAL, NO FILTER)

**File:** `src/runtime/recovery/crash-recovery.ts:400-570`

Quét `~/.pi/.../state/runs/active-run-index.json` — **machine-global**, không có session filter.

**Path A (line 486-502):** run "running" + async PID dead + no recent life evidence → cancel:

```ts
if (manifest?.status === "running" && manifest.async?.pid !== undefined) {
    const pidAlive = checkProcessLiveness(manifest.async.pid).alive;
    if (!pidAlive && !hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
        // cancel all running tasks, terminate live agents
```

**Path B (line 548-572):** run "running" + NO async PID + no recent life evidence → cancel:

```ts
if (manifest?.status === "running" && manifest.async === undefined) {
    if (!hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
```

`hasRecentLifeEvidence` (line 381-394, re-verify) check `manifest.updatedAt` **OR** `heartbeat.json` mtime — trả `true` nếu **một trong hai** fresh (defense-in-depth, Bug X fix). Foreground runs chỉ bị cancel khi **cả hai** signal đều stale >5min. LLM generation dài vô heartbeat mới dính. *(Audit gốc nói "updatedAt stale → cancel" — thiếu OR logic; đã sửa.)*

**Trigger paths:**
- `lifecycle-handlers.ts:324` — `runDeferredSessionCleanup` (session B start)
- `runtime-cleanup.ts:86,158` — `cleanupRuntime` / `cleanupSessionResourcesOnly` (session B shutdown)

**Hậu quả:** Session B shutdown → purge global registry → cancel run foreground của A nếu `updatedAt` >5min stale.

---

### Vector #7 — `detectInterruptedRuns` (NO FILTER)

**File:** `src/runtime/recovery/crash-recovery.ts:107-127`

```ts
export function detectInterruptedRuns(cwd: string, manifestCache: ManifestCache, deadMs = 300_000): RecoveryPlan[] {
    for (const manifest of manifestCache.list(50)) {
        if (manifest.status !== "running" && manifest.status !== "blocked") continue;
        if (isPlanApprovalPending(manifest)) continue;
        if (manifest.async?.pid !== undefined && checkProcessLiveness(manifest.async.pid).alive) continue;
        // KHÔNG có ownerSessionId filter
```

Gọi từ `observability.ts:271-289` khi `session_start` + `autoRecover === true`. ⚠️ **Re-verify:** caller **chỉ notify operator** (`deps.notifyOperator(...)`), **KHÔNG tự gọi `applyRecoveryPlan`**. `applyRecoveryPlan` chỉ chạy nếu user **manual accept** recovery từ dashboard.

**Hậu quả (sửa):** Session B start → notify "interrupted run" của A. Interference thật (reset tasks A về queued) **chỉ xảy ra nếu user B accept** recovery prompt — không tự động. Severity giảm **HIGH → MEDIUM** (cần thao tác người dùng).

---

### Vector #8 — Dashboard filter discarded after frame 1

**File:** `src/ui/run-dashboard.ts:428-433` (constructor — filter đúng)

```ts
const filteredRuns = options.workspaceId
    ? runs.filter((run) => !run.ownerSessionId || run.ownerSessionId === options.workspaceId)
    : runs;
this.runs = filteredRuns;
```

**File:** `src/ui/run-dashboard.ts:517-521` (refreshRuns — filter BỊ DROP)

```ts
private refreshRuns(): void {
    if (!this.options.runProvider) return;
    const selectedRunId = this.selectedRunId();
    const next = this.options.runProvider();  // ← manifestCache.list(50) — global
    this.runs = Array.isArray(next) ? next : this.runs;
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //          KHÔNG áp dụng workspaceId filter
```

`refreshRuns()` gọi ở đầu mỗi `render()` (line 616).

**Hậu quả:** Dashboard hiển thị mọi run của mọi session từ frame đầu tiên. Select run của A → press Enter/`e`/`o`/`t` → mở transcript/events/output của A.

---

### Vector #9 — Widget component render without workspaceId

**File:** `src/ui/widget/index.ts:344-351` (updateCrewWidget — filter đúng, 1 lần)

```ts
let workspaceId = ctx.sessionManager?.getSessionId?.();  // ← correct accessor
if (!workspaceId && manifestCache) {
    const runs = manifestCache.list(20);
    const active = runs.find((r) => r.status === "running" || r.status === "queued");
    if (active?.ownerSessionId) workspaceId = active.ownerSessionId;
    //  ^^^^^^^^^^^^^^^^^^^^^^^^  FALLBACK: adopt ownerSessionId của run đầu tiên
    //                            → có thể là session A's ID → widget B hiển thị runs của A
}
const runs = activeWidgetRuns(ctx.cwd, manifestCache, snapshotCache, preloadedManifests, workspaceId);
```

**File:** `src/ui/widget/index.ts:273` (CrewWidgetComponent.render — KHÔNG truyền workspaceId)

```ts
const runs = activeWidgetRuns(this.model.cwd, this.model.manifestCache, this.model.snapshotCache, this.model.preloadManifests);
//          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//          Missing 5th arg: workspaceId = undefined → no filter
```

`CrewWidgetModel` (`widget-types.ts:16-24`) không có field `workspaceId`.

**Hậu quả:** Widget repaint trên mỗi tick không filter → hiển thị runs của cả 2 session. Fallback adopt ownerSessionId của run đầu tiên tìm thấy → có thể hiển thị runs của session khác và ẩn runs của chính mình.

---

### Vector #10 — Powerbar/footer (NO SESSION SCOPING)

**File:** `src/ui/powerbar-publisher.ts:230`

```ts
const runs = preloadedManifests ?? (manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20));
//          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//          Không có workspaceId parameter trên toàn bộ function signature
```

```ts
// powerbar-publisher.ts:303
const liveRunning = listLiveAgents().filter((a) => a.status === "running").length;
//                   ^^^^^^^^^^^^^^^^ global in-process registry
```

`updatePiCrewPowerbar` (`:91-101`), `PowerbarUpdateArgs` (`:185-194`), `requestPowerbarUpdate` (`:434-445`) — **không có workspaceId parameter**.

**Hậu quả:** Footer/powerbar gộp run counts, queued counts, token totals, model name, "(N live)" của cả 2 session.

---

### Vector #11 — Async notifier + session summary

**File:** `src/extension/async-notifier.ts:128,136,154`  *(re-verify: KHÔNG có subdir `registration/`; nằm ở `src/extension/` trực tiếp)*

```ts
// :128 (seed), :136 (interval, debounced): cachedRuns = listRuns(ctx.cwd).slice(0, 20);  — merge global active-run registry
// :154 — ctx.ui.notify(`pi-crew run ${current.status}: ${current.runId} (${current.team}/${current.workflow ?? "none"})`, level)
```

Suppression duy nhất: `state.seenFinishedRunIds` (`AsyncNotifierState`, :11-16) — per-process in-memory Set, không persist. Session B toast completion notification cho run của A, và cả 2 session toast cùng run.

**File:** `src/extension/session-summary.ts:6-20`  *(re-verify: nằm ở `src/extension/` trực tiếp, không `registration/`)*

```ts
export function notifyActiveRuns(ctx: ExtensionContext): void {
    const active = listRuns(ctx.cwd)               // re-verify: listRuns (KHÔNG phải listRecentRuns)
        .filter((run) => { /* status running/queued/planning + isDisplayActiveRun */ })
        .slice(0, 5);                              // KHÔNG có ownerSessionId filter
    if (active.length === 0) return;
    ctx.ui.notify(`pi-crew active runs: ${active.map((run) => `${run.runId} [${run.status}]`).join(", ")}`, "info");
}
```

**Hậu quả:** Session B start → toast liệt kê active runs của session A. *(Audit gốc ghi `listRecentRuns`/`registration/` — đã sửa theo source thật.)*

---

### Vector #12 — DeliveryCoordinator.activate(sessionId) discards argument

**File:** `src/runtime/delivery-coordinator.ts:36-39`

```ts
activate(sessionId: string): void {
    this.active = true;
    this.flushQueuedResults();
    // sessionId được nhận nhưng KHÔNG BAO GIỜ store
}
```

Pending queue (`pending: PendingDelivery[]`) keyed by `runId` only — không session ownership.

`deactivate()` (`:41-44`) chỉ bump `generation`. Generation check chỉ áp dụng cho `type === "steer"` (`:126-129`), không cho results/notifications.

**Cross-process:** Không leak (separate instances). **In-process session switch:** queued results/notifications survive → flush vào session mới.

---

### Vector #13 — `isOwnerSessionCurrent` process-local counter

**File:** `src/runtime/subagent-manager-setup.ts:73,234,260`

```ts
if (!ctx.isOwnerSessionCurrent(f?.ownerSessionGeneration ?? c.ownerGen)) return false;
```

`isOwnerSessionCurrent` (`context-builder.ts:89`):

```ts
isOwnerSessionCurrent: (gen) => !ctx.cleanedUp && (gen === undefined || gen === ctx.sessionGeneration),
//                                                                     ^^^^^^^^^^^^^^^^^^^^
//                                                                     Integer counter, per-process
```

`ctx.sessionGeneration` được increment trong `lifecycle-handlers.ts:99` (session_before_switch) và `:160` (session_start) — **integer local to extension instance**.

**Hậu quả:** 2 process đều start counter tại 0/1 → `ownerSessionGeneration` values không phân biệt được. Gate cung cấp **zero cross-process isolation**. Combined với Vector #4 (clobbered persisted record), `ownerSessionGeneration` của process khác có thể spuriously satisfy/fail gate → flip completion wake-up on/off.

---

## 6. Các bề mặt đã đúng (không phải leak)

| Bề mặt | File:line | Evidence |
|--------|-----------|----------|
| `withSessionId` | `team-tool/context.ts:25` | `ctx.sessionManager?.getSessionId?.()` — working |
| Widget `workspaceId` (initial) | `widget/index.ts:344` | `ctx.sessionManager?.getSessionId?.()` — working (nhưng bị drop sau frame 1, xem Vector #9) |
| Dashboard `workspaceId` (initial) | `commands.ts:400,417` | `cmdCtx.sessionManager?.getSessionId?.()` — working (nhưng bị drop sau frame 1, xem Vector #8) |
| Broker sessionId | `lifecycle-handlers.ts:173` | `extractBrokerSessionId` — working |
| Broker socket path | `utils/socket-path.ts` | `sha256(sessionId)[0:8]` — per-session, per-uid dir *(re-verify: file ở `src/utils/`, không phải `src/runtime/broker/`)* |
| `cancelOrphanedRuns` | `crash-recovery.ts:227` | `manifest.ownerSessionId` vs `currentSessionId` từ `extractBrokerSessionId` — working |
| Foreign-run detection (tool actions) | `cancel.ts:55`, `respond.ts:45`, `lifecycle-actions.ts:105,217,621`, `team-tool.ts:327` | `typeof ownerSessionId === "string" && ownerSessionId !== ctx.sessionId` — working (ctx.sessionId từ `withSessionId`) |
| Compaction guard filter logic | `compaction-guard.ts:127` | `return run.ownerSessionId === currentSessionId;` — strict, ownerless excluded (nhưng `currentSessionId` từ broken `extractSessionId`, xem Vector #2) |
| Orphan worker cleanup | `orphan-worker-registry.ts:309-320` | `isMine` check + parent-PID liveness — safe for concurrent sessions |
| `terminateActiveChildPiProcesses` | `child-pi-kill.ts:176` | Module-level Map, process-local — safe across processes |
| Broker token registry | `crew-broker-tokens.ts:38` | Heap-only, per-broker-instance |
| `crew-agent-records.ts` | `:13-15` | Run-scoped disk layout, path containment — not a leak source itself |
| `agents-pane.ts:84` | `options.workspaceId ? listLiveAgentsByWorkspace(options.workspaceId) : listLiveAgents()` | Honours passed id strictly |
| `run-dashboard.ts:431` (constructor) | `!run.ownerSessionId \|\| run.ownerSessionId === options.workspaceId` | Working (nhưng bị discard ở refreshRuns) |

---

## 7. Đề xuất fix

> **Severity re-rank (sau re-verify)** — thứ tự theo *mức độ nguy hiểm*, không phải thứ tự implement:
> - **CRITICAL (P0):** #6 `purgeStaleActiveRunIndex` (global + 3 trigger paths + auto cancel/terminate), #5 `reconcileAllStaleRuns` (auto mỗi 60s + session_start, mark FAILED).
> - **HIGH (P1):** #4 subagent records (zero ownership check + `SubagentRecord` thiếu `ownerSessionId`), #2 compaction resume (chủ động trigger turn).
> - **MEDIUM:** #1 ambient (cùng-repo), #8 dashboard (mở transcript cross-session), #7 detect (manual-accept nhưng mutate state A — reset tasks về queued).
> - **LOW–MED:** #9 widget, #10 powerbar, #11 notifier (display leak).
> - **LOW (cần điều kiện):** #12 delivery (in-process), #13 generation gate.
> - **REFUTED:** #3 (filter hỏng ngược — over-filtered).
>
> *Lưu ý: fix `extractSessionId` (Ưu tiên 1) là enabler cho #1/#2, nhưng bản thân #5/#6 nguy hiểm hơn nên nên làm song song chứ không tuần tự theo 1→5.*

### Ưu tiên 1 — Sửa `extractSessionId` (fix #1, #2; #3 cần fix hướng khác)

Đổi primary accessor sang `sessionManager.getSessionId()`, giữ descriptor fallback cho test mocks:

```ts
export function extractSessionId(ctx: unknown): string | undefined {
    if (typeof ctx !== "object" || ctx === null) return undefined;
    try {
        // Primary: sessionManager.getSessionId() (works on pi 0.83.0+)
        const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
        const viaManager = sm?.getSessionId?.();
        if (typeof viaManager === "string" && viaManager.length > 0) return viaManager;
        // Fallback: direct property (for test mocks / older pi versions)
        const direct = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
        if (typeof direct === "string" && direct.length > 0) return direct;
    } catch {
        // Defensive: hostile Proxy or exotic object
    }
    return undefined;
}
```

**Cảnh báo TUI freeze:** Comment hiện tại nói gọi `sessionManager.getSessionId()` trên hot path (mỗi LLM call) từng freeze TUI. Cần:
1. Test trên pi 0.83.0 trước khi áp dụng cho `context-status-injection`
2. Nếu vẫn freeze: cache sessionId per-session qua `SessionStateMap` khi `session_start` fire, đọc từ cache trên hot path thay vì gọi `getSessionId()` mỗi lần

> **Lưu ý Vector #3 (REFUTED, fix riêng):** `extractSessionId` không phải root cause của #3 — #3 dùng cast trực tiếp `(ctx.currentCtx as {sessionId?:string}).sessionId`. Fix #3: (a) bỏ clause 3 dead-code `ownerSessionGeneration` (field không tồn tại trên `TeamRunManifest`), (b) clause 2 đổi sang `ctx.sessionManager?.getSessionId()`. Kết quả: filter từ "drop all owned" → "pass only own session".

### Ưu tiên 2 — Thêm `currentSessionId` param vào recovery functions (fix #5, #6, #7)

```ts
// crash-recovery.ts
export function reconcileAllStaleRuns(
    cwd: string,
    manifestCache: ManifestCache,
    now = Date.now(),
    currentSessionId?: string,  // ← NEW
): ReconcileResult[] {
    const runIds = manifestCache
        .list(50)
        .filter((m) => {
            if (m.status !== "running" && m.status !== "blocked") return false;
            // Skip runs owned by another live session
            if (currentSessionId && m.ownerSessionId && m.ownerSessionId !== currentSessionId) return false;
            return true;
        })
        .map((m) => m.runId);
```

Tương tự cho `purgeStaleActiveRunIndex` và `detectInterruptedRuns`. Caller truyền `extractBrokerSessionId(ctx)` (working accessor).

### Ưu tiên 3 — Sửa UI surfaces giữ filter xuyên suốt (fix #8, #9, #10)

**Dashboard:** Áp dụng lại filter trong `refreshRuns()`:

```ts
private refreshRuns(): void {
    if (!this.options.runProvider) return;
    const next = this.options.runProvider();
    const unfiltered = Array.isArray(next) ? next : this.runs;
    this.runs = this.options.workspaceId
        ? unfiltered.filter((run) => !run.ownerSessionId || run.ownerSessionId === this.options.workspaceId)
        : unfiltered;
}
```

**Widget:** Thêm `workspaceId` vào `CrewWidgetModel`, truyền vào mỗi `activeWidgetRuns` call trong `render()`.

**Powerbar:** Thêm `workspaceId` param vào `updatePiCrewPowerbar` + `PowerbarUpdateArgs`, filter runs.

### Ưu tiên 4 — Session scoping cho subagent records (fix #4)

**Option A — Path-based:**

```ts
function persistedSubagentPath(cwd: string, id: string, sessionId?: string): string {
    const dir = sessionId
        ? path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir, sessionId)
        : path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.subagentsSubdir);
    return path.join(dir, `${id}.json`);
}
```

**Option B — Ownership check (ít thay đổi hơn):**

Thêm `ownerSessionId` vào `SubagentRecord`, check khi đọc trong `get_subagent_result`:

```ts
const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
if (record?.ownerSessionId && record.ownerSessionId !== currentSessionId) {
    return subagentToolResult("Agent belongs to another session.", {}, true);
}
```

### Ưu tiên 5 — Sửa các vector còn lại

- **#11 (async-notifier/session-summary):** Thêm `ownerSessionId` filter vào `listRecentRuns` call sites
- **#12 (DeliveryCoordinator):** Store activating sessionId, drop/park deliveries whose owning session differs
- **#13 (isOwnerSessionCurrent):** Đổi sang compare `sessionManager.getSessionId()` thay vì process-local counter

---

## 8. Phụ lục: Inventory state files

### Per-session (đúng)

| Path | Key |
|------|-----|
| `${XDG_RUNTIME_DIR}/pi-crew-<uid>/pi-crew-<sha256(sessionId)[0:8]>.sock` | sessionId hash |

### Per-project (shared, cần filter)

| Path | Key | Có ownerSessionId? |
|------|-----|---------------------|
| `.crew/state/runs/{runId}/manifest.json` | runId | Có |
| `.crew/state/runs/{runId}/tasks.json` | runId | — |
| `.crew/state/runs/{runId}/events.jsonl` | runId | — |
| `.crew/state/runs/{runId}/agents/{taskId}/status.json` | runId/taskId | — |
| `.crew/artifacts/{runId}/...` | runId | — |
| `.crew/state/subagents/{id}.json` | agentId | **Không** |
| `.crew/state/notifications/{date}.jsonl` | date | Không |

### Machine-global (shared across all sessions + all projects)

| Path | Key | Có session filter? |
|------|-----|---------------------|
| `~/.pi/agent/extensions/pi-crew/state/runs/active-run-index.json` | — | **Không** *(re-verify: `userCrewRoot()` = `~/.pi/agent/extensions/pi-crew`)* |
| `~/.pi/agent/extensions/pi-crew/state/runs/active-run-index.bin` | — | **Không** |
| `~/.pi/agent/state/orphan-workers.json` | — | Có (sessionId field + parentPid check) |

### In-process only (không cross-process leak)

| State | File | Key |
|-------|------|-----|
| `SubagentManager.records` | `subagent-manager.ts:226` | agentId (Map) |
| `liveAgents` | `live-agent-manager.ts:71` | agentId (Map) |
| `activeChildProcesses` | `child-pi-kill.ts:28` | pid (Map) |
| `runEventBus` | `run-event-bus.ts:~300` | runId/channel |
| `globalAnchorManager` | `anchor-manager.ts:19` | sessionId (Map) |
| `BatchBarrier` | `batch-barrier.ts:50` | batchId (Map) |
| `DeliveryCoordinator.pending` | `delivery-coordinator.ts` | runId (array) |
| `completion-dedupe globalStore` | `completion-dedupe.ts:56` | globalThis |

---

*Audit thực hiện bởi Droid (Factory) — 2026-08-05*
*Pi version: 0.83.0 | pi-crew source: src/ | 3 parallel explorer subagents + direct investigation*

*Re-verify độc lập bởi 5 verifier agent (pi-crew) — 2026-08-05: 2/2 lỗi gốc CONFIRMED, 12/13 vector CONFIRMED, #3 REFUTED (inverted). Xem banner đầu file + note "⚠️ Re-verify" trong từng vector.*
