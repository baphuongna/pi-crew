/**
 * Provider capability cho spawn flow Task 7 + prepareSurfaceSpawn (spec §13.1).
 *
 * Contract:
 * - `createSurface` có thể tạo pane MÀ KHÔNG gửi command gì cả (opts.command
 *   undefined → không send-keys / pane.send_text) — flow §13.1 cần pane id
 *   TRƯỚC khi build script (env PI_CREW_SURFACE_PANE = id thật), rồi mới gửi
 *   `bash <script>`.
 * - `sendCommand(handle, text)` gửi literal text vào pane đang sống (cả tmux
 *   lẫn herdr) — cách host boot worker sau khi script đã sẵn sàng.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrProvider, type HerdrSocket } from "../../../../src/runtime/surface/herdr-provider.ts";
import type { SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";
import { createTmuxProvider } from "../../../../src/runtime/surface/tmux-provider.ts";

const CWD = "/tmp/project";

test("tmux createSurface with no command only splits (+titles) and does not send keys", async () => {
	const calls: string[][] = [];
	const provider = createTmuxProvider({
		env: { TMUX: "/tmp/tmux,test,0", TMUX_PANE: "%0" },
		tmux: (args) => {
			calls.push(args);
			return "%7\n";
		},
	});
	const handle = await provider.createSurface("01_explore", { cwd: CWD });
	assert.equal(handle.id, "%7");
	assert.ok(
		calls.every((args) => args[0] !== "send-keys"),
		"không được gửi phím khi command bỏ trống",
	);
	assert.equal(calls[0][0], "split-window", "split-window vẫn phải chạy để lấy pane id");
});

test("tmux sendCommand sends literal text then Enter into the handle's pane", async () => {
	const calls: string[][] = [];
	let sendPaneId = "";
	const provider = createTmuxProvider({
		env: { TMUX: "/tmp/tmux,test,0", TMUX_PANE: "%0" },
		tmux: (args) => {
			calls.push(args);
			if (args[0] === "split-window") return "%9\n";
			return "";
		},
	});
	const handle = await provider.createSurface("t", { cwd: CWD });
	sendPaneId = handle.id;
	calls.length = 0;
	await provider.sendCommand!(handle, "bash '/tmp/x.sh'");
	const sent = calls.filter((args) => args[0] === "send-keys");
	assert.equal(sent.length, 2, "literal text + Enter");
	assert.deepEqual(sent[0], ["send-keys", "-t", sendPaneId, "-l", "bash '/tmp/x.sh'"]);
	assert.deepEqual(sent[1], ["send-keys", "-t", sendPaneId, "Enter"]);
});

/** Provider herdr giả với scripted responses theo method — ghi lại mọi request. */
function makeFakeHerdrProvider(responsesByMethod: Record<string, unknown>): {
	provider: SurfaceProvider;
	requests: Array<{ method: string; params: Record<string, unknown> }>;
} {
	const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	let seq = 0;
	const provider = createHerdrProvider({
		connect(): HerdrSocket {
			seq += 1;
			const id = `req-${seq}`;
			let lineCb: ((line: string) => void) | null = null;
			return {
				write(line) {
					const req = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> };
					requests.push({ method: req.method, params: req.params ?? {} });
					queueMicrotask(() => {
						lineCb?.(JSON.stringify({ id: req.id, result: responsesByMethod[req.method] }));
					});
				},
				onLine(cb) {
					lineCb = cb;
				},
				// biome-ignore lint/suspicious/noEmptyBlockStatements: socket giả không có gì để đóng
				close() {},
			};
		},
	});
	return { provider, requests };
}

test("herdr createSurface with no command splits but sends no pane.send_text", async () => {
	const { provider, requests } = makeFakeHerdrProvider({
		"pane.current": { pane: { pane_id: "%1" } },
		"pane.split": { pane: { pane_id: "%2" } },
	});
	const handle = await provider.createSurface("01_explore", { cwd: CWD });
	assert.equal(handle.id, "%2");
	assert.ok(
		requests.every((r) => r.method !== "pane.send_text"),
		"không được send_text khi command bỏ trống",
	);
});

test("herdr sendCommand sends pane.send_text with trailing newline into the handle's pane", async () => {
	const { provider, requests } = makeFakeHerdrProvider({
		"pane.current": { pane: { pane_id: "%1" } },
		"pane.split": { pane: { pane_id: "%3" } },
	});
	const handle = await provider.createSurface("t", { cwd: CWD });
	requests.length = 0;
	await provider.sendCommand!(handle, "bash '/tmp/x.sh'");
	assert.deepEqual(requests, [{ method: "pane.send_text", params: { pane_id: "%3", text: "bash '/tmp/x.sh'\n" } }]);
});

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
