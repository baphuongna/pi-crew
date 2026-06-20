/**
 * Structured Result Extractor — attempts to extract structured data from worker output.
 * Tries multiple extraction strategies before falling back to raw text.
 */
export interface ExtractedResult {
	/** Whether structured data was successfully extracted */
	structured: boolean;
	/** Parsed structured data (if structured=true) */
	data: unknown;
	/** Raw text output (always available) */
	rawText: string;
	/** Error message if extraction was attempted but failed */
	error?: string;
}

/**
 * Extract structured result from raw worker output text.
 * Tries strategies in order: direct JSON, fenced JSON, key-value markers.
 */
export function extractStructuredResult(raw: string, _schema?: Record<string, unknown>): ExtractedResult {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { structured: false, data: null, rawText: raw };
	}

	// Strategy 1: Direct JSON parse (entire output is JSON)
	const directResult = tryDirectJson(trimmed);
	if (directResult !== undefined) {
		return { structured: true, data: directResult, rawText: raw };
	}

	// Strategy 2: Extract from ```json ... ``` fence
	const fencedResult = tryFencedJson(trimmed);
	if (fencedResult !== undefined) {
		return { structured: true, data: fencedResult, rawText: raw };
	}

	// Strategy 3: Extract from markers like "RESULT:" or "OUTPUT:"
	const markerResult = tryMarkerExtraction(trimmed);
	if (markerResult !== undefined) {
		return { structured: true, data: markerResult, rawText: raw };
	}

	// Strategy 4: Scan for the first JSON object/array anywhere in text.
	// Models often add prose preamble/epilogue ("Here's my review:", "Let me analyze...")
	// around the JSON. This catches JSON embedded in sentences, lists, or prose.
	const scannedResult = tryScanJson(trimmed);
	if (scannedResult !== undefined) {
		return { structured: true, data: scannedResult, rawText: raw };
	}

	return { structured: false, data: null, rawText: raw };
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
