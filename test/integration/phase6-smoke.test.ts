import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { expandParallelResearchWorkflow } from "../../src/runtime/parallel-research.ts";
import { getPiSpawnCommand } from "../../src/runtime/pi-spawn.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const parallelResearchWorkflow: WorkflowConfig = {
	name: "parallel-research",
	description: "parallel smoke",
	source: "builtin",
	filePath: "parallel.workflow.md",
	steps: [
		{ id: "discover", role: "explorer", task: "discover" },
		{ id: "explore-core", role: "explorer", task: "explore core" },
		{ id: "synthesize", role: "analyst", task: "synthesize", dependsOn: ["explore-core"] },
		{ id: "write", role: "writer", task: "write", dependsOn: ["synthesize"] },
	],
};

test("multi-shard fanout expands Source/pi-* projects and wires synthesize dependencies", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fanout-smoke-"));
	try {
		for (const name of ["pi-a", "pi-b", "pi-c", "pi-d", "pi-e"]) {
			fs.mkdirSync(path.join(cwd, "Source", name), { recursive: true });
			fs.writeFileSync(path.join(cwd, "Source", name, "README.md"), `# ${name}\n`, "utf-8");
		}
		const expanded = expandParallelResearchWorkflow(parallelResearchWorkflow, cwd);
		const shards = expanded.steps.filter((step) => step.id.startsWith("explore-shard-"));
		assert.equal(shards.length, 4);
		assert.ok(shards.every((step) => /Source\/pi-/.test(step.task ?? "")));
		const synthesize = expanded.steps.find((step) => step.id === "synthesize");
		assert.deepEqual(synthesize?.dependsOn, shards.map((step) => step.id));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Pi spawn command does not use blank-console shell start wrappers", () => {
	const command = getPiSpawnCommand(["--version"]);
	const joined = [command.command, ...command.args].join(" ").toLowerCase();
	assert.doesNotMatch(joined, /cmd(?:\.exe)?\s+\/c\s+start/);
	assert.doesNotMatch(joined, /powershell(?:\.exe)?.*start-process/);
});
