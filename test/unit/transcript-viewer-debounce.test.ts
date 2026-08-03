import assert from "node:assert/strict";
import test from "node:test";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { DurableTranscriptViewer, type readRunTranscript } from "../../src/ui/transcript-viewer.ts";

type TranscriptResult = ReturnType<typeof readRunTranscript>;

function fakeResult(lines: string[]): TranscriptResult {
	return {
		title: "team_debounce:01",
		path: "/tmp/transcript.jsonl",
		lines,
		bytesRead: lines.join("\n").length,
		size: lines.join("\n").length,
		truncated: false,
	};
}

// Minimal manifest — the real reader is replaced by a spy, so no fields are
// actually accessed and no fs I/O happens. The cast keeps the constructor
// signature satisfied.
const manifest = {} as TeamRunManifest;

function makeSpy(lines: string[]): { fn: typeof readRunTranscript; state: { calls: number } } {
	const state = { calls: 0 };
	const fn: typeof readRunTranscript = () => {
		state.calls += 1;
		return fakeResult(lines);
	};
	return { fn, state };
}

const lines = (count: number) => Array.from({ length: count }, (_value, index) => `line-${index}`);

const noopTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

test("DurableTranscriptViewer reads the transcript once on open, not on every keypress (UI-9)", () => {
	const spy = makeSpy(lines(40));
	const viewer = new DurableTranscriptViewer(manifest, noopTheme, () => undefined, undefined, { readTranscript: spy.fn });
	// Read exactly once when the viewer opens.
	assert.equal(spy.state.calls, 1);

	// A burst of keystrokes must not trigger another read each — the bug did a
	// synchronous fs read per keypress here.
	viewer.handleInput("j");
	viewer.handleInput("j");
	viewer.handleInput("k");
	viewer.handleInput("\u001b[A");
	viewer.handleInput("\u001b[B");
	viewer.handleInput("\u001b[5~");
	viewer.handleInput("\u001b[6~");
	viewer.handleInput("G");
	viewer.handleInput("g");
	viewer.handleInput("a");
	assert.equal(spy.state.calls, 1, "readRunTranscript must not be called on every keypress");
});

test("DurableTranscriptViewer refreshes the cache only on the explicit full/tail toggle", () => {
	const spy = makeSpy(lines(40));
	const viewer = new DurableTranscriptViewer(manifest, noopTheme, () => undefined, undefined, { readTranscript: spy.fn });
	assert.equal(spy.state.calls, 1);

	viewer.handleInput("j");
	viewer.handleInput("k");
	assert.equal(spy.state.calls, 1, "scroll keys must not read");

	// The full/tail toggle changes the read options → a single explicit refresh.
	viewer.handleInput("f");
	assert.equal(spy.state.calls, 2, "the toggle should refresh the cache once");

	// Subsequent keystrokes still do not re-read.
	viewer.handleInput("j");
	viewer.handleInput("G");
	assert.equal(spy.state.calls, 2, "scroll keys after toggle must not read");
});

test("DurableTranscriptViewer scroll math stays correct without per-keypress reads", () => {
	const spy = makeSpy(lines(40));
	const viewer = new DurableTranscriptViewer(manifest, noopTheme, () => undefined, undefined, { readTranscript: spy.fn });
	// lastHeight defaults to 16 → maxScroll = 40 - 16 = 24.
	viewer.handleInput("G"); // jump to bottom

	const statusLine = viewer.render(100).find((line) => line.includes("lines ·"));
	assert.ok(statusLine, "expected a status line in the rendered overlay");
	assert.match(statusLine, /100%/, "G should pin the view to the bottom (100%)");

	// render() performs the TTL-cached read that refreshes the per-keypress cache;
	// that is expected and still does not happen on scroll keystrokes above.
	assert.equal(spy.state.calls, 2);
});
