import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
import { AgentPickerOverlay, type AgentPickerSelection } from "../../src/ui/overlays/agent-picker-overlay.ts";

test("AgentPickerOverlay renders agents and selects current row", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-picker-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "pick",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "wf",
			description: "",
			steps: [
				{ id: "one", role: "worker" },
				{ id: "two", role: "worker" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "pick",
		});
		saveCrewAgents(
			created.manifest,
			created.tasks.map((task) => ({
				id: `${created.manifest.runId}:${task.id}`,
				runId: created.manifest.runId,
				taskId: task.id,
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
			})),
		);
		const selections: AgentPickerSelection[] = [];
		const overlay = new AgentPickerOverlay({
			cwd,
			runId: created.manifest.runId,
			done: (selection) => {
				if (selection) selections.push(selection);
			},
		});
		assert.ok(overlay.render(80).some((line) => line.includes("one")));
		overlay.handleInput("j");
		overlay.handleInput("\r");
		assert.match(selections[0]?.agentId ?? "", /two$/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("AgentPickerOverlay cancels with ESC", () => {
	const selections: Array<AgentPickerSelection | undefined> = [];
	const overlay = new AgentPickerOverlay({
		cwd: process.cwd(),
		runId: "missing",
		done: (selection) => selections.push(selection),
	});
	overlay.handleInput("\u001b");
	assert.equal(selections.length, 1);
	assert.equal(selections[0], undefined);
});
