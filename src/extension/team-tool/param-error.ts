/**
 * Friendly team-tool parameter validation error formatting.
 *
 * The team tool validates every call with `Value.Check(TeamToolParams, ...)`.
 * On failure it used to return the opaque `"Invalid team tool parameters"` —
 * which gave calling agents (LLMs) no clue WHAT was wrong, so they retried the
 * same malformed shape indefinitely (observed in the wild: agents passing
 * `goal` as an array/object, or `action` with wrong casing, then looping).
 *
 * `formatTeamToolParamError` produces an actionable message:
 *   1. Targeted heuristics for the COMMON mistakes (action casing; goal/team/
 *      runId passed as a non-string) — pinpoint the exact field, because the
 *      TypeBox Union reports only a root-level "Expected union value".
 *   2. TypeBox `Value.Errors` output (catches anything the heuristics miss).
 *   3. Concrete correct-call examples for the common actions.
 * Agents can self-correct from this instead of looping.
 */
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";

/** Short human description of a received value (for error messages). */
function describeValue(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `array (length ${v.length})`;
	if (typeof v === "object") return "object";
	if (typeof v === "string") return `string "${v.length > 40 ? `${v.slice(0, 37)}...` : v}"`;
	return `${typeof v} (${String(v).slice(0, 40)})`;
}

/** Pinpoint the common agent mistakes that TypeBox Union can't field-locate. */
function diagnoseCommonMistakes(params: unknown): string[] {
	const hints: string[] = [];
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return hints;
	}
	const p = params as Record<string, unknown>;

	// action: casing / non-string
	if ("action" in p) {
		const a = p.action;
		if (typeof a !== "string") {
			hints.push(`  • 'action': must be a lowercase string (e.g. "run", "status", "list") — got ${describeValue(a)}.`);
		} else if (a !== a.toLowerCase()) {
			hints.push(`  • 'action': "${a}" has wrong casing — action is case-sensitive. Use "${a.toLowerCase()}".`);
		}
	}

	// Flat-string fields that agents commonly pass as objects/arrays
	const stringFields = ["goal", "team", "runId", "task", "role", "agent", "workflow", "model", "cwd", "chain"];
	for (const f of stringFields) {
		if (!(f in p)) continue;
		const v = p[f];
		if (typeof v === "string") continue;
		if (Array.isArray(v)) {
			hints.push(
				`  • '${f}': must be a single flat string — got an array (length ${v.length}). Pass e.g. "${f}": "<value>", not a list.`,
			);
		} else if (typeof v === "object" && v !== null) {
			hints.push(`  • '${f}': must be a single flat string — got an object. Pass e.g. "${f}": "<value>".`);
		} else {
			hints.push(`  • '${f}': must be a string — got ${describeValue(v)}.`);
		}
	}
	return hints;
}

/**
 * Build a helpful validation-failure message for a team-tool call.
 *
 * @param schema The TypeBox schema (TeamToolParams) that rejected the params.
 * @param params The raw params the caller passed.
 * @returns A multi-line message: what went wrong + correct-call examples.
 */
export function formatTeamToolParamError(schema: TSchema, params: unknown): string {
	const issues = [...diagnoseCommonMistakes(params)];

	try {
		const errors = [...Value.Errors(schema, params)];
		const seen = new Set<string>();
		for (const e of errors) {
			if (issues.length >= 8) break;
			const key = `${e.path}|${e.type}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const pathLabel = e.path ? `'${e.path}'` : "(schema)";
			issues.push(`  • ${pathLabel}: ${e.message} — received ${describeValue(e.value)}`);
		}
	} catch {
		/* Value.Errors itself threw — the heuristic issues are still shown */
	}

	if (issues.length === 0) {
		issues.push("  • params did not match any valid team-tool action shape");
	}

	return [
		"Invalid team tool parameters — the call was rejected by schema validation.",
		"",
		"What went wrong:",
		...issues,
		"",
		"Correct call shapes — `action` is case-sensitive (lowercase); `goal`,",
		"`team`, `runId`, `task`, `role` MUST be flat strings, never objects/arrays:",
		'  • Run a team:       { "action": "run", "goal": "<what to achieve>", "team": "implementation" }',
		'  • Suggest a team:   { "action": "recommend", "goal": "<what to achieve>" }',
		'  • List recent runs: { "action": "list" }',
		'  • Run status:       { "action": "status", "runId": "<runId>" }',
		'  • Direct one agent: { "action": "run", "role": "<agent>", "task": "<one task>" }',
		"",
		'Common mistakes: `action` uppercase (use "run" not "Run"); `goal` passed',
		"as an array/object instead of a single string; params nested instead of flat.",
	].join("\n");
}
