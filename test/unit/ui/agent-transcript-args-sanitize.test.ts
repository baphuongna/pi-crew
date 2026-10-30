/**
 * W9-R1 (SEC-2026-11 w7a-render deferred residual): `tool_execution_start`
 * event.args are worker-controlled and were handed to pi's
 * ToolExecutionComponent verbatim — formatToolCallWithArgs interpolates
 * top-level keys and string values RAW, per-tool call renderers receive the
 * whole record, so raw OSC-52 / OSC-8 / CSI payloads rode pi-tui's verbatim
 * terminal.write. The fix strips terminal sequences from every string leaf
 * (and every object key) at the parser boundary, recursing shallowly into
 * nested objects/arrays; non-string leaves are inert (only ever rendered via
 * JSON.stringify, which escapes control characters) and are NOT touched.
 *
 * Two levels of proof (mirrors agent-transcript-untrusted-escape.test.ts):
 *  1. parser-level: the args of every parsed tool item are escape-free;
 *  2. render-level: CrewAgentPane.render() over poisoned args emits none of
 *     the planted payload markers while the sanitized arg prose renders live.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { CrewAgentPane } from "../../../src/ui/inline-panel/agent-pane.ts";
import { readAgentTranscript, resetAllAgentTranscriptCursors } from "../../../src/ui/inline-panel/agent-transcript.ts";
import { setViewedAgent } from "../../../src/ui/inline-panel/panel-store.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const TASK = "task_1";
const RUN = "run_1";

const OSC52 = "\u001b]52;c;aGkK\u0007"; // clipboard grab, BEL-terminated
const OSC52_ST = "\u001b]52;c;ZWNobyBwd25lZA==\u001b\\"; // clipboard grab, ST-terminated
const CSI2J = "\u001b[2J"; // screen clear
const OSC0 = "\u001b]0;evil-title\u0007"; // title set

interface Fixture {
	manifest: TeamRunManifest;
	dir: string;
	file: string;
}

function makeFixture(runId: string = RUN): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-agent-transcript-args-test-"));
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

function cleanup(fixture: Fixture): void {
	resetAllAgentTranscriptCursors();
	try {
		fs.rmSync(fixture.dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

test("args string leaves (top level, nested objects, arrays, keys) are sanitized at parse time", () => {
	const fixture = makeFixture();
	try {
		writeEvents(fixture, [
			{
				type: "tool_execution_start",
				toolName: "write",
				args: {
					file_path: `/tmp/${OSC52}a.ts`,
					cmd: `${OSC52_ST}curl http://evil${CSI2J}`,
					nested: { inner: `${OSC0}deep${OSC52}`, arr: [`x${OSC52}y`, 42, { k: `v${CSI2J}w` }] },
					limit: 42,
					flag: true,
					[`evil${OSC52}key`]: "safe value",
				},
			},
			{ type: "tool_execution_end", toolName: "write" },
		]);

		const items = readAgentTranscript(fixture.manifest, TASK);
		const json = JSON.stringify(items);
		assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(json), `parsed items must be escape-free, got: ${json}`);

		const tool = items.find((item) => item.type === "tool");
		assert.ok(tool && tool.type === "tool");
		const args = tool.args;
		assert.equal(args.file_path, "/tmp/a.ts", "top-level string value sanitized");
		assert.equal(args.cmd, "curl http://evil", "ST-terminated OSC-52 + CSI removed, prose preserved");
		const nested = args.nested as { inner: string; arr: Array<unknown> };
		assert.equal(nested.inner, "deep", "nested object string sanitized");
		assert.equal(nested.arr[0], "xy", "nested array string sanitized");
		assert.equal(nested.arr[1], 42, "numeric leaf untouched (not stringified)");
		assert.equal(nested.arr[2] && (nested.arr[2] as { k: string }).k, "vw", "array-of-object string leaf sanitized");
		assert.equal(args.limit, 42, "top-level numeric leaf untouched");
		assert.equal(args.flag, true, "boolean leaf untouched");
		assert.equal(args.evilkey, "safe value", "poisoned KEY sanitized, value preserved");
		assert.equal(
			Object.keys(args).some((key) => /[\u001b\u0007]/.test(key)),
			false,
			"no key may carry escape bytes",
		);
	} finally {
		cleanup(fixture);
	}
});

test("clean args pass through untouched (deep-equal, no over-sanitization)", () => {
	const fixture = makeFixture();
	try {
		const originalArgs = { file_path: "/tmp/a.ts", opts: { limit: 3, mode: "rw" }, arr: [1, "two", null] };
		writeEvents(fixture, [{ type: "tool_execution_start", toolName: "read", args: originalArgs }]);
		const items = readAgentTranscript(fixture.manifest, TASK);
		const tool = items.find((item) => item.type === "tool");
		assert.ok(tool && tool.type === "tool");
		assert.deepEqual(tool.args, originalArgs);
	} finally {
		cleanup(fixture);
	}
});

// ─── render-level: CrewAgentPane.render over poisoned args ───────────────────

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

test("pane render of poisoned args emits none of the planted payload markers, sanitized prose renders live", async () => {
	// pi's ToolExecutionComponent throws "Theme not initialized" without this —
	// initializing makes the args card genuinely render (non-vacuous absence
	// assertions below; each process runs its own module instance).
	initTheme();
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "crew-agent-transcript-pane-args-"));
	try {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({
			cwd: dir,
			team: fixtureTeam,
			workflow: fixtureWorkflow,
			goal: "args escape render check",
		});
		const taskId = tasks[0]!.id;
		const agentsDir = path.join(manifest.stateRoot, "agents", taskId);
		fs.mkdirSync(agentsDir, { recursive: true });
		// Keep the args SHORT: the collapsed card previews the first 100 chars,
		// so every planted marker must fall inside the genuinely-rendered span
		// (no vacuous absence assertions).
		const events = [
			{
				type: "tool_execution_start",
				toolName: "run",
				args: {
					p: `/x${OSC52}`,
					c: `${OSC52_ST}${CSI2J}curl http://evil`,
					t: `${OSC0}deep`,
				},
			},
			{ type: "tool_execution_end", toolName: "run" },
		];
		const lines = events.map((event, i) => JSON.stringify({ seq: i + 1, time: new Date().toISOString(), event }));
		fs.appendFileSync(path.join(agentsDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");

		const tui = { terminal: { rows: 80, columns: 160 }, requestRender: () => undefined };
		const pane = new CrewAgentPane(tui as never, { colors: {} } as never, dir);
		setViewedAgent({ runId: manifest.runId, taskId });
		try {
			const out = pane.render(160).join("\n");
			assert.ok(!/[\u001b]52;c;/.test(out), "no OSC-52 introducer+body may reach rendered lines");
			assert.ok(!out.includes("aGkK"), "OSC-52 BEL-variant base64 body must not survive the render");
			assert.ok(!out.includes("ZWNobyBwd25lZA=="), "OSC-52 ST-variant base64 body must not survive the render");
			assert.ok(!out.includes("evil-title"), "OSC-0 title payload must not survive the render");
			assert.ok(!out.includes("\u001b[2J"), "no raw CSI may reach rendered lines");
			// The render path is LIVE: the sanitized arg prose must be present.
			assert.ok(out.includes("curl http://evil"), `sanitized arg value must render, got:\n${out}`);
		} finally {
			setViewedAgent(undefined);
			resetAllAgentTranscriptCursors();
			pane.dispose();
		}
	} finally {
		await removeDirWithRetry(dir);
	}
});
