/**
 * w7a-render — worker transcript terminal-escape-injection regression tests
 * (fingerprint: pi-crew/inline-panel/worker-transcript-terminal-escape-injection).
 *
 * Worker-written events.jsonl strings (assistant text/thinking, toolName,
 * user text, system text, tool-result content) reached pi host components
 * verbatim, so raw OSC 52 / OSC 8 / CSI payloads rode pi-tui's verbatim
 * terminal.write. The fix neutralizes every string at the parser boundary
 * (agent-transcript.ts) via stripTerminalSequences.
 *
 * Two levels of proof:
 *  1. parser-level: every string field of every parsed item is escape-free
 *     (the exact seam handed to AssistantMessageComponent /
 *     ToolExecutionComponent / UserMessageComponent / the dim system line);
 *  2. render-level: CrewAgentPane.render() output for the poisoned fixture
 *     contains none of the planted payload markers (trusted pi styling may
 *     add its own ANSI, so payload-marker absence is the assertion, plus
 *     the sanitized prose MUST be present proving the render path is live).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { CrewAgentPane } from "../../../src/ui/inline-panel/agent-pane.ts";
import {
	type CrewTranscriptItem,
	readAgentTranscript,
	resetAllAgentTranscriptCursors,
} from "../../../src/ui/inline-panel/agent-transcript.ts";
import { setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const TASK = "task_1";
const RUN = "run_1";

const OSC52 = "\u001b]52;c;aGkK\u0007"; // clipboard grab, BEL-terminated
const OSC52_ST = "\u001b]52;c;ZWNobyBwd25lZA==\u001b\\"; // clipboard grab, ST-terminated
const CSI2J = "\u001b[2J"; // screen clear
const DA1 = "\u001b[6n"; // device-status query (response spoofing)
const OSC0 = "\u001b]0;evil-title\u0007"; // title set

interface Fixture {
	manifest: TeamRunManifest;
	dir: string;
	file: string;
}

function makeFixture(runId: string = RUN): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-agent-transcript-esc-test-"));
	const agentsDir = path.join(dir, "agents", TASK);
	fs.mkdirSync(agentsDir, { recursive: true });
	const file = path.join(agentsDir, "events.jsonl");
	const manifest = { runId, stateRoot: dir, artifactsRoot: dir } as unknown as TeamRunManifest;
	return { manifest, dir, file };
}

function writeEvents(fixture: Fixture, events: Array<Record<string, unknown>>, startSeq = 1): void {
	const lines = events.map((event, i) => JSON.stringify({ seq: startSeq + i, time: new Date().toISOString(), event }));
	fs.appendFileSync(fixture.file, `${lines.join("\n")}\n`, "utf-8");
}

/** Every string anywhere in the item tree must be free of ESC/C1/BEL bytes. */
function assertItemsEscapeFree(items: CrewTranscriptItem[]): void {
	const json = JSON.stringify(items);
	assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(json), `parsed items must be escape-free, got: ${json}`);
}

async function cleanup(fixture: Fixture): Promise<void> {
	resetAllAgentTranscriptCursors();
	try {
		await removeDirWithRetry(fixture.dir);
	} catch {
		/* ignore */
	}
}

test("parser strips OSC/CSI from assistant text, thinking, toolName, user, system and toolResult text", async () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: `plan${OSC52}ning` },
						{ type: "text", text: `Hello ${OSC52}${CSI2J}${OSC0}world\nsecond line` },
					],
					stopReason: "end_turn",
				},
			},
			{ type: "tool_execution_start", toolName: `re${OSC52}ad`, args: { file_path: "/tmp/a.ts" } },
			{ type: "tool_execution_end", toolName: "read" },
			{
				type: "message_end",
				message: { role: "toolResult", content: [{ type: "text", text: `<file${CSI2J}body>${OSC52_ST}` }], isError: false },
			},
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: `run${OSC52}now` }] } },
			{ type: "system", text: `sys${OSC52}tem` },
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		assertItemsEscapeFree(items);

		const assistant = items.find((i) => i.type === "assistant");
		assert.ok(assistant && assistant.type === "assistant");
		assert.equal(assistant.text, "Hello world\nsecond line", "escape payloads removed, newline structure PRESERVED");
		const messageJson = JSON.stringify(assistant.message);
		assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(messageJson), `retained message must be escape-free: ${messageJson}`);
		assert.ok((messageJson as string).includes("planning"), "sanitized thinking text must survive inside the retained message");

		const tool = items.find((i) => i.type === "tool");
		assert.ok(tool && tool.type === "tool");
		assert.equal(tool.name, "read", "toolName sanitized — and still folds with its toolResult (both sides sanitized alike)");
		assert.ok(tool.result !== undefined, "toolResult must still fold into the pending start");
		assert.deepEqual(tool.result!.content, [{ type: "text", text: "<filebody>" }]);

		const user = items.find((i) => i.type === "user");
		assert.ok(user && user.type === "user");
		assert.equal(user.text, "runnow");

		const system = items.find((i) => i.type === "system");
		assert.ok(system && system.type === "system");
		assert.equal(system.text, "system");
	} finally {
		await cleanup(fixture);
	}
});

test("clean transcripts are untouched by the sanitization pass", async () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "plain prose\nover two lines" }], stopReason: "end_turn" },
			},
		]);
		const items = readAgentTranscript(fixture.manifest, TASK);
		assert.equal(items.length, 1);
		const assistant = items[0]!;
		assert.ok(assistant.type === "assistant");
		assert.equal(assistant.text, "plain prose\nover two lines");
	} finally {
		await cleanup(fixture);
	}
});

// ─── render-level: CrewAgentPane.render over the poisoned fixture ────────────

const fixtureTeam: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const fixtureWorkflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

test("pane render of a poisoned transcript emits none of the planted payload markers", async () => {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "crew-agent-transcript-pane-esc-"));
	try {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd: dir,
			team: fixtureTeam,
			workflow: fixtureWorkflow,
			goal: "escape render check",
		});
		const taskId = tasks[0]!.id;
		const agentsDir = path.join(manifest.stateRoot, "agents", taskId);
		fs.mkdirSync(agentsDir, { recursive: true });
		const events = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Hello ${OSC52}${DA1}${OSC0}world` }],
					stopReason: "end_turn",
				},
			},
			{ type: "tool_execution_start", toolName: `re${OSC52_ST}ad`, args: { file_path: "/tmp/a.ts" } },
			{ type: "tool_execution_end", toolName: "read" },
			{
				type: "message_end",
				message: { role: "toolResult", content: [{ type: "text", text: `body${OSC52_ST}` }], isError: false },
			},
			{ type: "system", text: `sys${OSC52}tem` },
		];
		const lines = events.map((event, i) => JSON.stringify({ seq: i + 1, time: new Date().toISOString(), event }));
		fs.appendFileSync(path.join(agentsDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");

		const tui = { terminal: { rows: 80, columns: 160 }, requestRender: () => undefined };
		const pane = new CrewAgentPane(tui as never, { colors: {} } as never, dir);
		setViewedAgent({ runId: manifest.runId, taskId });
		try {
			const out = pane.render(160).join("\n");
			assert.ok(!/[\u001b]52;c;/.test(out), "no OSC-52 introducer+body may reach rendered lines");
			assert.ok(!out.includes("aGkK"), "OSC-52 base64 body must not survive the render");
			assert.ok(!out.includes("ZWNobyBwd25lZA=="), "OSC-52 ST-variant base64 body must not survive the render");
			assert.ok(!out.includes("evil-title"), "OSC-0 title payload must not survive the render");
			assert.ok(!out.includes("file:///"), "no planted OSC-8 hyperlink target may appear");
			// The render path is LIVE: the sanitized assistant prose must be present.
			assert.ok(out.includes("Hello world"), `sanitized assistant text must render, got:\n${out}`);
		} finally {
			setViewedAgent(undefined);
			resetAllAgentTranscriptCursors();
			pane.dispose();
		}
	} finally {
		await removeDirWithRetry(dir);
	}
});
