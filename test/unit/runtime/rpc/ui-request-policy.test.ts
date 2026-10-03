/**
 * ui-request-policy.test.ts — W7 (P2-3) design gates 1+2 (fake data, no spawn).
 *
 * GATE 1: fire-and-forget ui-requests are counted per method and DROPPED
 *         (server never registered a pending promise — rpc-mode.js:87-130).
 * GATE 2: dialog ui-requests are answered per policy — "cancel" writes the
 *         universal safe answer {cancelled:true}; "block" writes NOTHING and
 *         counts. The Round-2 live shape (15 fire-and-forget + 1 dialog in
 *         the first 16 records) is replayed as the drain fixture.
 *
 * SECURITY INVARIANT (asserted): no policy mode ever answers `confirmed:true`
 * or a value — auto-confirm does not exist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { createUiRequestPolicy, type DialogAnswerPolicy } from "../../../../src/runtime/rpc/ui-request-policy.ts";

interface Harness {
	written: RpcExtensionUIResponse[];
	warnings: string[];
	handle: (request: RpcExtensionUIRequest) => void;
	counters: () => ReturnType<ReturnType<typeof createUiRequestPolicy>["counters"]>;
}

function makePolicy(dialogPolicy: DialogAnswerPolicy): Harness {
	const written: RpcExtensionUIResponse[] = [];
	const warnings: string[] = [];
	const policy = createUiRequestPolicy({
		dialogPolicy,
		writeResponse: (response) => written.push(response),
		onWarn: (message) => warnings.push(message),
	});
	return { written, warnings, handle: (r) => policy.handle(r), counters: () => policy.counters() };
}

/** The Round-2 live first-16-records shape: 15 fire-and-forget + 1 dialog. */
function round2StartupRecords(): RpcExtensionUIRequest[] {
	const records: RpcExtensionUIRequest[] = [];
	for (let i = 0; i < 6; i++) {
		records.push({ type: "extension_ui_request", id: `s${i}`, method: "setStatus", statusKey: `k${i}`, statusText: `t${i}` });
	}
	for (let i = 0; i < 5; i++) {
		records.push({ type: "extension_ui_request", id: `w${i}`, method: "setWidget", widgetKey: `k${i}`, widgetLines: [`l${i}`] });
	}
	records.push({ type: "extension_ui_request", id: "n1", method: "notify", message: "hello" });
	records.push({ type: "extension_ui_request", id: "n2", method: "notify", message: "again", notifyType: "warning" });
	records.push({ type: "extension_ui_request", id: "t1", method: "setTitle", title: "T" });
	records.push({ type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "x" });
	// 15 fire-and-forget so far; the 16th record was a dialog.
	records.push({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Proceed?", message: "m" });
	assert.equal(records.filter((r) => r.method !== "confirm").length, 15);
	return records;
}

test("GATE 1: fire-and-forget methods are counted + dropped, never answered", () => {
	const h = makePolicy("cancel");
	for (const record of round2StartupRecords().slice(0, 15)) h.handle(record);
	const c = h.counters();
	assert.equal(c.uiRequestsDrained, 15);
	assert.deepEqual(c.drainedByMethod, { setStatus: 6, setWidget: 5, notify: 2, setTitle: 1, set_editor_text: 1 });
	assert.equal(c.dialogsCancelled, 0);
	assert.equal(c.dialogsBlocked, 0);
	// Drain = DROP: nothing was written back to the server.
	assert.deepEqual(h.written, []);
});

test("GATE 2 (cancel): every dialog method gets the universal safe answer", () => {
	const h = makePolicy("cancel");
	const dialogs: RpcExtensionUIRequest[] = [
		{ type: "extension_ui_request", id: "d-select", method: "select", title: "pick", options: ["a", "b"] },
		{ type: "extension_ui_request", id: "d-confirm", method: "confirm", title: "ok?", message: "m" },
		{ type: "extension_ui_request", id: "d-input", method: "input", title: "name" },
		{ type: "extension_ui_request", id: "d-editor", method: "editor", title: "edit" },
	];
	for (const d of dialogs) h.handle(d);
	assert.equal(h.counters().dialogsCancelled, 4);
	assert.equal(h.counters().dialogsBlocked, 0);
	assert.deepEqual(
		h.written,
		dialogs.map((d) => ({ type: "extension_ui_response", id: d.id, cancelled: true })),
	);
	// SECURITY: never confirmed:true, never a value answer.
	for (const w of h.written) {
		assert.equal("confirmed" in w, false, "no auto-confirm surface");
		assert.equal("value" in w, false, "no auto-value surface");
	}
});

test("GATE 2 (block): dialogs are left pending, nothing written, warned", () => {
	const h = makePolicy("block");
	h.handle({ type: "extension_ui_request", id: "d1", method: "input", title: "t" });
	h.handle({ type: "extension_ui_request", id: "d2", method: "select", title: "t", options: ["x"] });
	const c = h.counters();
	assert.equal(c.dialogsBlocked, 2);
	assert.equal(c.dialogsCancelled, 0);
	assert.deepEqual(h.written, []);
	assert.equal(h.warnings.length, 2);
	assert.match(h.warnings[0] ?? "", /left unanswered/);
});

test("Round-2 startup burst: 15 drained + 1 dialog cancelled, no cross-talk", () => {
	const h = makePolicy("cancel");
	for (const record of round2StartupRecords()) h.handle(record);
	const c = h.counters();
	assert.equal(c.uiRequestsDrained, 15);
	assert.equal(c.dialogsCancelled, 1);
	assert.deepEqual(h.written, [{ type: "extension_ui_response", id: "d1", cancelled: true }]);
});

test("unknown method fails safe: drained + dropped (never answered)", () => {
	const h = makePolicy("cancel");
	h.handle({ type: "extension_ui_request", id: "u1", method: "future_method" } as unknown as RpcExtensionUIRequest);
	const c = h.counters();
	assert.equal(c.uiRequestsDrained, 1);
	assert.deepEqual(c.drainedByMethod, { future_method: 1 });
	assert.deepEqual(h.written, []);
});
