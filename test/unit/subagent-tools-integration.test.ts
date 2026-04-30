import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { registerPiTeams } from "../../src/extension/register.ts";
import { readPersistedSubagentRecord, savePersistedSubagentRecord, SubagentManager, type SubagentSpawnOptions } from "../../src/runtime/subagent-manager.ts";
import { registerSubagentTools } from "../../src/extension/registration/subagent-tools.ts";
import { toolResult } from "../../src/extension/tool-result.ts";
import { createRunManifest, updateRunStatus } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function createFakePi(options: { throwForTools?: string[] } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: unknown[] = [];
	const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
	const events = {
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
		},
		emit(event: string, data: unknown, ctx?: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(data, ctx);
		},
	};
	return {
		tools,
		commands,
		sentMessages,
		sentUserMessages,
		api: {
			events,
			on: events.on,
			registerTool(tool: any) {
				if (options.throwForTools?.includes(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: any) { commands.set(name, command); },
			sendMessage(message: unknown) { sentMessages.push(message); },
			sendUserMessage(content: string, options?: unknown) { sentUserMessages.push({ content, options }); },
		},
	};
}

function fakeCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify() {},
			setWidget() {},
			setStatus() {},
		},
	};
}

async function removeDirWithRetry(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 7) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
		}
	}
}

test("conflict-safe crew_agent aliases still register when generic Agent name is unavailable", () => {
	const fake = createFakePi({ throwForTools: ["Agent"] });
	registerPiTeams(fake.api as never);
	assert.equal(fake.tools.has("Agent"), false);
	assert.equal(fake.tools.has("crew_agent"), true);
	assert.equal(fake.tools.has("crew_agent_result"), true);
	assert.equal(fake.tools.has("crew_agent_steer"), true);
	fake.api.events.emit("session_shutdown", {});
});

test("registered Agent tool stamps background subagents with owner session generation", async () => {
	const fake = createFakePi();
	let captured: SubagentSpawnOptions | undefined;
	const manager = {
		spawn(options: SubagentSpawnOptions) {
			captured = options;
			return {
				id: "agent_owner_generation",
				type: options.type,
				description: options.description,
				prompt: options.prompt,
				status: "running",
				startedAt: Date.now(),
				background: options.background,
				ownerSessionGeneration: options.ownerSessionGeneration,
			};
		},
		getRecord() { return undefined; },
		waitForRecord: async () => undefined,
	} as unknown as SubagentManager;
	registerSubagentTools(fake.api as never, manager, { ownerSessionGeneration: () => 42 });
	const result = await fake.tools.get("Agent").execute("call-owner", { prompt: "Explore", description: "Explore", subagent_type: "explorer", run_in_background: true }, undefined, undefined, fakeCtx(process.cwd()) as never);
	assert.match(firstText(result), /Agent ID: agent_owner_generation/);
	assert.equal(captured?.ownerSessionGeneration, 42);
});

test("registered Agent tool can run a background subagent and join its result", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-tool-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const agentTool = fake.tools.get("Agent");
		const resultTool = fake.tools.get("get_subagent_result");
		assert.ok(agentTool);
		assert.ok(resultTool);
		assert.ok(fake.tools.get("crew_agent"));
		assert.ok(fake.tools.get("crew_agent_result"));
		const ctx = fakeCtx(cwd) as never;
		const launched = await agentTool.execute("call-1", { prompt: "Explore with tool", description: "Explore", subagent_type: "explorer", run_in_background: true }, undefined, undefined, ctx);
		const launchText = firstText(launched);
		assert.match(launchText, /Agent ID:/);
		const agentId = launchText.match(/Agent ID: (\S+)/)?.[1];
		assert.ok(agentId);
		const joined = await resultTool.execute("call-2", { agent_id: agentId, wait: true, verbose: true }, undefined, undefined, ctx);
		const joinedText = firstText(joined);
		assert.match(joinedText, /Status: completed/);
		assert.doesNotMatch(joinedText, /Error: Team workflow completed/);
		assert.match(joinedText, /Mock JSON success for explorer/);
		const restarted = createFakePi();
		registerPiTeams(restarted.api as never);
		const persisted = await restarted.tools.get("get_subagent_result").execute("call-3", { agent_id: agentId, verbose: true }, undefined, undefined, ctx);
		assert.match(firstText(persisted), /Status: completed/);
		assert.match(firstText(persisted), /Mock JSON success for explorer/);
		assert.equal(readPersistedSubagentRecord(cwd, agentId)?.resultConsumed, true);
		restarted.api.events.emit("session_shutdown", {});
		assert.equal(fake.sentMessages.length, 0, "wait=true marks result consumed and suppresses duplicate follow-up notification");
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("background subagent completion wakes the parent agent to join results", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-wakeup-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const ctx = fakeCtx(cwd) as never;
		const launched = await fake.tools.get("Agent").execute("call-wakeup", { prompt: "Explore and report", description: "Explore", subagent_type: "explorer", run_in_background: true }, undefined, undefined, ctx);
		const agentId = firstText(launched).match(/Agent ID: (\S+)/)?.[1];
		assert.ok(agentId);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && fake.sentUserMessages.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(fake.sentUserMessages.length, 1);
		assert.match(fake.sentUserMessages[0]!.content, /background subagent changed state/);
		assert.match(fake.sentUserMessages[0]!.content, new RegExp(`"id": "${agentId}"`));
		assert.match(fake.sentUserMessages[0]!.content, /"status": "completed"/);
		assert.match(fake.sentUserMessages[0]!.content, new RegExp(`agent_id="${agentId}"`));
		assert.match(fake.sentUserMessages[0]!.content, /continue the user's original task/);
		assert.deepEqual(fake.sentUserMessages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		await removeDirWithRetry(cwd);
	}
});

test("background subagent completion does not wake a newer session", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-stale-wakeup-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const ctx = fakeCtx(cwd) as never;
		fake.api.events.emit("session_start", {}, ctx);
		const launched = await fake.tools.get("Agent").execute("call-stale-wakeup", { prompt: "Explore and report", description: "Explore", subagent_type: "explorer", run_in_background: true }, undefined, undefined, ctx);
		assert.match(firstText(launched), /Agent ID:/);
		fake.api.events.emit("session_start", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 3500));
		assert.equal(fake.sentUserMessages.length, 0);
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		await removeDirWithRetry(cwd);
	}
});

test("session_before_switch suppresses pending background subagent wakeup", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-switch-wakeup-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const ctx = fakeCtx(cwd) as never;
		fake.api.events.emit("session_start", {}, ctx);
		const launched = await fake.tools.get("Agent").execute("call-switch-wakeup", { prompt: "Explore and report", description: "Explore", subagent_type: "explorer", run_in_background: true }, undefined, undefined, ctx);
		assert.match(firstText(launched), /Agent ID:/);
		fake.api.events.emit("session_before_switch", {});
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(fake.sentUserMessages.length, 0);
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		await removeDirWithRetry(cwd);
	}
});

test("get_subagent_result wait=true does not consume final result when wait returns blocked", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-blocked-wait-consume-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team: TeamConfig = { name: "blocked", description: "blocked", source: "builtin", filePath: "blocked.team.md", roles: [{ name: "executor", agent: "executor" }] };
		const { manifest } = createRunManifest({ cwd, team, goal: "blocked wait consume" });
		const running = updateRunStatus(manifest, "running", "running");
		const completedStatuses: string[] = [];
		const manager = new SubagentManager(1, (record) => completedStatuses.push(`${record.status}:${record.resultConsumed === true}`), 5);
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const runner = async (_options: SubagentSpawnOptions) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			updateRunStatus(running, "blocked", "blocked");
			return toolResult("blocked", { action: "run", status: "ok" as const, runId: running.runId });
		};
		const record = manager.spawn({ cwd, type: "executor", description: "blocked", prompt: "do", background: true }, runner);
		const result = await fake.tools.get("get_subagent_result").execute("call-blocked-wait", { agent_id: record.id, wait: true, verbose: true }, undefined, undefined, fakeCtx(cwd) as never);
		assert.match(firstText(result), /Status: blocked/);
		assert.equal(record.resultConsumed, false);
		updateRunStatus(running, "completed", "completed");
		const deadline = Date.now() + 1000;
		while (!completedStatuses.some((entry) => entry.startsWith("completed:")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(completedStatuses.includes("completed:false"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("get_subagent_result refreshes blocked records after run resumes to terminal", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-blocked-refresh-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		const team: TeamConfig = { name: "blocked", description: "blocked", source: "builtin", filePath: "blocked.team.md", roles: [{ name: "executor", agent: "executor" }] };
		const { manifest } = createRunManifest({ cwd, team, goal: "blocked refresh" });
		const running = updateRunStatus(manifest, "running", "running");
		const completed = updateRunStatus(running, "completed", "completed");
		const agentId = "agent_blocked_refresh_1";
		savePersistedSubagentRecord(cwd, {
			id: agentId,
			type: "executor",
			description: "Blocked refresh",
			prompt: "Do work",
			status: "blocked",
			startedAt: Date.now(),
			background: true,
			runId: completed.runId,
			blockedAt: Date.now() - 1000,
		});
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const result = await fake.tools.get("get_subagent_result").execute("call-blocked-refresh", { agent_id: agentId, verbose: true }, undefined, undefined, fakeCtx(cwd) as never);
		assert.match(firstText(result), /Status: completed/);
		assert.equal(readPersistedSubagentRecord(cwd, agentId)?.status, "completed");
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("get_subagent_result after restart fails fast for unrecoverable running record without run id", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-unrecoverable-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	let fake: ReturnType<typeof createFakePi> | undefined;
	try {
		const agentId = "agent_unrecoverable_1";
		savePersistedSubagentRecord(cwd, {
			id: agentId,
			type: "reviewer",
			description: "Interrupted",
			prompt: "Review",
			status: "running",
			startedAt: Date.now(),
			background: true,
		});
		fake = createFakePi();
		registerPiTeams(fake.api as never);
		const ctx = fakeCtx(cwd) as never;
		const result = await fake.tools.get("get_subagent_result").execute("call-unrecoverable", { agent_id: agentId, wait: true, verbose: true }, undefined, undefined, ctx);
		const text = firstText(result);
		assert.match(text, /Status: error/);
		assert.match(text, /cannot be recovered after restart/);
		assert.equal(readPersistedSubagentRecord(cwd, agentId)?.status, "error");
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

