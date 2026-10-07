// U9 (pi 1.0.4 version floor): --no-mcp emission matrix for the U2-lite
// parity (non-hermetic) block. buildPiWorkerArgs stays PURE/SYNC — piVersion
// is a threaded INPUT here, never probed (the probe lives in runChildPi).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

function countFlag(args: string[], flag: string): number {
	return args.reduce((n, a) => (a === flag ? n + 1 : n), 0);
}

function excludeToolsValue(args: string[]): string | undefined {
	const idx = args.indexOf("--exclude-tools");
	return idx >= 0 ? args[idx + 1] : undefined;
}

const AT_OR_ABOVE_FLOOR = ["1.0.4", "1.0.5", "1.1.0", "2.0.0"];
const BELOW_FLOOR = ["1.0.3", "1.0.3-beta", "0.99.2"];
const UNKNOWN_VERSIONS: (string | null | undefined)[] = [null, undefined, "1.0.x", "garbage", ""];

test("parity + piVersion >= 1.0.4 → --no-mcp exactly once; mcp__* fold stays as the cross-version baseline", () => {
	for (const v of AT_OR_ABOVE_FLOOR) {
		const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), hermeticWorkers: false, piVersion: v, env: {} });
		assert.equal(countFlag(args, "--no-mcp"), 1, `${v}: --no-mcp emitted exactly once`);
		assert.equal(countFlag(args, "--exclude-tools"), 1, `${v}: still exactly ONE --exclude-tools (strict parser)`);
		assert.equal(excludeToolsValue(args), "mcp__*", `${v}: mcp__* cut stays alongside --no-mcp`);
		assert.ok(!args.includes("--no-extensions"), `${v}: parity spawn stays non-hermetic`);
	}
});

test("parity + piVersion < 1.0.4 → NO --no-mcp (pre-floor host would reject the unknown flag)", () => {
	for (const v of BELOW_FLOOR) {
		const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), hermeticWorkers: false, piVersion: v, env: {} });
		assert.equal(countFlag(args, "--no-mcp"), 0, `${v}: below floor → no flag`);
		assert.equal(countFlag(args, "--exclude-tools"), 1, `${v}: parity mcp__* cut is version-independent`);
	}
});

test("parity + unknown/malformed piVersion → NO --no-mcp (conservative)", () => {
	for (const v of UNKNOWN_VERSIONS) {
		const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), hermeticWorkers: false, piVersion: v, env: {} });
		assert.equal(countFlag(args, "--no-mcp"), 0, `${String(v)}: unknown → no flag`);
		assert.equal(countFlag(args, "--exclude-tools"), 1, `${String(v)}: parity mcp__* cut still applies`);
	}
});

test("parity + declared disallowedTools + 1.0.4 → ONE merged --exclude-tools value AND --no-mcp", () => {
	const { args } = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ disallowedTools: ["foo"] }),
		hermeticWorkers: false,
		piVersion: "1.0.4",
		env: {},
	});
	assert.equal(countFlag(args, "--exclude-tools"), 1, "merge, never a second flag");
	assert.equal(excludeToolsValue(args), "foo,mcp__*", "declared denylist first, pattern appended");
	assert.equal(countFlag(args, "--no-mcp"), 1, "floor flag rides along on parity spawns");
});

test("hermetic spawns never get --no-mcp at ANY version — already MCP-clean via --no-extensions", () => {
	for (const v of [...AT_OR_ABOVE_FLOOR, ...BELOW_FLOOR, ...UNKNOWN_VERSIONS]) {
		const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), hermeticWorkers: true, piVersion: v, env: {} });
		assert.ok(args.includes("--no-extensions"), "hermetic flag present");
		assert.equal(countFlag(args, "--no-mcp"), 0, `${String(v)}: hermetic path unchanged`);
		assert.equal(countFlag(args, "--exclude-tools"), 0, "no parity fold on hermetic spawns");
	}
});

test("default loadout (hermeticWorkers unset) + 1.0.4 → still NO --no-mcp (default is hermetic)", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), piVersion: "1.0.4", env: {} });
	assert.ok(args.includes("--no-extensions"), "default stays hermetic");
	assert.equal(countFlag(args, "--no-mcp"), 0);
	assert.equal(countFlag(args, "--exclude-tools"), 0);
});

test("disableTools:true + parity + 1.0.4 → --no-tools only; no --exclude-tools, no --no-mcp (U9 shares the U2-lite else-block)", () => {
	const { args } = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ disableTools: true }),
		hermeticWorkers: false,
		piVersion: "1.0.4",
		env: {},
	});
	assert.ok(args.includes("--no-tools"), "capability lock present");
	assert.equal(countFlag(args, "--exclude-tools"), 0);
	assert.equal(countFlag(args, "--no-mcp"), 0, "--no-tools already locks the whole tool surface");
});
