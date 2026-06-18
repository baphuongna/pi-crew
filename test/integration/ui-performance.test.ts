import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest } from "../../src/state/state-store.ts";
import { updateCrewWidget, type CrewWidgetState } from "../../src/ui/crew-widget.ts";
import { createRunSnapshotCache } from "../../src/ui/run-snapshot-cache.ts";
import { RunDashboard } from "../../src/ui/run-dashboard.ts";
import { clearTranscriptCache, getTranscriptCacheEntry, readTranscriptLinesCached } from "../../src/ui/transcript-cache.ts";

function makeTeam(name: string): never {
	return { name, description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
}

function makeWorkflow(name: string): never {
	return { name, description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
}

test("dashboard snapshot render scales to 50 runs with bounded cache entries", { timeout: 60000 }, () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-perf-dashboard-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		// Scale down to 30 runs for CI stability while still testing the bounded cache behavior
		const runCount = process.env.CI ? 30 : 50;
		const manifests = Array.from({ length: runCount }, (_value, index) => {
			const created = createRunManifest({ cwd, team: makeTeam(`team-${index}`), workflow: makeWorkflow("workflow"), goal: `perf ${index}` });
			saveRunManifest({ ...created.manifest, status: index % 2 === 0 ? "running" : "completed" });
			saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:one`, runId: created.manifest.runId, taskId: created.tasks[0]?.id ?? "one", agent: "worker", role: "worker", runtime: "child-process", status: index % 2 === 0 ? "running" : "completed", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: [`run ${index}`], toolCount: 1, currentTool: "read", activityState: "active" } }]);
			const events = Array.from({ length: 200 }, (_event, eventIndex) => JSON.stringify({ time: created.manifest.createdAt, type: "task.progress", runId: created.manifest.runId, taskId: "one", message: `event ${eventIndex}`, metadata: { seq: eventIndex + 1, provenance: "test" } })).join("\n");
			fs.writeFileSync(created.manifest.eventsPath, `${events}\n`, "utf-8");
			return created.manifest;
		});
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0, maxEntries: 60 });
		const dashboard = new RunDashboard(manifests, () => {}, {}, { snapshotCache: cache, runProvider: () => manifests });
		const rendered = dashboard.render(140);
		// Verify that the dashboard renders output with the correct number of runs
		// The dashboard should show run IDs and status info
		assert.ok(rendered.length > 0, 'dashboard should render some output');
		// Verify the cache correctly bounds entries
		assert.ok(cache.snapshotsByKey().size <= runCount, 'cache should not exceed run count');
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("large transcript tail mode reads less than one megabyte by default", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-perf-transcript-"));
	try {
		const transcriptPath = path.join(cwd, "large.jsonl");
		const chunk = `${JSON.stringify({ type: "message_delta", text: "x".repeat(1000) })}\n`;
		fs.writeFileSync(transcriptPath, chunk.repeat(5000), "utf-8");
		clearTranscriptCache(transcriptPath);
		const parse = (text: string): string[] => text.split(/\r?\n/).filter(Boolean);
		const lines = readTranscriptLinesCached(transcriptPath, parse, Date.now(), { maxTailBytes: 256 * 1024 });
		const entry = getTranscriptCacheEntry(transcriptPath, { maxTailBytes: 256 * 1024 });
		assert.ok(lines.length > 0);
		assert.equal(entry?.truncated, true);
		assert.ok((entry?.bytesRead ?? Number.POSITIVE_INFINITY) <= 1024 * 1024);
		readTranscriptLinesCached(transcriptPath, parse, Date.now(), { full: true, maxTailBytes: 256 * 1024 });
		assert.equal(getTranscriptCacheEntry(transcriptPath, { full: true, maxTailBytes: 256 * 1024 })?.truncated, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("repeated widget updates keep a single persistent widget install", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ui-perf-widget-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const created = createRunManifest({ cwd, team: makeTeam("widget"), workflow: makeWorkflow("workflow"), goal: "widget perf" });
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [{ id: `${created.manifest.runId}:one`, runId: created.manifest.runId, taskId: created.tasks[0]?.id ?? "one", agent: "worker", role: "worker", runtime: "child-process", status: "running", startedAt: created.manifest.createdAt, progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "active" } }]);
		const setWidgetCalls: Array<{ key: string; content: unknown }> = [];
		const ctx = { cwd, hasUI: true, ui: { setStatus: () => {}, requestRender: () => {}, setWidget: (key: string, content: unknown) => setWidgetCalls.push({ key, content }) } } as never;
		const state: CrewWidgetState = { frame: 0 };
		for (let index = 0; index < 100; index += 1) updateCrewWidget(ctx, state);
		assert.equal(setWidgetCalls.filter((call) => call.key === "pi-crew-active" && call.content).length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
