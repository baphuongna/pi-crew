/**
 * F-L2 regression: boot-window steer loss in the steering file poll.
 *
 * Found live 2026-09-21 (battery run team_20260921035840, root-caused via
 * bisection probes R7-R9): a steer entry written to
 * `<artifactsRoot>/steering/<taskId>.jsonl` while the worker extension is
 * still LOADING (pre-bindExtensions) used to be silently lost forever:
 *
 *   1. registerPiTeamsPromptRuntime starts the steering poll at extension
 *      LOAD time (pre-bind).
 *   2. pi's extension runtime gates action methods until bind —
 *      `sendMessage: notInitialized` THROWS synchronously.
 *   3. The old poll advanced `lastOffset` to `stat.size` BEFORE the line
 *      loop, and its per-line catch swallowed the throw as "malformed
 *      line" — the offset was already past the entry, so no later tick
 *      ever re-read it. No log, no retry, no delivery.
 *
 * The fix walks the buffer by byte offset and advances `lastOffset` only
 * past lines with a terminal verdict (delivered / non-steer / rejected /
 * malformed); a DELIVERY failure rewinds to the failing line's start and
 * un-marks its dedup id so the next tick retries cleanly.
 *
 * These tests drive the REAL poll (500ms cadence) through a mock ExtensionAPI
 * whose sendMessage throws exactly like pi's pre-bind runtime, then succeeds.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import registerPiTeamsPromptRuntime from "../../../src/prompt/prompt-runtime.ts";

type PromptRuntimePi = Parameters<typeof registerPiTeamsPromptRuntime>[0];

interface SentMessage {
	customType?: string;
	content?: string;
}

function makeBootWindowHarness(options: {
	/** How many sendMessage calls throw before the first success. */
	failuresBeforeSuccess: number | "always";
}): { pi: PromptRuntimePi; sent: SentMessage[]; throwCount(): number; flipToSuccess(): void } {
	const sent: SentMessage[] = [];
	let throwsRemaining = options.failuresBeforeSuccess === "always" ? Number.POSITIVE_INFINITY : options.failuresBeforeSuccess;
	let throwCount = 0;
	const pi = {
		registerTool: () => {
			/* record nothing */
		},
		on: () => {
			/* record nothing */
		},
		sendMessage: (message: SentMessage) => {
			if (throwsRemaining > 0) {
				throwsRemaining -= 1;
				throwCount += 1;
				// Exact error pi's loader throws pre-bind (loader.js notInitialized).
				throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			}
			sent.push(message);
			return Promise.resolve();
		},
	};
	return {
		pi: pi as unknown as PromptRuntimePi,
		sent,
		throwCount: () => throwCount,
		flipToSuccess: () => {
			throwsRemaining = 0;
		},
	};
}

function setupSteeringLayout(t: test.TestContext): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steer-bootwindow-"));
	const steeringDir = path.join(dir, "artifacts", "steering");
	fs.mkdirSync(steeringDir, { recursive: true });
	const steeringFile = path.join(steeringDir, "01_01-agent.jsonl");
	const saved = process.env.PI_CREW_STEERING_FILE;
	process.env.PI_CREW_STEERING_FILE = steeringFile;
	t.after(() => {
		if (saved === undefined) delete process.env.PI_CREW_STEERING_FILE;
		else process.env.PI_CREW_STEERING_FILE = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return steeringFile;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return predicate();
}

test("F-L2: id-less steer written pre-bind (sendMessage throws once) is re-delivered on the next tick, not lost", async (t) => {
	const steeringFile = setupSteeringLayout(t);
	// Steer already in the file BEFORE the poll's first tick — the boot-window case.
	fs.writeFileSync(steeringFile, `${JSON.stringify({ type: "steer", message: "BOOT_WINDOW_STEER" })}\n`);

	const harness = makeBootWindowHarness({ failuresBeforeSuccess: 1 });
	registerPiTeamsPromptRuntime(harness.pi);

	// First poll tick (~500ms) throws pre-bind; the second (~1000ms) must
	// re-read the SAME entry (offset rewound) and deliver it.
	const delivered = await waitFor(() => harness.sent.length > 0, 5000);
	assert.equal(delivered, true, "steer must be delivered after the pre-bind throw");
	assert.equal(harness.throwCount(), 1);
	assert.equal(harness.sent[0]?.customType, "crew-steer");
	assert.equal(harness.sent[0]?.content, "BOOT_WINDOW_STEER");

	// Exactly once — the rewind must not cause duplicate delivery.
	await sleep(1200);
	assert.equal(harness.sent.length, 1);
});

test("F-L2: id-bearing steer survives a pre-bind throw via dedup unmark (no silent dedup loss)", async (t) => {
	const steeringFile = setupSteeringLayout(t);
	fs.writeFileSync(steeringFile, `${JSON.stringify({ type: "steer", id: "steer-boot-1", message: "ID_BEARING_STEER" })}\n`);

	const harness = makeBootWindowHarness({ failuresBeforeSuccess: 1 });
	registerPiTeamsPromptRuntime(harness.pi);

	// Without unmark, the retry would hit markOrSkip("steer-boot-1") → false
	// and the steer would be dropped forever — this test pins the unmark path.
	const delivered = await waitFor(() => harness.sent.length > 0, 5000);
	assert.equal(delivered, true, "id-bearing steer must be delivered after the pre-bind throw");
	assert.equal(harness.sent[0]?.content, "ID_BEARING_STEER");

	await sleep(1200);
	assert.equal(harness.sent.length, 1);
});

test("F-L2: persistent pre-bind failure keeps retrying (offset never advances past an undelivered entry)", async (t) => {
	const steeringFile = setupSteeringLayout(t);
	fs.writeFileSync(steeringFile, `${JSON.stringify({ type: "steer", message: "PERSISTENT_STEER" })}\n`);

	const harness = makeBootWindowHarness({ failuresBeforeSuccess: "always" });
	registerPiTeamsPromptRuntime(harness.pi);

	// Two poll ticks must BOTH attempt delivery (old code attempted once,
	// then advanced the offset and went silent).
	const retried = await waitFor(() => harness.throwCount() >= 2, 5000);
	assert.equal(retried, true, "poll must retry the undelivered entry on later ticks");

	// Once the runtime binds (sendMessage works), the entry delivers exactly once.
	harness.flipToSuccess();
	const delivered = await waitFor(() => harness.sent.length > 0, 5000);
	assert.equal(delivered, true);
	assert.equal(harness.sent[0]?.content, "PERSISTENT_STEER");

	await sleep(1200);
	assert.equal(harness.sent.length, 1);
});

test("F-L2: multiple entries — a pre-bind failure rewinds to the failing line, earlier delivered lines are not re-sent", async (t) => {
	const steeringFile = setupSteeringLayout(t);
	// Entry 1 delivers fine; entry 2 hits the pre-bind throw; entry 3 must
	// still arrive after the rewind (delivered on the retry tick).
	fs.writeFileSync(
		steeringFile,
		[
			JSON.stringify({ type: "steer", message: "FIRST_STEER" }),
			JSON.stringify({ type: "steer", message: "SECOND_STEER" }),
			JSON.stringify({ type: "steer", message: "THIRD_STEER" }),
			"",
		].join("\n"),
	);

	// Fail exactly the SECOND sendMessage call (first succeeds — simulates a
	// steer landing mid-boot after bind became available mid-file).
	let call = 0;
	const sent: SentMessage[] = [];
	const pi = {
		registerTool: () => {
			/* record nothing */
		},
		on: () => {
			/* record nothing */
		},
		sendMessage: (message: SentMessage) => {
			call += 1;
			if (call === 2) throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
			sent.push(message);
			return Promise.resolve();
		},
	};
	registerPiTeamsPromptRuntime(pi as unknown as PromptRuntimePi);

	const allDelivered = await waitFor(() => sent.length >= 3, 6000);
	assert.equal(allDelivered, true, "all three steers must eventually deliver");
	assert.deepEqual(
		sent.map((m) => m.content),
		["FIRST_STEER", "SECOND_STEER", "THIRD_STEER"],
		"delivery order preserved, SECOND retried (not skipped, not duplicated)",
	);

	await sleep(1200);
	assert.equal(sent.length, 3);
});
