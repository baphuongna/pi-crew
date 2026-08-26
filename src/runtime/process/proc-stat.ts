/**
 * proc-stat.ts — THE single `/proc/<pid>/stat` field parser.
 *
 * Three consumers previously hand-rolled the same paren-aware split (the
 * surface spawn's parent starttime capture, the worker-side parent-guard, and
 * the zombie scanner's ppid/starttime read). A divergence between them is not
 * cosmetic: the spawn writes `PI_CREW_PARENT_START_TIME` from field 22, and
 * the worker kills itself when that value stops matching — so both sides MUST
 * index identically. comm (field 2) may contain spaces AND ')' characters,
 * hence everything up to the LAST ")" is skipped, never a naive whitespace
 * split.
 *
 * Layout after the comm field: rest[0] = state, rest[1] = ppid, …
 * rest[STARTTIME_INDEX] = starttime (field 22, clock ticks since boot).
 */

/** Field 22 (starttime) minus the two consumed by the comm cut = index 19. */
export const PROC_STAT_STARTTIME_INDEX = 19;
/** Field 3 (state) → first entry after the comm cut. */
export const PROC_STAT_STATE_INDEX = 0;
/** Field 4 (ppid) → second entry after the comm cut. */
export const PROC_STAT_PPID_INDEX = 1;

/**
 * Fields of a `/proc/<pid>/stat` line AFTER the comm column (paren-aware).
 * Returns undefined when the buffer has no closing paren at all.
 */
export function fieldsAfterComm(stat: string): string[] | undefined {
	const lastParen = stat.lastIndexOf(")");
	if (lastParen === -1) return undefined;
	return stat
		.slice(lastParen + 1)
		.trim()
		.split(/\s+/);
}

/**
 * Raw starttime ticks (field 22) as a string, for byte-exact comparison with
 * the value the spawner recorded. undefined when absent/unparseable.
 */
export function procStartTimeTicks(stat: string): string | undefined {
	const fields = fieldsAfterComm(stat);
	if (!fields) return undefined;
	const raw = fields[PROC_STAT_STARTTIME_INDEX];
	return raw && Number.isFinite(Number(raw)) ? raw : undefined;
}
