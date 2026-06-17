import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { buildCrewWidgetLines, updateCrewWidget, type CrewWidgetState } from "../../src/ui/widget/index.ts";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { clearLiveAgentsForTest } from "../../src/runtime/live-agent-manager.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../src/state/state-store.ts";

test("crew widget keeps persistent component until placement changes and refreshes progress", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-persist-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = { name: "fast-fix", description: "", roles: [{ name: "explorer", agent: "explorer" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "fast-fix", description: "", steps: [{ id: "explore", role: "explorer" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "persistent widget" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "01", agent: "explorer", role: "explorer", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: ["first output"], toolCount: 1, currentTool: "read", tokens: 10 } }]);
		const setWidgetCalls: Array<{ key: string; content: unknown; placement?: string }> = [];
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				setStatus: () => {},
				setWidget: (key: string, content: unknown, options?: { placement?: string }) => setWidgetCalls.push({ key, content, placement: options?.placement }),
				requestRender: () => {},
			},
		} as never;
		const state: CrewWidgetState = { frame: 0 };
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		assert.equal(setWidgetCalls.filter((call) => call.key === "pi-crew-active" && call.content).length, 1);
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as ((tui: unknown, theme: unknown) => { render(width: number): string[] });
		const component = factory(undefined, { fg: (_color: string, value: string) => value, bold: (value: string) => value });
		assert.match(component.render(100).join("\n"), /read/);
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "01", agent: "explorer", role: "explorer", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: ["second output"], toolCount: 2, currentTool: "bash", tokens: 20 } }]);
		assert.match(component.render(100).join("\n"), /running command/);
		updateCrewWidget(ctx, state, { widgetPlacement: "belowEditor" });
		assert.equal(setWidgetCalls.filter((call) => call.key === "pi-crew-active" && call.content).length, 2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew widget header spinner animates time-based across renders even when state.frame is fixed", async () => {
	clearLiveAgentsForTest();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-spin-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = { name: "fast-fix", description: "", roles: [{ name: "executor", agent: "executor" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "fast-fix", description: "", steps: [{ id: "fix", role: "executor" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "spin smoke" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "01", agent: "executor", role: "executor", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: ["working"], toolCount: 1, currentTool: "bash" } }]);
		const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
		const ctx = { cwd, hasUI: true, ui: { setStatus: () => {}, setWidget: (key: string, content: unknown) => setWidgetCalls.push({ key, content }), requestRender: () => {} } } as never;
		const state: CrewWidgetState = { frame: 7 };
		updateCrewWidget(ctx, state, { widgetPlacement: "aboveEditor" });
		const factory = setWidgetCalls.find((call) => call.key === "pi-crew-active" && call.content)?.content as ((tui: unknown, theme: unknown) => { render(width: number): string[] });
		const component = factory(undefined, { fg: (_color: string, value: string) => value, bold: (value: string) => value });
		const first = component.render(100)[0] ?? "";
		const firstGlyph = first.codePointAt(0);
		// Wait > spinner frame interval; state.frame is unchanged but glyph should rotate.
		await new Promise((resolve) => setTimeout(resolve, 220));
		const second = component.render(100)[0] ?? "";
		const secondGlyph = second.codePointAt(0);
		assert.notEqual(firstGlyph, secondGlyph, "expected spinner glyph to advance with wall-clock time even when state.frame is stable");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew widget hides active async runs whose background process is stale", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-stale-async-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-widget-stale-async-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = { name: "parallel-research", description: "", roles: [{ name: "explorer", agent: "explorer" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "parallel-research", description: "", steps: [{ id: "discover", role: "explorer" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "stale async" });
		const stalePid = 0;
		saveRunManifest({
			...created.manifest,
			status: "queued",
			async: { pid: stalePid, logPath: path.join(created.manifest.stateRoot, "background.log"), spawnedAt: new Date().toISOString() },
		});
		const lines = buildCrewWidgetLines(cwd, 0);
		assert.equal(lines.join("\n"), "");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});
