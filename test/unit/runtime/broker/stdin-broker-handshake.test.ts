import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStdinBrokerPayload } from "../../../../src/runtime/broker/stdin-handshake.ts";
import { buildBrokerStdinLine } from "../../../../src/runtime/async-runner.ts";

/**
 * F4 (2026-09-12 live battery): detached workers lost ALL broker connectivity
 * because the env route is closed by design (secret-suffixed token rejected by
 * the allowlist sanitizer) and the runner registers no issuer. The fix is a
 * STDIN handshake: async-runner writes ONE line; background-runner reads and
 * validates it. These tests pin the WRITER format against the READER parser —
 * a drift between the two silently degrades every async run back to
 * "proceed with best judgment".
 */

const RUN = "team_20260912_test_run";
const CREDS = { socketPath: "/run/user/1000/pi-crew-1000/pi-crew-deadbeef.sock", token: "0f8a2c1e-1111-4bbb-9ccc-222233334444" };

describe("stdin broker handshake (F4)", () => {
	it("round-trip: buildBrokerStdinLine → parseStdinBrokerPayload survives intact", () => {
		const line = buildBrokerStdinLine(RUN, CREDS);
		const parsed = parseStdinBrokerPayload(line, RUN);
		assert.deepEqual(parsed, { v: 1, runId: RUN, ...CREDS });
	});

	it("writer emits exactly one newline-terminated JSON line", () => {
		const line = buildBrokerStdinLine(RUN, CREDS);
		assert.ok(line.endsWith("\n"));
		assert.equal(line.indexOf("\n"), line.length - 1, "no embedded newline");
	});

	it("rejects a payload minted for a DIFFERENT run (cross-run containment)", () => {
		const line = buildBrokerStdinLine("team_OTHER_run", CREDS);
		assert.equal(parseStdinBrokerPayload(line, RUN), undefined);
	});

	it("rejects wrong version, malformed JSON, and missing/empty fields", () => {
		assert.equal(parseStdinBrokerPayload("{not json", RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 2, runId: RUN, ...CREDS }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 1, runId: RUN, socketPath: "", token: "x" }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 1, runId: RUN, socketPath: "/s" }), RUN), undefined);
		assert.equal(parseStdinBrokerPayload(JSON.stringify({ v: 1, runId: RUN, socketPath: "/s", token: "" }), RUN), undefined);
	});

	it("non-object payloads (array/string/null) are rejected", () => {
		assert.equal(parseStdinBrokerPayload("[1,2]", RUN), undefined);
		assert.equal(parseStdinBrokerPayload('"hello"', RUN), undefined);
		assert.equal(parseStdinBrokerPayload("null", RUN), undefined);
	});
});
