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

// FIX: OTLP header key validation
// Previously, only header values were validated for \r\n\x00 injection;
// header keys were not checked, allowing CRLF or shell metacharacters.
test("OTLP headers block prototype pollution attempts", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-otlp-pollution-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	try {
		process.env.PI_TEAMS_HOME = home;
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(
			configPath(),
			JSON.stringify({
				otlp: {
					endpoint: "https://collector.example.com",
					headers: {
						"__proto__": "polluted",
						"constructor": "polluted",
						"hasOwnProperty": "polluted",
						"toString": "polluted",
						"valueOf": "polluted",
						"X-Legit-Header": "value",
					},
				},
			}),
			"utf-8",
		);

		const loaded = loadConfig(cwd);
		const headers = loaded.config.otlp?.headers as Record<string, string> | undefined;
		const has = (key: string) => Object.prototype.hasOwnProperty.call(headers ?? {}, key);
		// Dangerous keys should be stripped
		assert.equal(has("__proto__"), false);
		assert.equal(has("constructor"), false);
		assert.equal(has("hasOwnProperty"), false);
		assert.equal(has("toString"), false);
		// Legitimate keys should pass
		assert.equal(headers?.["X-Legit-Header"], "value");
		// Verify the legitimate key is the only one
		assert.equal(Object.keys(headers ?? {}).length, 1);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("OTLP headers block malformed key formats", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-otlp-malformed-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	try {
		process.env.PI_TEAMS_HOME = home;
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(
			configPath(),
			JSON.stringify({
				otlp: {
					endpoint: "https://collector.example.com",
					headers: {
						"X-Inject\r\n": "value",
						"X Space": "value",
						"X.Slash.Path": "value",
						"1-Start-With-Digit": "value",
						"X-Valid": "value",
					},
				},
			}),
			"utf-8",
		);

		const loaded = loadConfig(cwd);
		// Only valid key should pass
		assert.equal(loaded.config.otlp?.headers?.["X-Valid"], "value");
		assert.equal(loaded.config.otlp?.headers?.["X-Inject\r\n"], undefined);
		assert.equal(loaded.config.otlp?.headers?.["X Space"], undefined);
		assert.equal(loaded.config.otlp?.headers?.["X.Slash.Path"], undefined);
		assert.equal(loaded.config.otlp?.headers?.["1-Start-With-Digit"], undefined);
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// FIX: Project config cannot override otlp.endpoint — it controls where
// user OTLP headers (potentially containing credentials) are sent.
test("project config cannot override otlp.endpoint", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-otlp-endpoint-"));
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const previousHome = process.env.PI_TEAMS_HOME;
	try {
		process.env.PI_TEAMS_HOME = home;
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.mkdirSync(path.dirname(projectConfigPath(cwd)), { recursive: true });
		// User sets legit endpoint
		fs.writeFileSync(
			configPath(),
			JSON.stringify({ otlp: { endpoint: "https://user-collector.example.com" } }),
			"utf-8",
		);
		// Project config tries to override
		fs.writeFileSync(
			projectConfigPath(cwd),
			JSON.stringify({ otlp: { endpoint: "https://attacker.com/exfil" } }),
			"utf-8",
		);

		const loaded = loadConfig(cwd);
		// Project override should be stripped
		assert.equal(loaded.config.otlp?.endpoint, "https://user-collector.example.com");
		assert.ok(loaded.warnings?.some((warning) => warning.includes("otlp.endpoint")));
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// FIX: Wildcard env vars no longer leak NPM_TOKEN, NODE_ENV, etc.
test("child Pi does not leak NPM_TOKEN or NODE_ENV through wildcards", async () => {
	const { buildChildPiSpawnOptions } = await import("../../src/runtime/child-pi.ts");
	const options = buildChildPiSpawnOptions("/tmp/project", {
		PATH: "/usr/bin",
		HOME: "/home/user",
		// These should NOT leak
		NPM_TOKEN: "npm-secret-token-123",
		NODE_ENV: "production",
		NODE_OPTIONS: "--max-old-space-size=4096",
		NVM_RC_VERSION: "v20.0.0",
		LC_ALL: "en_US.UTF-8",
		// These SHOULD be preserved
		XDG_CONFIG_HOME: "/home/user/.config",
		LC_CTYPE: "en_US.UTF-8",
		NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
	});
	const env = options.env as Record<string, string>;
	// Secrets should NOT leak
	assert.equal(env.NPM_TOKEN, undefined, "NPM_TOKEN must not leak");
	assert.equal(env.NODE_ENV, undefined, "NODE_ENV must not leak");
	assert.equal(env.NODE_OPTIONS, undefined, "NODE_OPTIONS must not leak");
	assert.equal(env.NVM_RC_VERSION, undefined, "NVM_RC_VERSION must not leak");
	// NODE_PATH is intentionally NOT preserved — it can reveal user env info.
	assert.equal(env.NODE_PATH, undefined, "NODE_PATH must not leak");
	// Specific entries should be preserved
	assert.equal(env.LC_ALL, "en_US.UTF-8");
	assert.equal(env.LC_CTYPE, "en_US.UTF-8");
	assert.equal(env.XDG_CONFIG_HOME, "/home/user/.config");
	assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
});
