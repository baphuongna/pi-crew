/**
 * W5 (P2-2) — session_before_compact observer in the prompt-runtime
 * extension.
 *
 * The listener is observe-only: it returns undefined (never cancels or
 * customizes host compaction) and self-reports `worker.session_before_compact`
 * through the WP-9 worker events channel — scalar payload only, dormant
 * (zero file writes) when the worker carries no PI_CREW_EVENTS_PATH.
 *
 * NAME DISCIPLINE: `session_before_compact` is the host pi SDK's SESSION
 * compaction (context summarization), NOT pi-crew's internal
 * `prepareCompaction` event-log rotation — same word, different mechanism.
 *
 * Env note: this suite scrubs every PI_CREW_ and PI_TEAMS_ prefixed env
 * var at setup and restores them at teardown — required when run from inside
 * a pi-crew worker (ambient PI_CREW vars would otherwise leak in and flip
 * dormant gates).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPiTeamsPromptRuntime from "../../../src/prompt/prompt-runtime.ts";
import { readEvents } from "../../../src/state/event-log/cursor.ts";

type CompactHandler = (event: Record<string, unknown>) => unknown;

/** Stub-pi (pattern: ask-tool-lifecycle.test.ts makeMockPi) that records handlers. */
function makeMockPi(): { pi: ExtensionAPI; handlers: Map<string, CompactHandler[]> } {
	const handlers = new Map<string, CompactHandler[]>();
	const pi = {
		registerTool: () => undefined,
		on: (event: string, handler: CompactHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

const savedEnv = new Map<string, string | undefined>();
for (const key of Object.keys(process.env)) {
	if (key.startsWith("PI_CREW_") || key.startsWith("PI_TEAMS_")) savedEnv.set(key, process.env[key]);
}
function scrubCrewEnv(): void {
	for (const key of savedEnv.keys()) delete process.env[key];
}
function restoreCrewEnv(): void {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function fireCompact(handlers: Map<string, CompactHandler[]>, event: Record<string, unknown>): unknown {
	const list = handlers.get("session_before_compact");
	assert.ok(list && list.length > 0, "session_before_compact handler must be registered");
	return list[0]!(event);
}

test("observer: observe-only (returns undefined) and emits worker.session_before_compact with a scalar-only payload", () => {
	scrubCrewEnv();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-compact-obs-"));
	const eventsPath = path.join(dir, "events.jsonl");
	process.env.PI_CREW_EVENTS_PATH = eventsPath;
	process.env.PI_CREW_BROKER_RUN_ID = "run-compact-1";
	process.env.PI_CREW_TASK_ID = "task-compact-1";
	const { pi, handlers } = makeMockPi();
	let result: unknown;
	try {
		registerPiTeamsPromptRuntime(pi);
		result = fireCompact(handlers, {
			type: "session_before_compact",
			preparation: { tokensBefore: 987_654 },
			branchEntries: [{ type: "message", content: "SECRET-BRANCH-BODY" }],
			customInstructions: "SECRET-CUSTOM-INSTRUCTIONS",
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		});
	} finally {
		restoreCrewEnv();
	}
	// Observe-only: never cancel/redirect the host's own compaction.
	assert.equal(result, undefined);
	const raw = fs.readFileSync(eventsPath, "utf-8");
	const observed = readEvents(eventsPath).find((e) => e.type === "worker.session_before_compact");
	assert.ok(observed, "worker.session_before_compact must land in events.jsonl");
	assert.equal(observed.runId, "run-compact-1");
	assert.equal(observed.taskId, "task-compact-1");
	assert.equal(typeof observed.time, "string", "TeamEvent contract: time is required");
	assert.deepEqual(observed.data, {
		reason: "threshold",
		willRetry: false,
		branchEntryCount: 1,
		hasCustomInstructions: true,
		tokensBefore: 987_654,
	});
	// Payload hygiene: branch entries / custom-instruction bodies are NEVER serialized.
	assert.ok(!raw.includes("SECRET-BRANCH-BODY"), "branchEntries bodies must not be logged");
	assert.ok(!raw.includes("SECRET-CUSTOM-INSTRUCTIONS"), "customInstructions body must not be logged");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("observer: defensive payload when preparation is shapeless (no tokensBefore, no branchEntries)", () => {
	scrubCrewEnv();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-compact-obs-"));
	const eventsPath = path.join(dir, "events.jsonl");
	process.env.PI_CREW_EVENTS_PATH = eventsPath;
	process.env.PI_CREW_BROKER_RUN_ID = "run-compact-2";
	process.env.PI_CREW_TASK_ID = "task-compact-2";
	const { pi, handlers } = makeMockPi();
	let result: unknown;
	try {
		registerPiTeamsPromptRuntime(pi);
		result = fireCompact(handlers, {
			type: "session_before_compact",
			preparation: {},
			branchEntries: [],
			reason: "overflow",
			willRetry: true,
			signal: new AbortController().signal,
		});
	} finally {
		restoreCrewEnv();
	}
	assert.equal(result, undefined);
	const observed = readEvents(eventsPath).find((e) => e.type === "worker.session_before_compact");
	assert.ok(observed, "event must still be emitted");
	assert.deepEqual(observed.data, {
		reason: "overflow",
		willRetry: true,
		branchEntryCount: 0,
		hasCustomInstructions: false,
	});
	fs.rmSync(dir, { recursive: true, force: true });
});

test("observer: dormant without PI_CREW_EVENTS_PATH — handler registers, returns undefined, writes nothing", () => {
	scrubCrewEnv();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-compact-obs-"));
	const wouldBePath = path.join(dir, "events.jsonl");
	const { pi, handlers } = makeMockPi();
	let result: unknown;
	try {
		registerPiTeamsPromptRuntime(pi);
		result = fireCompact(handlers, {
			type: "session_before_compact",
			preparation: { tokensBefore: 1 },
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		});
	} finally {
		restoreCrewEnv();
	}
	assert.equal(result, undefined);
	assert.equal(fs.existsSync(wouldBePath), false, "no events file may be created outside a team run");
	fs.rmSync(dir, { recursive: true, force: true });
});
