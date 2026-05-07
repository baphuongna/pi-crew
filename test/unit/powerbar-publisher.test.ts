import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { compactTokens, registerPiCrewPowerbarSegments, updatePiCrewPowerbar } from "../../src/ui/powerbar-publisher.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

test("powerbar publisher registers and updates active crew segments", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = { emit: (event: string, data: unknown) => events.push({ event, data }) };
		registerPiCrewPowerbarSegments(bus);
		assert.ok(events.some((item) => item.event === "powerbar:register-segment"));
		const team = { name: "fast-fix", description: "", roles: [{ name: "explorer", agent: "explorer" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "fast-fix", description: "", steps: [{ id: "explore", role: "explorer" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "powerbar" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "01", agent: "explorer", role: "explorer", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt }]);
		updatePiCrewPowerbar(bus, cwd);
		assert.ok(events.some((item) => item.event === "powerbar:update" && JSON.stringify(item.data).includes("pi-crew-active")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

function payloadRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}

test("powerbar progress uses task totals and respects model/token visibility", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-tasks-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-tasks-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = { emit: (event: string, data: unknown) => events.push({ event, data }) };
		const team = { name: "powerbar-team", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "powerbar-workflow", description: "", steps: [{ id: "one", role: "worker" }, { id: "two", role: "worker" }, { id: "three", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "powerbar" });
		saveRunManifest({ ...created.manifest, status: "running" });
		const tasks = created.tasks.map((task, index): TeamTaskState => ({
			...task,
			status: index === 0 ? "completed" : index === 1 ? "running" : "queued",
			usage: index === 0 ? { input: 1000, output: 500 } : undefined,
		}));
		saveRunTasks(created.manifest, tasks);
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: tasks[1]?.id ?? "two", agent: "worker", role: "worker", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, model: "provider/visible-model", progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "active" } }]);

		updatePiCrewPowerbar(bus, cwd, { showModel: false, showTokens: false });
		const hiddenActive = [...events].reverse().find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-active");
		const hiddenProgress = [...events].reverse().find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-progress");
		assert.equal(payloadRecord(hiddenActive?.data).suffix, undefined);
		assert.equal(payloadRecord(hiddenProgress?.data).suffix, "1/3");
		assert.equal(payloadRecord(hiddenProgress?.data).bar, 33);

		events.length = 0;
		updatePiCrewPowerbar(bus, cwd, { showModel: true, showTokens: true });
		const visibleActive = [...events].reverse().find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-active");
		const visibleProgress = [...events].reverse().find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-progress");
		assert.equal(payloadRecord(visibleActive?.data).suffix, "visible-model · 2k");
		assert.equal(payloadRecord(visibleProgress?.data).suffix, "1/3 · 2k");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar mirrors status when no powerbar consumer is registered", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-fallback-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-fallback-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = { emit: (event: string, data: unknown) => events.push({ event, data }), listenerCount: () => 0 };
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) } };
		const team = { name: "fallback-team", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "fallback-workflow", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "powerbar fallback" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "one", agent: "worker", role: "worker", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "active" } }]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, ctx);
		assert.ok(events.some((item) => item.event === "powerbar:update"));
		assert.ok(statuses.some((item) => item.key === "pi-crew" && item.text?.includes("crew 1a")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar skips status fallback when a powerbar consumer is registered", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-consumer-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-consumer-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const bus = { emit: () => {}, listenerCount: (event: string) => event === "powerbar:update" ? 1 : 0 };
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) } };
		const team = { name: "consumer-team", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "consumer-workflow", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "powerbar consumer" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "one", agent: "worker", role: "worker", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "active" } }]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, ctx);
		assert.equal(statuses.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar active segment includes notification badge", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-badge-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-badge-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = { emit: (event: string, data: unknown) => events.push({ event, data }) };
		const team = { name: "badge-team", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
		const workflow = { name: "badge-workflow", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
		const created = createRunManifest({ cwd, team, workflow, goal: "powerbar badge" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:01`, runId: created.manifest.runId, taskId: "one", agent: "worker", role: "worker", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "active" } }]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, undefined, 3);
		const active = events.map((item) => payloadRecord(item.data)).find((item) => item.id === "pi-crew-active" && typeof item.text === "string");
		assert.match(String(active?.text ?? ""), /3/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("compactTokens keeps short values and compacts thousands", () => {
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(1500), "2k");
});
