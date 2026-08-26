/**
 * herdr SurfaceProvider (spec §4) — Socket API NDJSON client
 *
 * Wire format đối chiếu trực tiếp với server herdr 0.8.2 (protocol 20) qua
 * `herdr api schema --json` + probe trên socket thật (2026-08-26):
 * - MỖI REQUEST MỘT CONNECTION: connect → 1 dòng request `{"id","method","params"}`
 *   → 1 dòng response cùng id → server tự đóng (request thứ hai trên cùng
 *   connection nhận broken pipe). Verified thực nghiệm.
 * - Subscription là connection dài hạn riêng: ack `subscription_started` rồi
 *   mỗi dòng sau là event pushed với envelope `{"event":"pane_closed","data":{...}}`
 *   — event kind DÙNG UNDERSCORE và KHÔNG có id (khác request/response).
 * - Socket path resolution theo docs herdr.dev/docs/socket-api:
 *   HERDR_SOCKET_PATH → HERDR_SESSION (sessions/<name>/herdr.sock) → default.
 *
 * onExit: MỘT subscription connection chung cho cả provider (lazy — mở khi
 * handle đầu tiên đăng ký onExit), subscribe `pane.closed` server-wide rồi
 * filter theo pane_id client-side (schema không hỗ trợ filter pane_id cho
 * pane.closed). Subscription socket EOF (server chết/restart) → "mux-dead"
 * cho mọi handle còn sống.
 *
 * closeSurface A1: herdr không có signal-theo-pid trên socket API —
 * `pane.close` để herdr tự terminate cả cây process trong pane, nên graceful
 * và force cùng đường (khác tmux provider). TODO(A2): kill theo pid worker
 * từ manifest (pane.process_info) trước khi pane.close cho graceful thật.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { SurfaceDetection, SurfaceExitReason, SurfaceHandle, SurfaceProvider, SurfaceSpawnOpts } from "./surface-provider.ts";

/**
 * Socket abstraction injectable. Quy ước EOF/error: onLine được gọi đúng một
 * lần với chuỗi rỗng khi server đóng connection (đối chiếu NDJSON — dòng
 * rỗng không bao giờ là message hợp lệ).
 */
export interface HerdrSocket {
	write(line: string): void;
	onLine(cb: (line: string) => void): void;
	close(): void;
}

/** Dependencies injectable — mọi I/O đều thay được để unit test không chạm server thật. */
export interface HerdrProviderDeps {
	/** Mở connection tới socket path. Throw khi không connect được. */
	connect?: (path: string) => HerdrSocket;
	/** Nguồn HERDR_SOCKET_PATH / HERDR_SESSION (default process.env). */
	env?: NodeJS.ProcessEnv;
}

/** herdr socket path theo docs: HERDR_SOCKET_PATH → HERDR_SESSION → default. */
export function herdrSocketPath(env: NodeJS.ProcessEnv): string {
	if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
	if (env.HERDR_SESSION) {
		return path.join(os.homedir(), ".config", "herdr", "sessions", env.HERDR_SESSION, "herdr.sock");
	}
	return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

/** Default connect: unix socket NDJSON. accessSync fail-fast cho detect sync. */
function defaultConnect(socketPath: string): HerdrSocket {
	fs.accessSync(socketPath);
	// KHÔNG unref: request socket tự đóng sau response (vài ms), còn
	// subscription socket PHẢI giữ event loop sống khi còn pane cần theo dõi —
	// unref khiến process exit giữa chừng với promise pending.
	const socket = net.createConnection({ path: socketPath });
	let lineCb: ((line: string) => void) | null = null;
	let buffer = "";
	let ended = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let idx = buffer.indexOf("\n");
		while (idx !== -1) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim()) lineCb?.(line);
			idx = buffer.indexOf("\n");
		}
	});
	const onEnd = (): void => {
		if (ended) return;
		ended = true;
		lineCb?.("");
		lineCb = null;
	};
	socket.on("close", onEnd);
	socket.on("error", onEnd);
	return {
		write(line) {
			socket.write(`${line}\n`);
		},
		onLine(cb) {
			lineCb = cb;
		},
		close() {
			socket.destroy();
		},
	};
}

/** Một dòng response/error từ server (đã parse). */
interface WireResponse {
	id?: string;
	result?: { type?: string } & Record<string, unknown>;
	error?: { code?: string; message?: string };
}

/** Một dòng event pushed trên subscription connection (đã parse). */
interface WireEvent {
	event?: string;
	data?: { pane_id?: string };
}

/** Watcher theo pane id — callback list + trạng thái exit cho replay. */
interface PaneWatcher {
	callbacks: Array<(reason: SurfaceExitReason) => void>;
	exited: boolean;
	reason?: SurfaceExitReason;
}

export function createHerdrProvider(deps: HerdrProviderDeps = {}): SurfaceProvider {
	const env = deps.env ?? process.env;
	const connect = deps.connect ?? defaultConnect;

	const watchers = new Map<string, PaneWatcher>();
	let reqSeq = 0;
	let subscription: HerdrSocket | null = null;
	let subscriptionCb: ((line: string) => void) | null = null;

	function activeWatchers(): number {
		let active = 0;
		for (const watcher of watchers.values()) if (!watcher.exited) active += 1;
		return active;
	}

	/** Bắn reason MỘT lần cho mọi callback của pane (copy list — cb có thể dispose). */
	function fire(paneId: string, reason: SurfaceExitReason): void {
		const watcher = watchers.get(paneId);
		if (!watcher || watcher.exited) return;
		watcher.exited = true;
		watcher.reason = reason;
		for (const cb of [...watcher.callbacks]) cb(reason);
		maybeCloseSubscription();
	}

	function maybeCloseSubscription(): void {
		if (!subscription || activeWatchers() > 0) return;
		subscription.close();
		subscription = null;
		subscriptionCb = null;
	}

	/**
	 * Gửi một request trên connection riêng (verified: server đóng sau response).
	 * Đóng socket ngay khi có kết quả — id tăng dần req-N toàn provider.
	 */
	function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		reqSeq += 1;
		const id = `req-${reqSeq}`;
		return new Promise<T>((resolve, reject) => {
			let socket: HerdrSocket;
			try {
				socket = connect(herdrSocketPath(env));
			} catch (err) {
				reject(new Error(`herdr socket unavailable: ${(err as Error).message}`));
				return;
			}
			let settled = false;
			socket.onLine((line) => {
				if (settled) return;
				if (!line) {
					// EOF trước response — server chết giữa chừng.
					settled = true;
					socket.close();
					reject(new Error(`herdr socket closed before response to ${id} (${method})`));
					return;
				}
				let msg: WireResponse;
				try {
					msg = JSON.parse(line) as WireResponse;
				} catch {
					return; // dòng lệch format — bỏ qua, chờ response thật
				}
				if (msg.id !== id) return;
				settled = true;
				socket.close();
				if (msg.error) {
					reject(new Error(`${msg.error.code ?? "herdr_error"}: ${msg.error.message ?? "unknown error"}`));
					return;
				}
				resolve(msg.result as T);
			});
			socket.write(JSON.stringify({ id, method, params }));
		});
	}

	/** Dispatch một dòng trên subscription connection: event hoặc EOF. */
	function onSubscriptionLine(line: string): void {
		if (!line) {
			// Server đóng subscription socket — mọi handle còn sống thành mux-dead.
			subscription = null;
			subscriptionCb = null;
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		let msg: WireEvent;
		try {
			msg = JSON.parse(line) as WireEvent;
		} catch {
			return;
		}
		if (msg.event !== "pane_closed") return;
		const paneId = msg.data?.pane_id;
		if (typeof paneId === "string" && watchers.has(paneId)) fire(paneId, "pane-closed");
	}

	/**
	 * Mở (một lần) subscription connection khi handle đầu tiên cần onExit.
	 * Lazy như ensureTimer của tmux provider — không giữ socket khi không
	 * theo dõi pane nào. Subscribe fail → mux-dead mọi watcher sống.
	 * Note: pane đóng giữa split xong và onExit đầu tiên sẽ mất event —
	 * caller đăng ký onExit ngay sau createSurface nên gap chỉ tính ms.
	 */
	function ensureSubscription(): void {
		if (subscription) return;
		reqSeq += 1;
		const id = `req-${reqSeq}`;
		let socket: HerdrSocket;
		try {
			socket = connect(herdrSocketPath(env));
		} catch {
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		subscription = socket;
		subscriptionCb = onSubscriptionLine;
		socket.onLine((line) => subscriptionCb?.(line));
		socket.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: [{ type: "pane.closed" }] } }));
		// Ack subscription_started cũng đi qua onSubscriptionLine — JSON hợp lệ
		// nhưng thiếu envelope event nên bị bỏ qua một cách vô hại.
	}

	function makeHandle(paneId: string): SurfaceHandle {
		return {
			id: paneId,
			kind: "herdr",
			onExit(cb) {
				let watcher = watchers.get(paneId);
				if (!watcher) {
					watcher = { callbacks: [], exited: false };
					watchers.set(paneId, watcher);
				}
				watcher.callbacks.push(cb);
				// Đăng ký sau exit → replay reason ngay để không mất event.
				if (watcher.exited) {
					cb(watcher.reason as SurfaceExitReason);
					return;
				}
				ensureSubscription();
			},
			dispose() {
				const watcher = watchers.get(paneId);
				if (!watcher) return;
				// Host chủ động dispose khi pane còn sống → "detached" cho listener.
				if (!watcher.exited) fire(paneId, "detached");
				watchers.delete(paneId);
				maybeCloseSubscription();
			},
		};
	}

	function assertHerdrHandle(handle: SurfaceHandle): void {
		if (handle.kind !== "herdr") {
			throw new Error(`Expected a herdr handle, got kind "${handle.kind}" (id ${handle.id})`);
		}
	}

	return {
		kind: "herdr",

		detect(): SurfaceDetection {
			// Cheap probe: connect được tới socket là ok. Full liveness ping
			// (ping + timeout) là trách nhiệm resolveSurface (T2, pingSocketSync)
			// — SurfaceDetection sync nên provider không đợi response ở đây.
			try {
				const socket = connect(herdrSocketPath(env));
				socket.close();
				return { ok: true, kind: "herdr" };
			} catch (err) {
				return { ok: false, reason: `herdr socket unavailable: ${(err as Error).message}` };
			}
		},

		async createSurface(_name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle> {
			// Pane cha = pane đang focus của server (caller_pane_id chỉ đáng tin
			// khi pi chạy trong pane herdr; focused pane an toàn cho cả hai).
			const current = await call<{ pane?: { pane_id?: string } }>("pane.current", {});
			const parentPaneId = current.pane?.pane_id;
			if (!parentPaneId) throw new Error("pane.current returned no pane_id — no focused pane?");
			const split = await call<{ pane?: { pane_id?: string } }>("pane.split", {
				direction: "right",
				target_pane_id: parentPaneId,
				cwd: opts.cwd,
				focus: false,
			});
			const paneId = split.pane?.pane_id;
			if (!paneId) throw new Error("pane.split returned no pane_id");
			if (opts.title) {
				try {
					await call("pane.rename", { pane_id: paneId, label: opts.title });
				} catch {
					// Title là cosmetic — pane vẫn dùng được.
				}
			}
			// Command đã build sẵn ("bash <script-path>") — gửi literal + newline.
			await call("pane.send_text", { pane_id: paneId, text: `${opts.command}\n` });
			return makeHandle(paneId);
		},

		attach(_id: string): SurfaceHandle | null {
			// A1: attach cần request đồng bộ (pane.get) mà SurfaceProvider.attach
			// là sync — defer đến khi runtime thật cần re-attach (A2).
			return null;
		},

		async readScreen(handle: SurfaceHandle, lines = 50): Promise<string> {
			assertHerdrHandle(handle);
			// source "visible" — verified live trên herdr 0.8.2: "recent"/"recent_unwrapped"
			// trả text rỗng kể cả trên pane đang bận, còn "visible" trả đúng nội
			// dung màn hình (đúng ngữ nghĩa "current screen" của interface).
			const result = await call<{ read?: { text?: string } }>("pane.read", {
				pane_id: handle.id,
				source: "visible",
				lines: Math.max(1, lines),
			});
			return result.read?.text ?? "";
		},

		async closeSurface(handle: SurfaceHandle, _opts?: { force?: boolean }): Promise<void> {
			assertHerdrHandle(handle);
			// A1: graceful lẫn force đều pane.close — herdr terminate cả cây
			// process trong pane (xem header TODO(A2) cho graceful theo pid).
			try {
				await call("pane.close", { pane_id: handle.id });
			} catch (err) {
				// Pane đã mất từ trước → mục tiêu đạt được, idempotent.
				if ((err as Error).message.includes("pane_not_found")) return;
				throw err;
			}
		},
	};
}
