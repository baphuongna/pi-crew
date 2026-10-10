/**
 * U13 (upgrade spec 2026-10-09 §U13): the `verify_gate` TOOL — executes via
 * the probe-proven 5th ToolDefinition.execute parameter (ctx.executeTool):
 * nested bash calls resolve (never reject), failures arrive as isError VALUES
 * with exit_code readable in structuredContent. These tests mock the nested
 * executeTool exactly like the probe observed the host behave.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	registerVerifyGateTool,
	VERIFY_GATE_TOOL_MAX_CHECKS,
	VERIFY_GATE_TOOL_MAX_COMMAND_CHARS,
} from "../../../src/extension/registration/verify-gate-tool.ts";
import { createMetricRegistry } from "../../../src/observability/metric-registry.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

/** The nested-tool shape the probe verified: AgentToolCallOutcome. */
interface NestedOutcome {
	isError: boolean;
	result: { structuredContent?: unknown; content?: unknown };
}

/** Capture-registered tool + a scripted executeTool standing in for the host. */
function harness(behavior: { exit_code?: number; output?: string; throwFor?: string } = {}) {
	let registered: ToolDefinition | undefined;
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	const registry = createMetricRegistry();
	const nestedCalls: Array<{ name: string; args: unknown; options?: unknown }> = [];
	registerVerifyGateTool(pi, { getMetricRegistry: () => registry });
	assert.ok(registered, "tool registered");
	const tool = registered as ToolDefinition & {
		execute: (
			id: string,
			params: unknown,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: unknown,
		) => Promise<{
			content: Array<{ type: string; text: string }>;
			details: unknown;
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
		}>;
	};
	const ctx = {
		cwd: process.cwd(),
		executeTool: async (name: string, args: unknown, options?: unknown): Promise<NestedOutcome> => {
			nestedCalls.push({ name, args, options });
			if (behavior.throwFor && JSON.stringify(args).includes(behavior.throwFor)) {
				// Probe: thrown tool errors ALSO surface as isError values — the
				// host wraps them. Simulate that wrap here.
				return { isError: true, result: { content: [{ type: "text", text: "tool threw" }] } };
			}
			return {
				isError: behavior.exit_code !== 0 && behavior.exit_code !== undefined,
				result: {
					structuredContent: {
						output: behavior.output ?? "",
						truncated: false,
						exit_code: behavior.exit_code ?? 0,
						wall_time_seconds: 0.01,
					},
				},
			};
		},
	};
	return { tool, ctx, nestedCalls, registry };
}

test("verify_gate: exposure codemode (hidden from model, callable via executeTool)", () => {
	const { tool } = harness();
	assert.equal(tool.name, "verify_gate");
	assert.equal(tool.exposure, "codemode");
	assert.equal(tool.defaultActive, false);
});

test("verify_gate: green nested bash calls → PASS verdict in structuredContent", async () => {
	const { tool, ctx, nestedCalls } = harness({ exit_code: 0, output: "101/101 pass" });
	const result = await tool.execute(
		"call-1",
		{ checks: [{ name: "typecheck", command: "npm run typecheck" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, false);
	assert.equal((result.structuredContent as { verdict: string }).verdict, "PASS");
	assert.equal(nestedCalls.length, 1);
	assert.equal(nestedCalls[0]?.name, "bash");
	// nested call args: cd into cwd + the check command + bash timeout in SECONDS
	const args = nestedCalls[0]?.args as { command: string; timeout: number } | undefined;
	assert.ok(args, "nested call captured");
	assert.match(args.command, /cd '.+' && npm run typecheck/);
	assert.equal(typeof args.timeout, "number");
});

test("verify_gate: non-zero exit arrives as an isError VALUE (never throws) → FAILED verdict", async () => {
	const { tool, ctx } = harness({ exit_code: 2, output: "error TS2322" });
	const result = await tool.execute(
		"call-2",
		{ checks: [{ name: "typecheck", command: "npm run typecheck" }] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.isError, false); // gate verdict ≠ tool error
	assert.equal((result.structuredContent as { verdict: string }).verdict, "FAILED");
	assert.match(result.content[0]?.text ?? "", /Gate verdict: FAILED/);
});

test("verify_gate: thrown nested tool error is read back as a failed check", async () => {
	const { tool, ctx } = harness({ throwFor: "explode" });
	const result = await tool.execute("call-3", { checks: [{ name: "boom", command: "explode now" }] }, undefined, undefined, ctx);
	assert.equal((result.structuredContent as { verdict: string }).verdict, "FAILED");
	const checks = (result.structuredContent as { checks: Array<{ exitCode: number | null }> }).checks;
	assert.equal(checks[0]?.exitCode, -1); // isError without structured exit code
});

test("verify_gate: missing ctx.executeTool → INCONCLUSIVE, not an error", async () => {
	const { tool } = harness();
	const result = await tool.execute("call-4", { checks: [{ name: "x", command: "y" }] }, undefined, undefined, { cwd: process.cwd() });
	assert.equal(result.isError, false);
	assert.equal((result.structuredContent as { verdict: string }).verdict, "INCONCLUSIVE");
	assert.match(result.content[0]?.text ?? "", /executeTool unavailable/);
});

test("verify_gate: default preset resolves from package.json scripts in cwd", async () => {
	const dir = createTrackedTempDir("pi-crew-verify-gate-tool-preset-");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
	const { tool, ctx, nestedCalls } = harness({ exit_code: 0 });
	const result = await tool.execute("call-5", { cwd: dir }, undefined, undefined, ctx);
	assert.equal((result.structuredContent as { verdict: string }).verdict, "PASS");
	assert.equal(nestedCalls.length, 1);
	const nestedArgs = nestedCalls[0]?.args as { command: string } | undefined;
	assert.ok(nestedArgs, "nested call captured");
	assert.match(nestedArgs.command, new RegExp(`cd '${dir.replaceAll("'", "")}' && npm run --silent typecheck`));
	// No scripts → INCONCLUSIVE (escalates to the LLM verifier)
	const empty = createTrackedTempDir("pi-crew-verify-gate-tool-empty-");
	const result2 = await tool.execute("call-6", { cwd: empty }, undefined, undefined, ctx);
	assert.equal((result2.structuredContent as { verdict: string }).verdict, "INCONCLUSIVE");
});

test("verify_gate: nested-limit guards reject oversized inputs as tool errors", async () => {
	const { tool, ctx } = harness({ exit_code: 0 });
	const tooMany = {
		checks: Array.from({ length: VERIFY_GATE_TOOL_MAX_CHECKS + 1 }, (_, i) => ({ name: `c${i}`, command: "node -e 0" })),
	};
	const many = await tool.execute("call-7", tooMany, undefined, undefined, ctx);
	assert.equal(many.isError, true);
	assert.match(many.content[0]?.text ?? "", /too many checks/);
	const tooLong = { checks: [{ name: "x", command: "a".repeat(VERIFY_GATE_TOOL_MAX_COMMAND_CHARS + 1) }] };
	const long = await tool.execute("call-8", tooLong, undefined, undefined, ctx);
	assert.equal(long.isError, true);
	assert.match(long.content[0]?.text ?? "", /exceeds/);
});

test("verify_gate: metrics count gate runs by verdict", async () => {
	const { tool, ctx, registry } = harness({ exit_code: 0 });
	await tool.execute("call-9", { checks: [{ name: "x", command: "node -e 0" }] }, undefined, undefined, ctx);
	const metric = registry.snapshot().find((m) => m.name === "crew.verification.verify_gate_runs_total");
	assert.ok(metric, "gate-run metric exists");
});

test("verify_gate: abort signal is forwarded to nested executeTool options", async () => {
	const { tool, ctx, nestedCalls } = harness({ exit_code: 0 });
	const controller = new AbortController();
	await tool.execute("call-10", { checks: [{ name: "x", command: "node -e 0" }] }, controller.signal, undefined, ctx);
	assert.equal((nestedCalls[0]?.options as { signal?: AbortSignal } | undefined)?.signal, controller.signal);
});
