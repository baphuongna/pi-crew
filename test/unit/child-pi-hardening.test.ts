/**
 * #3 unresponsive worker + #7 over-budget result capture hardening tests.
 *
 * Verifies:
 * - killProcessPid schedules a SIGKILL fallback timer (hardKillTimer)
 * - ChildPiLineObserver.getIntermediateFindings() returns non-empty when only
 *   tool_result events are present (no final message_end)
 *
 * Run with: PI_CREW_ALLOW_MOCK=1 PI_TEAMS_MOCK_CHILD_PI=success npx tsx --test test/unit/child-pi-hardening.test.ts
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { ChildPiLineObserver, killProcessPid } from "../../src/runtime/child-pi.ts";

// --- Test helpers ---

/** A complete valid agent config for ChildPiRunInput. */
const MINIMAL_AGENT: AgentConfig = {
	name: "test",
	description: "",
	source: "builtin",
	filePath: "/test/agent.json",
	systemPrompt: "",
};

/** Build a ChildPiRunInput with no-op callbacks. */
function makeInput() {
	return {
		cwd: "/tmp",
		task: "test task",
		agent: MINIMAL_AGENT,
		onJsonEvent: (_e: unknown) => {
			/* noop */
		},
		onLifecycleEvent: (_e: unknown) => {
			/* noop */
		},
	};
}

// ---------------------------------------------------------------------------
// #3 HARDENING: SIGKILL timer scheduled after killProcessPid
// ---------------------------------------------------------------------------

describe("#3 SIGKILL timer hardening", () => {
	// The SIGTERM → SIGKILL escalation timer is a Unix-only mechanism. On
	// Windows, killProcessPid uses `taskkill /T /F` and returns early (no
	// SIGTERM, no SIGKILL timer). This subtest verifies the Unix path; skip it
	// on win32 (cross-platform CI caught the original assertion assuming SIGTERM).
	test("killProcessPid schedules SIGKILL timer after SIGTERM (mock)", {
		skip: process.platform === "win32" ? "Unix-only path (win32 uses taskkill)" : false,
	}, () => {
		// This test verifies the hardKillTimer is scheduled by checking the
		// side effect: after SIGTERM succeeds, a setTimeout with HARD_KILL_MS
		// (3000ms) is armed.
		const HARD_KILL_MS = 3000; // from defaults

		// Save originals
		const originalKill = process.kill.bind(process);
		const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
		const killCalls: Array<[number, string]> = [];
		let capturedDelay: number | undefined;

		try {
			// Mock process.kill to succeed without throwing
			(process as unknown as Record<string, unknown>).kill = (pid: number, sig?: string) => {
				killCalls.push([pid, sig ?? "(default)"]);
				// Don't actually send signals
			};

			// Override setTimeout to capture the timer delay
			(globalThis as unknown as Record<string, unknown>).setTimeout = (fn: () => void, delay: number): NodeJS.Timeout => {
				capturedDelay = delay;
				// Fire immediately so the test doesn't hang
				return originalSetTimeout(fn, 0);
			};

			// Call with PID 88888 (unlikely to exist — function catches errors internally)
			killProcessPid(88888);

			// Verify SIGTERM was attempted
			const termCall = killCalls.find(([, sig]) => sig === "SIGTERM");
			assert.ok(termCall, "Should have attempted SIGTERM");

			// Verify a timer was scheduled with HARD_KILL_MS delay
			assert.ok(capturedDelay !== undefined, "A timer should be scheduled after SIGTERM");
			assert.strictEqual(capturedDelay, HARD_KILL_MS, `Timer delay should be ${HARD_KILL_MS}ms (HARD_KILL_MS)`);
		} finally {
			// Restore originals
			(process as unknown as Record<string, unknown>).kill = originalKill;
			(globalThis as unknown as Record<string, unknown>).setTimeout = originalSetTimeout;
		}
	});

	test("killProcessPid does not throw on valid PID (handles errors gracefully)", () => {
		// Verify killProcessPid never throws even when signals fail.
		// (Process 1 exists everywhere but sending SIGTERM to it is harmless.)
		const originalKill = process.kill.bind(process);
		try {
			// Mock to throw (simulates permission denied)
			(process as unknown as Record<string, unknown>).kill = () => {
				throw new Error("EPERM: permission denied");
			};
			// Should NOT throw
			killProcessPid(1);
		} finally {
			(process as unknown as Record<string, unknown>).kill = originalKill;
		}
	});
});

// ---------------------------------------------------------------------------
// #7 RESULT CAPTURE HARDENING: intermediate findings for over-budget workers
// ---------------------------------------------------------------------------

describe("#7 intermediate findings (over-budget worker hardening)", () => {
	test("getIntermediateFindings returns empty string when no events observed", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);
		assert.strictEqual(observer.getIntermediateFindings(), "");
	});

	test("getIntermediateFindings returns content from tool_result display lines (no message_end)", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);

		// Simulate a worker that produces tool_result events but no final message_end.
		// This is the over-budget scenario: worker spent budget on tool calls.
		const toolResultEvents = [
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "Read",
				args: { path: "/src/main.ts" },
			}),
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolResult",
							name: "Read",
							content: "export const VERSION = '1.0.0';\n",
						},
					],
				},
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "Write",
				args: { path: "/src/output.txt" },
			}),
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolResult",
							name: "Write",
							content: "File written successfully (42 bytes).",
						},
					],
				},
			}),
		];

		for (const event of toolResultEvents) {
			observer.observe(event + "\n");
		}
		observer.flush();

		// intermediateFindings should be non-empty (captured tool result display lines)
		const findings = observer.getIntermediateFindings();
		assert.ok(findings.length > 0, "intermediateFindings should capture tool result content");
		assert.ok(findings.includes("Read") || findings.includes("Write"), "intermediateFindings should include tool names");
	});

	test("getIntermediateFindings is bounded by maxChars", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);

		// Feed many display lines
		for (let i = 0; i < 30; i++) {
			const line = JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Line ${i}: ${"x".repeat(50)}` }],
				},
			});
			observer.observe(line + "\n");
		}
		observer.flush();

		// With default maxChars=500, result should be ≤ 500
		const findings = observer.getIntermediateFindings();
		assert.ok(findings.length <= 500, `Findings (${findings.length} chars) should be bounded by default maxChars=500`);

		// With custom maxChars=50, should be ≤ 50
		const bounded = observer.getIntermediateFindings(50);
		assert.ok(bounded.length <= 50, `Findings (${bounded.length} chars) should be bounded by custom maxChars=50`);
	});

	test("getIntermediateFindings captures partial assistant text + tool results", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);

		// Worker produces partial assistant text, then tool calls, then budget exhausted.
		// No final message_end event — this is the over-budget scenario.
		observer.observe(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Writing file..." }],
				},
			}) + "\n",
		);
		observer.observe(
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "Write",
				args: { path: "/out.txt" },
			}) + "\n",
		);
		observer.observe(
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "assistant",
					content: [{ type: "toolResult", name: "Write", content: "Done." }],
				},
			}) + "\n",
		);
		observer.flush();

		// intermediateFindings should capture the partial text and tool result
		const findings = observer.getIntermediateFindings();
		assert.ok(findings.length > 0, "Should capture intermediate content");
		assert.ok(
			findings.includes("Writing file...") || findings.includes("Write") || findings.includes("Done"),
			"Should include partial assistant text or tool result",
		);
	});

	test("getIntermediateFindings does not conflict with rawFinalText", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);

		// Normal run: assistant text + final message_end
		observer.observe(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "The answer is 42." }],
				},
			}) + "\n",
		);
		observer.observe(
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "Read",
				args: { path: "/data.json" },
			}) + "\n",
		);
		observer.observe(
			JSON.stringify({
				type: "tool_result_end",
				message: {
					role: "assistant",
					content: [{ type: "toolResult", name: "Read", content: "42" }],
				},
			}) + "\n",
		);
		// Final assistant turn (with no tool call)
		observer.observe(
			JSON.stringify({
				type: "message_end",
				stopReason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done: 42." }],
				},
			}) + "\n",
		);
		observer.flush();

		// Both should be populated
		assert.ok(observer.getRawFinalText() !== undefined, "rawFinalText should be populated");
		assert.ok(observer.getIntermediateFindings().length > 0, "intermediateFindings should also be populated");

		// rawFinalText should be the LAST assistant text (the final "Done: 42.")
		assert.ok(observer.getRawFinalText()!.includes("Done: 42"), "rawFinalText should be the final assistant text");
	});

	test("rawFinalText is undefined only when no assistant/tool text is emitted", () => {
		const input = makeInput();
		const observer = new ChildPiLineObserver(input);

		// Feed only non-text events (e.g. heartbeat, progress)
		observer.observe(JSON.stringify({ type: "heartbeat" }) + "\n");
		observer.observe(JSON.stringify({ type: "progress", value: 50 }) + "\n");
		observer.flush();

		assert.strictEqual(observer.getRawFinalText(), undefined, "No text content");
		assert.strictEqual(observer.getIntermediateFindings(), "", "No display lines either");
	});
});
