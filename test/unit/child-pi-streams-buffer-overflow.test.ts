/**
 * RT-9 regression test: LineAccumulator buffer-overflow split order.
 *
 * BUG (child-pi-streams.ts observe()): on buffer overflow the ENTIRE buffer
 * was flushed as a single "line". When that buffer held several complete
 * `\n`-delimited JSON events (within a >1MB chunk), they were merged into one
 * giant line → JSON.parse failed → usage/turn/transcript events LOST.
 *
 * FIX: on overflow, split on newlines first; emit each complete line
 * individually and force-flush only the trailing partial (no terminating
 * newline). The normal (non-overflow) newline-splitting path is unchanged.
 *
 * Run: env -u PI_CREW_KIND -u PI_CREW_RUN_ID npx tsx --test test/unit/child-pi-streams-buffer-overflow.test.ts
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { MAX_LINE_BUFFER_BYTES } from "../../src/runtime/child-pi/child-pi-constants.ts";
import { ChildPiLineObserver } from "../../src/runtime/child-pi/child-pi-streams.ts";

const MINIMAL_AGENT: AgentConfig = {
	name: "test",
	description: "",
	source: "builtin",
	filePath: "/test/agent.json",
	systemPrompt: "",
};

interface Captured {
	events: unknown[];
	stdout: string[];
}

function makeInput(captured: Captured) {
	return {
		cwd: "/tmp",
		task: "test task",
		agent: MINIMAL_AGENT,
		onJsonEvent: (e: unknown) => captured.events.push(e),
		onStdoutLine: (l: string) => captured.stdout.push(l),
	};
}

/** Compact event → its `type` string (undefined when compaction dropped it). */
function eventType(e: unknown): string | undefined {
	const r = e as Record<string, unknown> | undefined;
	return r && typeof r === "object" ? (r.type as string | undefined) : undefined;
}

/** Build one complete JSON event line of approximately `padBytes` (valid JSON,
 *  survives compaction as `{type}` only). */
function paddedEvent(type: string, padBytes: number): string {
	// The `padding` field is dropped by compactChildPiEvent's generic fallthrough,
	// so the onJsonEvent still receives a compact `{type}` while the raw line is
	// large enough to push the buffer past the overflow threshold.
	return JSON.stringify({ type, padding: "A".repeat(padBytes) });
}

describe("RT-9: buffer-overflow splits complete lines (no merge)", () => {
	test("each complete JSON event is emitted individually; only trailing partial is force-flushed", () => {
		const captured: Captured = { events: [], stdout: [] };
		const observer = new ChildPiLineObserver(makeInput(captured));

		// Several complete, individually-parseable JSON events followed by a
		// partial line (no terminating newline). The total chunk exceeds the
		// overflow threshold so the overflow branch runs.
		const pad = Math.ceil((MAX_LINE_BUFFER_BYTES / 4) + 4096); // ~4 events → > 1MB
		const types = ["usage", "turn", "transcript", "metric"];
		const partial = '{"type":"partial-malformed';
		const chunk =
			types.map((t) => paddedEvent(t, pad) + "\n").join("") + partial;

		// Sanity: the single chunk must exceed the threshold to reach the overflow path.
		assert.ok(
			chunk.length > MAX_LINE_BUFFER_BYTES,
			`chunk (${chunk.length}) must exceed MAX_LINE_BUFFER_BYTES (${MAX_LINE_BUFFER_BYTES})`,
		);
		// Mutation guard: the merged buffer is NOT valid JSON — i.e. the OLD
		// behavior (flush entire buffer as one line) would parse-fail and emit
		// zero events.
		assert.throws(() => JSON.parse(chunk), "merged buffer must be unparseable (proves old code loses data)");

		observer.observe(chunk);

		// Every complete event survived as its own line and is parseable/compacted.
		assert.equal(
			captured.events.length,
			types.length,
			`expected ${types.length} compacted events (one per complete line), got ${captured.events.length}`,
		);
		assert.deepEqual(
			captured.events.map(eventType),
			types,
			"complete events must be emitted IN ORDER with per-line identity",
		);

		// The trailing partial (non-JSON) is the only non-JSON line: it has no
		// displayLine for the compacted events, so onStdoutLine fires exactly
		// once for the overflow remainder.
		assert.equal(captured.stdout.length, 1, "only the trailing partial should reach onStdoutLine");
		assert.equal(captured.stdout[0], partial, "trailing partial must be the overflow remainder");

		// Buffer is cleared after overflow force-flush.
		assert.equal(observer.getRawFinalText(), undefined, "no assistant text in synthetic events");
	});

	test("RT-F8 preserved: single huge line with NO newlines still force-flushes as one line", () => {
		const captured: Captured = { events: [], stdout: [] };
		const observer = new ChildPiLineObserver(makeInput(captured));

		// A single line with no newlines that exceeds the threshold — the
		// original RT-F8 case. split() yields one element; behavior unchanged.
		const huge = "X".repeat(MAX_LINE_BUFFER_BYTES + 1024);
		observer.observe(huge);

		// Non-JSON → 0 json events, 1 stdout line (the whole huge line).
		assert.equal(captured.events.length, 0, "non-JSON huge line yields no json events");
		assert.equal(captured.stdout.length, 1, "single huge line force-flushed as one line");
		assert.equal(captured.stdout[0], huge, "force-flush preserves the single line verbatim");
	});

	test("trailing-newline overflow: empty trailing element is a no-op (not a spurious event)", () => {
		const captured: Captured = { events: [], stdout: [] };
		const observer = new ChildPiLineObserver(makeInput(captured));

		const pad = Math.ceil((MAX_LINE_BUFFER_BYTES / 3) + 4096);
		// Chunk ends WITH a newline → split produces a trailing "" element.
		const types = ["usage", "turn", "transcript"];
		const chunk = types.map((t) => paddedEvent(t, pad) + "\n").join("");
		assert.ok(chunk.length > MAX_LINE_BUFFER_BYTES, "chunk must exceed threshold");

		observer.observe(chunk);

		assert.equal(captured.events.length, types.length, "trailing empty element must not add an event");
		assert.deepEqual(captured.events.map(eventType), types);
		// No non-JSON line (trailing "" is whitespace → emitLine no-ops).
		assert.equal(captured.stdout.length, 0, "trailing empty line is skipped, no overflow remainder");
	});

	test("property/fuzz: random newline placement — all complete events emitted, remainder is the last partial", () => {
		// Deterministic PRNG so the run is reproducible.
		let seed = 0xC0FFEE;
		const rand = () => {
			// xorshift32
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			return (seed >>> 0) / 0x100000000;
		};

		for (let iter = 0; iter < 64; iter++) {
			const captured: Captured = { events: [], stdout: [] };
			const observer = new ChildPiLineObserver(makeInput(captured));

			// Between 3 and 9 complete events; pad so the whole chunk exceeds the threshold.
			const n = 3 + Math.floor(rand() * 7);
			const pad = Math.ceil((MAX_LINE_BUFFER_BYTES / n) + 4096);
			const types: string[] = [];
			for (let i = 0; i < n; i++) types.push(`evt_${iter}_${i}`);

			const parts = types.map((t) => paddedEvent(t, pad));
			// 50% of the time append a trailing partial line.
			const withPartial = rand() < 0.5;
			const partial = withPartial ? `{"type":"partial_${iter}` : "";
			// 50% of the time terminate the last complete event with a newline.
			const trailingNewline = rand() < 0.5;

			let chunk = parts.join("\n");
			if (trailingNewline || withPartial) chunk += "\n";
			chunk += partial;

			// Only exercise the overflow path.
			if (chunk.length <= MAX_LINE_BUFFER_BYTES) continue;

			observer.observe(chunk);

			assert.equal(
				captured.events.length,
				n,
				`iter=${iter} expected ${n} events, got ${captured.events.length}`,
			);
			assert.deepEqual(
				captured.events.map(eventType),
				types,
				`iter=${iter} event types must match in order`,
			);
			// The overflow remainder: the trailing partial (if present) reaches
			// onStdoutLine; a trailing-newline-only tail emits nothing.
			if (withPartial) {
				assert.equal(captured.stdout.length, 1, `iter=${iter} trailing partial expected`);
				assert.equal(captured.stdout[0], partial, `iter=${iter} remainder must equal trailing partial`);
			} else {
				assert.equal(captured.stdout.length, 0, `iter=${iter} no trailing partial expected`);
			}
		}
	});
});
