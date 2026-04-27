import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { registerPiTeams } from "../../src/extension/register.ts";

function createFakePi(options: { throwForTools?: string[] } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const sentMessages: unknown[] = [];
	const events = {
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
		},
		emit(event: string, data: unknown) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
	return {
		tools,
		commands,
		sentMessages,
		api: {
			events,
			on: events.on,
			registerTool(tool: any) {
				if (options.throwForTools?.includes(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: any) { commands.set(name, command); },
			sendMessage(message: unknown) { sentMessages.push(message); },
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

test("conflict-safe crew_agent aliases still register when generic Agent name is unavailable", () => {
	const fake = createFakePi({ throwForTools: ["Agent"] });
	registerPiTeams(fake.api as never);
	assert.equal(fake.tools.has("Agent"), false);
	assert.equal(fake.tools.has("crew_agent"), true);
	assert.equal(fake.tools.has("crew_agent_result"), true);
	assert.equal(fake.tools.has("crew_agent_steer"), true);
	fake.api.events.emit("session_shutdown", {});
});

test("registered Agent tool can run a background subagent and join its result", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-tool-test-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
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
		const launchText = launched.content[0]?.text ?? "";
		assert.match(launchText, /Agent ID:/);
		const agentId = launchText.match(/Agent ID: (\S+)/)?.[1];
		assert.ok(agentId);
		const joined = await resultTool.execute("call-2", { agent_id: agentId, wait: true, verbose: true }, undefined, undefined, ctx);
		const joinedText = joined.content[0]?.text ?? "";
		assert.match(joinedText, /Status: completed/);
		assert.doesNotMatch(joinedText, /Error: Team workflow completed/);
		assert.match(joinedText, /Mock JSON success for explorer/);
		assert.equal(fake.sentMessages.length, 0, "wait=true marks result consumed and suppresses duplicate follow-up notification");
	} finally {
		fake?.api.events.emit("session_shutdown", {});
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
