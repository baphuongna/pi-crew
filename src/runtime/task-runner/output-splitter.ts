/**
 * output-splitter.ts — partition one worker's combined output into N
 * per-task results (M6 real-dispatch, MVP).
 *
 * The combined worker is told to wrap each task's result in
 * `<<<TASK_RESULT:{taskId}>>>` ... `<<<END_TASK_RESULT>>>` delimiters.
 * This module parses the raw output and returns a Map<taskId, resultText>.
 *
 * Strategy (in priority order):
 *   1. Delimiter parse — exact match of `<<<TASK_RESULT:id>>>` markers
 *   2. Section heading parse — `### Task N of M` / `## Task N` headers
 *   3. Whole-output broadcast — assign full raw output to ALL taskIds
 *      (safe fallback for read-only roles where identical context is OK)
 *
 * Returns an array of { taskId, text } records in input-order. When the
 * delimiter strategy succeeds, each entry contains that task's delimited
 * text. When broadcast fallback is used, all entries contain the full
 * raw output.
 *
 * Note: pure function — no I/O, no LLM calls, deterministic. This is
 * deliberately the simplest possible splitter; we don't try fuzzy
 * matching, NL extraction, or retry-the-LLM. The MVP trusts workers
 * to follow delimiters 99% of the time and broadcasts the rest.
 */

export interface SplitResult {
	taskId: string;
	text: string;
	/** Which strategy produced this entry. */
	strategy: "delimiter" | "section" | "broadcast";
}

/**
 * Split a raw worker output into N per-task result texts.
 *
 * @param rawOutput  — the worker's combined output text
 * @param taskIds    — ordered list of task IDs (matches the dispatch order)
 */
export function splitCoalescedOutput(rawOutput: string, taskIds: string[]): SplitResult[] {
	if (taskIds.length === 0) return [];
	if (taskIds.length === 1) {
		// Single-task group: return the whole output as the one task's result.
		return [{ taskId: taskIds[0]!, text: rawOutput, strategy: "delimiter" }];
	}

	const byId = new Map<string, string>();
	const delimiterHits = new Set<string>();

	// Strategy 1: delimiter parse.
	// Pattern: <<<TASK_RESULT:{id}>>> ... <<<END_TASK_RESULT>>>
	// We match greedily, allowing nested markers between start and end.
	const delimiterRegex = /<<<TASK_RESULT:([^\s>]+)>>>([\s\S]*?)<<<END_TASK_RESULT>>>/g;
	let match: RegExpExecArray | null;
	while ((match = delimiterRegex.exec(rawOutput)) !== null) {
		const id = match[1]!;
		const body = match[2]!.trim();
		if (taskIds.includes(id) && !byId.has(id)) {
			byId.set(id, body);
			delimiterHits.add(id);
		}
	}

	if (delimiterHits.size === taskIds.length) {
		// All tasks got delimiter hits — return in input order.
		return taskIds.map((id) => ({
			taskId: id,
			text: byId.get(id) ?? "",
			strategy: "delimiter" as const,
		}));
	}

	// Strategy 2: section heading parse.
	// Look for `### Task N of M` or `## Task {id}` markers. We try both.
	if (delimiterHits.size === 0) {
		const bySection = parseBySectionHeadings(rawOutput, taskIds);
		if (bySection.size === taskIds.length) {
			return taskIds.map((id) => ({
				taskId: id,
				text: bySection.get(id) ?? "",
				strategy: "section" as const,
			}));
		}
	}

	// Strategy 3: broadcast fallback. All tasks get the full raw output.
	// This is safe for read-only roles (explorers, reviewers) where
	// downstream consumers care about findings, not strict per-task partitioning.
	return taskIds.map((id) => ({
		taskId: id,
		text: rawOutput,
		strategy: "broadcast" as const,
	}));
}

/**
 * Strategy 2 implementation: parse sections by heading patterns.
 *
 * Matches `### Task N of M` (N=1..M) or `### Task N` headers, then
 * captures text up to the next header or end-of-input.
 *
 * Falls back to "first heading wins all text" if no N-of-M numbering is
 * present, which is common in worker output that just labels sections.
 */
function parseBySectionHeadings(rawOutput: string, taskIds: string[]): Map<string, string> {
	const result = new Map<string, string>();
	// First try numbered: "### Task 1 of N" / "## Task 1" / "### Task 1"
	const numberedRegex = /^(#{2,3})\s+Task\s+(\d+)\s+of\s+\d+.*$/gm;
	const sections: { num: number; start: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = numberedRegex.exec(rawOutput)) !== null) {
		sections.push({ num: Number(m[2]), start: m.index + m[0].length });
	}
	if (sections.length >= taskIds.length) {
		sections.sort((a, b) => a.start - b.start);
		for (let i = 0; i < sections.length && i < taskIds.length; i += 1) {
			const section = sections[i]!;
			const end = sections[i + 1]?.start ?? rawOutput.length;
			const text = rawOutput.slice(section.start, end).trim();
			const taskId = taskIds[i];
			if (taskId) result.set(taskId, text);
		}
		return result;
	}
	// Try "### Task {taskId}" headers — direct ID matching.
	const idHeaderRegex = /^(#{2,3})\s+Task\s+([^\s].*?)$/gm;
	while ((m = idHeaderRegex.exec(rawOutput)) !== null) {
		const headerText = m[2]!.trim();
		const matchedId = taskIds.find((id) => headerText.includes(id));
		if (matchedId && !result.has(matchedId)) {
			result.set(matchedId, ""); // placeholder; filled below
		}
	}
	if (result.size === taskIds.length) {
		// Re-scan to extract body per matched header
		const headerPositions: { taskId: string; start: number }[] = [];
		const idHeaderRegex2 = /^(#{2,3})\s+Task\s+([^\s].*?)$/gm;
		while ((m = idHeaderRegex2.exec(rawOutput)) !== null) {
			const headerText = m[2]!.trim();
			const matchedId = taskIds.find((id) => headerText.includes(id));
			if (matchedId) headerPositions.push({ taskId: matchedId, start: m.index + m[0].length });
		}
		headerPositions.sort((a, b) => a.start - b.start);
		for (let i = 0; i < headerPositions.length; i += 1) {
			const cur = headerPositions[i]!;
			const next = headerPositions[i + 1];
			const end = next ? rawOutput.lastIndexOf("\n#", next.start) : rawOutput.length;
			const text = rawOutput.slice(cur.start, end > 0 ? end : rawOutput.length).trim();
			result.set(cur.taskId, text);
		}
	}
	return result;
}
