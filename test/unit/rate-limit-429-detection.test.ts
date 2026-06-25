import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePiJsonOutput, type ParsedPiJsonOutput } from "../../src/runtime/pi-json-output.ts";
import { detectRetryableModelFailureFromOutput } from "../../src/runtime/task-runner.ts";

/**
 * 429/rate-limit fix (PI_CREW_TOOLING_429_NOTE.md). A worker can exit code 0
 * with no hard error, but the transcript is full of `message_end` events with
 * `errorMessage: "429 ... overloaded"` and empty content. The model never
 * produced a tool call → worker "completed" without doing anything → pi-crew
 * treated it as success. This fix detects that case and surfaces it as an error
 * so the model-fallback chain retries on another model.
 */

// A real Z.AI 429 message_end event (from the bug report).
const event429 = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [],
		model: "glm-5.2",
		errorMessage: "429 The service may be temporarily overloaded, please try again later",
		stopReason: "error",
	},
});

const eventRateLimit = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [], errorMessage: "rate_limit_error: too many requests" },
});

const eventAuth = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [], errorMessage: "401 unauthorized: invalid api key" },
});

const eventText = JSON.stringify({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "I will now edit the file." }] },
});

describe("parsePiJsonOutput — errorMessages extraction", () => {
	it("extracts errorMessage from message_end events", () => {
		const parsed = parsePiJsonOutput(event429);
		assert.ok(parsed.errorMessages);
		assert.equal(parsed.errorMessages!.length, 1);
		assert.match(parsed.errorMessages![0]!, /429.*overloaded/i);
	});

	it("collects multiple error messages", () => {
		const parsed = parsePiJsonOutput(`${event429}\n${eventRateLimit}`);
		assert.equal(parsed.errorMessages!.length, 2);
	});

	it("returns undefined errorMessages when no error events", () => {
		const parsed = parsePiJsonOutput(eventText);
		assert.equal(parsed.errorMessages, undefined);
	});
});

describe("detectRetryableModelFailureFromOutput — 429-only run detection", () => {
	it("surfaces error when transcript has retryable 429 messages AND no real output", () => {
		const parsed = parsePiJsonOutput(event429); // empty content, no text
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err, "must surface the 429 as an error");
		assert.match(err!, /429.*overloaded/i);
		assert.match(err!, /no output/i);
	});

	it("surfaces error for rate_limit_error too", () => {
		const parsed = parsePiJsonOutput(eventRateLimit);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /rate_limit_error/i);
	});

	it("returns undefined when there's real output (model recovered despite transient 429s)", () => {
		// 429 then a successful text response — the run recovered, don't fail it.
		const parsed = parsePiJsonOutput(`${event429}\n${eventText}`);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.equal(err, undefined, "recovered run must not be flagged");
	});

	it("returns undefined for non-retryable errors (auth/billing) — those shouldn't trigger fallback", () => {
		// Auth errors are NON_RETRYABLE — isRetryableModelFailure returns false.
		// We should NOT surface them here (they'd be caught by other layers /
		// would loop the fallback chain forever).
		const parsed = parsePiJsonOutput(eventAuth);
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.equal(err, undefined, "non-retryable auth errors must not trigger this path");
	});

	it("returns undefined when no error messages at all (normal successful run)", () => {
		const parsed = parsePiJsonOutput(eventText);
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("returns undefined for empty transcript", () => {
		const parsed = parsePiJsonOutput("");
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});
});

describe("detectRetryableModelFailureFromOutput — secondary messageEndEvents signal (FIX 3)", () => {
	// FIX 3 (task packet 01_01-agent): the detector also inspects a raw
	// `messageEndEvents` (or `transcript`) array on the parsed output as a
	// secondary signal. The ParsedPiJsonOutput type does not currently declare
	// this field, so the function reads it through a local extension cast. This
	// block exercises that secondary path: callers that bypass the
	// errorMessages extraction (e.g. a test, or a future parser that captures
	// the full event stream) still get the retryable failure surfaced.

	it("surfaces retryable error from messageEndEvents when errorMessages is absent", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{ stopReason: "error", errorMessage: "Provider error: api_error" },
			],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err, "must surface the api_error from messageEndEvents");
		assert.match(err!, /api_error/i);
		assert.match(err!, /no output/i);
	});

	it("accepts the alternative `transcript` field name for the event stream", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			transcript: [
				{ stopReason: "error", errorMessage: "upstream timeout" },
			],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /upstream timeout/i);
	});

	it("ignores messageEndEvents without stopReason='error'", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{ stopReason: "stop", errorMessage: "Provider error: api_error" },
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("ignores messageEndEvents with empty/non-string errorMessage", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{ stopReason: "error", errorMessage: "" },
				{ stopReason: "error" /* no errorMessage field */ },
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("ignores non-retryable messageEndEvents (auth/billing) and falls through", () => {
		const parsed = {
			jsonEvents: 1,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{ stopReason: "error", errorMessage: "401 unauthorized: invalid api key" },
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("returns undefined for messageEndEvents when real output is present (recovered)", () => {
		const parsed = {
			jsonEvents: 2,
			textEvents: ["I will now edit the file."],
			finalText: "I will now edit the file.",
			patches: undefined,
			errorMessages: undefined,
			messageEndEvents: [
				{ stopReason: "error", errorMessage: "Provider error: api_error" },
			],
		} as unknown as ParsedPiJsonOutput;
		assert.equal(detectRetryableModelFailureFromOutput(parsed), undefined);
	});

	it("primary errorMessages signal still wins over secondary messageEndEvents", () => {
		// errorMessages carries a 429; messageEndEvents carries a different
		// retryable error. The function must return the 429 (primary) — not
		// whichever secondary event comes first.
		const parsed = {
			jsonEvents: 2,
			textEvents: [],
			finalText: undefined,
			patches: undefined,
			errorMessages: ["429 The service may be temporarily overloaded"],
			messageEndEvents: [
				{ stopReason: "error", errorMessage: "Provider error: api_error" },
			],
		} as unknown as ParsedPiJsonOutput;
		const err = detectRetryableModelFailureFromOutput(parsed);
		assert.ok(err);
		assert.match(err!, /429.*overloaded/i);
	});
});
