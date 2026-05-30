import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildPiSpawnOptions, runChildPi } from "../../src/runtime/child-pi.ts";
import { collectDependencyOutputContext, renderDependencyOutputContext } from "../../src/runtime/task-output-context.ts";
import { readCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import { writeArtifact } from "../../src/state/artifact-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "phase3",
	description: "phase3",
	source: "builtin",
	filePath: "phase3.team.md",
	roles: [{ name: "explorer", agent: "explorer" }, { name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "phase3",
	description: "phase3",
	source: "builtin",
	filePath: "phase3.workflow.md",
	steps: [
		{ id: "explore", role: "explorer", task: "Explore" },
		{ id: "plan", role: "planner", task: "Plan", dependsOn: ["explore"], reads: ["context.md"] },
	],
};

test("child Pi spawn options preserve configured extra env vars", () => {
	const options = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: process.env.PATH ?? "",
			CUSTOM_PROVIDER_API_KEY: "provider-secret",
			AWS_PROFILE: "nsx",
			UNRELATED_SECRET: "drop-me",
		},
		["CUSTOM_PROVIDER_API_KEY", "AWS_PROFILE"],
	);
	const env = options.env as Record<string, string>;
	assert.equal(env.CUSTOM_PROVIDER_API_KEY, "provider-secret");
	assert.equal(env.AWS_PROFILE, "nsx");
	assert.equal(env.UNRELATED_SECRET, undefined);
});

test("child Pi spawn options preserve configured env var globs", () => {
	const options = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: process.env.PATH ?? "",
			MYPROXY_TOKEN: "token-secret",
			MYPROXY_ENDPOINT: "https://proxy.example",
			OTHER_TOKEN: "drop-me",
		},
		["MYPROXY_*"],
	);
	const env = options.env as Record<string, string>;
	assert.equal(env.MYPROXY_TOKEN, "token-secret");
	assert.equal(env.MYPROXY_ENDPOINT, "https://proxy.example");
	assert.equal(env.OTHER_TOKEN, undefined);
});

test("child Pi spawn options hide Windows console windows", () => {
	const options = buildChildPiSpawnOptions("/tmp/project", { PATH: process.env.PATH ?? "" });
	assert.equal(options.windowsHide, true);
	assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]); // stdin=ignore: child doesn't wait for input; task comes via CLI args (Bug #18 fix)
});

test("child Pi runtime writes JSONL transcript callbacks", async () => {
	const previous = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-transcript-"));
	const transcriptPath = path.join(dir, "transcript.jsonl");
	const events: unknown[] = [];
	try {
		const result = await runChildPi({ cwd: dir, task: "hello", agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" }, transcriptPath, onJsonEvent: (event) => events.push(event) });
		assert.equal(result.exitCode, 0);
		assert.equal(events.length, 2);
		assert.match(fs.readFileSync(transcriptPath, "utf-8"), /message_end/);
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi response timeout treats filtered stdout JSON as activity", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousBin = process.env.PI_TEAMS_PI_BIN;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-filtered-activity-"));
	try {
		const fakePi = path.join(process.cwd(), "node_modules", ".bin", "fake-pi-phase3.js");
		fs.writeFileSync(fakePi, `
console.log(JSON.stringify({ type: "message_update", message: { content: [{ type: "thinking", text: "still working" }] } }));
setTimeout(() => console.log(JSON.stringify({ type: "message_update", message: { content: [{ type: "thinking", text: "still working" }] } })), 600);
setTimeout(() => {
  console.log(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }));
}, 1500);
setTimeout(() => process.exit(0), 1550);
`, "utf-8");
		process.env.PI_TEAMS_PI_BIN = fakePi;
		const result = await runChildPi({ cwd: dir, task: "hello", agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" }, responseTimeoutMs: 1000, finalDrainMs: 1000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.match(result.stdout, /done/);
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = previousBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi final-drain termination after final assistant output is treated as completed", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousBin = process.env.PI_TEAMS_PI_BIN;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-final-drain-"));
	try {
		const fakePi = path.join(process.cwd(), "node_modules", ".bin", "fake-pi-phase3-drain.js");
		fs.writeFileSync(fakePi, `
console.log(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final answer before lingering cleanup" }] } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }));
setInterval(() => {}, 1000);
`, "utf-8");
		process.env.PI_TEAMS_PI_BIN = fakePi;
		const result = await runChildPi({ cwd: dir, task: "hello", agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" }, finalDrainMs: 100, hardKillMs: 100, responseTimeoutMs: 1000 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.match(result.stdout, /final answer before lingering cleanup/);
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = previousBin;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("child Pi runtime ignores observer callback failures", async () => {
	const previous = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-child-callback-failure-"));
	try {
		const result = await runChildPi({
			cwd: dir,
			task: "hello",
			agent: { name: "mock", description: "mock", source: "builtin", filePath: "mock.md", systemPrompt: "mock" },
			onJsonEvent: () => { throw new Error("observer write failed"); },
			onStdoutLine: () => { throw new Error("output write failed"); },
		});
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /MOCK.*JSON success/);
	} finally {
		if (previous === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("dependency output context injects prior task output and shared reads", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-output-context-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "phase3" });
		const resultArtifact = writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: "results/01_explore.md", producer: "01_explore", content: "Exploration output" });
		fs.mkdirSync(path.join(manifest.artifactsRoot, "shared"), { recursive: true });
		fs.writeFileSync(path.join(manifest.artifactsRoot, "shared", "context.md"), "Shared context", "utf-8");
		const updatedTasks = tasks.map((task) => task.stepId === "explore" ? { ...task, status: "completed" as const, resultArtifact } : task);
		const plan = updatedTasks.find((task) => task.stepId === "plan")!;
		const ctx = collectDependencyOutputContext(manifest, updatedTasks, plan, workflow.steps[1]!);
		const rendered = renderDependencyOutputContext(ctx);
		assert.match(rendered, /Exploration output/);
		assert.match(rendered, /Shared context/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew agent records mirror task agents", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-records-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "phase3" });
		assert.deepEqual(readCrewAgents(manifest), []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
