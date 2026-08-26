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
	/** Socket đang giữ subscription events (null nếu chưa subscribe). */
	subscription: () => FakeSocket | null;
	/** Đẩy một event pane_closed xuống subscription socket. */
	emitPaneClosed: (paneId: string) => void;
	failNextWith: (code: string, message: string) => void;
}

/** Respond mặc định: split trả pane w3:pC, các method khác trả ok/empty. */
function defaultRespond(req: SentRequest): unknown {
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
	return {
		deps,
		env,
		sockets,
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
	opts?: { command?: string; cwd?: string; title?: string },
): Promise<{ provider: SurfaceProvider; handle: SurfaceHandle }> {
	const provider = createHerdrProvider(h.deps);
	const handle = await provider.createSurface("t1", {
		cwd: opts?.cwd ?? "/tmp/wt",
		command: opts?.command ?? "bash /tmp/pi-crew-launch-t1.sh",
		title: opts?.title,
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

test("createSurface: pane.current → pane.split(right, từ pane hiện tại, cwd) → pane.send_text; mỗi request một connection", async () => {
	const h = makeFake();
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

test("onExit: subscription connection riêng, subscribe pane.closed; event pane_closed pane khác bị ignore", async () => {
	const h = makeFake();
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	const sub = h.subscription();
	assert.ok(sub, "phải mở subscription connection");
	assert.deepEqual(sub.requests[0]?.params, { subscriptions: [{ type: "pane.closed" }] });
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

test("attach: chưa hỗ trợ trong A1 → null", async () => {
	const h = makeFake();
	const provider = createHerdrProvider(h.deps);
	assert.equal(provider.attach("w3:pC"), null);
	assert.equal(h.sockets.length, 0);
});
