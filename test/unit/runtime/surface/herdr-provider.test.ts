/**
 * herdr provider tests (spec §4)
 *
 * Wire format đối chiếu với server herdr 0.8.2 THẬT (protocol 20):
 * - Một request = một connection: connect → 1 dòng request → 1 dòng
 *   response cùng id → server tự đóng. Verified bằng probe trực tiếp
 *   (request thứ hai trên cùng connection → broken pipe).
 * - Subscription là connection dài hạn riêng: ack subscription_started rồi
 *   mỗi dòng sau đó là event pushed, envelope {"event":"pane_closed","data":{...}}
 *   (event kind dùng underscore, KHÔNG có id) — khác docs dot-notation.
 * - pane.read source "visible": "recent" trả text rỗng trên 0.8.2 kể cả
 *   pane đang bận (verified live); "visible" trả đúng nội dung màn hình.
 * Mọi socket đều fake qua deps.connect — không chạm server thật.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHerdrProvider, type HerdrProviderDeps, type HerdrSocket } from "../../../../src/runtime/surface/herdr-provider.ts";
import type { SurfaceExitReason, SurfaceHandle, SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";
import { MAX_PANES_PER_TAB } from "../../../../src/runtime/surface/surface-provider.ts";

/** Request đã parse mà provider gửi xuống socket. */
interface SentRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

/** Fake socket: nắm mọi dòng write, cho phép push response/event + EOF. */
class FakeSocket implements HerdrSocket {
	readonly writes: string[] = [];
	readonly requests: SentRequest[] = [];
	private lineCb: ((line: string) => void) | null = null;
	private closedByProvider = false;
	private readonly respond: (req: SentRequest, sock: FakeSocket) => unknown | undefined;

	constructor(respond: (req: SentRequest, sock: FakeSocket) => unknown | undefined) {
		this.respond = respond;
	}

	write(line: string): void {
		this.writes.push(line);
		const parsed = JSON.parse(line) as SentRequest;
		this.requests.push(parsed);
		const result = this.respond(parsed, this);
		if (result !== undefined) this.pushLine(JSON.stringify({ id: parsed.id, result }));
	}

	onLine(cb: (line: string) => void): void {
		this.lineCb = cb;
	}

	close(): void {
		this.closedByProvider = true;
	}

	/** Test đẩy một dòng thô xuống provider (response/event). */
	pushLine(line: string): void {
		this.lineCb?.(line);
	}

	/** Server đóng socket: onLine nhận dòng rỗng đúng một lần. */
	end(): void {
		this.lineCb?.("");
		this.lineCb = null;
	}

	get isClosed(): boolean {
		return this.closedByProvider;
	}

	get lastRequest(): SentRequest {
		return this.requests[this.requests.length - 1] as SentRequest;
	}
}

interface FakeHarness {
	deps: HerdrProviderDeps;
	env: Record<string, string | undefined>;
	sockets: FakeSocket[];
	/**
	 * Provider dùng CHUNG cho harness — tab-map là per-provider nên các lần
	 * spawnPane cùng harness phải tái dùng một instance (tab.create chỉ chạy
	 * lần đầu cho tabKey mới).
	 */
	provider: () => SurfaceProvider;
	/** Socket đang giữ subscription events (null nếu chưa subscribe). */
	subscription: () => FakeSocket | null;
	/** Đẩy một event pane_closed xuống subscription socket. */
	emitPaneClosed: (paneId: string) => void;
	failNextWith: (code: string, message: string) => void;
}

/** Respond mặc định: split trả pane w3:pC, các method khác trả ok/empty. */
function defaultRespond(req: SentRequest): unknown {
	if (req.method === "tab.create") return { type: "tab_created", tab: { tab_id: "w3:t9" }, root_pane: { pane_id: "w3:pR" } };
	if (req.method === "pane.current") return { type: "pane_current", pane: { pane_id: "w3:pB", workspace_id: "w3" } };
	if (req.method === "pane.split") return { type: "pane_info", pane: { pane_id: "w3:pC", workspace_id: "w3" } };
	if (req.method === "pane.read") return { type: "pane_read", read: { text: "screen content\n" } };
	return { type: "ok" };
}

function makeFake(respond: (req: SentRequest, sock: FakeSocket) => unknown = defaultRespond): FakeHarness {
	const sockets: FakeSocket[] = [];
	const env: Record<string, string | undefined> = {};
	let errorNext: { code: string; message: string } | null = null;
	let subscriptionSocket: FakeSocket | null = null;

	const wrapped: (req: SentRequest, sock: FakeSocket) => unknown = (req, sock) => {
		if (req.method === "events.subscribe") {
			subscriptionSocket = sock;
			return { type: "subscription_started" };
		}
		if (errorNext) {
			const err = errorNext;
			errorNext = null;
			sock.pushLine(JSON.stringify({ id: req.id, error: { code: err.code, message: err.message } }));
			return undefined;
		}
		return respond(req, sock);
	};

	const deps: HerdrProviderDeps = {
		connect: () => {
			const sock = new FakeSocket(wrapped);
			sockets.push(sock);
			return sock;
		},
		env,
	};
	let cachedProvider: SurfaceProvider | null = null;
	return {
		deps,
		env,
		sockets,
		provider: () => (cachedProvider ??= createHerdrProvider(deps)),
		subscription: () => subscriptionSocket,
		emitPaneClosed: (paneId) => {
			subscriptionSocket?.pushLine(
				JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: paneId, workspace_id: "w3" } }),
			);
		},
		failNextWith: (code, message) => {
			errorNext = { code, message };
		},
	};
}

async function spawnPane(
	h: FakeHarness,
	opts?: { command?: string; cwd?: string; title?: string; tabKey?: string; splitIndex?: number },
): Promise<{ provider: SurfaceProvider; handle: SurfaceHandle }> {
	const provider = h.provider();
	const handle = await provider.createSurface("t1", {
		cwd: opts?.cwd ?? "/tmp/wt",
		command: opts?.command ?? "bash /tmp/pi-crew-launch-t1.sh",
		title: opts?.title,
		tabKey: opts?.tabKey,
		splitIndex: opts?.splitIndex,
	});
	return { provider, handle };
}

test("socket path được resolve: HERDR_SOCKET_PATH → HERDR_SESSION → default ~/.config/herdr/herdr.sock", async () => {
	const makeWithEnv = (env: Record<string, string | undefined>) => {
		const paths: string[] = [];
		const deps: HerdrProviderDeps = {
			env,
			connect: (path) => {
				paths.push(path);
				return new FakeSocket(defaultRespond);
			},
		};
		return { deps, paths };
	};

	const withOverride = makeWithEnv({ HERDR_SOCKET_PATH: "/tmp/custom.sock" });
	await createHerdrProvider(withOverride.deps).createSurface("t1", { cwd: "/tmp", command: "bash x.sh" });
	assert.equal(withOverride.paths[0], "/tmp/custom.sock");

	const withSession = makeWithEnv({ HERDR_SESSION: "work" });
	await createHerdrProvider(withSession.deps).createSurface("t1", { cwd: "/tmp", command: "bash x.sh" });
	assert.ok(withSession.paths[0].endsWith("sessions/work/herdr.sock"), withSession.paths[0]);

	const defaults = makeWithEnv({});
	await createHerdrProvider(defaults.deps).createSurface("t1", { cwd: "/tmp", command: "bash x.sh" });
	assert.ok(defaults.paths[0].endsWith(".config/herdr/herdr.sock"), defaults.paths[0]);
});

test("createSurface: env HERDR_PANE_ID ưu tiên làm pane cha — không gọi pane.current, split target_pane_id = HERDR_PANE_ID", async () => {
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W"; // pane của process (đặt bởi herdr khi spawn trong pane)
	const { handle } = await spawnPane(h, { title: "crew:r1:t1" });
	assert.equal(handle.id, "w3:pC");
	// env có → KHÔNG gọi pane.current → method đầu tiên là pane.split
	assert.equal(h.sockets[0]?.requests[0]?.method, "pane.split");
	const split = h.sockets[0]?.requests[0];
	assert.deepEqual(split?.params, {
		direction: "right",
		target_pane_id: "w2:p4W",
		cwd: "/tmp/wt",
		focus: false,
	});
});

test("tabKey per-run: tab.create cho run mới; splitIndex quyết right/down; cùng tabKey tái dùng tab; đầy 8 → tab mới", async () => {
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W"; // env-first (fix 2026-08-27) — không gọi pane.current
	const { handle: h1 } = await spawnPane(h, { title: "01_explore", tabKey: "runA", splitIndex: 0 } as never);
	assert.equal(h1.id, "w3:pC");
	// tab.create phải được gọi cho run mới
	assert.ok(
		h.sockets.some((s) => s.requests[0]?.method === "tab.create"),
		"phải tab.create cho tabKey mới",
	);
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

test("tabKey per-run: đầy MAX_PANES_PER_TAB pane → tab.create tab mới (tabMap ghi đè), worker thứ MAX+1 split vào root_pane của tab MỚI", async () => {
	let tabSeq = 0;
	const h = makeFake((req) => {
		if (req.method === "tab.create") {
			tabSeq += 1;
			return { type: "tab_created", tab: { tab_id: `w3:t${tabSeq}` }, root_pane: { pane_id: `w3:pR${tabSeq}` } };
		}
		return defaultRespond(req);
	});
	// Đầy đúng MAX_PANES_PER_TAB worker vào tab runB — chỉ 1 tab.create.
	for (let i = 0; i < MAX_PANES_PER_TAB; i++) {
		await spawnPane(h, { title: `w${i}`, tabKey: "runB", splitIndex: i });
	}
	assert.equal(tabSeq, 1, "8 worker đầu chung 1 tab");
	// Worker thứ MAX+1 → tab.create thứ 2 (tabMap ghi đè entry cũ), split target
	// là root_pane của tab MỚI (w3:pR2) chứ không phải root của tab cũ (w3:pR1).
	const { handle } = await spawnPane(h, { title: "w8", tabKey: "runB", splitIndex: MAX_PANES_PER_TAB });
	assert.equal(handle.id, "w3:pC");
	assert.equal(tabSeq, 2, "vượt max pane → tab mới");
	const splits = h.sockets.filter((s) => s.requests[0]?.method === "pane.split");
	const lastSplit = splits[splits.length - 1]?.requests[0];
	assert.equal(lastSplit?.params.target_pane_id, "w3:pR2");
	assert.notEqual(lastSplit?.params.target_pane_id, "w3:pR1", "phải split vào root_pane của tab mới");
	assert.deepEqual(lastSplit?.params.direction, "down", "tab mới → luân phiên lại từ index 0");
});

test("tabMap deferred commit: pane.split fail sau tab.create thành công → throw; retry cùng tabKey phải tab.create lại (không reuse), không lệch bước luân phiên", async () => {
	let splitShouldFail = true;
	const h = makeFake((req, sock) => {
		if (req.method === "pane.split" && splitShouldFail) {
			sock.pushLine(JSON.stringify({ id: req.id, error: { code: "split_failed", message: "no space" } }));
			return undefined;
		}
		return defaultRespond(req);
	});
	// Lần 1: tab.create thành công nhưng pane.split lỗi → createSurface throw,
	// tabMap KHÔNG commit (closure commitTabPane chưa chạy).
	await assert.rejects(() => spawnPane(h, { title: "w0", tabKey: "runC", splitIndex: 0 }), /split_failed: no space/);
	assert.equal(h.sockets.filter((s) => s.requests[0]?.method === "tab.create").length, 1);
	// Lần 2 (retry) cùng tabKey: tab chưa có pane hợp lệ nào → phải tab.create
	// LẠI (không vào nhánh reuse), pane đầu của tab mới vẫn direction down.
	splitShouldFail = false;
	h.sockets.length = 0;
	const { handle } = await spawnPane(h, { title: "w0", tabKey: "runC", splitIndex: 0 });
	assert.equal(handle.id, "w3:pC");
	assert.equal(h.sockets[0]?.requests[0]?.method, "tab.create", "retry cùng tabKey phải tab.create lại");
	const split2 = h.sockets.find((s) => s.requests[0]?.method === "pane.split")?.requests[0];
	assert.equal(split2?.params.target_pane_id, "w3:pR");
	assert.deepEqual(split2?.params.direction, "down", "pane đầu của tab mới phải down — luân phiên không lệch bước");
});

test("race concurrency: 2 createSurface cùng tabKey ĐỒNG THỜI → serialize per-tabKey: 1 tab.create, 2 pane.split, direction khác nhau", async () => {
	// Task 4 (review Task 3 — race latent): team-run spawn worker SONG SONG nên
	// 2 createSurface cùng tabKey là kịch bản THẬT. Không serialize: cả 2 đọc
	// tabMap trước khi cái nào commit → 2 tab.create (1 tab mồ côi) hoặc cùng
	// paneIndexInTab (under-count, luân phiên lệch bước).
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W";
	const provider = h.provider();
	// Gọi ĐỒNG THỜI — không await giữa 2 lời gọi.
	const [a, b] = await Promise.all([
		provider.createSurface("t1", { cwd: "/tmp/wt", command: "bash a.sh", title: "w0", tabKey: "runR", splitIndex: 0 }),
		provider.createSurface("t2", { cwd: "/tmp/wt", command: "bash b.sh", title: "w1", tabKey: "runR", splitIndex: 1 }),
	]);
	assert.equal(a.id, "w3:pC");
	assert.equal(b.id, "w3:pC");
	assert.equal(h.sockets.filter((s) => s.requests[0]?.method === "tab.create").length, 1, "chỉ 1 tab.create — tab thứ 2 sẽ là mồ côi");
	const splitReqs = h.sockets.filter((s) => s.requests[0]?.method === "pane.split").map((s) => s.requests[0]);
	assert.equal(splitReqs.length, 2, "mỗi worker một pane.split");
	assert.deepEqual(splitReqs[0]?.params.direction, "down", "worker đầu của tab → index 0 → down");
	assert.deepEqual(splitReqs[1]?.params.direction, "right", "worker hai đọc tabMap SAU commit của worker đầu → index 1 → right");
	assert.equal(splitReqs[1]?.params.target_pane_id, "w3:pR", "cả 2 split vào root pane của CÙNG tab");
	// paneCount đúng 2 sau 2 spawn đồng thời: worker thứ 3 (tuần tự) tiếp tục
	// luân phiên tại index 2 → down, KHÔNG mở tab mới (2/8 pane).
	await provider.createSurface("t3", { cwd: "/tmp/wt", command: "bash c.sh", tabKey: "runR", splitIndex: 2 });
	assert.equal(h.sockets.filter((s) => s.requests[0]?.method === "tab.create").length, 1, "tab còn chỗ → không tab mới");
	const split3 = h.sockets
		.filter((s) => s.requests[0]?.method === "pane.split")
		.map((s) => s.requests[0])
		.at(-1);
	assert.deepEqual(split3?.params.direction, "down", "index 2 (chẵn) → down: paneCount = 2 sau race");
});

test("race concurrency: lần spawn đầu trong chain FAIL → lần sau vẫn chạy (chain không chết)", async () => {
	// tabInFlight lưu bản .catch(() => {}) — promise settled (kể cả reject)
	// thì .then kế chạy ngay; nếu chain chết, MỌI createSurface sau một fail
	// cùng tabKey sẽ reject vĩnh viễn.
	let failFirstSplit = true;
	const h = makeFake((req, sock) => {
		if (req.method === "pane.split" && failFirstSplit) {
			failFirstSplit = false;
			sock.pushLine(JSON.stringify({ id: req.id, error: { code: "split_failed", message: "no space" } }));
			return undefined;
		}
		return defaultRespond(req);
	});
	const provider = h.provider();
	const first = provider.createSurface("t1", { cwd: "/tmp/wt", command: "bash a.sh", title: "w0", tabKey: "runF", splitIndex: 0 });
	const second = provider.createSurface("t2", { cwd: "/tmp/wt", command: "bash b.sh", title: "w1", tabKey: "runF", splitIndex: 1 });
	await assert.rejects(first, /split_failed: no space/);
	assert.equal((await second).id, "w3:pC", "chain phải sống tiếp sau thất bại của lần đầu");
	// Lần đầu fail sau tab.create thành công → deferred-commit không ghi
	// tabMap → lần hai phải tab.create LẠI (không tái dùng tab không pane).
	assert.equal(
		h.sockets.filter((s) => s.requests[0]?.method === "tab.create").length,
		2,
		"lần đầu không commit → lần hai tab.create lại",
	);
});

test("Task 5 tab-layout: handle.tabId = tab của pane; đường legacy (không tabKey) → tabId undefined", async () => {
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W";
	const { handle } = await spawnPane(h);
	assert.equal(handle.tabId, undefined, "spawn ngoài run không thuộc tab nào");
});

test("Task 5 tab-layout: closeTab đóng MỌI tab của run qua tab.close; dọn tabMap → idempotent + spawn lại tab.create lại", async () => {
	let tabSeq = 0;
	const h = makeFake((req) => {
		if (req.method === "tab.create") {
			tabSeq += 1;
			return { type: "tab_created", tab: { tab_id: `w3:t${tabSeq}` }, root_pane: { pane_id: `w3:pR${tabSeq}` } };
		}
		return defaultRespond(req);
	});
	h.env.HERDR_PANE_ID = "w2:p4W";
	const provider = h.provider();
	const h1 = await provider.createSurface("w0", { cwd: "/w", command: "bash a.sh", title: "w0", tabKey: "runT", splitIndex: 0 });
	assert.equal(h1.tabId, "w3:t1", "handle mang tabId để caller ghi manifest surface.tabs");
	for (let i = 1; i < MAX_PANES_PER_TAB; i++) {
		await provider.createSurface(`w${i}`, { cwd: "/w", command: "bash a.sh", title: `w${i}`, tabKey: "runT", splitIndex: i });
	}
	const h9 = await provider.createSurface("w8", {
		cwd: "/w",
		command: "bash a.sh",
		title: "w8",
		tabKey: "runT",
		splitIndex: MAX_PANES_PER_TAB,
	});
	assert.equal(h9.tabId, "w3:t2", "tab thứ 2 của cùng run cũng được track (không leak tab cũ)");
	assert.equal(tabSeq, 2, "precondition: run dùng 2 tab");

	h.sockets.length = 0;
	assert.ok(provider.closeTab, "provider phải implement closeTab (spec tab-layout §5)");
	await provider.closeTab!("runT");
	const closeReqs = h.sockets.map((s) => s.requests[0]).filter((r) => r?.method === "tab.close");
	assert.deepEqual(
		closeReqs.map((r) => r?.params.tab_id),
		["w3:t1", "w3:t2"],
		"closeTab đóng CẢ HAI tab của run — không chỉ tab cuối",
	);
	// Idempotent: tabMap đã dọn → không request nào nữa.
	h.sockets.length = 0;
	await provider.closeTab!("runT");
	assert.equal(h.sockets.filter((s) => s.requests[0]?.method === "tab.close").length, 0);
	// Map đã dọn hoàn toàn: spawn lại cùng tabKey phải tab.create từ đầu (tab mới).
	await provider.createSurface("w9", { cwd: "/w", command: "bash b.sh", title: "w9", tabKey: "runT", splitIndex: 0 });
	assert.equal(h.sockets.filter((s) => s.requests[0]?.method === "tab.create").length, 1, "tabMap dọn sạch → tab.create lại");
});

test("Task 5 tab-layout: closeTab tab_not_found → idempotent không throw; error khác → throw", async () => {
	const h = makeFake();
	h.env.HERDR_PANE_ID = "w2:p4W";
	const provider = h.provider();
	await provider.createSurface("w0", { cwd: "/w", command: "bash a.sh", tabKey: "runN", splitIndex: 0 });
	await provider.createSurface("w1", { cwd: "/w", command: "bash b.sh", tabKey: "runM", splitIndex: 0 });
	h.failNextWith("tab_not_found", "no such tab");
	await provider.closeTab!("runN"); // tab đã mất từ trước → không throw
	h.failNextWith("mux_dead", "server gone");
	await assert.rejects(() => provider.closeTab!("runM"), /mux_dead/);
});

test("Task 6 doctor: closeTabById đóng tab.close theo id — thành công 'closed'; tab_not_found 'gone'; lỗi khác throw", async () => {
	const h = makeFake();
	const provider = h.provider();
	const closeTabById = provider.closeTabById;
	assert.ok(closeTabById, "provider phải implement closeTabById (doctor cleanup Task 6)");

	h.sockets.length = 0;
	assert.equal(await closeTabById.call(provider, "w2:t1"), "closed");
	const req = h.sockets[0]?.requests[0];
	assert.equal(req?.method, "tab.close", "đóng trực tiếp theo tab_id lấy từ manifest");
	assert.equal(req?.params.tab_id, "w2:t1");
	assert.notEqual(req?.method, "closeTab", "KHÔNG đi qua map nội bộ tabKey (trống ở doctor process)");

	// Tab server không còn biết → mux xác nhận "đã mất" = gone, không throw.
	h.failNextWith("tab_not_found", "no such tab");
	assert.equal(await closeTabById.call(provider, "w2:t1"), "gone");

	// Lỗi thật (server chết...) vẫn ném để doctor ghi failure.
	h.failNextWith("mux_dead", "server gone");
	await assert.rejects(() => closeTabById.call(provider, "w2:t1"), /mux_dead/);
});

test("createSurface: env không có HERDR_PANE_ID → fallback pane.current (focus pane) làm pane cha", async () => {
	const h = makeFake(); // env rỗng → fallback pane.current trả w3:pB
	const { handle } = await spawnPane(h, { title: "crew:r1:t1" });
	assert.equal(handle.id, "w3:pC");
	const methods = h.sockets.map((s) => s.requests[0]?.method);
	assert.equal(methods[0], "pane.current");
	const split = h.sockets[1]?.requests[0];
	assert.deepEqual(split?.params, {
		direction: "right",
		target_pane_id: "w3:pB",
		cwd: "/tmp/wt",
		focus: false,
	});
});

test("createSurface: env HERDR_PANE_ID không có + pane.current trả thiếu pane → throw no parent pane", async () => {
	const h = makeFake((req) => {
		if (req.method === "pane.current") return { type: "pane_current", pane: null as never };
		return defaultRespond(req);
	});
	const provider = createHerdrProvider(h.deps);
	await assert.rejects(() => provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" }), /no parent pane/);
});

test("createSurface: full send-text flow — fallback pane.current → pane.split(right) → pane.rename → pane.send_text; mỗi connection một request", async () => {
	const h = makeFake(); // env rỗng → fallback pane.current trả w3:pB
	const { handle } = await spawnPane(h, { title: "crew:r1:t1" });
	assert.equal(handle.id, "w3:pC");
	assert.equal(handle.kind, "herdr");
	// Mỗi request một socket riêng + đúng thứ tự method (title trước khi chạy)
	assert.deepEqual(
		h.sockets.map((s) => s.requests[0]?.method),
		["pane.current", "pane.split", "pane.rename", "pane.send_text"],
	);
	const current = h.sockets[0]?.requests[0];
	assert.deepEqual(current?.params, {});
	const split = h.sockets[1]?.requests[0];
	assert.deepEqual(split?.params, {
		direction: "right",
		target_pane_id: "w3:pB",
		cwd: "/tmp/wt",
		focus: false,
	});
	const rename = h.sockets[2]?.requests[0];
	assert.deepEqual(rename?.params, { pane_id: "w3:pC", label: "crew:r1:t1" });
	const sendText = h.sockets[3]?.requests[0];
	assert.deepEqual(sendText?.params, { pane_id: "w3:pC", text: "bash /tmp/pi-crew-launch-t1.sh\n" });
	// id tăng dần req-N, mỗi dòng là JSON một dòng
	assert.equal(current?.id, "req-1");
	assert.equal(split?.id, "req-2");
	assert.equal(sendText?.id, "req-4");
	for (const s of h.sockets) {
		assert.equal(s.writes.length, 1, "mỗi connection đúng một dòng request");
	}
});

test("createSurface: không title → bỏ pane.rename", async () => {
	const h = makeFake();
	await spawnPane(h);
	assert.ok(!h.sockets.some((s) => s.requests[0]?.method === "pane.rename"));
});

test("createSurface: pane.rename fail → vẫn thành công (title là cosmetic)", async () => {
	const h = makeFake((req, sock) => {
		if (req.method === "pane.rename") {
			sock.pushLine(JSON.stringify({ id: req.id, error: { code: "invalid_params", message: "bad label" } }));
			return undefined;
		}
		return defaultRespond(req);
	});
	const { handle } = await spawnPane(h, { title: "crew:r1:t1" });
	assert.equal(handle.id, "w3:pC");
});

test("createSurface: error response (pane_not_found) → throw kèm code/message", async () => {
	const h = makeFake();
	h.failNextWith("no_pane", "no focused pane");
	const provider = createHerdrProvider(h.deps);
	await assert.rejects(() => provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" }), /no_pane: no focused pane/);
});

test("createSurface: socket chết giữa chừng (EOF trước response) → throw", async () => {
	const h = makeFake((req, sock) => {
		if (req.method === "pane.split") {
			sock.end(); // server đóng trước khi respond
			return undefined;
		}
		return defaultRespond(req);
	});
	const provider = createHerdrProvider(h.deps);
	await assert.rejects(() => provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" }), /herdr socket/);
});

test("onExit: subscription connection riêng, subscribe pane.closed + pane.exited; event pane_closed pane khác bị ignore", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	const sub = h.subscription();
	assert.ok(sub, "phải mở subscription connection");
	assert.deepEqual(sub.requests[0]?.params, {
		subscriptions: [{ type: "pane.closed" }, { type: "pane.exited" }],
	});
	h.emitPaneClosed("w9:zZ"); // pane khác — bỏ qua
	assert.deepEqual(reasons, []);
});

test("onExit: event pane_closed pane mình → 'pane-closed' đúng một lần, tick sau im lặng", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	h.emitPaneClosed("w3:pC");
	assert.deepEqual(reasons, ["pane-closed"]);
	h.emitPaneClosed("w3:pC"); // duplicate — không bắn lần 2
	assert.deepEqual(reasons, ["pane-closed"]);
});

test("onExit: đăng ký sau exit → replay reason ngay", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	handle.onExit(() => undefined);
	h.emitPaneClosed("w3:pC");
	const late: SurfaceExitReason[] = [];
	handle.onExit((r) => late.push(r));
	assert.deepEqual(late, ["pane-closed"]);
});

test("onExit: subscription socket EOF → 'mux-dead' cho mọi handle sống", async () => {
	const h = makeFake();
	const provider = createHerdrProvider(h.deps);
	const first = await provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" });
	const second = await provider.createSurface("t2", { cwd: "/tmp", command: "bash y.sh" });
	const r1: SurfaceExitReason[] = [];
	const r2: SurfaceExitReason[] = [];
	first.onExit((r) => r1.push(r));
	second.onExit((r) => r2.push(r));
	h.subscription()?.end();
	assert.deepEqual(r1, ["mux-dead"]);
	assert.deepEqual(r2, ["mux-dead"]);
});

test("dispose: host dispose → 'detached'; event pane_closed sau đó không bắn thêm", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	handle.dispose();
	assert.deepEqual(reasons, ["detached"]);
	h.emitPaneClosed("w3:pC");
	assert.deepEqual(reasons, ["detached"]);
});

test("dispose handle cuối cùng → đóng subscription socket; dispose sau exit không double-fire", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	handle.dispose();
	assert.equal(h.subscription()?.isClosed, true);
	// pane đóng thật sau dispose → socket đã đóng, không còn event
	assert.deepEqual(reasons, ["detached"]);
});

test("readScreen: pane.read {pane_id, source:'visible', lines}; default 50; trả read.text", async () => {
	const h = makeFake();
	const { provider, handle } = await spawnPane(h);
	const out = await provider.readScreen(handle);
	assert.equal(out, "screen content\n");
	const req = h.sockets.at(-1)?.requests[0];
	assert.equal(req?.method, "pane.read");
	assert.deepEqual(req?.params, { pane_id: "w3:pC", source: "visible", lines: 50 });
	await provider.readScreen(handle, 5);
	assert.deepEqual(h.sockets.at(-1)?.requests[0]?.params, { pane_id: "w3:pC", source: "visible", lines: 5 });
});

test("closeSurface: graceful và force đều pane.close {pane_id} — A1 herdr tự terminate cây process", async () => {
	const h = makeFake();
	const { provider, handle } = await spawnPane(h);
	h.sockets.length = 0;
	await provider.closeSurface(handle);
	assert.deepEqual(h.sockets[0]?.requests[0]?.params, { pane_id: "w3:pC" });
	assert.equal(h.sockets[0]?.requests[0]?.method, "pane.close");
	h.sockets.length = 0;
	await provider.closeSurface(handle, { force: true });
	assert.equal(h.sockets[0]?.requests[0]?.method, "pane.close");
});

test("closeSurface: error pane_not_found → coi như đã đóng (idempotent); error khác → throw", async () => {
	const h = makeFake();
	const { provider, handle } = await spawnPane(h);
	h.failNextWith("pane_not_found", "pane not found");
	await provider.closeSurface(handle); // không throw
	h.failNextWith("internal_error", "boom");
	await assert.rejects(() => provider.closeSurface(handle), /internal_error: boom/);
});

test("readScreen/closeSurface: handle không phải herdr → throw", async () => {
	const h = makeFake();
	const provider = createHerdrProvider(h.deps);
	const alien: SurfaceHandle = { id: "%12", kind: "tmux", onExit: () => undefined, dispose: () => undefined };
	await assert.rejects(() => provider.readScreen(alien), /herdr handle/);
	await assert.rejects(() => provider.closeSurface(alien), /herdr handle/);
});

test("detect: connect thành công → ok; connect throw → !ok kèm reason", () => {
	const h = makeFake();
	const provider = createHerdrProvider(h.deps);
	assert.deepEqual(provider.detect(), { ok: true, kind: "herdr" });
	const hFail = makeFake();
	hFail.deps.connect = () => {
		throw new Error("connect ENOENT");
	};
	const failed = createHerdrProvider(hFail.deps).detect();
	assert.equal(failed.ok, false);
	assert.equal(failed.kind, undefined);
	assert.ok(failed.reason);
});

test("attach: optimistic handle (interface sync không round-trip được) — doctor xác minh aliveness qua readScreen", async () => {
	// Trước đây attach trả null → doctor xếp MỌI orphan herdr là "gone" và
	// không bao giờ đóng pane (bắt được từ E2E herdr 2026-08-27). Giờ trả
	// handle; closeSurface lên pane chết đã idempotent (pane_not_found → ok).
	const h = makeFake();
	const provider = createHerdrProvider(h.deps);
	const handle = provider.attach("w3:pC");
	assert.ok(handle, "attach phải trả handle optimistic");
	assert.equal(handle.id, "w3:pC");
	assert.equal(handle.kind, "herdr");
	assert.equal(h.sockets.length, 0, "attach sync không mở socket");
});

test("wire framing: provider KHÔNG tự nối \\n — defaultConnect's write() wrapper mới là nơi nối (chống frame \\n\\n)", async () => {
	// Bug thật bắt được bởi E2E live (2026-08-27, herdr 0.8.2): frame kết thúc
	// `\n\n` (provider tự nối \n trên wrapper đã nối sẵn) khiến server ĐÓNG
	// subscription connection — empty line bị coi malformed → mọi watcher
	// thành mux-dead. Fake socket thay thế cả wrapper nên pin chiều NGƯỢC:
	// những gì provider đẩy xuống socket PHẢI KHÔNG kết thúc bằng \n. Framing
	// một-\n đúng được pin live bởi test/system/surface-herdr.e2e.test.ts.
	const h = makeFake();
	const { provider, handle } = await spawnPane(h);
	try {
		handle.onExit(() => {});
		const sub = h.subscription();
		assert.ok(sub, "phải có subscription socket");
		let frames = 0;
		for (const sock of h.sockets) {
			for (const w of sock.writes) {
				frames += 1;
				assert.ok(
					!w.endsWith("\n"),
					`frame không được kết thúc newline ở tầng provider (wrapper đã nối), nhận: ${JSON.stringify(w)}`,
				);
			}
		}
		assert.ok(frames > 0, "phải có ít nhất một frame write");
	} finally {
		handle.dispose();
		provider.closeSurface(handle).catch(() => {});
	}
});

test("onExit: event pane_exited (process exit tự nhiên) → 'pane-closed' — herdr 0.8.2 không push pane.closed cho exit tự nhiên", async () => {
	// Bug thật bắt được từ E2E live (2026-08-27): worker herdr xong việc → shell
	// `exit` → pane biến mất khỏi pane.list nhưng KHÔNG có pane_closed — chỉ có
	// pane_exited. Thiếu subscribe này thì mọi worker hoàn thành bình thường
	// treo host tới response deadline 600s.
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	h.subscription()?.pushLine(
		JSON.stringify({ event: "pane_exited", data: { type: "pane_exited", pane_id: "w3:pC", workspace_id: "w3" } }),
	);
	assert.deepEqual(reasons, ["pane-closed"]);
});

test("onExit: subscription đăng ký CẢ hai loại pane.closed + pane.exited", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	handle.onExit(() => {});
	const sub = h.subscription();
	assert.ok(sub, "phải có subscription socket");
	const subscribeReq = sub.requests.find((req) => req.method === "events.subscribe");
	assert.ok(subscribeReq, "phải có request events.subscribe");
	const types = ((subscribeReq?.params?.subscriptions as Array<{ type?: string }>) ?? []).map((s) => s.type);
	assert.ok(types.includes("pane.closed"), `phải subscribe pane.closed, nhận: ${JSON.stringify(types)}`);
	assert.ok(types.includes("pane.exited"), `phải subscribe pane.exited, nhận: ${JSON.stringify(types)}`);
	handle.dispose();
});
