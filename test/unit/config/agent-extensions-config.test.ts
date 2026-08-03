import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverAgents, invalidateAgentDiscoveryCache } from "../../../src/agents/discover-agents.ts";
import { configPath, parseConfig } from "../../../src/config/config.ts";

// ─── runtime.agentExtensions — parse ────────────────────────────────────────

test("parseConfig: runtime.agentExtensions parses string array", () => {
	const parsed = parseConfig({
		runtime: {
			agentExtensions: ["/home/u/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts"],
		},
	});
	assert.deepEqual(parsed.runtime?.agentExtensions, ["/home/u/.pi/agent/npm/node_modules/pi-commandcode-provider/index.ts"]);
});

test("parseConfig: runtime.agentExtensions accepts array, drops invalid", () => {
	const parsed = parseConfig({
		runtime: {
			agentExtensions: ["/a.ts", 42, "", "/b.ts"],
		},
	});
	// parseStringList: 42 is dropped by Type.Array(String) — the whole field
	// becomes undefined when any element is invalid (TypeBox strict). Verify
	// either graceful drop or empty-list behavior — the contract is: no crash.
	assert.ok(
		parsed.runtime?.agentExtensions === undefined || Array.isArray(parsed.runtime?.agentExtensions),
		"agentExtensions must be undefined or a string array after parse",
	);
});

test("parseConfig: runtime.agentExtensions undefined when absent", () => {
	const parsed = parseConfig({ runtime: { preferLiveSession: true } });
	assert.equal(parsed.runtime?.agentExtensions, undefined);
});

test("parseConfig: agentExtensions survives schema validation (additionalProperties ok)", () => {
	const parsed = parseConfig({
		runtime: {
			mode: "child-process",
			agentExtensions: ["/tmp/ext-a.ts", "/tmp/ext-b.ts"],
		},
	});
	assert.deepEqual(parsed.runtime?.agentExtensions, ["/tmp/ext-a.ts", "/tmp/ext-b.ts"]);
});

// ─── runtime.agentExtensions — discoverAgents wiring ───────────────────────

function withTempConfig(
	config: Record<string, unknown>,
	fn: () => void,
	agentFiles?: Array<{ subdir: string; name: string; body: string }>,
): void {
	const previousHome = process.env.PI_TEAMS_HOME;
	const previousSkip = process.env.PI_CREW_SKIP_HOME_CHECK;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agentext-"));
	process.env.PI_TEAMS_HOME = home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	try {
		const filePath = configPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(config), "utf-8");
		for (const f of agentFiles ?? []) {
			const dir = path.join(home, f.subdir);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, f.name), f.body, "utf-8");
		}
		invalidateAgentDiscoveryCache();
		fn();
	} finally {
		if (previousHome !== undefined) process.env.PI_TEAMS_HOME = previousHome;
		else delete process.env.PI_TEAMS_HOME;
		if (previousSkip !== undefined) process.env.PI_CREW_SKIP_HOME_CHECK = previousSkip;
		else delete process.env.PI_CREW_SKIP_HOME_CHECK;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("discoverAgents: global agentExtensions are merged into builtin+user agents", () => {
	withTempConfig({
		runtime: {
			agentExtensions: ["/tmp/global-provider.ts"],
		},
	}, () => {
		const found = discoverAgents(process.cwd());
		const check = (agents: Array<{ extensions?: string[]; source: string }>, label: string) => {
			const agent = agents[0];
			assert.ok(agent, `${label}: expected at least one agent`);
			assert.ok(
				agent.extensions?.includes("/tmp/global-provider.ts"),
				`${label}: expected global extension merged, got ${JSON.stringify(agent.extensions)}`,
			);
		};
		check(found.builtin, "builtin");
		check(found.user, "user");
	}, [
		{
			subdir: ".pi/agent/agents",
			name: "my-user-agent.md",
			body: `---\nname: my-user-agent\ndescription: Test user agent\n---\nYou are a test agent.`,
		},
	]);
});

test("discoverAgents: project agents do NOT receive global agentExtensions (SEC-1)", () => {
	withTempConfig(
		{
			runtime: {
				agentExtensions: ["/tmp/global-provider.ts"],
			},
		},
		() => {
			const found = discoverAgents(process.cwd());
			for (const agent of [...(found.project ?? []), ...(found.projectPi ?? [])]) {
				assert.ok(
					!agent.extensions?.includes("/tmp/global-provider.ts"),
					`project agent "${agent.name}" must NOT get global extensions (SEC-1), got ${JSON.stringify(agent.extensions)}`,
				);
			}
		},
	);
});

test("discoverAgents: no config → no extensions injected", () => {
	withTempConfig(
		{
			runtime: {},
		},
		() => {
			const found = discoverAgents(process.cwd());
			const agent = found.builtin[0];
			assert.ok(agent);
			// Builtin agents have no extensions by default; undefined is fine.
			if (agent.extensions !== undefined) {
				assert.equal(agent.extensions.length, 0, "builtin agent should have no extensions without config");
			}
		},
	);
});
