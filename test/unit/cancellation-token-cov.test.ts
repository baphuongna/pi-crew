import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CrewCancellationError } from "../../src/runtime/process/cancellation.ts";
import { CancellationToken, createCancellationToken } from "../../src/runtime/process/cancellation-token.ts";

describe("CancellationToken", () => {
	it("starts in non-aborted state", () => {
		const token = new CancellationToken();
		assert.equal(token.aborted, false);
		assert.equal(token.reason, undefined);
		assert.equal(token.lastHeartbeatAt, undefined);
		assert.equal(token.lastHeartbeatStage, undefined);
	});

	it("abort() sets aborted to true", () => {
		const token = new CancellationToken();
		token.abort("test reason");
		assert.equal(token.aborted, true);
		assert.ok(token.reason);
		assert.equal(token.reason!.code, "caller_cancelled");
	});

	it("abort() is idempotent — second call is a no-op", () => {
		const token = new CancellationToken();
		token.abort("first");
		token.abort("second");
		assert.equal(token.reason!.message, "first");
	});

	it("throwIfCancelled() does nothing when not aborted", () => {
		const token = new CancellationToken();
		assert.doesNotThrow(() => token.throwIfCancelled());
	});

	it("throwIfCancelled() throws CrewCancellationError when aborted", () => {
		const token = new CancellationToken();
		token.abort("stop");
		assert.throws(() => token.throwIfCancelled(), CrewCancellationError);
	});

	it("heartbeat() records timestamp and stage", () => {
		const fixedDate = new Date("2026-01-01T00:00:00Z");
		const token = new CancellationToken({ now: () => fixedDate });
		const state = token.heartbeat("processing");
		assert.equal(state.lastHeartbeatStage, "processing");
		assert.equal(state.lastHeartbeatAt, fixedDate.toISOString());
		assert.equal(state.aborted, false);
	});

	it("heartbeat() throws when already aborted", () => {
		const token = new CancellationToken();
		token.abort();
		assert.throws(() => token.heartbeat("stage"), CrewCancellationError);
	});

	it("state() returns snapshot with only defined fields", () => {
		const token = new CancellationToken();
		const s = token.state();
		assert.deepEqual(Object.keys(s).sort(), ["aborted"]);
		assert.equal(s.aborted, false);
	});

	it("state() includes reason and heartbeat after they are set", () => {
		const fixedDate = new Date("2026-06-01T12:00:00Z");
		const token = new CancellationToken({ now: () => fixedDate });
		token.heartbeat("init");
		token.abort("done");
		const s = token.state();
		assert.equal(s.aborted, true);
		assert.ok(s.reason);
		assert.equal(s.lastHeartbeatStage, "init");
	});

	it("signal reflects abort state", () => {
		const token = new CancellationToken();
		assert.equal(token.signal.aborted, false);
		token.abort("x");
		assert.equal(token.signal.aborted, true);
	});

	it("wait() resolves after specified ms when not aborted", async () => {
		const token = new CancellationToken();
		const start = Date.now();
		await token.wait(10);
		const elapsed = Date.now() - start;
		assert.ok(elapsed >= 5, `wait should delay at least ~10ms, got ${elapsed}ms`);
	});

	it("wait() throws immediately if already aborted", () => {
		const token = new CancellationToken();
		token.abort();
		assert.throws(() => token.wait(1000), CrewCancellationError);
	});

	it("wait() rejects when abort happens during wait", async () => {
		const token = new CancellationToken();
		const p = token.wait(5000);
		setTimeout(() => token.abort("interrupted"), 10);
		await assert.rejects(() => p, CrewCancellationError);
	});

	it("wait(0) resolves immediately", async () => {
		const token = new CancellationToken();
		await token.wait(0);
	});

	it("accepts an external AbortSignal and mirrors its abort", () => {
		const external = new AbortController();
		const token = new CancellationToken({ signal: external.signal });
		assert.equal(token.aborted, false);
		external.abort("external-stop");
		assert.equal(token.aborted, true);
		assert.ok(token.reason);
	});

	it("accepts an already-aborted signal at construction", () => {
		const ac = new AbortController();
		ac.abort("pre-abort");
		const token = new CancellationToken({ signal: ac.signal });
		assert.equal(token.aborted, true);
	});

	it("onHeartbeat callback receives state", () => {
		let captured: unknown;
		const token = new CancellationToken({
			onHeartbeat: (state) => {
				captured = state;
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
		});
		token.heartbeat("my-stage");
		assert.ok(captured);
		assert.equal((captured as { lastHeartbeatStage: string }).lastHeartbeatStage, "my-stage");
	});
});

describe("createCancellationToken", () => {
	it("creates a token with default options", () => {
		const token = createCancellationToken();
		assert.equal(token.aborted, false);
		assert.ok(token instanceof CancellationToken);
	});

	it("passes options through", () => {
		const fixedDate = new Date("2026-03-15T00:00:00Z");
		const token = createCancellationToken({ now: () => fixedDate });
		token.heartbeat("test");
		assert.equal(token.lastHeartbeatAt, fixedDate.toISOString());
	});
});
