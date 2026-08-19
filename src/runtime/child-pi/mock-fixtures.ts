/**
 * Mock-mode fixture runner for child Pi workers (H3 phase 3).
 *
 * Extracted from `runChildPi` (src/runtime/child-pi/child-pi.ts) on
 * 2026-08-10 — the mock branch was ~140 self-contained lines embedded in the
 * 840-line spawn orchestrator. Behaviour is byte-identical.
 *
 * Security model (unchanged): PI_TEAMS_MOCK_CHILD_PI is in the env allowlist
 * (passed to children) but PI_CREW_ALLOW_MOCK is NOT — mock mode can only be
 * activated from the parent process scope, never inherited by a child.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCrewEnv } from "../../config/env-vars.ts";
import { atomicWriteFile } from "../../state/atomic-write.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi.ts";

/**
 * Run a mock child if mock mode is active (PI_TEAMS_MOCK_CHILD_PI set).
 * Returns `undefined` when mock mode is NOT active — the caller falls through
 * to the real spawn path.
 *
 * @param input          The child run input (agent, env…).
 * @param effectiveTask  The task text after inherit-context prepend.
 * @param observe        Callback that feeds a stdout chunk through the line
 *                       observer (owned by child-pi.ts).
 */
export async function runMockChildPi(
	input: ChildPiRunInput,
	effectiveTask: string,
	observe: (input: ChildPiRunInput, text: string) => Promise<void>,
): Promise<ChildPiRunResult | undefined> {
	const mock = getCrewEnv("PI_TEAMS_MOCK_CHILD_PI");
	if (!mock) return undefined;

	// SECURITY (Issue #2): see module docstring — PI_CREW_ALLOW_MOCK is only
	// checked in the parent process scope; it is never passed to children.
	const allowMock = getCrewEnv("PI_CREW_ALLOW_MOCK") === "1" || getCrewEnv("PI_CREW_ALLOW_MOCK") === "true";
	if (!allowMock) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: "Mock mode requires PI_CREW_ALLOW_MOCK=1",
		};
	}
	// SECURITY: Log mock mode activation prominently for audit trail
	logInternalError("child-pi.mock", new Error(`Mock mode active: ${mock}`), "NOT running real agents");

	if (mock === "success") {
		const stdout = `[MOCK] Success for ${input.agent.name}\n`;
		await observe(input, stdout);
		return { exitCode: 0, stdout, stderr: "" };
	}

	if (mock === "json-slow-success") {
		// T1/WP-1 (mid-run steer test): same JSON event shape as json-success,
		// but sleeps briefly BEFORE emitting so the task stays in `running` — the
		// steering window the steer tool's T-S1 guard must permit. Bounded
		// (default 1500ms, cap 5000ms) via PI_TEAMS_MOCK_STEER_WINDOW_MS.
		const windowMs = Number(getCrewEnv("PI_TEAMS_MOCK_STEER_WINDOW_MS") ?? "1500");
		await new Promise((resolve) => setTimeout(resolve, Math.min(windowMs, 5000)));
		const text = `[MOCK] JSON success for ${input.agent.name}`;
		const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
		await observe(input, stdout);
		return { exitCode: 0, stdout, stderr: "" };
	}

	if (mock === "json-success" || mock === "adaptive-plan") {
		const text =
			mock === "adaptive-plan" && effectiveTask.includes("ADAPTIVE_PLAN_JSON_START")
				? `[MOCK] Adaptive plan\nADAPTIVE_PLAN_JSON_START\n${JSON.stringify({
						phases: [
							{
								name: "research",
								tasks: [
									{
										role: "explorer",
										task: "Explore adaptive target",
									},
									{
										role: "analyst",
										task: "Analyze adaptive target",
									},
									{
										role: "planner",
										task: "Plan adaptive target",
									},
								],
							},
							{
								name: "build",
								tasks: [
									{
										role: "executor",
										task: "Implement adaptive target",
									},
								],
							},
							{
								name: "check",
								tasks: [
									{
										role: "reviewer",
										task: "Review adaptive target",
									},
									{
										role: "test-engineer",
										task: "Test adaptive target",
									},
									{
										role: "writer",
										task: "Summarize adaptive target",
									},
								],
							},
						],
					})}\nADAPTIVE_PLAN_JSON_END`
				: `[MOCK] JSON success for ${input.agent.name}`;
		const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
		await observe(input, stdout);
		return { exitCode: 0, stdout, stderr: "" };
	}

	if (mock === "retryable-failure")
		return {
			exitCode: 1,
			stdout: "",
			stderr: "[MOCK] rate limit: mock failure",
		};

	// E2E fallback-chain fixture: invocation #1 returns a SILENT retryable
	// failure (exit code 0, no real assistant text, message_end carries a
	// retryable-pattern errorMessage). Invocation #2+ delegates to the
	// standard json-success shape. Counter lives in os.tmpdir() keyed by
	// process.pid + mock name so concurrent test processes don't collide.
	// The test cleans up the file in its finally block.
	if (mock === "retryable-failure-then-success") {
		const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
		let count = 0;
		try {
			const raw = fs.readFileSync(counterFile, "utf-8");
			const parsed = Number.parseInt(raw.trim(), 10);
			if (Number.isFinite(parsed) && parsed >= 0) count = parsed;
		} catch {
			// file missing or unreadable — first invocation in this process
		}
		count += 1;
		try {
			atomicWriteFile(counterFile, String(count));
		} catch (error) {
			logInternalError("child-pi.mock-counter-write", error as Error, `file=${counterFile}`);
		}
		if (count === 1) {
			// Silent retryable failure: exit 0, no real text, message_end
			// carries errorMessage matching `/provider[_ ]?error/i` so that
			// `detectRetryableModelFailureFromOutput` surfaces it as an error
			// and `isRetryableModelFailure` routes the next attempt to the
			// next candidate model. `stopReason:"error"` (NOT "stop") so
			// `isFinalAssistantEvent` does NOT prematurely terminate the run.
			const failureEvent = {
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					errorMessage: "Provider error: api_error",
					stopReason: "error",
				},
			};
			const stdout = `${JSON.stringify(failureEvent)}\n`;
			await observe(input, stdout);
			return { exitCode: 0, stdout, stderr: "" };
		}
		// Subsequent invocations: delegate to json-success shape so the
		// fallback chain's second attempt succeeds and the run completes.
		const text = `[MOCK] JSON success for ${input.agent.name}`;
		const stdout = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n${JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } })}\n`;
		await observe(input, stdout);
		return { exitCode: 0, stdout, stderr: "" };
	}

	return { exitCode: 1, stdout: "", stderr: `[MOCK] failure: ${mock}` };
}
