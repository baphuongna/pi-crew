/**
 * Resilient edit wrapper — uses the cascading replace() engine as a fallback
 * when the native edit tool fails with "old_string not found".
 *
 * Multi-agent runs (crew workers) often provide slightly-wrong oldText:
 *   - indentation drift (tabs vs spaces)
 *   - trailing whitespace differences
 *   - line-ending normalization (\r\n vs \n)
 *
 * The native edit tool is exact-match only and fails hard on these. This
 * wrapper catches that failure and retries with the cascading engine, which
 * tries (in order): exact → escape-normalized → line-trimmed → block-anchor →
 * whitespace-normalized → trimmed-boundary.
 *
 * CONFLICT AWARENESS: pi-diff (`@heyhuynhgiabuu/pi-diff`) also overrides the
 * edit tool with its own replace() integration. To avoid double-wrapping,
 * this module is OPT-IN via the `CREW_RESILIENT_EDIT=1` env var, and
 * auto-disables if pi-diff is detected in the loaded extensions.
 *
 * Usage (in register.ts, guarded):
 *   if (process.env.CREW_RESILIENT_EDIT === "1") {
 *       wrapEditWithResilientReplace(pi);
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replace, type ReplaceResult } from "../runtime/replace.ts";

interface ToolLike {
	name: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: any, signal: any, onUpdate: any) => Promise<unknown>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

interface EditParams {
	path?: string;
	filePath?: string;
	oldString?: string;
	old_string?: string;
	newString?: string;
	new_string?: string;
	replaceAll?: boolean;
	replace_all?: boolean;
}

interface EditResult {
	content?: unknown[];
	[key: string]: unknown;
}

const NOT_FOUND_PATTERNS = [
	/old_string not found/i,
	/oldstring not found/i,
	/no match/i,
	/could not find/i,
	/string not found/i,
];

function isNotFoundResult(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const r = result as EditResult;
	const text = JSON.stringify(r.content ?? r);
	return NOT_FOUND_PATTERNS.some((re) => re.test(text));
}

/** Detect whether pi-diff is loaded (to avoid double-wrapping edit). */
function isPiDiffLoaded(pi: ExtensionAPI): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const piAny = pi as any;
		const extensions = piAny?.extensions ?? piAny?._extensions ?? [];
		const names = Array.isArray(extensions)
			? extensions.map((e: unknown) => (typeof e === "string" ? e : (e as { name?: string })?.name ?? ""))
			: Object.keys(extensions);
		return names.some((n: string) => typeof n === "string" && n.includes("pi-diff"));
	} catch {
		return false;
	}
}

/**
 * Wrap the native `edit` tool so that on "old_string not found" failures, it
 * retries using the cascading replace() engine (lenient matching).
 *
 * @param pi      the Pi extension API
 * @param tools   optional injected tool registry (for testing)
 * @returns true if the wrapper was applied, false if skipped
 */
export function wrapEditWithResilientReplace(pi: ExtensionAPI, tools?: { edit: ToolLike }): boolean {
	// Auto-disable if pi-diff is present (it has its own replace integration).
	if (isPiDiffLoaded(pi)) {
		return false;
	}

	const t = tools ?? ((pi as unknown as { tools?: { edit?: ToolLike } }).tools);
	if (!t?.edit?.execute) return false;

	const nativeExecute = t.edit.execute.bind(t.edit);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	t.edit.execute = async function resilientExecute(toolCallId: string, params: any, signal: any, onUpdate: any): Promise<unknown> {
		try {
			const result = await nativeExecute(toolCallId, params, signal, onUpdate);
			if (!isNotFoundResult(result)) return result;
			// Fall through to resilient retry.
			return await retryWithReplace(params, toolCallId, signal, onUpdate);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (NOT_FOUND_PATTERNS.some((re) => re.test(msg))) {
				return await retryWithReplace(params, toolCallId, signal, onUpdate);
			}
			throw err;
		}
	};

	return true;

	async function retryWithReplace(
		params: EditParams,
		toolCallId: string,
		signal: any,
		onUpdate: any,
	): Promise<unknown> {
		const filePath = params.path ?? params.filePath;
		const oldStr = params.oldString ?? params.old_string;
		const newStr = params.newString ?? params.new_string;
		const replaceAll = params.replaceAll ?? params.replace_all ?? false;

		if (!filePath || typeof oldStr !== "string" || typeof newStr !== "string") {
			// Can't retry — rethrow a not-found style error.
			throw new Error("old_string not found (and resilient retry skipped: missing path/old/new)");
		}

		// LAZY: defer dynamic import of node:fs/promises to its call site.
		const fs = await import("node:fs/promises");
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf8");
		} catch (readErr) {
			throw new Error(
				`resilient edit: could not read ${filePath}: ${
					readErr instanceof Error ? readErr.message : String(readErr)
				}`,
			);
		}

		const result: ReplaceResult = replace(content, oldStr, newStr, { replaceAll });
		if (!result.changed) {
			throw new Error(
				`old_string not found (resilient cascade exhausted, strategy=${result.strategy})`,
			);
		}

		await fs.writeFile(filePath, result.content, "utf8");
		return {
			content: [
				{
					type: "text",
					text: `Edited ${filePath} via resilient cascade (strategy: ${result.strategy}).`,
				},
			],
			_replaceStrategy: result.strategy,
		};
	}
}
