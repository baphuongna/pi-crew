# Plan — Fix Cross-Session Information Leak (pi-crew)

> **Source audit:** [`cross-session-leak-audit.md`](./cross-session-leak-audit.md) (re-verified: 2/2 root cause CONFIRMED, 12/13 vector CONFIRMED, #3 REFUTED).
> **Pi version:** 0.83.0 · **pi-crew src:** `pi-crew/src/`
> **Revision:** v2 — sửa sau critique (B1–B4 blocking, N1–N7). Đã verify source.
> **Mục tiêu:** loại bỏ rò rỉ thông tin / can thiệp trạng thái giữa các pi session song song trên cùng repo, **không phá** crash-recovery cho session thực sự chết.

## Nguyên tắc thiết kế

1. **Session-awareness theo pattern `cancelOrphanedRuns`** (`crash-recovery.ts:~263`): mọi hàm dọn dẹp nhận `currentSessionId?`, **skip run có `ownerSessionId === currentSessionId`** (run của chính session đang sống). Run của session khác (đã chết) + ownerless vẫn bị dọn.
   > ⚠️ **GOTCHA filter direction:** dùng `=== currentSessionId` để **skip-own** (giữ run của mình). Đừng dùng `!==` (audit §7 Ưu tiên 2 nháp đầu ghi `!==` → sẽ skip run của session khác = phá crash-recovery). Tham chiếu đúng: `cancelOrphanedRuns:263` `if (!ownerId || ownerId === currentSessionId) continue`.
2. **Một accessor duy nhất**: `ctx.sessionManager?.getSessionId()` (working trên 0.83.0). `extractSessionId` sửa thành primary accessor + cache keyed bởi **`sessionManager`** (ổ định, không phải `ctx`).
3. **Back-compat**: mọi filter đều `if (currentSessionId && m.ownerSessionId && ...) skip` → `currentSessionId===undefined` giữ behavior cũ.
4. **Filter xuyên suốt** (dashboard/widget/powerbar), không chỉ frame đầu.
5. **Ownership field**: thêm `ownerSessionId` vào `SubagentRecord` (hiện chỉ có `ownerSessionGeneration` vô dụng cross-process).

## File ownership (conflict-safe) — v2

Mỗi file có 1 phase owner. **File chia sẻ (shared)** phải do 1 worker xử lý mọi phase.

| File | Owner phase | Vector | Ghi chú |
|------|-------------|--------|---------|
| `src/utils/session-utils.ts` | P0 | #1,#2 | enabler |
| `src/runtime/recovery/crash-recovery.ts` | P1 | #5,#6,#7 | 3 hàm |
| `src/extension/registration/lazy-configurers.ts` | P1 | #5 | wrapper `:93` — **B3, fires mỗi turn** |
| `src/extension/registration/observability.ts` | P1 | #5,#7 | `:188` before_agent_start + `:209` setInterval + type `:59` |
| `src/extension/registration/crash-recovery-cache.ts` | P1 | #6 | `purgeStaleActiveRunIndexSyncIfLoaded:47` thêm param — **B4** |
| `src/extension/registration/runtime-cleanup.ts` | P1 | #6 | `:86,158` truyền param |
| `src/extension/register.ts` | P1 | #6 | `:61` assignment (nếu đổi signature) |
| `src/extension/registration/registration-types.ts` | **P1+P2 (1 worker)** | #6,#13 | P1 `:143` (purge type) + P2 `:125` (isOwnerSessionCurrent type) |
| `src/extension/registration/context-builder.ts` | **P1+P2 (1 worker)** | #6,#13 | P1 `:101` (purge default) + P2 `:89` (isOwnerSessionCurrent impl) |
| `src/extension/registration/lifecycle-handlers.ts` | **P1+P5 (1 worker)** | #5,#6,#3 | P1 callers `:326,342` + P5 filter `:613` (2 vùng cách xa) |
| `src/ui/widget/widget-model.ts` | P1 | #5 | reconcile caller `:42` (P3 **không** đụng — `activeWidgetRuns` đã nhận workspaceId) |
| `src/runtime/subagent-manager.ts` | P2 | #4 | `SubagentRecord:28`, `SubagentSpawnOptions:13`, `spawn:239`, ID `:241` |
| `src/extension/registration/subagent-tools.ts` | P2 | #4,#13 | ownership check `:274`, resultConsumed `:326`, thread sessionId `:141` |
| `src/extension/registration/subagent-manager-setup.ts` | P2 | #13 | 4 call sites `:73,234,260,311` |
| `src/ui/run-dashboard.ts` | P3 | #8 | refreshRuns `:517` |
| `src/ui/widget/index.ts` | P3 | #9 | render `:273` truyền workspaceId |
| `src/ui/widget/widget-types.ts` | P3 | #9 | thêm `workspaceId` vào CrewWidgetModel |
| `src/extension/async-notifier.ts` | P4 | #11 | filter listRuns |
| `src/extension/session-summary.ts` | P4 | #11 | filter listRuns |
| `src/runtime/delivery-coordinator.ts` | P4 | #12 | store sessionId, gate flush |
| tests (`src/runtime/recovery/__tests__/` etc.) | P6 | all | characterization + regression |

**Parallelization an toàn (sau khi gộp shared files):**
- P0 độc lập (chạy đầu).
- P1 ↔ P2 **không song song** (shared `registration-types.ts` + `context-builder.ts`).
- P3 ↔ P4 ↔ P1/P2 **độc lập về file** → song song được.
- P5 gộp vào worker sở hữu `lifecycle-handlers.ts` (cùng worker P1).

→ Khuyến nghị thực thi: **P0 → P1 → P2** (tuần tự do shared files), rồi **P3 ‖ P4** (song song), rồi P5 (nếu chưa gộp), rồi **P6**.

---

## Phase 0 — Sửa `extractSessionId` (enabler #1, #2)

**File:** `src/utils/session-utils.ts:67-79`

**Thay đổi:**
- Primary: `ctx.sessionManager?.getSessionId?.()`.
- Fallback: descriptor `sessionId` (test mock / pi cũ).
- try/catch defensive.
- **Cache keyed bởi `sessionManager`** (KHÔNG phải `ctx` — `ctx` được `createContext()` tạo mới mỗi event, `runner.js:577/608/647`). `sessionManager` là field ổn định trên runner:

```ts
const sessionIdCache = new WeakMap<object, string>(); // keyed by sessionManager ref
export function extractSessionId(ctx: unknown): string | undefined {
    if (typeof ctx !== "object" || ctx === null) return undefined;
    try {
        const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager;
        if (sm && typeof sm === "object") {
            const cached = sessionIdCache.get(sm as object);
            if (cached) return cached;
            const id = (sm as { getSessionId?: () => unknown }).getSessionId?.();
            if (typeof id === "string" && id.length > 0) { sessionIdCache.set(sm as object, id); return id; }
        }
        const direct = Object.getOwnPropertyDescriptor(ctx, "sessionId")?.value;
        if (typeof direct === "string" && direct.length > 0) return direct;
    } catch { /* defensive */ }
    return undefined;
}
```

> **B1 note:** `getSessionId()` thực ra trivial (`return this.sessionId`, `session-manager.js:718`) nên risk TUI freeze có thể đã stale — nhưng cache đúng key vẫn cần để an toàn.
**Verify:** unit test: extractSessionId trả id từ mock ctx có `sessionManager.getSessionId()`; cache hit không gọi lại; `undefined` khi ctx rỗng.

---

## Phase 1 — Crash-recovery session-aware (P0 CRITICAL: #5, #6, #7)

**File chính:** `src/runtime/recovery/crash-recovery.ts`

### P1.1 — `reconcileAllStaleRuns` (`:608`) — có `.filter()`
```ts
export function reconcileAllStaleRuns(cwd, manifestCache, now = Date.now(), currentSessionId?: string) {
    const runIds = manifestCache.list(50)
        .filter((m) => {
            if (m.status !== "running" && m.status !== "blocked") return false;
            if (currentSessionId && m.ownerSessionId && m.ownerSessionId === currentSessionId) return false; // skip own live run
            return true;
        })
        .map((m) => m.runId);
    // ...
}
```

### P1.2 — `purgeStaleActiveRunIndex` (`:400`) — **skip TRONG loop body, KHÔNG phải `.filter()`** (B2)
Registry entries (`ActiveRunRegistryEntry`, `active-run-registry.ts:20-26`) **không có `ownerSessionId`** — chỉ có sau khi đọc manifest (~`:469-472`). Vậy skip phải đặt **sau** `readManifestWithTransientRetry`, **trước** logic purge (~`:475`):
```ts
export function purgeStaleActiveRunIndex(staleThresholdMs = 300_000, now = Date.now(), currentSessionId?: string) {
    // ... for (const entry of entries) { ... manifest = readManifestWithTransientRetry(...) ...
    if (currentSessionId && manifest?.ownerSessionId && manifest.ownerSessionId === currentSessionId) {
        kept.push(entry.runId);   // skip own live run
        continue;
    }
    // ... existing purge logic ...
}
```

### P1.3 — `detectInterruptedRuns` (`:107`) — **`for...of` + `continue`**, KHÔNG phải `.filter()` (N6)
```ts
export function detectInterruptedRuns(cwd, manifestCache, deadMs = 300_000, currentSessionId?: string) {
    for (const manifest of manifestCache.list(50)) {
        if (manifest.status !== "running" && manifest.status !== "blocked") continue;
        if (currentSessionId && manifest.ownerSessionId && manifest.ownerSessionId === currentSessionId) continue; // skip own
        // ...
    }
}
```

### P1.4 — Thread `currentSessionId` qua TẤT CẢ callers (B3, B4)
| Caller | File:line | Việc |
|--------|-----------|------|
| reconcile wrapper | `lazy-configurers.ts:93` | đổi `(cwd, cache) => reconcileAllStaleRuns(cwd, cache, Date.now(), sid)` |
| reconcile type | `observability.ts:59` | thêm `currentSessionId?: string` vào `ObservabilityDeps.reconcileStaleRuns` |
| reconcile call ×2 | `observability.ts:188,209` | lấy `sid = extCtx.sessionManager?.getSessionId()` rồi truyền |
| detect caller | `observability.ts:~271` | truyền `sid` (autoRecover path) |
| purge wrapper | `crash-recovery-cache.ts:47` | `purgeStaleActiveRunIndexSyncIfLoaded(currentSessionId?: string)` → forward |
| purge type | `registration-types.ts:143` | thêm param |
| purge default | `context-builder.ts:101` | stub `(sid?) => undefined` |
| purge assign | `register.ts:61` | giữ (nếu signature đổi, ensure forward) |
| purge call ×2 | `runtime-cleanup.ts:86,158` | truyền `sid` |
| reconcile lifecycle | `lifecycle-handlers.ts:326,342` | truyền `extractBrokerSessionId(ctx)` |
| reconcile widget | `widget-model.ts:42` | dùng param `workspaceId` (đã trong scope của `activeWidgetRuns`) truyền vào `reconcileAllStaleRuns(cwd, cache, Date.now(), workspaceId)` |

> ⚠️ **B3 là path leak tần suất cao nhất**: `observability.ts:188` fires mỗi `before_agent_start` (= mỗi user turn), `:209` fires mỗi 5min. Bỏ sót = leak #5 vẫn xảy ra liên tục.

**Risk:** crash-recovery thật giữ nguyên — run session chết có `ownerSessionId !== currentSessionId` → vẫn qua check PID/heartbeat → bị dọn. Back-compat khi `currentSessionId===undefined`.
**Verify (P6 characterization TRƯỚC):** ghi lại behavior hiện tại: session chết (PID dead + stale) bị dọn; rồi test mới: session B start/turn/shutdown không mark-failed/cancel run foreground của A (heartbeat fresh).

---

## Phase 2 — Subagent ownership + #13 (P1 HIGH: #4, #13)

**Files:** `subagent-manager.ts`, `subagent-tools.ts`, `subagent-manager-setup.ts`, `registration-types.ts:125`, `context-builder.ts:89`

### P2.1 — `SubagentRecord` (`subagent-manager.ts:28`) thêm `ownerSessionId?: string`
(Viết ngay trong file này — **KHÔNG** ở `state/types.ts` [N1]; `state/types.ts` chỉ có `TeamRunManifest`.)

### P2.2 — Thread sessionId qua `SubagentSpawnOptions` (N2: `spawn()` không có ctx)
- `SubagentSpawnOptions` (`subagent-manager.ts:13`): thêm `ownerSessionId?: string`.
- `subagent-tools.ts:141` (đã có `ctxWithSession = withSessionId(ctx)`): set `spawnOptions.ownerSessionId = ctxWithSession.sessionId`.
- `spawn()` (`:239`): copy `options.ownerSessionId` vào `record.ownerSessionId`.

### P2.3 — Ownership check khi đọc (subagent-tools.ts:~274)
```ts
const record = inMemory ?? readPersistedSubagentRecord(ctx.cwd, p.agent_id);
if (record?.ownerSessionId && record.ownerSessionId !== currentSessionId) {
    return subagentToolResult("Agent belongs to another session.", {}, true);
}
```

### P2.4 — `resultConsumed` write chỉ khi cùng owner (subagent-tools.ts:~326)
Tránh clobber notification của session khác.

### P2.5 — Vector #13: `isOwnerSessionCurrent` (N3 — fully in-scope)
- `registration-types.ts:125`: signature `(ownerGeneration?: number, ownerSessionId?: string) => boolean`.
- `context-builder.ts:89`: impl (định nghĩa `const currentSid = ctx.currentCtx?.sessionManager?.getSessionId()` trong closure) `(gen, oid) => !ctx.cleanedUp && (oid === undefined || oid === currentSid) && (gen === undefined || gen === ctx.sessionGeneration)`.
- `subagent-manager-setup.ts:73,234,260,311` (4 sites): truyền `record.ownerSessionId` cùng `ownerSessionGeneration`.

### P2.6 — ID collision entropy (subagent-manager.ts:241)
Prefix bằng sessionId hash hoặc `crypto.randomUUID().slice(0,8)` để 2 process không cùng `agent_<ms>_1`.

**Verify:** test 2 session: B gọi `get_subagent_result(<A's agent>)` → bị từ chối; A vẫn nhận completion notification; record cũ (không ownerSessionId) vẫn đọc được (back-compat).

---

## Phase 3 — UI filter xuyên suốt (#8, #9, #10)

**Files:** `run-dashboard.ts`, `widget/index.ts`, `widget-types.ts` (P3 **không** đụng `widget-model.ts` — N5)

1. **Dashboard `refreshRuns()`** (`run-dashboard.ts:~517`): re-apply `options.workspaceId` filter sau `runProvider()`.
2. **Widget**: thêm `workspaceId?: string` vào `CrewWidgetModel` (`widget-types.ts:16-24`); populate từ `ctx.sessionManager?.getSessionId()` ở `updateCrewWidget` (`index.ts:~347`); truyền làm arg thứ 5 vào `activeWidgetRuns` trong `CrewWidgetComponent.render` (`index.ts:273`).
3. **Powerbar** (`powerbar-publisher.ts`): thêm `workspaceId?` vào `updatePiCrewPowerbar` + `PowerbarUpdateArgs` + `requestPowerbarUpdate`; filter runs + dùng `listLiveAgentsByWorkspace()` thay `listLiveAgents()`.

**Verify:** thủ công 2 session — dashboard/widget/footer chỉ hiện run của mình từ frame 2+.

---

## Phase 4 — Notifier & delivery session scoping (#11, #12)

**Files:** `async-notifier.ts`, `session-summary.ts`, `delivery-coordinator.ts`

1. **async-notifier** (`:128,136,154`): filter `listRuns(ctx.cwd)` bằng `ownerSessionId === currentSessionId` trước notify.
2. **session-summary `notifyActiveRuns`** (`:6-20`): filter `listRuns` bằng ownerSessionId.
3. **DeliveryCoordinator.activate(sessionId)** (`:36`): store `this.activeSessionId`; trong `flushQueuedResults`, park delivery có owning session khác.

> ⚠️ **Re-verify (post-impl): Vector #12 là INERT ở runtime.** `deliverResult`/`deliverNotification`/`deliverSteer` KHÔNG có production caller nào (grep confirmed — chỉ `dispose`/`getPendingCount`/`activate`/`deactivate` được dùng). Queue không bao giờ được feed → park-on-cross-session logic không bao giờ fire. Tức là #12 vốn đã inert từ trước fix (không có gì để flush sai). Infrastructure ownerSessionId đã staged để sẵn — nếu sau này delivery path được wire thì fix tự kích hoạt. **#11 (notifier/session-summary) là phần có hiệu lực thật của P4.**

**Verify:** 2 session: B không toast completion của A (#11 — có hiệu lực). Queued results flush sai session (#12) — không thể test ở runtime vì delivery path chưa wire (inert).

---

## Phase 5 — Vector #3 health filter (LOW, hướng riêng)

**File:** `lifecycle-handlers.ts:613-618` (cùng worker P1)

- Bỏ clause 3 dead-code (`ownerSessionGeneration` không tồn tại trên `TeamRunManifest`).
- Clause 2: `(ctx.currentCtx as {sessionId?:string}).sessionId` → **`ctx.currentCtx?.sessionManager?.getSessionId()`** (N4: `ctx` là RegistrationContext, không có `sessionManager` trực tiếp — phải qua `currentCtx`).
- Kết quả: filter "drop all owned" → "pass own session + ownerless".

**Verify:** health warning fire cho run của chính session; không fire cho session khác.

---

## Phase 6 — Tests & build

**Characterization tests TRƯỚC khi sửa (N7 — không có test hiện có):**
- Ghi lại behavior `reconcileAllStaleRuns` / `purgeStaleActiveRunIndex` hiện tại (session chết PID-dead+stale → dọn) để đảm bảo invariant không break.

**Regression/new tests:**
- `crash-recovery`: 2 session — B start/turn/shutdown không mark-failed/cancel run foreground của A (heartbeat fresh); session crash (PID dead + stale) vẫn bị dọn.
- `subagent`: cross-session `get_subagent_result` bị chặn; completion notification không bị triệt tiêu chéo; record cũ back-compat.
- `extractSessionId`: trả id từ mock ctx có sessionManager; cache hit; `undefined` khi ctx rỗng.
- UI: dashboard/widget filter frame 2+.

**Build & smoke:**
- `npm test`.
- `npm run build:bundle` (dist/index.mjs là entry thực tế — source edit không hot-load per knowledge.md).
- Smoke thủ công: 2 pi session song song cùng repo, spawn subagent ở A, kiểm B không thấy/kill A.

---

## Sequencing & gates (v2)

```
P0 (extractSessionId, WeakMap<sessionManager>) ──► gate: unit test cache + accessor
P1 (crash-recovery + ALL callers incl. lazy-configurers/observability/crash-recovery-cache) ──► gate: 2-session smoke (A chạy, B turn/start/shutdown → A sống); session crash vẫn dọn
P2 (subagent ownerSessionId + #13 isOwnerSessionCurrent) ──► gate: cross-session get_subagent_result bị chặn
P3 ‖ P4 (UI ‖ notifier/delivery) ──► gate: dashboard/widget/footer/notifier chỉ hiện/toast của mình
P5 (#3 health, cùng worker lifecycle-handlers.ts) ──► gate: warning fire đúng session
P6 (characterization + regression tests, bundle) ──► gate: npm test PASS + dist rebuilt
```

## Out of scope
- Path-based session scoping cho subagent records (audit §7 Option A) — ownership-check (Option B) đủ, ít rủi ro.
- Thêm session component vào global active-run-index — chỉ cần caller filter đúng (đã cover P1).
- Vector #13 alternative (replace generation entirely) — giữ generation cho in-process switch, thêm ownerSessionId check (P2.5).
