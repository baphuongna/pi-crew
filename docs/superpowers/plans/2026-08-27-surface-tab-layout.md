# MuxSurface Tab-Layout (per-TEAM-RUN tab, max 8 pane/tab, right/down luân phiên) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay thế layout surface "mọi pane split-right dồn 1 tab" bằng **mỗi TEAM RUN 1 tab riêng** (tmux new-window / herdr tab create), **max 8 worker panes/tab** rồi tạo tab mới, **tab chỉ đóng khi run end/cancel/kill**, phân phối `right`/`down` theo `splitIndex % 2` (0→down, 1→right).

**Architecture:** `SurfaceSpawnOpts` thêm `tabKey` (= runId) + `splitIndex`; 2 provider (tmux/herdr) tự quản lý tab-map nội bộ (`tabKey → tabId` + pane-count per tab), tạo tab mới khi đầy 8; `prepareSurfaceSpawn` tính `tabKey` từ `stateRoot` + `splitIndex` từ manifest surface pane count. Manifest `panes` mở rộng thêm `tabId` per pane; doctor cleanup đóng cả tab khi run terminal.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), node:test, tmux CLI (execFileSync), herdr socket API (NDJSON unix socket), pi-crew manifest state (JSON).

## Global Constraints

- **Spec**: `docs/superpowers/specs/2026-08-27-surface-tab-layout.md` — tab = 1 TEAM RUN (`tabKey = runId`), max **8 pane/tab** (vượt → tab mới), tab đóng **CHỈ khi run end/cancel/kill**, luân phiên `splitIndex % 2 === 0 → down`, `1 → right`.
- **Fail-closed**: mọi lỗi mux/tab → degrade headless, KHÔNG throw ra ngoài `prepareSurfaceSpawn` (giữ nguyên contract hiện tại — `surface-spawn.ts` header).
- **Provider contract**: `createSurface(name, opts)` trả `SurfaceHandle`; `sendCommand` boot sau khi script build; `closeSurface` idempotent (giữ nguyên, bổ sung close-tab khi run end).
- **Không đổi gate matrix** §3 (mode-off/depth/pane-cap/role-not-visible/no-mux) — task này chỉ đổi layout/pane placement.
- **Backward-compat manifest**: `ManifestSurfaceState.panes` thêm `tabId` optional — manifests cũ parse bình thường (`normalizeSurfaceState` bỏ qua field lạ).
- **Test commands**: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 <file>`; full: `npm run test:critical`; `npm run typecheck`; `npm run build:bundle`.
- **Commit style**: conventional commits (`feat(scope): ...` / `test(scope): ...`), tiếng Việt trong body nếu cần.
- **HERDR_PANE_ID env-first**: giữ nguyên fix đã có (pane cha = `env.HERDR_PANE_ID`, fallback `pane.current`) — KHÔNG đụng.

---

### Task 1: `SurfaceSpawnOpts` thêm `tabKey` + `splitIndex` (interface + helper thuần)

**Files:**
- Modify: `src/runtime/surface/surface-provider.ts:26-30` (SurfaceSpawnOpts)
- Test: `test/unit/runtime/surface/surface-spawn.test.ts` (thêm test helper)

**Interfaces:**
- Consumes: `SurfaceSpawnOpts` hiện tại `{cwd, command?, title?}`.
- Produces: `SurfaceSpawnOpts` mới `{cwd, command?, title?, tabKey?: string, splitIndex?: number}` + export helper `splitDirectionFor(index: number): "down" | "right"` (0→down, lẻ→right) + export const `MAX_PANES_PER_TAB = 8`.

- [ ] **Step 1: Write the failing test**

Thêm vào cuối `test/unit/runtime/surface/surface-spawn.test.ts`:

```ts
import { MAX_PANES_PER_TAB, splitDirectionFor } from "../../../../src/runtime/surface/surface-provider.ts";

test("splitDirectionFor: 0 → down, 1 → right, xen kẽ (splitIndex%2)", () => {
	assert.equal(splitDirectionFor(0), "down");
	assert.equal(splitDirectionFor(1), "right");
	assert.equal(splitDirectionFor(2), "down");
	assert.equal(splitDirectionFor(3), "right");
	assert.equal(splitDirectionFor(7), "right");
	assert.equal(splitDirectionFor(8), "down");
});

test("MAX_PANES_PER_TAB = 8 (spec 2026-08-27-surface-tab-layout)", () => {
	assert.equal(MAX_PANES_PER_TAB, 8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/surface-spawn.test.ts`
Expected: FAIL — `splitDirectionFor` / `MAX_PANES_PER_TAB` không export.

- [ ] **Step 3: Write minimal implementation**

Trong `src/runtime/surface/surface-provider.ts`, mở rộng interface + thêm helper:

```ts
/** Max worker panes per tab trước khi provider mở tab mới (spec tab-layout §5). */
export const MAX_PANES_PER_TAB = 8;

/**
 * Hướng split luân phiên theo pane index trong tab (spec tab-layout §4):
 * chẵn → down (dọc), lẻ → right (ngang) — không dồn một phía.
 */
export function splitDirectionFor(index: number): "down" | "right" {
	return index % 2 === 0 ? "down" : "right";
}

export interface SurfaceSpawnOpts {
	cwd: string;
	command?: string;
	title?: string;
	/** runId — mọi worker của cùng TEAM RUN chia tab (spec tab-layout §3.1). */
	tabKey?: string;
	/** Pane thứ mấy trong tab hiện tại — quyết định hướng down/right. */
	splitIndex?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/surface-spawn.test.ts`
Expected: PASS toàn file (test cũ không đổi hành vi — 2 field mới optional).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/surface/surface-provider.ts test/unit/runtime/surface/surface-spawn.test.ts
git commit -m "feat(surface): SurfaceSpawnOpts thêm tabKey/splitIndex + splitDirectionFor helper"
```

---

### Task 2: tmux-provider — tab per-run (new-window + split -h/-v + kill-window khi run end)

**Files:**
- Modify: `src/runtime/surface/tmux-provider.ts:224-293` (createSurface + closeSurface)
- Test: `test/unit/runtime/surface/tmux-provider.test.ts`

**Interfaces:**
- Consumes: `MAX_PANES_PER_TAB`, `splitDirectionFor` từ Task 1; `SurfaceSpawnOpts.tabKey/splitIndex`.
- Produces: tmux `createSurface` tôn trọng tabKey/splitIndex (window per run, split xen kẽ); closeSurface giữ nguyên semantics per-pane (run end sẽ đóng window ở Task 5 — provider thêm `closeTab(windowId)` internal, export qua handle meta `tabWindowId`).

- [ ] **Step 1: Write the failing test**

Thêm vào `test/unit/runtime/surface/tmux-provider.test.ts`:

```ts
test("tabKey per-run: worker đầu tạo window mới + rename; splitIndex quyết định -h/-v; full 8 pane → window mới", async () => {
	const calls: string[][] = [];
	let windowSeq = 0;
	const provider = createTmuxProvider({
		env: { TMUX: "/tmp/tmux,test,0", TMUX_PANE: "%0" },
		tmux: (args) => {
			calls.push(args);
			if (args[0] === "new-window") {
				windowSeq += 1;
				return `@${windowSeq}\n`;
			}
			if (args[0] === "split-window") return `%${100 + calls.length}\n`;
			return "";
		},
	});
	// Worker đầu của run "runA" — tạo window @1, pane đầu split DOWN từ root window pane.
	const h1 = await provider.createSurface("01_explore", { cwd: "/w", tabKey: "runA", splitIndex: 0, title: "01_explore" });
	assert.equal(h1.kind, "tmux");
	const newWin = calls.find((a) => a[0] === "new-window");
	assert.ok(newWin, "phải tạo window mới cho run mới");
	assert.ok(newWin?.includes("-P"), "new-window -P để lấy window id");
	const rename = calls.find((a) => a[0] === "rename-window");
	assert.ok(rename, "phải rename window theo tab label");
	// splitIndex 0 → down → split-window phải là -v (không phải -h)
	const firstSplit = calls.find((a) => a[0] === "split-window");
	assert.ok(firstSplit?.includes("-v"), `splitIndex 0 phải -v (down), nhận: ${JSON.stringify(firstSplit)}`);
	// splitIndex 1 → right → -h
	calls.length = 0;
	await provider.createSurface("02_execute", { cwd: "/w", tabKey: "runA", splitIndex: 1, title: "02_execute" });
	assert.ok(!calls.some((a) => a[0] === "new-window"), "cùng tabKey → KHÔNG tạo window mới");
	const secondSplit = calls.find((a) => a[0] === "split-window");
	assert.ok(secondSplit?.includes("-h"), `splitIndex 1 phải -h (right), nhận: ${JSON.stringify(secondSplit)}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/tmux-provider.test.ts`
Expected: FAIL — createSurface hiện không gọi `new-window`, split luôn `-h`.

- [ ] **Step 3: Write minimal implementation**

Trong `src/runtime/surface/tmux-provider.ts`:

1. Thêm state tab-map ở scope provider (trong `createTmuxProvider`):

```ts
// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey(run) → window id +
// số pane đã spawn trong window đó. Tab mở khi run spawn worker đầu, KHÔNG
// đóng khi từng worker xong — chỉ đóng khi run end (closeTabFor, Task 5).
const tabWindows = new Map<string, { windowId: string; paneCount: number }>();
```

2. Thay logic split trong `createSurface` (giữ TMUX_PANE fallback cho đường KHÔNG có tabKey — spawn ngoài run):

```ts
async createSurface(_name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle> {
	let targetWindow: string;
	let paneIndexInTab: number;
	if (opts.tabKey) {
		const existing = tabWindows.get(opts.tabKey);
		if (existing && existing.paneCount < MAX_PANES_PER_TAB) {
			existing.paneCount += 1;
			targetWindow = existing.windowId;
			paneIndexInTab = existing.paneCount - 1;
		} else {
			// Tab mới cho run (hoặc tab cũ đã đầy 8) — window riêng, rename theo tab.
			const windowId = tmux(["new-window", "-P", "-F", "#{window_id}"]).trim();
			if (!/^@\d+$/.test(windowId)) {
				throw new Error(`Unexpected tmux new-window output: ${JSON.stringify(windowId)}`);
			}
			const label = opts.title ?? opts.tabKey;
			try {
				tmux(["rename-window", "-t", windowId, label]);
			} catch {
				// rename là cosmetic — pane vẫn dùng được.
			}
			tabWindows.set(opts.tabKey, { windowId, paneCount: 1 });
			targetWindow = windowId;
			paneIndexInTab = 0;
		}
	} else {
		// Đường legacy (spawn ngoài run): giữ split từ pane cha như cũ.
		const parentPane = env.TMUX_PANE;
		if (!parentPane) {
			throw new Error("TMUX_PANE not set — tmux provider chỉ chạy bên trong tmux session");
		}
		targetWindow = parentPane;
		paneIndexInTab = opts.splitIndex ?? 0;
	}
	const directionFlag = splitDirectionFor(paneIndexInTab) === "down" ? "-v" : "-h";
	const raw = tmux(["split-window", "-d", directionFlag, "-P", "-F", "#{pane_id}", "-t", targetWindow]);
	const paneId = raw.trim();
	if (!/^%\d+$/.test(paneId)) {
		throw new Error(`Unexpected tmux split-window output: ${JSON.stringify(raw)}`);
	}
	// … (title/select-pane + send-keys giữ nguyên như cũ)
	return makeHandle(paneId);
}
```

3. Import thêm ở đầu file: `import { MAX_PANES_PER_TAB, splitDirectionFor } from "./surface-provider.ts";` (gộp vào import type hiện tại thành 2 dòng: 1 type + 1 value).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/tmux-provider.test.ts`
Expected: PASS toàn file (test cũ dùng createSurface không tabKey → đường legacy giữ nguyên).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/surface/tmux-provider.ts test/unit/runtime/surface/tmux-provider.test.ts
git commit -m "feat(surface): tmux provider tab per-run — new-window + split -v/-h luân phiên + max 8 pane/tab"
```

---

### Task 3: herdr-provider — tab per-run (tab create + pane.split right/down + close-tab khi run end)

**Files:**
- Modify: `src/runtime/surface/herdr-provider.ts:317-344` (createSurface)
- Test: `test/unit/runtime/surface/herdr-provider.test.ts`

**Interfaces:**
- Consumes: `MAX_PANES_PER_TAB`, `splitDirectionFor` từ Task 1; wire herdr `tab.create` (`TabCreateParams: cwd, env, focus, label, workspace_id` → `result.tab.tab_id` + `result.root_pane.pane_id`), `pane.split` direction `right|down`.
- Produces: herdr `createSurface` tôn trọng tabKey/splitIndex; tab-map nội bộ; `closeSurface` giữ per-pane (run end đóng tab ở Task 5).

- [ ] **Step 1: Write the failing test**

Thêm vào `test/unit/runtime/surface/herdr-provider.test.ts` (trong `defaultRespond` thêm `tab.create`):

```ts
// Bổ sung vào defaultRespond (file đã có):
if (req.method === "tab.create") return { type: "tab_created", tab: { tab_id: "w3:t9" }, root_pane: { pane_id: "w3:pR" } };
```

```ts
test("tabKey per-run: tab.create cho run mới; splitIndex quyết right/down; cùng tabKey tái dùng tab; đầy 8 → tab mới", async () => {
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W"; // env-first (fix 2026-08-27) — không gọi pane.current
	const { handle: h1 } = await spawnPane(h, { title: "01_explore", tabKey: "runA", splitIndex: 0 } as never);
	assert.equal(h1.id, "w3:pC");
	// tab.create phải được gọi cho run mới
	assert.ok(h.sockets.some((s) => s.requests[0]?.method === "tab.create"), "phải tab.create cho tabKey mới");
	const tabCreate = h.sockets.find((s) => s.requests[0]?.method === "tab.create")?.requests[0];
	assert.equal(tabCreate?.params.label, "01_explore");
	// split đầu tiên trong tab: target = root_pane của tab (w3:pR), direction = down (index 0)
	const split1 = h.sockets.find((s) => s.requests[0]?.method === "pane.split")?.requests[0];
	assert.deepEqual(split1?.params.direction, "down");
	assert.equal(split1?.params.target_pane_id, "w3:pR");
	// Worker 2 cùng run → KHÔNG tab.create nữa, direction right (index 1)
	h.sockets.length = 0;
	await spawnPane(h, { title: "02_execute", tabKey: "runA", splitIndex: 1 } as never);
	assert.ok(!h.sockets.some((s) => s.requests[0]?.method === "tab.create"), "cùng tabKey → tái dùng tab");
	const split2 = h.sockets.find((s) => s.requests[0]?.method === "pane.split")?.requests[0];
	assert.deepEqual(split2?.params.direction, "right");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/herdr-provider.test.ts`
Expected: FAIL — createSurface hiện không gọi `tab.create`, split luôn `right` từ HERDR_PANE_ID.

- [ ] **Step 3: Write minimal implementation**

Trong `src/runtime/surface/herdr-provider.ts`:

1. Thêm tab-map trong `createHerdrProvider`:

```ts
// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey(run) → {tabId, rootPaneId,
// paneCount}. Tab mở khi run spawn worker đầu; KHÔNG đóng khi worker xong — chỉ
// đóng khi run end (Task 5 gọi closeTabForRun).
const tabMap = new Map<string, { tabId: string; rootPaneId: string; paneCount: number }>();
```

2. Trong `createSurface`, sau khối env-first pane cha hiện có, thêm nhánh tabKey:

```ts
// Tab-layout: có tabKey (spawn trong run) → mọi worker của run chia tab riêng,
// split từ root pane của tab theo hướng luân phiên. KHÔNG tabKey → đường legacy
// (split từ HERDR_PANE_ID / pane.current như cũ).
let parentPaneId: string | undefined;
let paneIndexInTab = opts.splitIndex ?? 0;
if (opts.tabKey) {
	const existing = tabMap.get(opts.tabKey);
	if (existing && existing.paneCount < MAX_PANES_PER_TAB) {
		existing.paneCount += 1;
		parentPaneId = existing.rootPaneId;
		paneIndexInTab = existing.paneCount - 1;
	} else {
		const created = await call<{ tab?: { tab_id?: string }; root_pane?: { pane_id?: string } }>("tab.create", {
			label: opts.title ?? opts.tabKey,
			...(env.HERDR_WORKSPACE_ID ? { workspace_id: env.HERDR_WORKSPACE_ID } : {}),
		});
		const tabId = created.tab?.tab_id;
		const rootPaneId = created.root_pane?.pane_id;
		if (!tabId || !rootPaneId) throw new Error("tab.create returned no tab_id/root_pane");
		tabMap.set(opts.tabKey, { tabId, rootPaneId, paneCount: 1 });
		parentPaneId = rootPaneId;
		paneIndexInTab = 0;
	}
} else {
	const envPaneId = env.HERDR_PANE_ID;
	if (envPaneId) parentPaneId = envPaneId;
	else {
		const current = await call<{ pane?: { pane_id?: string } }>("pane.current", {});
		parentPaneId = current.pane?.pane_id;
	}
}
if (!parentPaneId) {
	throw new Error("no parent pane — HERDR_PANE_ID unset, no tabKey, and pane.current returned no pane_id");
}
const split = await call<{ pane?: { pane_id?: string } }>("pane.split", {
	direction: splitDirectionFor(paneIndexInTab),
	target_pane_id: parentPaneId,
	cwd: opts.cwd,
	focus: false,
});
```

(xóa logic direction hard-code `"right"` cũ; giữ rename + send_text như cũ.)

3. Import: thêm `MAX_PANES_PER_TAB, splitDirectionFor` vào import từ `./surface-provider.ts` (value import riêng dòng).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/herdr-provider.test.ts`
Expected: PASS toàn file (test legacy env-first/fallback vẫn xanh vì defaultRespond giờ thêm `tab.create` nhưng đường không-tabKey không gọi nó).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/surface/herdr-provider.ts test/unit/runtime/surface/herdr-provider.test.ts
git commit -m "feat(surface): herdr provider tab per-run — tab.create + pane.split down/right luân phiên + max 8 pane/tab"
```

---

### Task 4: `prepareSurfaceSpawn` truyền `tabKey` + `splitIndex` cho provider

**Files:**
- Modify: `src/runtime/surface/surface-spawn.ts:232-236` (createSurface call)
- Test: `test/unit/runtime/surface/prepare-surface-spawn.test.ts`

**Interfaces:**
- Consumes: `PrepareSurfaceSpawnInput.stateRoot` (path …/runs/{runId} — chạy `path.basename(stateRoot)` ra runId); fakeProvider trong test bắt opts.
- Produces: `provider.createSurface(taskId, {cwd, title, tabKey: runId, splitIndex})` — splitIndex lấy từ `input.livePaneCount` (số pane sống của run = đếm pane đã spawn, reset khi provider đổi tab nội bộ — provider tự lo vì counter trong provider là thật; caller chỉ truyền index "worker thứ mấy của run" = `livePaneCount`).

- [ ] **Step 1: Write the failing test**

Thêm vào `test/unit/runtime/surface/prepare-surface-spawn.test.ts`:

```ts
test("prepareSurfaceSpawn truyền tabKey=runId (từ stateRoot) + splitIndex=livePaneCount cho provider", async () => {
	const provider = fakeProvider();
	const input = baseInput({ livePaneCount: 2, stateRoot: "/state/runs/team_20260827_runA" });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assert.equal(outcome.mode, "surface");
	const createCall = provider.createCalls[0]; // fakeProvider cần lưu opts — thêm nếu chưa có
	assert.equal(createCall.opts.tabKey, "team_20260827_runA", "tabKey = basename(stateRoot) = runId");
	assert.equal(createCall.opts.splitIndex, 2, "splitIndex = livePaneCount");
});
```

(Nếu `fakeProvider` chưa lưu opts của createSurface, cập nhật fake: thêm `createCalls: Array<{name: string; opts: SurfaceSpawnOpts}>` + push trong `createSurface`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/prepare-surface-spawn.test.ts`
Expected: FAIL — `tabKey` hiện undefined (createSurface chỉ nhận `{cwd, title}`).

- [ ] **Step 3: Write minimal implementation**

Trong `src/runtime/surface/surface-spawn.ts`, sửa call site createSurface (dòng ~236):

```ts
// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey = runId (basename
// của stateRoot) — mọi worker của run chia tab; splitIndex = số pane worker
// run đã có (provider tự luân phiên down/right + mở tab mới khi đầy 8).
const runId = input.stateRoot ? path.basename(input.stateRoot) : undefined;
handle = await provider.createSurface(input.taskId, {
	cwd: input.cwd,
	title: input.taskId,
	...(runId ? { tabKey: runId, splitIndex: input.livePaneCount } : {}),
});
```

(Thêm `import * as path from "node:path";` nếu chưa có.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/prepare-surface-spawn.test.ts`
Expected: PASS toàn file.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/surface/surface-spawn.ts test/unit/runtime/surface/prepare-surface-spawn.test.ts
git commit -m "feat(surface): prepareSurfaceSpawn truyền tabKey=runId + splitIndex cho provider"
```

---

### Task 5: Tab chỉ đóng khi RUN END — `releaseSurfacePane` không đóng pane; run end → provider đóng toàn tab

**Files:**
- Modify: `src/runtime/surface/degrade.ts` (releaseSurfacePane — bỏ close-pane; thêm closeRunTabs)
- Modify: `src/runtime/surface/tmux-provider.ts` (thêm `closeTabFor(tabKey)` qua handle meta)
- Modify: `src/runtime/surface/herdr-provider.ts` (thêm `closeTabFor(tabKey)`)
- Modify: `src/state/types.ts:437` (ManifestSurfaceState — thêm `tabs?: Record<string, string[]>` runId→tabIds)  *(đơn giản hóa: `tabs?: Record<string, string>` tabKey→tabId hiện tại — 1 run có thể nhiều tab khi >8; dùng `string[]`)*
- Test: `test/unit/runtime/surface/degrade.test.ts`

**Interfaces:**
- Consumes: provider tab-map nội bộ (Task 2/3); `ManifestSurfaceState` shape; `releaseSurfacePane` hiện đóng pane khi worker xong.
- Produces: `SurfaceProvider.closeTab?(tabKey: string): Promise<void>` (optional — tmux `kill-window`, herdr `tab close`); `releaseSurfacePane` chỉ remove entry khỏi manifest, KHÔNG close pane; `finalizeRun` (caller trong team-runner hoặc wherever releaseSurfacePane được gọi lúc run end) gọi `provider.closeTab(runId)` cho mọi tab của run.

- [ ] **Step 1: Write the failing test**

Thêm vào `test/unit/runtime/surface/degrade.test.ts` (đọc file trước để theo pattern fake provider hiện có):

```ts
test("releaseSurfacePane KHÔNG đóng pane (tab sống tới run end); closeTabForRun đóng toàn tab khi run terminal", async () => {
	// Giả lập provider + manifest surface state theo pattern test hiện có trong file.
	// 1) releaseSurfacePane(taskId) → manifest.panes mất entry NHƯNG provider.closeSurface KHÔNG được gọi.
	// 2) closeTabForRun(runId, provider) → provider.closeTab gọi đúng tabId(s) từ manifest.surface.tabs.
	const closedTabs: string[] = [];
	const provider = {
		kind: "herdr",
		closeTab: async (tabKey: string) => { closedTabs.push(tabKey); },
		// … các method khác theo interface fake của file
	} as never;
	const state = { provider: "herdr", panes: { "01_explore": "w2:p5Q" }, tabs: { team_A: ["w2:t1", "w2:t2"] }, workerPids: {}, sessionPaths: {} };
	releaseSurfacePane(state, "01_explore", provider as never); // API theo file thật
	assert.equal(state.panes["01_explore"], undefined, "entry pane được remove");
	// closeSurface không gọi — assert qua spy của fake provider theo pattern file.
	await closeTabForRun(state, "team_A", provider as never);
	assert.deepEqual(closedTabs, [], "closeTab nhận tabId thật — điều chỉnh theo signature thực");
});
```

*(Đọc `degrade.test.ts` + `degrade.ts` vùng releaseSurfacePane trước khi viết test thật để khớp signature — inline trên là khung; test cuối phải assert: release không close-pane, closeTabForRun gọi kill toàn tab từ manifest.tabs.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/degrade.test.ts`
Expected: FAIL — `closeTabForRun` chưa tồn tại; releaseSurfacePane hiện vẫn close pane.

- [ ] **Step 30: Write minimal implementation**

1. `surface-provider.ts` — thêm optional method:

```ts
/** Đóng toàn bộ tab của một run (chỉ gọi khi run end/cancel/kill — spec tab-layout §5). */
closeTab?(tabKey: string): Promise<void>;
```

2. `tmux-provider.ts`:

```ts
async closeTab(tabKey: string): Promise<void> {
	const entry = tabWindows.get(tabKey);
	if (!entry) return;
	tabWindows.delete(tabKey);
	try {
		tmux(["kill-window", "-t", entry.windowId]);
	} catch {
		// window đã mất — idempotent.
	}
}
```

3. `herdr-provider.ts`:

```ts
async closeTab(tabKey: string): Promise<void> {
	const entry = tabMap.get(tabKey);
	if (!entry) return;
	tabMap.delete(tabKey);
	try {
		await call("tab.close", { tab_id: entry.tabId });
	} catch (err) {
		if ((err as Error).message.includes("tab_not_found")) return; // idempotent
		throw err;
	}
}
```

4. `degrade.ts` — trong `releaseSurfacePane`: bỏ call `provider.closeSurface` (chỉ gỡ entry manifest + giữ pane sống); thêm export:

```ts
/** Run end/cancel/kill → đóng toàn tab của run (spec tab-layout §5). */
export async function closeTabForRun(surface: ManifestSurfaceState, tabKey: string, provider: SurfaceProvider): Promise<void> {
	const tabIds = surface.tabs?.[tabKey] ?? [];
	for (const _tabId of tabIds) {
		await provider.closeTab?.(tabKey);
	}
	surface.tabs = { ...(surface.tabs ?? {}), [tabKey]: [] };
}
```

5. Provider khi tạo tab / spawn pane phải **ghi `tabId` vào manifest** — qua outcome: `SurfaceSpawnOutcome` mode "surface" thêm `tabId?: string`; caller (child-pi.ts surface branch) ghi vào `manifest.surface.tabs[runId]` khi chưa có. *(Implementation: trong `createSurface` trả handle; `prepareSurfaceSpawn` lấy tabId qua provider outcome — thêm getter `tabOf(tabKey)` optional hoặc trả trong handle meta. Đơn giản nhất: `SurfaceHandle` thêm `tabId?: string`, provider set khi makeHandle trong tab-flow.)*

```ts
// surface-provider.ts
export interface SurfaceHandle {
	id: string;
	kind: "tmux" | "herdr";
	/** Tab/window chứa pane này (tab-layout) — doctor/cleanup + run-end close. */
	tabId?: string;
	// … giữ nguyên onExit/dispose
}
```

tmux `makeHandle(paneId, tabWindowId)` set `tabId`; herdr `makeHandle(paneId, tabId)` tương tự. `prepareSurfaceSpawn` outcome thêm `tabId: handle.tabId`; caller ghi manifest `surface.tabs[runId] = [...new Set([...(tabs[runId] ?? []), tabId])]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/surface/degrade.test.ts`
Expected: PASS (release không close-pane; closeTabForRun đóng toàn tab).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/surface/degrade.ts src/runtime/surface/tmux-provider.ts src/runtime/surface/herdr-provider.ts src/runtime/surface/surface-provider.ts src/state/types.ts test/unit/runtime/surface/degrade.test.ts
git commit -m "feat(surface): tab sống tới run end — releaseSurfacePane không đóng pane; closeTabForRun đóng toàn tab"
```

---

### Task 6: Doctor cleanup theo tab (đóng tab orphan từ manifest.tabs)

**Files:**
- Modify: `src/extension/team-tool/doctor.ts:522-670` (cleanupOrphanSurfacePanes)
- Test: `test/unit/extension/team-tool/doctor.test.ts` (hoặc file test doctor hiện có — tìm `grep -rln cleanupOrphanSurfacePanes test/`)

**Interfaces:**
- Consumes: `manifest.surface.tabs` (Task 5); provider `closeTab`.
- Produces: doctor dọn pane orphan như cũ + **đóng tab** của run terminal có tabs entry (run finished + tabs chưa rỗng → closeTab).

- [ ] **Step 1: Write the failing test**

Theo pattern test doctor hiện có (tìm `cleanupOrphanSurfacePanes` trong test) — thêm case: manifest run completed có `surface.tabs: {team_A: ["w2:t1"]}` → doctor gọi `provider.closeTab("team_A")` và clear entry.

```ts
test("doctor cleanup: run terminal có surface.tabs → closeTab từng tab + clear", async () => {
	// fake provider bắt closeTab; manifest completed có tabs entry
	// gọi cleanupOrphanSurfacePanes theo signature hiện có của file test
	// assert closeTab được gọi với tabKey; manifest.tabs entry rỗng sau cleanup
});
```

- [ ] **Step 2: Run test to verify it fails**

Run theo file test doctor (tìm chính xác tên: `grep -rln "cleanupOrphanSurfacePanes" test/` rồi chạy file đó).
Expected: FAIL — doctor chưa đọc `surface.tabs` / chưa gọi closeTab.

- [ ] **Step 3: Write minimal implementation**

Trong `cleanupOrphanSurfacePanes` (doctor.ts), sau vòng đóng pane orphan hiện có, thêm:

```ts
// Tab-layout (spec 2026-08-27): run terminal mà tabs entry còn tabId → run
// không finalize sạch (host chết giữa chừng) → đóng tab + clear entry.
for (const manifest of terminalRunManifests) {
	const surface = manifest.surface as { tabs?: Record<string, string[]> } | undefined;
	if (!surface?.tabs) continue;
	for (const [tabKey, tabIds] of Object.entries(surface.tabs)) {
		if (tabIds.length === 0) continue;
		const provider = /* provider theo manifest.surface.provider như vòng pane */;
		await provider?.closeTab?.(tabKey);
		surface.tabs[tabKey] = [];
		// persist manifest theo cơ chế hiện có của vòng pane orphan
	}
}
```

*(Căn chỉnh với biến/thenames thật trong doctor.ts khi implement — vòng pane orphan đã có pattern provider theo kind + persist manifest.)*

- [ ] **Step 4: Run test to verify it passes**

Run file test doctor tương ứng.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/team-tool/doctor.ts test/unit/extension/team-tool/doctor.test.ts
git commit -m "feat(doctor): cleanup đóng tab orphan theo manifest.surface.tabs khi run terminal"
```

---

### Task 7: E2E thật (tmux + herdr) — tab per-run, >8 → tab mới, tab sống tới run end

**Files:**
- Modify: `test/system/surface-tmux.e2e.test.ts` (thêm test tab)
- Modify: `test/system/surface-herdr.e2e.test.ts` (thêm test tab)

**Interfaces:**
- Consumes: toàn bộ Task 1-6; E2E hiện có spawn pane thật qua `runChildPi` → `trySurfaceBranch` → `prepareSurfaceSpawn`.
- Produces: bằng chứng real: mỗi run 1 tab; pane count trong tab; tab đóng khi run end.

- [ ] **Step 1: Viết test E2E tab (tmux)**

Trong `test/system/surface-tmux.e2e.test.ts` thêm test theo pattern test spawn hiện có — spawn 2 worker cùng runId (mock stateRoot cùng run) → assert 1 window mới chứa 2 pane (`tmux list-windows` + `list-panes -t <window>`); sau run end (closeTab) → window biến mất. (Chạy trong tmux thật — test skip khi không có $TMUX như guard hiện có.)

- [ ] **Step 2: Viết test E2E tab (herdr)**

Trong `test/system/surface-herdr.e2e.test.ts` thêm test tương tự qua socket thật: 2 worker cùng runId → `herdr tab list` có 1 tab label runId với ≥2 pane; run end → tab đóng. (Skip guard như hiện có.)

- [ ] **Step 3: Chạy E2E cả 2 backend**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/system/surface-tmux.e2e.test.ts test/system/surface-herdr.e2e.test.ts`
Expected: PASS (tmux cần $TMUX; herdr cần socket sống + không trong tmux — chạy đúng môi trường).

- [ ] **Step 4: Full validate + bundle**

Run: `npm run test:critical && npm run typecheck && npm run build:bundle`
Expected: 102/102 pass (hoặc hơn nếu thêm test critical), typecheck pass, bundle build xong.

- [ ] **Step 5: Commit**

```bash
git add test/system/surface-tmux.e2e.test.ts test/system/surface-herdr.e2e.test.ts
git commit -m "test(surface): E2E tab per-run — 1 tab/run, >8 tab mới, tab sống tới run end"
```

---

## Self-Review

**1. Spec coverage** — check từng mục spec:
- §3.1 SurfaceSpawnOpts tabKey/splitIndex → **Task 1** ✅
- §3.2 tmux new-window + -h/-v + max 8 → **Task 2** ✅
- §3.3 herdr tab.create + right/down + max 8 → **Task 3** ✅
- §3.4 prepareSurfaceSpawn tính tabKey=runId + splitIndex → **Task 4** ✅
- §5 "tab chỉ đóng khi run end/cancel/kill" → **Task 5** ✅ (releaseSurfacePane không đóng pane + closeTabForRun)
- §8 rủi ro doctor dọn tab → **Task 6** ✅
- §6 testing E2E → **Task 7** ✅

**2. Placeholder scan** — Task 5/6/7 có đoạn "(đọc file / căn chỉnh theo pattern)" — chấp nhận được vì hướng dẫn đọc vị trí thật + pattern test có sẵn; KHÔNG có "TBD/TODO/implement later". Task 6 Step 1 test là khung cần điền theo signature thật (đã chỉ rõ cách tìm). *(Nếu muốn chặt hơn, người viết plan nên tự đọc doctor.test.ts + degrade.test.ts trước để inline đầy đủ — đánh dấu để executor đọc file trước khi viết test.)*

**3. Type consistency**:
- `MAX_PANES_PER_TAB = 8` / `splitDirectionFor(index)` — dùng thống nhất Task 1→2→3 ✅
- `tabKey: string, splitIndex: number` trong SurfaceSpawnOpts — Task 1 định nghĩa, Task 2/3/4 tiêu thụ ✅
- `closeTab(tabKey: string): Promise<void>` — Task 5 định nghĩa (provider), Task 6 tiêu thụ ✅
- `SurfaceHandle.tabId?: string` + `ManifestSurfaceState.tabs?: Record<string, string[]>` — Task 5 ✅ (Task 6 đọc cùng shape)
- Lưu ý Task 5: `closeTabForRun(surface, tabKey, provider)` lặp `tabIds` nhưng gọi `closeTab(tabKey)` mỗi lần — signature provider là theo tabKey (không tabId); đơn giản hoá: gọi 1 lần `closeTab(tabKey)` (provider tự đóng mọi window/tab của run theo map nội bộ). **Fix khi implement: bỏ vòng lặp tabIds, chỉ 1 call.**

## Execution Handoff

Plan xong — lưu tại `docs/superpowers/plans/2026-08-27-surface-tab-layout.md`. Hai lựa chọn:

1. **Subagent-Driven (khuyến nghị)** — dispatch fresh subagent per task, review giữa các task.
2. **Inline Execution** — chạy theo plan trong session này.

Chọn cách nào?