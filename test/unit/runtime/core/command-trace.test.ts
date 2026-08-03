import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCommandTrace } from "../../../../src/runtime/command-trace.ts";

/**
 * T10 (pi-agent-flow generateCommandsFromHistory): the command trace must be
 * derived MECHANICALLY from recorded tool-call history — never from LLM
 * self-reports. These tests pin the verbatim extraction + sanitization +
 * summary formatting so workers can't paraphrase their way around it.
 */

describe("command-trace — T10 verbatim extraction", () => {
	it("returns an empty trace for undefined/empty input", () => {
		const empty = extractCommandTrace(undefined);
		assert.equal(empty.totalTools, 0);
		assert.equal(empty.commandTools, 0);
		assert.deepEqual(empty.commands, []);
		assert.equal(empty.summary, "");
		assert.deepEqual(extractCommandTrace([]).commands, []);
	});

	it("extracts verbatim bash commands from {command: '...'} args", () => {
		const trace = extractCommandTrace([
			{ tool: "bash", args: JSON.stringify({ command: "npm test" }) },
			{ tool: "bash", args: JSON.stringify({ command: "git status" }) },
		]);
		assert.equal(trace.commandTools, 2);
		assert.deepEqual(trace.commands, ["npm test", "git status"]);
	});

	it("counts non-command tools (write/edit/read) without inlining them", () => {
		const trace = extractCommandTrace([
			{ tool: "read", args: "/some/file.ts" },
			{ tool: "write", args: '{"path":"/x.ts"}' },
			{ tool: "bash", args: '{"command":"ls"}' },
		]);
		assert.equal(trace.totalTools, 3, "counts all tools");
		assert.equal(trace.commandTools, 1, "only bash is a command tool");
		assert.deepEqual(trace.commands, ["ls"], "non-command tools not inlined");
	});

	it("summary shows cmd=N for command-only runs", () => {
		const trace = extractCommandTrace([{ tool: "bash", args: '{"command":"echo hi"}' }]);
		assert.equal(trace.summary, "cmd=1");
	});

	it("summary shows mix as 'cmd=N (K bash)' when non-command tools present", () => {
		const trace = extractCommandTrace([
			{ tool: "write", args: '{"path":"x"}' },
			{ tool: "bash", args: '{"command":"ls"}' },
			{ tool: "bash", args: '{"command":"pwd"}' },
		]);
		assert.equal(trace.summary, "cmd=3 (2 bash)");
	});

	it("sanitizes multi-line commands to a single line with ⏎ marker", () => {
		const trace = extractCommandTrace([
			{
				tool: "bash",
				args: JSON.stringify({ command: "echo a\necho b\nrm -rf x" }),
			},
		]);
		assert.equal(trace.commands.length, 1);
		assert.ok(trace.commands[0].includes("⏎"), "newline replaced with ⏎");
		assert.ok(!trace.commands[0].includes("\n"), "no raw newline remains");
	});

	it("truncates very long commands to a bounded length", () => {
		const long = "x".repeat(500);
		const trace = extractCommandTrace([{ tool: "bash", args: JSON.stringify({ command: long }) }]);
		assert.ok(trace.commands[0].length < 500, "must be truncated");
		assert.ok(trace.commands[0].endsWith("…"), "truncation marker present");
	});

	it("caps the returned command list to a bounded number", () => {
		const many = Array.from({ length: 50 }, (_, i) => ({
			tool: "bash",
			args: JSON.stringify({ command: `cmd-${i}` }),
		}));
		const trace = extractCommandTrace(many);
		assert.equal(trace.commandTools, 50);
		assert.ok(trace.commands.length <= 12, "commands list is capped");
		// Most-recent-last: the last kept command should be the last input.
		assert.equal(trace.commands[trace.commands.length - 1], "cmd-49");
	});

	it("recognizes alternative command-tool names (shell, run_command)", () => {
		const trace = extractCommandTrace([
			{ tool: "shell", args: '{"command":"whoami"}' },
			{ tool: "run_command", args: '{"command":"uname -a"}' },
		]);
		assert.equal(trace.commandTools, 2);
		assert.deepEqual(trace.commands, ["whoami", "uname -a"]);
	});

	it("falls back to treating raw args as the command when not JSON", () => {
		const trace = extractCommandTrace([{ tool: "bash", args: "ls -la /tmp" }]);
		assert.deepEqual(trace.commands, ["ls -la /tmp"]);
	});

	it("never trusts an LLM string — only recorded tool tuples", () => {
		// Even a malformed record (non-string tool) is skipped, not guessed.
		const trace = extractCommandTrace([
			{ tool: 123, args: '{"command":"should-be-skipped"}' } as never,
			{ tool: "bash", args: '{"command":"real"}' },
		]);
		assert.equal(trace.totalTools, 1);
		assert.deepEqual(trace.commands, ["real"]);
	});
});
