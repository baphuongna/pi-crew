/**
 * event-log-tail-source.ts — WorkerEventSource cho surface workers (spec §5.3).
 *
 * Headless workers phát events qua stdout JSON stream; surface workers chạy
 * TUI trong pane mux — không có stream nào cả — nên worker-side recorder
 * (S2-T8, prompt/surface-worker.ts) tự ghi per-agent
 * `agents/{taskId}/events.jsonl` theo đúng dòng `{seq,time,event}` host vẫn
 * viết (crew-agent-records.ts appendCrewAgentEvent). `EventLogTailSource` là
 * nửa host của hợp đồng đó: tail file này và phát lại `line.event` — payload
 * compacted pi event, tức đúng shape `bridgeEventFromJsonEvent` tiêu thụ (và
 * đúng shape `ChildPiLineObserver` phát cho `onJsonEvent` ở đường headless).
 *
 * Đọc incremental: watcher callback (fs.watch qua watchWithErrorHandler) chỉ
 * báo "có đổi" — SOURCE tự giữ byte offset (spec §5.3: caller quản position).
 * stat size > offset → readSync từ offset; size shrink (truncate) → reset về
 * 0; nửa dòng chưa có `\n` được giữ lại tới khi đủ. File chưa tồn tại lúc
 * start là ĐƯỜNG BÌNH THƯỜNG của surface (recorder tạo file ở event đầu, thậm
 * chí mkdir lười) — source bootstrap bằng poll nhẹ cho tới khi gắn được
 * watcher, rồi tắt poll.
 *
 * FEEDBACK-LOOP GUARD (đọc trước khi nối consumer): host KHÔNG ĐƯỢC đưa events
 * này vào chuỗi `onJsonEvent` của task-runner — callback đó gọi
 * `appendCrewAgentEventBuffered` ghi vào CHÍNH file này (worker đã ghi rồi,
 * §5.3 "transcript per-agent: worker-side recorder") → mỗi dòng bị ghi hai
 * lần và watcher tự kích hoạt chính nó (watch → append → watch …) không dừng.
 * Call site (child-pi.ts) chỉ bridge qua `bridgeEventFromJsonEvent` +
 * `runEventBus` cho dashboard/sidebar — không đụng disk.
 *
 * StdoutJsonEventSource: adapter mỏng của đường headless — bọc child.stdout,
 * tách dòng, compact qua `compactChildPiEvent` (cùng compaction recorder
 * worker dùng) và phát event. Đường headless CHÍNH vẫn giữ nguyên wiring
 * ChildPiLineObserver của nó (transcript/raw-text/steering không đổi); class
 * này tồn tại để cả hai nguồn cùng implement một interface cho consumer chung.
 */

import * as fs from "node:fs";
import type { Readable } from "node:stream";

import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { compactChildPiEvent } from "./child-pi/child-pi-streams.ts";

/**
 * Payload cả hai source phát: compacted pi event (`{type, ...}`) — INPUT shape
 * của `bridgeEventFromJsonEvent`, OUTPUT shape của `ChildPiLineObserver` /
 * worker recorder. Spec §5.3 phác callback là `StreamBridgeEvent`, nhưng không
 * source constructor nào mang runId/taskId để build shape đó; bridging thuộc
 * call site (child-pi.ts) nơi đủ ngữ cảnh.
 */
export type WorkerEventPayload = unknown;

export interface WorkerEventSource {
	/** Phân biệt nguồn — consumer chặn re-append cho "event-log" (xem header). */
	readonly sourceType: "stdout" | "event-log";
	/** Đăng ký callback nhận event (một source một callback — gọi lại là thay). */
	onEvent(cb: (event: WorkerEventPayload) => void): void;
	/** Dừng watcher/timer, detach stream. Idempotent, sync. */
	close(): void;
}

/** Nhịp poll bootstrap khi chưa watch được file (mặc định 250ms). */
export const TAIL_BOOTSTRAP_POLL_MS = 250;

interface TailDeps {
	/** Timer override cho test. */
	setTimeoutFn?: (fn: () => void, ms: number) => unknown;
	clearTimeoutFn?: (timer: unknown) => void;
}

export class EventLogTailSource implements WorkerEventSource {
	readonly sourceType = "event-log" as const;

	private readonly eventsPath: string;
	private readonly deps: TailDeps;
	private callback: ((event: WorkerEventPayload) => void) | undefined;
	private watcher: fs.FSWatcher | null = null;
	private bootstrapTimer: unknown;
	private closed = false;
	/** Cờ chống drain-before-close đệ quy (consumer close() trong callback). */
	private draining = false;
	/** Byte offset đã đọc tới — tự giữ qua các lần watcher báo đổi. */
	private offset = 0;
	/** Nửa dòng chưa kết thúc `\n` — giữ tới lần đọc kế tiếp. */
	private partial = "";

	constructor(input: { eventsPath: string }, deps: TailDeps = {}) {
		this.eventsPath = input.eventsPath;
		this.deps = deps;
	}

	onEvent(cb: (event: WorkerEventPayload) => void): void {
		this.callback = cb;
		if (this.closed) return;
		// Bắt kịp nội dung có sẵn (event landed trước khi source được dựng),
		// rồi gắn watcher. File chưa có → bootstrap poll.
		this.readFromOffset();
		this.attachWatcher();
	}

	close(): void {
		if (this.closed) return;
		// Final catch-up (bắt được từ E2E herdr thật, 2026-08-27): pane surface
		// có thể đóng rất nhanh sau worker.completed — host close ngay khi thấy
		// result, TRƯỚC cả nhịp bootstrap poll 250ms kế tiếp kịp attach file
		// agent-log (herdr socket nhanh; tmux chậm hơn nên thắng race). Đọc lần
		// cuối đồng bộ để mọi dòng worker đã ghi vẫn tới consumer (dashboard,
		// T11 controller pid) trước khi source chết.
		this.drainBeforeClose();
		this.closed = true;
		closeWatcher(this.watcher);
		this.watcher = null;
		if (this.bootstrapTimer !== undefined) {
			const clear = this.deps.clearTimeoutFn ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
			clear(this.bootstrapTimer);
			this.bootstrapTimer = undefined;
		}
	}

	/** Drain một lần, chống đệ quy khi consumer gọi close() ngay trong callback. */
	private drainBeforeClose(): void {
		if (this.draining) return;
		this.draining = true;
		try {
			this.readFromOffset();
		} finally {
			this.draining = false;
		}
	}

	private attachWatcher(): void {
		if (this.closed || this.watcher) return;
		// `created` phải là let-null (không phải const gán kết quả) — onError có
		// thể chạy ĐỒNG BỘ bên trong watchWithErrorHandler khi fs.watch throw,
		// trước khi kết quả gán xong (TDZ).
		let created: fs.FSWatcher | null = null;
		const onError = (error?: unknown): void => {
			if (created && this.watcher !== created) return; // watcher cũ lỗi muộn
			this.watcher = null;
			if (created) closeWatcher(created);
			logInternalError(
				"event-log-tail.watch",
				error instanceof Error ? error : new Error(String(error)),
				`eventsPath=${this.eventsPath}`,
				"warn",
			);
			// Watcher chết giữa chừng (file bị unlink…) — bootstrap lại; tick
			// poll tự giới hạn nhịp nên không thành vòng quay nóng.
			this.scheduleBootstrap();
		};
		created = watchWithErrorHandler(this.eventsPath, () => this.readFromOffset(), onError);
		if (created) this.watcher = created;
		else this.scheduleBootstrap(); // fs.watch unsupported / file chưa tồn tại
	}

	private scheduleBootstrap(): void {
		if (this.closed || this.bootstrapTimer !== undefined || this.watcher) return;
		const set = this.deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
		const timer = set(() => {
			this.bootstrapTimer = undefined;
			if (this.closed) return;
			this.readFromOffset();
			this.attachWatcher();
			if (!this.watcher) this.scheduleBootstrap();
		}, TAIL_BOOTSTRAP_POLL_MS);
		this.bootstrapTimer = timer;
		// Poll bootstrap không được giữ event loop sống — surface branch đã có
		// waitForSurfaceExit lo việc chờ.
		(timer as { unref?: () => void } | null)?.unref?.();
	}

	/** Đọc từ offset tới cuối file; truncate → reset offset; phát từng dòng JSON. */
	private readFromOffset(): void {
		if (this.closed) return;
		let size: number;
		try {
			size = fs.statSync(this.eventsPath).size;
		} catch {
			// File biến mất (chưa từng có, hoặc bị dọn giữa attempt) — đọc lại từ
			// 0 khi nó (tái)xuất hiện, đúng semantics truncate.
			this.offset = 0;
			this.partial = "";
			return;
		}
		if (size < this.offset) {
			// Shrink = truncate/replace → bỏ vị trí cũ, đọc lại toàn bộ.
			this.offset = 0;
			this.partial = "";
		}
		if (size === this.offset) return;
		let chunk: string;
		let bytesRead: number;
		try {
			const fd = fs.openSync(this.eventsPath, "r");
			try {
				const length = size - this.offset;
				const buffer = Buffer.alloc(length);
				// File có thể đổi giữa statSync và readSync (worker đang append /
				// truncate): bytesRead là sự thật, stat size chỉ là dự đoán.
				bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
				chunk = buffer.toString("utf-8", 0, bytesRead);
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			logInternalError(
				"event-log-tail.read",
				error instanceof Error ? error : new Error(String(error)),
				`eventsPath=${this.eventsPath}`,
				"warn",
			);
			return;
		}
		this.offset += bytesRead;

		const lines = (this.partial + chunk).split("\n");
		this.partial = lines.pop() ?? ""; // giữ nửa dòng cuối (chưa có \n)
		for (const text of lines) {
			if (!text.trim()) continue;
			let parsed: { event?: unknown };
			try {
				parsed = JSON.parse(text) as { event?: unknown };
			} catch {
				// Dòng hỏng/dở — bỏ qua, không làm kẹt cả stream.
				logInternalError("event-log-tail.parse", new Error("unparseable JSONL line"), `eventsPath=${this.eventsPath}`, "debug");
				continue;
			}
			if (parsed.event === null || typeof parsed.event !== "object") continue;
			try {
				this.callback?.(parsed.event);
			} catch (error) {
				// Consumer bug không được giết watcher — event kế tiếp vẫn phải tới.
				logInternalError("event-log-tail.callback", error instanceof Error ? error : new Error(String(error)), undefined, "warn");
			}
		}
	}
}

/** Adapter mỏng của đường headless: child.stdout JSON lines → compacted events. */
export class StdoutJsonEventSource implements WorkerEventSource {
	readonly sourceType = "stdout" as const;

	private readonly stdout: Readable;
	private callback: ((event: WorkerEventPayload) => void) | undefined;
	private buffer = "";
	private attached = false;

	constructor(child: { stdout: Readable }) {
		this.stdout = child.stdout;
	}

	onEvent(cb: (event: WorkerEventPayload) => void): void {
		this.callback = cb;
		if (this.attached) return;
		this.attached = true;
		this.stdout.on("data", this.onData);
		// Stream kết thúc → flush nửa dòng còn đọng (nếu là JSON trọn vẹn).
		this.stdout.once("end", this.onEnd);
	}

	close(): void {
		this.attached = false;
		this.callback = undefined;
		this.stdout.removeListener("data", this.onData);
		this.stdout.removeListener("end", this.onEnd);
	}

	private readonly onData = (chunk: Buffer | string): void => {
		this.observe(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
	};

	private readonly onEnd = (): void => {
		this.observe("\n");
	};

	private observe(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // dòng không phải JSON — đường headless cũng bỏ qua
			}
			const compacted = compactChildPiEvent(parsed);
			if (compacted === undefined) continue;
			try {
				this.callback?.(compacted);
			} catch (error) {
				logInternalError(
					"stdout-json-event.callback",
					error instanceof Error ? error : new Error(String(error)),
					undefined,
					"warn",
				);
			}
		}
	}
}
