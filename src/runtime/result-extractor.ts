/**
 * Structured Result Extractor — attempts to extract structured data from worker output.
 * Tries multiple extraction strategies before falling back to raw text.
 *
 * Round-13 P0-3: optional `schema` (TypeBox `TSchema`) — when provided, extracted
 * data is validated against the schema via `Value.Check`. On mismatch, the result
 * is `structured:false` with an explanatory `error`. Backward compatible: when
 * schema is undefined, behavior is identical to the previous regex-based extractor.
 */
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface ExtractedResult {
	/** Whether structured data was successfully extracted */
	structured: boolean;
	/** Parsed structured data (if structured=true AND validated against schema if provided) */
	data: unknown;
	/** Raw text output (always available) */
	rawText: string;
	/** Error message if extraction was attempted but failed */
	error?: string;
}

/**
 * Extract structured result from raw worker output text.
 * Tries strategies in order: direct JSON, fenced JSON, key-value markers, scan.
 *
 * @param raw - the raw text output from a worker
 * @param schema - optional TypeBox schema. When provided, the extracted value is
 *                 validated; mismatch produces `{structured:false, error:...}`.
 */
export function extractStructuredResult(raw: string, schema?: TSchema): ExtractedResult {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { structured: false, data: null, rawText: raw };
	}

	// Strategy 1: Direct JSON parse (entire output is JSON)
	const directResult = tryDirectJson(trimmed);
	if (directResult !== undefined) {
		return finalize(directResult, raw, schema);
	}

	// Strategy 2: Extract from ```json ... ``` fence
	const fencedResult = tryFencedJson(trimmed);
	if (fencedResult !== undefined) {
		return finalize(fencedResult, raw, schema);
	}

	// Strategy 3: Extract from markers like "RESULT:" or "OUTPUT:"
	const markerResult = tryMarkerExtraction(trimmed);
	if (markerResult !== undefined) {
		return finalize(markerResult, raw, schema);
	}

	// Strategy 4: Scan for the first JSON object/array anywhere in text.
	// Models often add prose preamble/epilogue ("Here's my review:", "Let me analyze...")
	// around the JSON. This catches JSON embedded in sentences, lists, or prose.
	const scannedResult = tryScanJson(trimmed);
	if (scannedResult !== undefined) {
		return finalize(scannedResult, raw, schema);
	}

	return { structured: false, data: null, rawText: raw };
}

/**
 * After extracting a candidate object, validate it against the optional TypeBox schema.
 * When no schema is given, behavior is the legacy "structured:true" path.
 * When a schema is given and validation fails, return structured:false with a
 * clear error message (caller can surface this in the AgentResult).
 *
 * NOTE: TypeBox 0.34.49's `Value.Check` returns a boolean and does not expose
 * per-error paths in its public API. We use the boolean + a fallback "type mismatch"
 * description. Scripts that need detailed diagnostics can wrap their own validator.
 */
function finalize(candidate: unknown, raw: string, schema: TSchema | undefined): ExtractedResult {
	if (!schema) {
		return { structured: true, data: candidate, rawText: raw };
	}
	const ok = Value.Check(schema, candidate);
	if (ok) {
		return { structured: true, data: candidate, rawText: raw };
	}
	return {
		structured: false,
		data: null,
		rawText: raw,
		error: `structured output does not match schema: expected shape ${describeSchemaShape(schema)}, got ${describeValue(candidate)}`,
	};
}

function describeValue(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		return json.length > 200 ? `${json.slice(0, 200)}…` : json;
	} catch {
		return typeof value;
	}
}

function describeSchemaShape(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "any";
	const obj = schema as Record<string, unknown>;
	const kind = obj.kind as string | undefined;
	const type = obj.type as string | undefined;
	if (kind === "object" || type === "object") {
		const properties = obj.properties;
		if (!properties || typeof properties !== "object") return "object";
		return `object<${Object.keys(properties as Record<string, unknown>).join(",")}>`;
	}
	if (kind === "array" || type === "array") return "array";
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf)) return "union";
	return "any";
}

function tryDirectJson(text: string): unknown | undefined {
	if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function tryFencedJson(text: string): unknown | undefined {
	const match = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
	if (!match?.[1]) return undefined;
	try {
		return JSON.parse(match[1].trim());
	} catch {
		return undefined;
	}
}

/**
 * Strategy 4: Scan for the first balanced JSON object/array anywhere in text.
 * Robust against prose preamble/epilogue that models add around JSON output.
 * Returns the first valid JSON value found, or undefined.
 */
function tryScanJson(text: string): unknown | undefined {
	// Find the first '{' or '[' in the text.
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== "{" && ch !== "[") continue;
		const rest = text.slice(i);
		const end = findMatchingBracket(rest);
		if (end <= 0) continue;
		const candidate = rest.slice(0, end);
		try {
			return JSON.parse(candidate);
		} catch {
			// Not valid JSON at this position; keep scanning for the next '{'/'['.
			continue;
		}
	}
	return undefined;
}

function tryMarkerExtraction(text: string): unknown | undefined {
	// Try to find JSON after common markers
	const markers = ["RESULT:", "OUTPUT:", "ANSWER:", "### Result\n", "## Output\n"];
	for (const marker of markers) {
		const idx = text.indexOf(marker);
		if (idx === -1) continue;
		const after = text.slice(idx + marker.length).trim();
		// Try JSON parse on text after marker
		if (after.startsWith("{") || after.startsWith("[")) {
			try {
				return JSON.parse(after);
			} catch {
				// Try to find just the JSON object/array
				const jsonEnd = findMatchingBracket(after);
				if (jsonEnd > 0) {
					try {
						return JSON.parse(after.slice(0, jsonEnd));
					} catch {
					}
				}
			}
		}
	}
	return undefined;
}

function findMatchingBracket(text: string): number {
	const openChar = text[0];
	const closeChar = openChar === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === openChar) depth++;
		if (ch === closeChar) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}
