/**
 * U13 (upgrade spec 2026-10-09 §U13): the `verify_gate` TOOL — the
 * extension-layer entry point of the deterministic verifier pre-gate.
 *
 * Runs the configured check commands (typecheck / test:critical / grep
 * evidence lines) via `ctx.executeTool("bash", ...)` — the FIFTH parameter of
 * ToolDefinition.execute. The round-10 probe (/tmp/pi-crew-verify10-xtool/,
 * 13/13 checks PASS) proved this path: nested calls get id `<parent>/1` +
 * parentToolCallId on events, errors arrive as isError VALUES (never throws),
 * exit codes are readable in result.structuredContent.exit_code, calls go
 * through the FULL pipeline (validation + tool_call/tool_result hooks +
 * permissions), and the host enforces nested limits (256 calls / 8KB per
 * call / 32KB total args) — the caps below stay far inside them.
 *
 * EXPOSURE — "codemode", not "model-only" (spec says "cân nhắc
 * exposure:'model-only' (giấu khỏi model, chỉ tool khác gọi được — codemode
 * pattern)"; the parenthetical is the INTENT, and per the SDK
 * (core/extensions/types.d.ts ToolExposure) the literal names mean the
 * opposite of the intent: `model-only` = "declared to the model while
 * active, NEVER callable" — executeTool calls to it fail — while `codemode`
 * = "callable whenever registered, not declared to the model unless
 * explicitly activated". `codemode` IS the "hidden from the model, callable
 * by other tools" pattern the spec wants (it is exactly what the codemode
 * tool itself does), so that is what we register.
 *
 * The verifier SPAWN SITE (task-runner.ts) consumes the same pure engine via
 * the subprocess executor; this tool is the in-host, zero-subprocess variant
 * other tools (or codemode scripts) can call to get a structured gate
 * verdict without any LLM involvement.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import type { MetricRegistry } from "../../observability/metric-registry.ts";
import {
	DEFAULT_VERIFY_GATE_TIMEOUT_MS,
	defaultVerifyGateChecks,
	renderVerifyGateContext,
	runVerifyGate,
	type VerifyGateCheck,
	type VerifyGateOutcome,
} from "../../runtime/verification/verify-gate.ts";

/** Nested-limit guards (host caps are 256 calls / 8KB call / 32KB args —
 *  these stay an order of magnitude under). */
export const VERIFY_GATE_TOOL_MAX_CHECKS = 8;
export const VERIFY_GATE_TOOL_MAX_COMMAND_CHARS = 2_000;
export const VERIFY_GATE_TOOL_MAX_TOTAL_COMMAND_CHARS = 8_000;
/** Bash tool timeout is in SECONDS. */
const BASH_TIMEOUT_MAX_SECONDS = 600;

const VerifyGateToolParams = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Working directory the checks run in. Defaults to the session cwd." })),
	checks: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Short check name, e.g. 'typecheck'." }),
				command: Type.String({ description: "Shell command; exit code 0 = pass, e.g. 'npm run --silent typecheck'." }),
				critical: Type.Optional(Type.Boolean({ description: "Stop the gate on this check's failure (default true)." })),
			}),
			{
				description:
					"Explicit checks. Defaults to the repo preset: package.json scripts 'typecheck' + 'test:critical' when present. Add grep evidence lines here (e.g. `grep -c \"<marker>\" dist/index.mjs`).",
			},
		),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			minimum: 1_000,
			maximum: 600_000,
			description: `Per-check timeout in ms (default ${DEFAULT_VERIFY_GATE_TIMEOUT_MS}).`,
		}),
	),
});

export interface VerifyGateToolDeps {
	/** Host metric registry (lazily resolved per call, same as team-tool). */
	getMetricRegistry?: () => MetricRegistry | undefined;
}

/** Quote a path for shell interpolation (single quotes; embedded quotes escaped). */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Read the bash exit code from a nested executeTool outcome. The bash tool
 *  reports { exit_code, output, truncated, wall_time_seconds } in
 *  structuredContent; a NON-ZERO exit is an isError VALUE (no throw) per the
 *  probe, so the code stays readable on failure paths. */
function readNestedBashResult(outcome: { isError: boolean; result: { structuredContent?: unknown; content?: unknown } }): {
	exitCode: number | null;
	output: string;
} {
	const structured = outcome.result.structuredContent;
	let exitCode: number | null = null;
	let output = "";
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		const record = structured as Record<string, unknown>;
		if (typeof record.exit_code === "number") exitCode = record.exit_code;
		if (typeof record.output === "string") output = record.output;
	}
	if (!output) {
		// Fallback: join text content parts (isError results keep content).
		const content = outcome.result.content;
		if (typeof content === "string") output = content;
		else if (Array.isArray(content)) {
			output = content
				.map((part) =>
					part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
						? (part as { text: string }).text
						: "",
				)
				.filter(Boolean)
				.join("\n");
		}
	}
	// isError without a structured exit code (blocked/thrown) → treat as a
	// failed check with an unknown code; the verdict stays deterministic.
	if (outcome.isError && exitCode === null) exitCode = -1;
	return { exitCode, output };
}

export function registerVerifyGateTool(pi: ExtensionAPI, deps: VerifyGateToolDeps): void {
	const tool: ToolDefinition = {
		name: "verify_gate",
		label: "Verify Gate",
		description: [
			"Deterministic verification gate (U13): runs check commands (typecheck / test:critical / grep evidence lines) and returns a structured verdict {verdict: PASS|FAILED|INCONCLUSIVE, checks, evidenceLines} — exit codes only, no LLM judgment.",
			"Registered codemode-style: callable by other tools via ctx.executeTool('verify_gate', {...}); not part of the model-facing active tool set.",
			"A PASS verdict is positive deterministic evidence that an LLM verifier spawn can be skipped; FAILED/INCONCLUSIVE escalate with these results attached.",
		].join("\n"),
		// codemode = hidden from the model, callable via ctx.executeTool — the
		// spec's "giấu khỏi model, chỉ tool khác gọi" pattern (see header note
		// for why the literal 'model-only' value would defeat that intent).
		exposure: "codemode",
		defaultActive: false,
		parameters: VerifyGateToolParams,
		outputSchema: Type.Object({
			verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAILED"), Type.Literal("INCONCLUSIVE")]),
			evidenceLines: Type.Array(Type.String()),
			allPassed: Type.Boolean(),
			totalDurationMs: Type.Number(),
			checks: Type.Array(
				Type.Object({
					name: Type.String(),
					command: Type.String(),
					exitCode: Type.Union([Type.Number(), Type.Null()]),
					passed: Type.Boolean(),
					durationMs: Type.Number(),
					skipped: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		async execute(_id, params: Static<typeof VerifyGateToolParams>, signal, _onUpdate, ctx) {
			const cwd = params.cwd && params.cwd.trim().length > 0 ? params.cwd : ctx.cwd;
			const checks: VerifyGateCheck[] = params.checks ?? defaultVerifyGateChecks(cwd);
			// Nested-limit guards — validate BEFORE any executeTool call.
			if (checks.length > VERIFY_GATE_TOOL_MAX_CHECKS) {
				return {
					content: [{ type: "text", text: `verify_gate: too many checks (${checks.length} > ${VERIFY_GATE_TOOL_MAX_CHECKS})` }],
					details: undefined,
					isError: true,
				};
			}
			let totalChars = 0;
			for (const check of checks) {
				if (check.command.length > VERIFY_GATE_TOOL_MAX_COMMAND_CHARS) {
					return {
						content: [
							{
								type: "text",
								text: `verify_gate: check '${check.name}' command exceeds ${VERIFY_GATE_TOOL_MAX_COMMAND_CHARS} chars`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				totalChars += check.command.length;
			}
			if (totalChars > VERIFY_GATE_TOOL_MAX_TOTAL_COMMAND_CHARS) {
				return {
					content: [
						{
							type: "text",
							text: `verify_gate: total command chars ${totalChars} > ${VERIFY_GATE_TOOL_MAX_TOTAL_COMMAND_CHARS}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
			const timeoutMs = params.timeoutMs ?? DEFAULT_VERIFY_GATE_TIMEOUT_MS;
			// The probe-proven 5th parameter: ctx.executeTool runs the built-in
			// bash tool through the full pipeline in the host process.
			if (typeof ctx.executeTool !== "function") {
				const outcome = inconclusiveOutcome(
					"verify_gate: ctx.executeTool unavailable in this context (no tool-call context factory) — gate not run",
				);
				return gateResult(outcome, false);
			}
			const executeTool = ctx.executeTool;
			const outcome = await runVerifyGate(
				checks,
				async (command, opts) => {
					const bashCommand = `cd ${shellQuote(opts.cwd)} && ${command}`;
					// executeTool never rejects for tool failures (probe): blocked
					// calls and non-zero exits come back as isError values.
					const nested = await executeTool(
						"bash",
						{ command: bashCommand, timeout: Math.min(Math.ceil(opts.timeoutMs / 1000), BASH_TIMEOUT_MAX_SECONDS) },
						{ signal },
					);
					return readNestedBashResult(nested);
				},
				{ cwd, signal, timeoutMs },
			);
			try {
				deps.getMetricRegistry?.()
					?.counter("crew.verification.verify_gate_runs_total", "Deterministic verify_gate executions by verdict")
					.inc({ verdict: outcome.verdict, entry: "tool" });
			} catch {
				/* metrics are best-effort */
			}
			return gateResult(outcome, false);
		},
	};
	pi.registerTool(tool);
}

function inconclusiveOutcome(note: string): VerifyGateOutcome {
	return {
		verdict: "INCONCLUSIVE",
		checks: [],
		evidenceLines: [note],
		allPassed: false,
		totalDurationMs: 0,
	};
}

function gateResult(outcome: VerifyGateOutcome, isError: boolean) {
	const text = [renderVerifyGateContext(outcome).replace(/\n+$/, "")].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		// Gate verdicts (FAILED/INCONCLUSIVE) are legitimate OUTCOMES, not tool
		// errors — callers (tools/codemode scripts) branch on structuredContent.
		details: outcome,
		structuredContent: {
			verdict: outcome.verdict,
			evidenceLines: outcome.evidenceLines,
			allPassed: outcome.allPassed,
			totalDurationMs: outcome.totalDurationMs,
			checks: outcome.checks.map((check) => ({
				name: check.name,
				command: check.command,
				exitCode: check.exitCode,
				passed: check.passed,
				durationMs: check.durationMs,
				...(check.skipped ? { skipped: check.skipped } : {}),
			})),
		},
		isError,
	};
}
