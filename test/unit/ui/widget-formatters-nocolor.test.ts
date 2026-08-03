/**
 * UI-10: comprehensive no-color mode for src/ui/widget/widget-formatters.ts.
 *
 * When NO_COLOR is set (any non-empty value, per https://bixense.com/clicolors/)
 * OR stdout is non-TTY, the formatters must emit NO ANSI escape codes — only
 * plain strings. This file exercises both suppression paths and also proves the
 * color gate actually emits codes in color mode (otherwise the suppression is
 * vacuous).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import {
	__resetColorMode,
	__setColorModeForTest,
	agentActivity,
	notificationBadge,
	stripAnsi,
} from "../../../src/ui/widget/widget-formatters.ts";

// Any SGR escape: "\x1b[ ... m"
const ANSI_RE = /\u001b\[[0-9;]*m/;

/** Minimal agent that resolves to the failed-activity branch. */
function failedAgent(error = "boom: exited with code 1"): CrewAgentRecord {
	return {
		id: "agent_failed",
		runId: "run_x",
		taskId: "task_x",
		agent: "worker",
		role: "executor",
		runtime: "child-process",
		status: "failed",
		startedAt: new Date(Date.now() - 10_000).toISOString(),
		error,
	} as unknown as CrewAgentRecord;
}

/** Minimal agent that resolves to the needs-attention activity branch. */
function needsAttentionAgent(): CrewAgentRecord {
	return {
		id: "agent_warn",
		runId: "run_x",
		taskId: "task_y",
		agent: "worker",
		role: "executor",
		runtime: "child-process",
		status: "needs_attention",
		startedAt: new Date(Date.now() - 10_000).toISOString(),
		progress: { recentTools: [], recentOutput: [], toolCount: 0, activityState: "needs_attention" },
	} as unknown as CrewAgentRecord;
}

// Restore the realistic non-TTY default after every case so a forced color
// state can never leak into a sibling test.
afterEach(() => {
	__setColorModeForTest(false);
});

test("no-color: NO_COLOR env at module-init disables all ANSI output", () => {
	const prev = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	__resetColorMode(); // replay module-init detection with NO_COLOR set
	try {
		const failed = agentActivity(failedAgent());
		assert.ok(!ANSI_RE.test(failed), `NO_COLOR set but found ANSI escapes: ${JSON.stringify(failed)}`);
		assert.match(stripAnsi(failed), /boom/, "plain text content is preserved");

		const warn = agentActivity(needsAttentionAgent());
		assert.ok(!ANSI_RE.test(warn), `NO_COLOR set but found ANSI escapes: ${JSON.stringify(warn)}`);

		const badge = notificationBadge(5);
		assert.ok(!ANSI_RE.test(badge), `NO_COLOR set but found ANSI escapes: ${JSON.stringify(badge)}`);
	} finally {
		if (prev === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prev;
		__setColorModeForTest(false);
	}
});

test("no-color: non-TTY stdout (the test runner) disables all ANSI output", () => {
	// tsx --test pipes stdout, so process.stdout.isTTY is falsy (false or
	// undefined) → the module already computed colorEnabled=false. __resetColorMode()
	// re-affirms it.
	assert.ok(process.stdout.isTTY !== true, "precondition: test runner stdout is non-TTY");
	delete process.env.NO_COLOR;
	__resetColorMode();

	const failed = agentActivity(failedAgent());
	assert.ok(!ANSI_RE.test(failed), `non-TTY but found ANSI escapes: ${JSON.stringify(failed)}`);

	const warn = agentActivity(needsAttentionAgent());
	assert.ok(!ANSI_RE.test(warn), `non-TTY but found ANSI escapes: ${JSON.stringify(warn)}`);

	const badge = notificationBadge(7);
	assert.ok(!ANSI_RE.test(badge), `non-TTY but found ANSI escapes: ${JSON.stringify(badge)}`);
});

test("color mode (forced on): formatters DO emit ANSI, proving the gate works", () => {
	__setColorModeForTest(true);

	const failed = agentActivity(failedAgent());
	assert.ok(ANSI_RE.test(failed), `color mode should emit ANSI for failed status: ${JSON.stringify(failed)}`);
	assert.ok(failed.includes("\x1b[31m"), "failed status must use red foreground");

	const warn = agentActivity(needsAttentionAgent());
	assert.ok(ANSI_RE.test(warn), `color mode should emit ANSI for needs_attention: ${JSON.stringify(warn)}`);
	assert.ok(warn.includes("\x1b[33m"), "needs_attention must use yellow foreground");
});

test("stripAnsi removes every ANSI SGR code", () => {
	__setColorModeForTest(true);
	const colored = agentActivity(failedAgent());
	assert.ok(ANSI_RE.test(colored), "precondition: colored output contains ANSI");
	const plain = stripAnsi(colored);
	assert.ok(!ANSI_RE.test(plain), `stripAnsi left escapes behind: ${JSON.stringify(plain)}`);
	assert.match(plain, /boom/, "stripAnsi preserves the visible text");
});

test("no-color mode is consistent across formatters (notificationBadge stays plain)", () => {
	__setColorModeForTest(false);
	const badge = notificationBadge(42, { TERM: "xterm-256color" });
	assert.ok(!ANSI_RE.test(badge), `notificationBadge leaked ANSI in no-color: ${JSON.stringify(badge)}`);
	assert.match(badge, /42 alerts/);
});
