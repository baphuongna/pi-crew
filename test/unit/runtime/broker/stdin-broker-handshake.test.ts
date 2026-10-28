import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrokerStdinLine } from "../../../../src/runtime/async-runner.ts";
import { BROKER_STDIN_LINE_WARN_BYTES, parseStdinBrokerPayload } from "../../../../src/runtime/broker/stdin-handshake.ts";

/**
 * F4 (2026-09-12 live battery): detached workers lost ALL broker connectivity
 * because the env route is closed by design (secret-suffixed token rejected by
 * the allowlist sanitizer) and the runner registers no issuer. The fix is a
 * STDIN handshake carrying PER-TASK COMPOUND tokens (v2 — wait.* rejects
 * bare-runId tokens per ADR-0 2026-08-17 item 6; the v1 single-token variant
 * connected fine but every park was forbidden). These tests pin the WRITER
 * format against the READER parser — a drift between the two silently
 * degrades every async run back to "proceed with best judgment".
 */

const RUN = "team_20260912_test_run";
const SOCKET = "/run/user/1000/pi-crew-1000/pi-crew-deadbeef.sock";
const TASKS = {
	"01_explore": "0f8a2c1e-1111-4bbb-9ccc-222233334444",
	"02_execute": "1a9b3d2f-2222-4ccc-8ddd-333344445555",
};

describe("stdin broker handshake (F4 v2 — per-task compound tokens)", () => {
	it("round-trip: buildBrokerStdinLine → parseStdinBrokerPayload survives intact", () => {
		const line = buildBrokerStdinLine(RUN, SOCKET, TASKS);
		const parsed = parseStdinBrokerPayload(line, RUN);
		assert.deepEqual(parsed, { v: 2, runId: RUN, socketPath: SOCKET, tasks: TASKS });
	});

	it("writer emits exactly one newline-terminated JSON line", () => {
		const line = buildBrokerStdinLine(RUN, SOCKET, TASKS);
		assert.ok(line.endsWith("\n"));
		assert.equal(line.indexOf("\n"), line.length - 1, "no embedded newline");
	});

	it("rejects a payload minted for a DIFFERENT run (cross-run containment)", () => {
		const line = buildBrokerStdinLine("team_OTHER_run", SOCKET, TASKS);
		assert.equal(parseStdinBrokerPayload(line, RUN), undefined);
	});

	it("rejects the v1 single-token shape (bare-runId tokens are forbidden for wait.*)", () => {
		const v1 = `${JSON.stringify({ v: 1, runId: RUN, socketPath: SOCKET, token: "abc" })}\n`;
		assert.equal(parseStdinBrokerPayload(v1, RUN), undefined);
	});

	it("rejects wrong version, malformed JSON, and missing/empty fields", () => {
		assert.equal(parseStdinBrokerPayload("{not json", RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 3, runId: RUN, socketPath: SOCKET, tasks: TASKS }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, socketPath: "", tasks: TASKS }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, socketPath: SOCKET }), RUN), undefined);
		// empty task id or empty token inside the map
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, socketPath: SOCKET, tasks: { "": "x" } }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, socketPath: SOCKET, tasks: { t1: "" } }), RUN), undefined);
		// tasks must be an object, not an array
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, socketPath: SOCKET, tasks: ["t1"] }), RUN), undefined);
	});

	it("non-object payloads (array/string/null) are rejected", () => {
		assert.equal(parseStdinBrokerPayload("[1,2]", RUN), undefined);
		assert.equal(parseStdinBrokerPayload('"hello"', RUN), undefined);
		assert.equal(parseStdinBrokerPayload("null", RUN), undefined);
	});
});

// ── FIX-3 (2026-10-28): oversize handshake line → LOUD warn, still written ─
//
// The worker reader (readStdinFirstLine) aborts past 64 KiB without a
// newline — a ~2.5k-task payload (~131 KiB observed live) silently lost
// EVERY task's creds in production with zero trace. buildBrokerStdinLine
// (the single construction point shared by BOTH writers) must warn LOUD at
// 60 KiB — severity "warn", i.e. NEVER gated on PI_TEAMS_DEBUG/PI_CREW_DEBUG
// — while still returning the line so the caller writes it unblocked.

describe("FIX-3: oversize handshake line diagnostics", () => {
	/** Capture console.error lines (logInternalError emits there) while `fn`
	 *  runs. Restores the original even on assertion failure. */
	function captureStderr(fn: () => void): string[] {
		const lines: string[] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => {
			lines.push(args.map((a) => String(a)).join(" "));
		};
		try {
			fn();
		} finally {
			console.error = orig;
		}
		return lines;
	}

	it("normal-size payload → no diagnostic, round-trip intact", () => {
		const lines = captureStderr(() => {
			const line = buildBrokerStdinLine(RUN, SOCKET, TASKS);
			assert.ok(line.length < BROKER_STDIN_LINE_WARN_BYTES);
			assert.deepEqual(parseStdinBrokerPayload(line, RUN), { v: 2, runId: RUN, socketPath: SOCKET, tasks: TASKS });
		});
		assert.equal(lines.length, 0, "no warn below the 60 KiB threshold");
	});

	it(">60 KiB payload (≈2.6k tasks) → one LOUD warn (ungated), line STILL one parseable line", () => {
		const tasks: Record<string, string> = {};
		for (let i = 0; i < 2600; i++) {
			tasks[`task-${String(i).padStart(4, "0")}`] = "0f8a2c1e-1111-4bbb-9ccc-222233334444";
		}
		let line = "";
		const lines = captureStderr(() => {
			line = buildBrokerStdinLine(RUN, SOCKET, tasks);
		});
		assert.ok(line.length > BROKER_STDIN_LINE_WARN_BYTES, `fixture must exceed the threshold (got ${line.length})`);
		assert.equal(lines.length, 1, "exactly one warn, severity warn — never debug-gated");
		assert.match(lines[0]!, /stdin-handshake\.oversize-payload/);
		assert.match(lines[0]!, /2600 tasks/);
		assert.match(lines[0]!, /creds/);
		// Not blocked: still exactly one newline-terminated line the reader can parse.
		assert.ok(line.endsWith("\n"));
		assert.equal(line.indexOf("\n"), line.length - 1);
		const parsed = parseStdinBrokerPayload(line, RUN);
		assert.ok(parsed, "oversize line is still protocol-valid (write is never blocked)");
		assert.equal(Object.keys(parsed!.tasks).length, 2600);
	});
});
