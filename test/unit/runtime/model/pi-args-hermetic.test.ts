// R3-19/D5 (hermetic worker spawns): buildPiWorkerArgs passes --no-extensions
// by default (cuts the ~1.37s/spawn ambient package-extension stack + the
// ambient tool surface: team/crew_agent/Agent host tools + 8 direct-exposure
// MCP tools — probe C §R3b.6), while explicit -e prompt-runtime, agent
// `extensions:` declarations, and --skill flags are independent and survive
// (cli.md:186-191). Off-switch: runtime.hermeticWorkers (default TRUE) and env
// PI_CREW_HERMETIC_WORKERS (beats config either way). Surface TUI spawns strip
// the flag (panes keep the full interactive session).
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs, cleanupTempDir, resolveHermeticWorkers } from "../../../../src/runtime/model/pi-args.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "user",
		filePath: "/test",
		systemPrompt: "",
		extensions: [],
		...fields,
	} as AgentConfig;
}

function extensionFlags(args: string[]): string[] {
	return args.flatMap((a, i) => (a === "--extension" ? [args[i + 1] as string] : []));
}

test("D5: resolveHermeticWorkers precedence — env beats explicit beats default TRUE", () => {
	assert.equal(resolveHermeticWorkers(undefined), true, "default hermetic");
	assert.equal(resolveHermeticWorkers(false), false, "explicit off");
	assert.equal(resolveHermeticWorkers(true), true, "explicit on");
	const saved = process.env.PI_CREW_HERMETIC_WORKERS;
	try {
		process.env.PI_CREW_HERMETIC_WORKERS = "0";
		assert.equal(resolveHermeticWorkers(true), false, "env 0 beats explicit true");
		process.env.PI_CREW_HERMETIC_WORKERS = "1";
		assert.equal(resolveHermeticWorkers(false), true, "env 1 beats explicit false");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_HERMETIC_WORKERS;
		else process.env.PI_CREW_HERMETIC_WORKERS = saved;
	}
});

test("D5: env PI_CREW_HERMETIC_WORKERS=0 overrides the hermetic default on argv", () => {
	const saved = process.env.PI_CREW_HERMETIC_WORKERS;
	try {
		process.env.PI_CREW_HERMETIC_WORKERS = "0";
		const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent() });
		assert.ok(!args.includes("--no-extensions"), "env off-switch removes the flag");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_HERMETIC_WORKERS;
		else process.env.PI_CREW_HERMETIC_WORKERS = saved;
	}
});

test("D5: --skill flags and --no-skills are independent of --no-extensions", () => {
	const built = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ inheritSkills: false }),
		skillPaths: ["/skills/explorer"],
	});
	try {
		assert.ok(built.args.includes("--no-extensions"), "hermetic default");
		assert.ok(built.args.includes("--no-skills"), "inheritSkills:false still disables discovery");
		const skillIdx = built.args.indexOf("--skill");
		assert.ok(skillIdx !== -1 && built.args[skillIdx + 1] === "/skills/explorer", "explicit --skill survives");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});

test("D5: declared extensions still load alongside --no-extensions (explicit -e wins)", () => {
	const built = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ extensions: ["/tmp/custom-ext.ts"] }),
	});
	try {
		assert.ok(built.args.includes("--no-extensions"));
		const flags = extensionFlags(built.args);
		assert.ok(
			flags.some((f) => f.includes("prompt-runtime")),
			"prompt-runtime -e survives",
		);
		assert.ok(flags.includes("/tmp/custom-ext.ts"), "declared agent -e survives");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});
