import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { rewriteTeamWorkerPrompt } from "../../src/prompt/prompt-runtime.ts";
import { runChildPi } from "../../src/runtime/child-pi/child-pi.ts";
import { buildPiWorkerArgs, checkCrewDepth } from "../../src/runtime/model/pi-args.ts";

const agent: AgentConfig = {
	name: "phase6",
	description: "phase6",
	source: "builtin",
	filePath: "phase6.md",
	systemPrompt: "system prompt",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("buildPiWorkerArgs writes long tasks to private @file and emits canonical depth env", () => {
	const result = buildPiWorkerArgs({
		task: "x".repeat(9000),
		agent,
		sessionEnabled: false,
		maxDepth: 5,
		env: { PI_CREW_DEPTH: "1" } as NodeJS.ProcessEnv,
	});
	try {
		const taskArg = result.args.find((arg) => arg.startsWith("@"));
		assert.ok(taskArg);
		const taskPath = taskArg!.slice(1);
		assert.equal(fs.existsSync(taskPath), true);
		assert.equal(fs.readFileSync(taskPath, "utf-8"), "x".repeat(9000));
		assert.equal(result.env.PI_CREW_DEPTH, "2");
		assert.equal(result.env.PI_CREW_MAX_DEPTH, "5");
		assert.equal(result.env.PI_CREW_ROLE, "phase6");
		assert.equal(result.env.PI_TEAMS_DEPTH, "2");
		assert.equal(result.env.PI_TEAMS_ROLE, "phase6");
		assert.equal(result.env.PI_CREW_INHERIT_PROJECT_CONTEXT, "0");
	} finally {
		if (result.tempDir) fs.rmSync(result.tempDir, { recursive: true, force: true });
	}
});

// G3 (SDD-2 W-B, spill-always): EVERY task text goes through a 0600 temp
// file — argv never carries task text (world-readable /proc/<pid>/cmdline).
// The long-task case above pins the >8000 path; these pin the SHORT cases
// that used to ride argv verbatim.
for (const [label, task] of [
	["tiny task", "zq7"],
	["empty task", ""],
	["just-under-limit task", "y".repeat(7999)],
] as const) {
	test(`buildPiWorkerArgs spills ${label} to a 0600 @file — argv carries no task text`, () => {
		const result = buildPiWorkerArgs({ task, agent });
		try {
			assert.ok(!result.args.some((arg) => arg.includes("Task:")), "no `Task:` positional may be emitted");
			const taskArg = result.args.find((arg) => arg.startsWith("@"));
			if (task.length > 0) {
				// Random-path collision guard (CI 2026-10-07 macos/Node-24 red, docs-only
				// diff): the `@<path>` arg legitimately carries the mkdtemp random path
				// (6-char [a-zA-Z0-9] suffix, ~62^6); a suffix substring-colliding with a
				// short task text (P ≈ 1/15k per run for 3 chars) is NOT a content leak.
				// Scan every argv arg EXCEPT the @-file arg itself.
				assert.ok(
					!result.args.some((arg) => arg !== "@" && arg !== taskArg && arg.includes(task)),
					"argv must not contain task text",
				);
			}
			assert.ok(taskArg, "task must ride a @file inclusion arg");
			const taskPath = taskArg!.slice(1);
			assert.ok(taskPath.endsWith("task.md"));
			assert.equal(fs.existsSync(taskPath), true);
			assert.equal(fs.readFileSync(taskPath, "utf-8"), task);
			// POSIX-only bit check: Windows fs reports 0o666 regardless of ACLs
			// (same guard as child-pi-timeout G3 — CI 2026-10-03 plain jobs).
			if (process.platform !== "win32") {
				assert.equal(fs.statSync(taskPath).mode & 0o777, 0o600, "task file must be owner-only (0600)");
			}
			assert.ok(result.tempDir, "tempDir must be reported for cleanup");
		} finally {
			if (result.tempDir) fs.rmSync(result.tempDir, { recursive: true, force: true });
		}
	});
}

test("crew depth guard blocks child workers at max depth before mock execution", async () => {
	const previousDepth = process.env.PI_CREW_DEPTH;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CREW_DEPTH = "2";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	try {
		assert.deepEqual(checkCrewDepth(2), {
			depth: 2,
			maxDepth: 2,
			blocked: true,
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-depth-"));
		try {
			const result = await runChildPi({
				cwd: dir,
				task: "hi",
				agent,
				maxDepth: 2,
			});
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr, /depth guard/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
	}
});

test("prompt runtime supports canonical pi-crew inherit env behavior", () => {
	const prompt = "Base\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nsecret\nCurrent date: now";
	assert.equal(
		rewriteTeamWorkerPrompt(prompt, {
			inheritProjectContext: false,
			inheritSkills: true,
		}).includes("secret"),
		false,
	);
});
