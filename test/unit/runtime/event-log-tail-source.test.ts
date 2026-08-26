/**
 * event-log-tail-source.test.ts — EventLogTailSource + WorkerEventSource
 * (spec §5.3, task S2-T9).
 *
 * Contract:
 * - Tail per-agent `agents/{taskId}/events.jsonl`: watcher change → incremental
 *   read từ byte offset (2+ write liên tiếp đúng thứ tự), truncate (size shrink)
 *   → offset reset về 0, close() dừng watcher (idempotent).
 * - File CHƯA tồn tại lúc start (đường bình thường của surface: worker recorder
 *   tạo file ở event đầu) → source vẫn bắt kịp (bootstrap cho tới khi watch
 *   được gắn).
 * - Dòng JSON `{seq,time,event}` → callback nhận `line.event` (đúng shape
 *   bridgeEventFromJsonEvent tiêu thụ).
 * - Nửa dòng (chunk boundary giữa lần ghi) → giữ lại tới khi đủ `\n`.
 * - StdoutJsonEventSource: bọc child.stdout — JSON lines → compacted events.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { EventLogTailSource, StdoutJsonEventSource } from "../../../src/runtime/event-log-tail-source.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function tmpEventsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tail-"));
	return path.join(dir, "agents", "task-9", "events.jsonl");
}

function line(seq: number, event: Record<string, unknown>): string {
	return `${JSON.stringify({ seq, time: new Date().toISOString(), event })}\n`;
}

async function waitFor(ready: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Đảm bảo dir cha tồn tại trước khi append (test mô phỏng recorder worker). */
function appendLine(target: string, text: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.appendFileSync(target, text, "utf-8");
}

// ── EventLogTailSource ────────────────────────────────────────────────────

describe("EventLogTailSource", () => {
	it("nhận đúng 2 event theo thứ tự qua 2 lần append liên tiếp", async () => {
		const eventsPath = tmpEventsPath();
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, "", "utf-8");

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		source.onEvent((event) => received.push(event));

		appendLine(eventsPath, line(1, { type: "message_end", message: { role: "assistant", text: "one" } }));
		await waitFor(() => received.length >= 1);
		appendLine(eventsPath, line(2, { type: "tool_execution_start", toolName: "bash" }));
		await waitFor(() => received.length >= 2);
		source.close();

		// Payload = `line.event` — đúng shape bridge tiêu thụ (KHÔNG wrap {seq,time}).
		assert.equal(received.length, 2);
		assert.deepEqual(received[0], { type: "message_end", message: { role: "assistant", text: "one" } });
		assert.deepEqual(received[1], { type: "tool_execution_start", toolName: "bash" });
	});

	it("truncate (size shrink) → offset reset, event kế tiếp vẫn nhận", async () => {
		const eventsPath = tmpEventsPath();
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, line(1, { type: "message_end", message: { role: "assistant", text: "x".repeat(200) } }), "utf-8");

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		source.onEvent((event) => received.push(event));
		await waitFor(() => received.length >= 1);

		// Truncate về file NGẮN HƠN offset hiện tại → đọc lại từ 0.
		fs.writeFileSync(eventsPath, line(1, { type: "tr" }), "utf-8");
		await waitFor(() => received.length >= 2);
		source.close();

		assert.deepEqual(received[1], { type: "tr" });
	});

	it("file chưa tồn tại lúc start → vẫn bắt event khi file xuất hiện", async () => {
		const eventsPath = tmpEventsPath(); // chưa tạo dir/file gì cả

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		source.onEvent((event) => received.push(event));

		// Worker recorder tạo file + ghi dòng đầu (đường bình thường của surface).
		appendLine(eventsPath, line(1, { type: "message_end", message: { role: "assistant" } }));
		await waitFor(() => received.length >= 1);
		appendLine(eventsPath, line(2, { type: "b" }));
		await waitFor(() => received.length >= 2);
		source.close();

		assert.deepEqual(received[0], { type: "message_end", message: { role: "assistant" } });
		assert.deepEqual(received[1], { type: "b" });
	});

	it("nửa dòng (ghi giữa ranh giới) → giữ lại tới khi có \\n", async () => {
		const eventsPath = tmpEventsPath();
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, "", "utf-8");

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		source.onEvent((event) => received.push(event));

		const whole = line(1, { type: "split" });
		fs.appendFileSync(eventsPath, whole.slice(0, Math.floor(whole.length / 2)), "utf-8");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(received.length, 0, "chưa có \\n kết thúc → không phát event nửa vời");
		fs.appendFileSync(eventsPath, whole.slice(Math.floor(whole.length / 2)), "utf-8");
		await waitFor(() => received.length >= 1);
		source.close();

		assert.deepEqual(received, [{ type: "split" }]);
	});

	it("close() dừng watcher và idempotent", async () => {
		const eventsPath = tmpEventsPath();
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, "", "utf-8");

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		source.onEvent((event) => received.push(event));

		appendLine(eventsPath, line(1, { type: "before-close" }));
		await waitFor(() => received.length >= 1);

		source.close();
		source.close(); // lần 2 không throw

		appendLine(eventsPath, line(2, { type: "after-close" }));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(received.length, 1, "event sau close() không được phát");
		assert.deepEqual(received[0], { type: "before-close" });
	});

	it("callback throw không giết watcher — event kế tiếp vẫn nhận", async () => {
		const eventsPath = tmpEventsPath();
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, "", "utf-8");

		const received: unknown[] = [];
		const source = new EventLogTailSource({ eventsPath });
		let first = true;
		source.onEvent((event) => {
			if (first) {
				first = false;
				throw new Error("consumer bug");
			}
			received.push(event);
		});

		appendLine(eventsPath, line(1, { type: "boom" }));
		await waitFor(() => !first);
		appendLine(eventsPath, line(2, { type: "still-alive" }));
		await waitFor(() => received.length >= 1);
		source.close();

		assert.deepEqual(received, [{ type: "still-alive" }]);
	});

	it("sourceType = event-log", () => {
		const source = new EventLogTailSource({ eventsPath: tmpEventsPath() });
		assert.equal(source.sourceType, "event-log");
		source.close();
	});
});

// ── StdoutJsonEventSource ─────────────────────────────────────────────────

describe("StdoutJsonEventSource", () => {
	it("stdout JSON lines → compacted events theo thứ tự (chunk boundary bất kỳ)", async () => {
		const chunks = [
			'{"type":"tool_execution_start","toolName":"bash","args":{"c',
			'md":"ls"},"extra":"stripped"}\n{"type":"message_end","mess',
			'age":{"role":"assistant","usage":{"input":10,"output":5}}}\n',
			"not-json-line\n",
		];
		const stdout = Readable.from(chunks);
		const received: unknown[] = [];
		const source = new StdoutJsonEventSource({ stdout });
		source.onEvent((event) => received.push(event));
		await new Promise((resolve) => setTimeout(resolve, 150));
		source.close();

		assert.equal(received.length, 2);
		// Compact shape như ChildPiLineObserver: tool events giữ toolName+args.
		assert.deepEqual(received[0], { type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } });
		const second = received[1] as Record<string, unknown>;
		assert.equal(second.type, "message_end");
	});

	it("close() detach stdout — data sau close không phát event", async () => {
		const stdout = new Readable({
			// biome-ignore lint/suspicious/noEmptyBlockStatements: fixture đẩy dữ liệu qua stdout.push() từ ngoài
			read() {},
		});
		const received: unknown[] = [];
		const source = new StdoutJsonEventSource({ stdout });
		source.onEvent((event) => received.push(event));

		stdout.push('{"type":"before"}\n');
		await waitFor(() => received.length >= 1);
		source.close();
		stdout.push('{"type":"after"}\n');
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(received.length, 1);
	});

	it("sourceType = stdout", () => {
		const source = new StdoutJsonEventSource({ stdout: Readable.from([]) });
		assert.equal(source.sourceType, "stdout");
		source.close();
	});
});
