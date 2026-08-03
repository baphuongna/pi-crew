import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan" }],
};

function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "file");
		return true;
	} catch {
		return false;
	}
}

function tryDirectorySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return true;
	} catch {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			return true;
		} catch {
			return false;
		}
	}
}

test("api refuses resultArtifact and transcript paths outside run artifacts", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-api-artifact-safe-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const outside = path.join(cwd, "outside.txt");
		fs.writeFileSync(outside, "OUTSIDE_SECRET_CONTENT", "utf-8");
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "safe api",
		});
		const task = tasks[0]!;
		saveRunTasks(manifest, [
			{
				...task,
				resultArtifact: {
					kind: "result",
					path: outside,
					createdAt: new Date().toISOString(),
					producer: task.id,
					retention: "run",
				},
			},
		]);
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:${task.id}`,
				runId: manifest.runId,
				taskId: task.id,
				agent: task.agent,
				role: task.role,
				runtime: "child-process",
				status: "completed",
				startedAt: new Date().toISOString(),
				transcriptPath: outside,
			},
		]);
		const result = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: { operation: "get-agent-result", agentId: task.id },
			},
			{ cwd },
		);
		assert.equal(result.isError, false);
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.doesNotMatch(resultText, /OUTSIDE_SECRET_CONTENT/);
		const transcript = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: {
					operation: "read-agent-transcript",
					agentId: task.id,
				},
			},
			{ cwd },
		);
		const transcriptText = transcript.content[0]?.type === "text" ? transcript.content[0].text : "";
		assert.doesNotMatch(transcriptText, /OUTSIDE_SECRET_CONTENT/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("api refuses directory symlink escapes from artifacts root", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-api-dir-symlink-safe-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const outsideDir = path.join(cwd, "outside-dir");
		fs.mkdirSync(outsideDir, { recursive: true });
		const outside = path.join(outsideDir, "secret.txt");
		fs.writeFileSync(outside, "SECRET_FROM_OUTSIDE", "utf-8");
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "dir symlink safe api",
		});
		const linkDir = path.join(manifest.artifactsRoot, "linked-dir");
		if (!tryDirectorySymlink(outsideDir, linkDir)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		const linkPath = path.join(linkDir, "secret.txt");
		const task = tasks[0]!;
		saveRunTasks(manifest, [
			{
				...task,
				resultArtifact: {
					kind: "result",
					path: linkPath,
					createdAt: new Date().toISOString(),
					producer: task.id,
					retention: "run",
				},
			},
		]);
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:${task.id}`,
				runId: manifest.runId,
				taskId: task.id,
				agent: task.agent,
				role: task.role,
				runtime: "child-process",
				status: "completed",
				startedAt: new Date().toISOString(),
				transcriptPath: linkPath,
			},
		]);
		const result = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: { operation: "get-agent-result", agentId: task.id },
			},
			{ cwd },
		);
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.doesNotMatch(resultText, /SECRET_FROM_OUTSIDE/);
		const transcript = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: {
					operation: "read-agent-transcript",
					agentId: task.id,
				},
			},
			{ cwd },
		);
		const transcriptText = transcript.content[0]?.type === "text" ? transcript.content[0].text : "";
		assert.doesNotMatch(transcriptText, /SECRET_FROM_OUTSIDE/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("api refuses symlink escapes from artifacts root", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-api-symlink-safe-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const outside = path.join(cwd, "outside.txt");
		fs.writeFileSync(outside, "OUTSIDE_SECRET_CONTENT", "utf-8");
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "symlink safe api",
		});
		const linkPath = path.join(manifest.artifactsRoot, "linked-secret.txt");
		if (!trySymlink(outside, linkPath)) {
			t.skip("symlinks unavailable on this platform");
			return;
		}
		const task = tasks[0]!;
		saveRunTasks(manifest, [
			{
				...task,
				resultArtifact: {
					kind: "result",
					path: linkPath,
					createdAt: new Date().toISOString(),
					producer: task.id,
					retention: "run",
				},
			},
		]);
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:${task.id}`,
				runId: manifest.runId,
				taskId: task.id,
				agent: task.agent,
				role: task.role,
				runtime: "child-process",
				status: "completed",
				startedAt: new Date().toISOString(),
				transcriptPath: linkPath,
			},
		]);
		const result = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: { operation: "get-agent-result", agentId: task.id },
			},
			{ cwd },
		);
		const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.doesNotMatch(resultText, /OUTSIDE_SECRET_CONTENT/);
		const transcript = await handleTeamTool(
			{
				action: "api",
				runId: manifest.runId,
				config: {
					operation: "read-agent-transcript",
					agentId: task.id,
				},
			},
			{ cwd },
		);
		const transcriptText = transcript.content[0]?.type === "text" ? transcript.content[0].text : "";
		assert.doesNotMatch(transcriptText, /OUTSIDE_SECRET_CONTENT/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
