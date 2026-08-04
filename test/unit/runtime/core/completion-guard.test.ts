import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendTaskAttentionEvent } from "../../../../src/runtime/attention-events.ts";
import { evaluateCompletionMutationGuard, expectsImplementationMutation } from "../../../../src/runtime/verification/completion-guard.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "guard",
	description: "guard",
	source: "builtin",
	filePath: "guard.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "guard",
	description: "guard",
	source: "builtin",
	filePath: "guard.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "Execute" }],
};

function withTranscript(lines: unknown[], fn: (file: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-completion-guard-"));
	try {
		const file = path.join(dir, "transcript.jsonl");
		fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
		fn(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("completion guard expects mutations only for mutating roles", () => {
	assert.equal(
		expectsImplementationMutation({
			role: "executor",
			taskText: "Implement fix",
		}),
		true,
	);
	assert.equal(
		expectsImplementationMutation({
			role: "test-engineer",
			taskText: "Add regression test",
		}),
		true,
	);
	assert.equal(
		expectsImplementationMutation({
			role: "reviewer",
			taskText: "Review fix",
		}),
		false,
	);
	assert.equal(
		expectsImplementationMutation({
			role: "executor",
			taskText: "Plan only; do not edit",
		}),
		false,
	);
});

test("completion guard detects toolCall edit/write mutations", () => {
	withTranscript(
		[
			{
				message: {
					content: [{ type: "toolCall", name: "edit", input: {} }],
				},
			},
		],
		(transcriptPath) => {
			const result = evaluateCompletionMutationGuard({
				role: "executor",
				taskText: "Implement fix",
				transcriptPath,
			});
			assert.equal(result.expectedMutation, true);
			assert.equal(result.observedMutation, true);
			assert.equal(result.reason, undefined);
		},
	);
});

test("completion guard detects tool_execution_start bash mutation", () => {
	withTranscript(
		[
			{
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "git add src/file.ts" },
			},
		],
		(transcriptPath) => {
			const result = evaluateCompletionMutationGuard({
				role: "executor",
				taskText: "Implement fix",
				transcriptPath,
			});
			assert.equal(result.observedMutation, true);
		},
	);
});

test("completion guard detects replace_in_file, insert, delete_files, patch tools", () => {
	const mutatingTools = ["replace_in_file", "insert", "delete_files", "create_file", "overwrite", "patch"];
	for (const tool of mutatingTools) {
		withTranscript(
			[
				{
					message: {
						content: [{ type: "toolCall", name: tool, input: {} }],
					},
				},
			],
			(transcriptPath) => {
				const result = evaluateCompletionMutationGuard({
					role: "executor",
					taskText: "Implement fix",
					transcriptPath,
				});
				assert.equal(result.observedMutation, true, `Tool ${tool} should be mutating`);
			},
		);
	}
});

test("completion guard detects sed -i, tee, wget -O, curl -o as bash mutations", () => {
	const mutatingCommands = ["sed -i 's/a/b/' file.txt", "tee output.log", "wget https://x -O out", "curl https://x -o out"];
	for (const command of mutatingCommands) {
		withTranscript(
			[
				{
					type: "tool_execution_start",
					toolName: "bash",
					args: { command },
				},
			],
			(transcriptPath) => {
				const result = evaluateCompletionMutationGuard({
					role: "executor",
					taskText: "Implement fix",
					transcriptPath,
				});
				assert.equal(result.observedMutation, true, `Command "${command}" should be mutating`);
			},
		);
	}
});

test("completion guard warns for implementation without mutation but not read-only commands", () => {
	withTranscript(
		[
			{
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "rg TODO src" },
			},
		],
		(transcriptPath) => {
			const result = evaluateCompletionMutationGuard({
				role: "executor",
				taskText: "Implement fix",
				transcriptPath,
			});
			assert.equal(result.expectedMutation, true);
			assert.equal(result.observedMutation, false);
			assert.equal(result.reason, "no_mutation_observed");
		},
	);
});

// NEW-P4 (TOCTOU): transcriptText now reads via readFileSync + ENOENT catch
// instead of existsSync+read. A missing transcriptPath must fall back to stdout
// without throwing; a present transcript still takes precedence.
test("completion guard falls back to stdout when transcript file is missing (NEW-P4)", () => {
	const missingPath = path.join(os.tmpdir(), "pi-crew-nonexistent-transcript-" + Date.now() + ".jsonl");
	const result = evaluateCompletionMutationGuard({
		role: "executor",
		taskText: "Implement fix",
		transcriptPath: missingPath,
		stdout: JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "git add src/file.ts" },
		}),
	});
	assert.equal(result.expectedMutation, true);
	assert.equal(result.observedMutation, true);
});

test("completion guard reads transcript file when present (NEW-P4)", () => {
	withTranscript(
		[
			{
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "git add src/file.ts" },
			},
		],
		(transcriptPath) => {
			// stdout contains no mutation; the transcript (present) must win.
			const result = evaluateCompletionMutationGuard({
				role: "executor",
				taskText: "Implement fix",
				transcriptPath,
				stdout: "no events here",
			});
			assert.equal(result.observedMutation, true);
		},
	);
});

test("task attention events dedupe by task and reason", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-attention-dedupe-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "dedupe",
		});
		const input = {
			manifest,
			taskId: "01_execute",
			message: "needs attention",
			data: {
				activityState: "needs_attention" as const,
				reason: "completion_guard" as const,
				taskId: "01_execute",
			},
		};
		assert.equal(appendTaskAttentionEvent(input), true);
		assert.equal(appendTaskAttentionEvent(input), false);
		assert.equal(readEvents(manifest.eventsPath).filter((event) => event.type === "task.attention").length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
