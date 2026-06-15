import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import {
	formatAmbientStatus,
	buildStatusMessage,
	handleContextEvent,
	AMBIENT_STATUS_SENTINEL,
} from "../../src/extension/context-status-injection.ts";

/** Build a minimal manifest fixture for testing. */
function makeRun(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "team_20260615_abcdef0123",
		sessionId: "sess_abcdef",
		team: "default",
		workflow: "default",
		goal: "Implement feature X",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-06-15T10:00:00.000Z",
		updatedAt: "2026-06-15T10:00:00.000Z",
		cwd: "/tmp/proj",
		stateRoot: "/tmp/proj/.crew/state/runs/team_20260615_abcdef0123",
		artifactsRoot: "/tmp/proj/.crew/artifacts/team_20260615_abcdef0123",
		tasksPath: "/tmp/proj/.crew/state/runs/team_20260615_abcdef0123/tasks.json",
		eventsPath: "/tmp/proj/.crew/state/runs/team_20260615_abcdef0123/events.jsonl",
		artifacts: [],
		...overrides,
	};
}

test("formatAmbientStatus: empty runs returns empty string", () => {
	assert.equal(formatAmbientStatus([]), "");
});

test("formatAmbientStatus: single run includes sentinel, runId, team, status, goal", () => {
	const text = formatAmbientStatus([makeRun()]);
	assert.ok(text.startsWith(AMBIENT_STATUS_SENTINEL), "starts with sentinel");
	assert.ok(text.includes("1 pi-crew run in flight"), "singular count");
	assert.ok(text.includes("team_20260615_abcdef0123"), "runId present");
	assert.ok(text.includes("running"), "status present");
	assert.ok(text.includes("default"), "team present");
	assert.ok(text.includes("Implement feature X"), "goal present");
	assert.ok(text.includes("environmental context"), "signals it is not a user request");
});

test("formatAmbientStatus: multiple runs use plural and list each", () => {
	const text = formatAmbientStatus([
		makeRun({ runId: "run_a", goal: "A" }),
		makeRun({ runId: "run_b", goal: "B", status: "queued" }),
	]);
	assert.ok(text.includes("2 pi-crew runs in flight"), "plural count");
	assert.ok(text.includes("run_a"));
	assert.ok(text.includes("run_b"));
});

test("formatAmbientStatus: truncates long goals", () => {
	const longGoal = "A".repeat(200);
	const text = formatAmbientStatus([makeRun({ goal: longGoal })]);
	// Goal capped at ~80 chars with ellipsis
	assert.ok(!text.includes("A".repeat(200)), "full long goal not present");
	assert.ok(text.includes("…"), "truncation ellipsis present");
	// Each run line is bounded
	const runLine = text.split("\n").find((l) => l.includes("runId")) ?? text.split("\n").find((l) => l.startsWith("•"))!;
	assert.ok(runLine!.length < 160, `run line kept compact (was ${runLine!.length})`);
});

test("formatAmbientStatus: caps inline runs at 3 with 'and N more'", () => {
	const runs = Array.from({ length: 6 }, (_, i) => makeRun({ runId: `run_${i}` }));
	const text = formatAmbientStatus(runs);
	assert.ok(text.includes("and 3 more"), "mentions remaining count");
	// run_5 should NOT be inlined (only run_0..run_2)
	assert.ok(!text.includes("run_5"), "6th run not inlined");
});

test("buildStatusMessage: returns user-role message with status text", () => {
	const msg = buildStatusMessage([makeRun()]);
	assert.equal(msg.role, "user");
	assert.ok(Array.isArray(msg.content));
	const textPart = msg.content[0];
	assert.equal(textPart.type, "text");
	assert.ok((textPart as { text: string }).text.startsWith(AMBIENT_STATUS_SENTINEL));
	assert.equal(typeof msg.timestamp, "number");
});

test("handleContextEvent: returns undefined when cwd has no in-flight runs", () => {
	// Use an empty/nonexistent cwd so collectInFlightRuns finds nothing.
	const event: ContextEvent = {
		type: "context",
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
	const result = handleContextEvent(event, "/nonexistent/empty/cwd/for/test");
	assert.equal(result, undefined);
});

test("handleContextEvent: preserves original messages and inserts status before last", () => {
	// End-to-end with a REAL in-flight run on disk: create a manifest (status
	// 'queued' is in-flight), then verify the handler injects the status note.
	const realTmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-ctx-inj-"));
	fs.mkdirSync(path.join(realTmp, ".crew"), { recursive: true });
	try {
		const team: TeamConfig = {
			name: "default", description: "d", source: "builtin", filePath: "default.team.md",
			roles: [{ name: "planner", agent: "planner" }],
		};
		const workflow: WorkflowConfig = {
			name: "default", description: "d", source: "builtin", filePath: "default.workflow.md",
			steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
		};
		const created = createRunManifest({ cwd: realTmp, team, workflow, goal: "Ship feature Z" });

		const baseMessages = [
			{ role: "user" as const, content: "earlier turn", timestamp: 1 },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], api: "anthropic" as never, provider: "anthropic" as never, model: "claude", usage: {} as never, stopReason: "stop" as const, timestamp: 2 },
			{ role: "user" as const, content: "current prompt", timestamp: 3 },
		];
		const event: ContextEvent = { type: "context", messages: baseMessages };
		const result = handleContextEvent(event, realTmp);
		assert.ok(result, "returns a modified messages array when runs are in-flight");
		assert.ok(result!.messages, "messages present");
		// Status note inserted BEFORE the last message, so the last stays 'current prompt'
		assert.equal(result!.messages.length, baseMessages.length + 1, "exactly one status note added");
		const last = result!.messages[result!.messages.length - 1] as { content: unknown };
		const lastText = typeof last.content === "string" ? last.content : "";
		assert.equal(lastText, "current prompt", "last message preserved as turn driver");
		// The injected note is the second-to-last and carries the sentinel + run goal.
		const injected = result!.messages[result!.messages.length - 2] as { role: string; content: { text?: string }[] };
		assert.equal(injected.role, "user");
		const injectedText = injected.content[0]?.text ?? "";
		assert.ok(injectedText.startsWith(AMBIENT_STATUS_SENTINEL), "injected note has sentinel");
		assert.ok(injectedText.includes("Ship feature Z"), "injected note includes the run goal");
		assert.ok(injectedText.includes(created.manifest.runId), "injected note includes the runId");
	} finally {
		fs.rmSync(realTmp, { recursive: true, force: true });
	}
});

test("registerContextStatusInjection: enabled=false registers nothing (no throw)", async () => {
	const { registerContextStatusInjection } = await import("../../src/extension/context-status-injection.ts");
	let registered = false;
	const fakePi = { on: () => { registered = true; } } as unknown as Parameters<typeof registerContextStatusInjection>[0];
	// disabled → no registration
	registerContextStatusInjection(fakePi, { enabled: false });
	assert.equal(registered, false, "disabled does not register a handler");
});

test("registerContextStatusInjection: enabled (default) registers a context handler", async () => {
	const { registerContextStatusInjection } = await import("../../src/extension/context-status-injection.ts");
	const registered: string[] = [];
	const fakePi = {
		on: (event: string) => { registered.push(event); },
	} as unknown as Parameters<typeof registerContextStatusInjection>[0];
	registerContextStatusInjection(fakePi); // default enabled
	assert.ok(registered.includes("context"), "registers a 'context' event handler");
});

test("registerContextStatusInjection: handler is a no-op when no runs in-flight", async () => {
	const { registerContextStatusInjection } = await import("../../src/extension/context-status-injection.ts");
	let capturedHandler: ((e: ContextEvent) => unknown) | null = null;
	const fakePi = {
		on: (_event: string, handler: (e: ContextEvent) => unknown) => { capturedHandler = handler; },
	} as unknown as Parameters<typeof registerContextStatusInjection>[0];
	registerContextStatusInjection(fakePi);
	assert.ok(capturedHandler, "handler captured");
	const event: ContextEvent = {
		type: "context",
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
	};
	const result = (capturedHandler as (e: ContextEvent) => unknown)(event);
	assert.equal(result, undefined, "no in-flight runs → no-op (undefined)");
});
