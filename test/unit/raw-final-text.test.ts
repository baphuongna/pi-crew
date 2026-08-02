/**
 * Fix A — RAW final-text capture for child-process results.
 *
 * The authoritative result.txt used to inherit the transcript's 16K cap because
 * it was derived from the compacted transcript. Now ChildPiLineObserver captures
 * the RAW assistant text BEFORE compaction, and task-runner prefers it. These
 * tests cover the new capture surface (the observer getter + the exported
 * extractText helper). The transcript stays compacted (telemetry memory bound
 * unchanged); only the authoritative result becomes raw.
 *
 * @see src/runtime/child-pi/child-pi.ts ChildPiLineObserver
 * @see src/runtime/pi-json-output.ts extractText
 * @see research-findings/output-handling-deep-dive.md §A
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildPiLineObserver, type ChildPiRunInput } from "../../src/runtime/child-pi/child-pi.ts";
import { extractText } from "../../src/runtime/pi-json-output.ts";

/** Build an observer with a minimal input — emitLine only touches
 *  onJsonEvent/onStdoutLine/transcriptPath, all optional-chained or guarded,
 *  so an empty object cast is safe (transcriptPath undefined → no-op). */
function makeObserver(): ChildPiLineObserver {
	return new ChildPiLineObserver({} as unknown as ChildPiRunInput);
}

/** Serialize a Pi `message` event carrying assistant text. */
function assistantMessage(text: string): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

test("extractText is exported and returns assistant-text fragments", () => {
	const event = {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
		},
	};
	const texts = extractText(event);
	assert.deepEqual(texts, ["hello"]);
});

test("extractText skips non-assistant messages", () => {
	const event = {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "ignored" }] },
	};
	assert.deepEqual(extractText(event), []);
});

test("observer captures RAW assistant text UNCAPPED past the 16K transcript limit (Fix A core)", () => {
	const observer = makeObserver();
	// 30 000 chars — nearly double the 16 384 transcript cap. With the old
	// transcript-derived result, this was compacted to ~16K with a marker.
	// Now the observer's getRawFinalText() returns the FULL uncapped text.
	const raw = "A".repeat(30_000);
	observer.observe(`${assistantMessage(raw)}\n`);
	observer.flush();
	const captured = observer.getRawFinalText();
	assert.ok(captured, "raw final text must be captured");
	assert.equal(captured!.length, raw.length, "captured text must be FULL length, not 16K-capped");
	assert.equal(captured, raw, "captured text must equal the raw input byte-for-byte");
});

test("observer getRawFinalText returns the LAST non-empty assistant utterance", () => {
	const observer = makeObserver();
	observer.observe(`${assistantMessage("first")}\n${assistantMessage("second")}\n${assistantMessage("third")}\n`);
	observer.flush();
	assert.equal(observer.getRawFinalText(), "third");
});

test("observer does not capture non-assistant or tool events", () => {
	const observer = makeObserver();
	const userEvent = JSON.stringify({
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "prompt" }] },
	});
	const toolEvent = JSON.stringify({
		type: "tool_result_end",
		message: { role: "tool", content: [{ type: "text", text: "output" }] },
	});
	observer.observe(`${userEvent}\n${toolEvent}\n`);
	observer.flush();
	assert.equal(observer.getRawFinalText(), undefined, "non-assistant events must not contribute to raw final text");
});

test("observer getRawFinalText is undefined when no assistant text was seen", () => {
	const observer = makeObserver();
	assert.equal(observer.getRawFinalText(), undefined);
	observer.observe("not-json-at-all\n");
	observer.flush();
	assert.equal(observer.getRawFinalText(), undefined);
});

test("observer tolerates a mix of JSON and non-JSON lines without throwing", () => {
	const observer = makeObserver();
	const mixed = [
		"some non-json stdout line",
		assistantMessage("real output"),
		"another non-json line",
		"", // empty
	].join("\n");
	assert.doesNotThrow(() => {
		observer.observe(`${mixed}\n`);
		observer.flush();
	});
	assert.equal(observer.getRawFinalText(), "real output");
});

test("observer handles assistant text spanning multiple content parts (mirrors parser)", () => {
	const observer = makeObserver();
	const event = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "part-1" },
				{ type: "text", text: "part-2" },
			],
		},
	});
	observer.observe(`${event}\n`);
	observer.flush();
	// extractText pushes each text part as a separate fragment; the final text
	// event's last fragment wins. Mirrors parsePiJsonOutput.finalText semantics.
	const captured = observer.getRawFinalText();
	assert.ok(captured);
	assert.equal(captured, "part-2");
});
