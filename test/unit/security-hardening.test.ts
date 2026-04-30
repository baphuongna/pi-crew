import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeArtifact } from "../../src/state/artifact-store.ts";
import { appendEvent } from "../../src/state/event-log.ts";
import { createJsonlWriter } from "../../src/state/jsonl-writer.ts";
import { appendMailboxMessage } from "../../src/state/mailbox.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { appendCrewAgentEvent, appendCrewAgentOutput, writeCrewAgentStatus } from "../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../src/runtime/crew-agent-runtime.ts";
import { configPath, loadConfig, projectConfigPath } from "../../src/config/config.ts";
import { allAgents } from "../../src/agents/discover-agents.ts";
import { allTeams } from "../../src/teams/discover-teams.ts";
import { allWorkflows } from "../../src/workflows/discover-workflows.ts";
import { redactSecretString } from "../../src/utils/redaction.ts";

const SECRET = "sk-test-secret-123";

function makeManifest(root: string): TeamRunManifest {
	const stateRoot = path.join(root, "state");
	const artifactsRoot = path.join(root, "artifacts");
	return {
		schemaVersion: 1,
		runId: "run-security",
		team: "fast-fix",
		goal: "security",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: root,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function assertRedacted(raw: string): void {
	assert.doesNotMatch(raw, new RegExp(SECRET));
	assert.match(raw, /\*\*\*/);
}

test("redacts secrets at event, mailbox, artifact, log, and agent persistence boundaries", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-security-"));
	try {
		const manifest = makeManifest(root);
		const event = appendEvent(manifest.eventsPath, { type: "secret", runId: manifest.runId, message: `token=${SECRET}`, data: { apiKey: SECRET } });
		assert.equal(event.data?.apiKey, SECRET);
		assertRedacted(fs.readFileSync(manifest.eventsPath, "utf-8"));

		const mailboxMessage = appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: `Authorization: Bearer ${SECRET}` });
		assert.match(mailboxMessage.body, new RegExp(SECRET));
		assertRedacted(fs.readFileSync(path.join(manifest.stateRoot, "mailbox", "inbox.jsonl"), "utf-8"));

		const artifact = writeArtifact(manifest.artifactsRoot, { kind: "log", relativePath: "logs/output.txt", content: `password=${SECRET}`, producer: "test" });
		assertRedacted(fs.readFileSync(artifact.path, "utf-8"));

		const logPath = path.join(manifest.stateRoot, "stream.jsonl");
		const writer = createJsonlWriter(logPath, { pause() {}, resume() {} });
		writer.writeLine(JSON.stringify({ token: SECRET, ok: true }));
		await writer.close();
		assertRedacted(fs.readFileSync(logPath, "utf-8"));

		appendCrewAgentEvent(manifest, "task-1", { authorization: `Bearer ${SECRET}` });
		appendCrewAgentOutput(manifest, "task-1", `api_key=${SECRET}`);
		const record: CrewAgentRecord = { id: "agent-1", runId: manifest.runId, taskId: "task-1", agent: "executor", role: "executor", runtime: "scaffold", status: "running", startedAt: new Date().toISOString(), error: `secret=${SECRET}` };
		writeCrewAgentStatus(manifest, record);
		assertRedacted(fs.readFileSync(path.join(manifest.stateRoot, "agents", "task-1", "events.jsonl"), "utf-8"));
		assertRedacted(fs.readFileSync(path.join(manifest.stateRoot, "agents", "task-1", "output.log"), "utf-8"));
		assertRedacted(fs.readFileSync(path.join(manifest.stateRoot, "agents", "task-1", "status.json"), "utf-8"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("redaction avoids broad auth false positives", () => {
	assert.equal(redactSecretString("author=alice authentication=required token=abc123456"), "author=alice authentication=required token=***");
});

test("project resources cannot shadow builtin or user resources", () => {
	assert.equal(allAgents({ project: [{ name: "executor", description: "project", source: "project", filePath: "p", systemPrompt: "project" }], builtin: [{ name: "executor", description: "builtin", source: "builtin", filePath: "b", systemPrompt: "builtin" }], user: [] })[0]?.source, "builtin");
	assert.equal(allAgents({ project: [{ name: "custom", description: "project", source: "project", filePath: "p", systemPrompt: "project" }], builtin: [], user: [] })[0]?.source, "project");
	assert.equal(allTeams({ project: [{ name: "implementation", description: "project", source: "project", filePath: "p", roles: [] }], builtin: [{ name: "implementation", description: "builtin", source: "builtin", filePath: "b", roles: [] }], user: [] })[0]?.source, "builtin");
	assert.equal(allWorkflows({ project: [{ name: "implementation", description: "project", source: "project", filePath: "p", steps: [] }], builtin: [{ name: "implementation", description: "builtin", source: "builtin", filePath: "b", steps: [] }], user: [] })[0]?.source, "builtin");
});

test("project config cannot override sensitive user trust-boundary settings", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-trust-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const previousHome = process.env.PI_TEAMS_HOME;
	try {
		process.env.PI_TEAMS_HOME = home;
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.mkdirSync(path.dirname(projectConfigPath(cwd)), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify({ executeWorkers: false, runtime: { mode: "scaffold", requirePlanApproval: true }, worktree: { setupHook: "echo user" }, otlp: { headers: { Authorization: "Bearer user" } }, autonomous: { profile: "manual" } }), "utf-8");
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ executeWorkers: true, runtime: { mode: "child-process", requirePlanApproval: false }, worktree: { setupHook: "curl bad" }, otlp: { headers: { Authorization: "Bearer project" } }, autonomous: { profile: "aggressive" } }), "utf-8");

		const loaded = loadConfig(cwd);
		assert.equal(loaded.config.executeWorkers, false);
		assert.equal(loaded.config.runtime?.mode, "scaffold");
		assert.equal(loaded.config.runtime?.requirePlanApproval, true);
		assert.equal(loaded.config.worktree?.setupHook, "echo user");
		assert.equal(loaded.config.otlp?.headers?.Authorization, "Bearer user");
		assert.equal(loaded.config.autonomous?.profile, "manual");
		assert.ok(loaded.warnings?.some((warning) => warning.includes("executeWorkers")));
		assert.ok(loaded.warnings?.some((warning) => warning.includes("runtime.requirePlanApproval")));
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
