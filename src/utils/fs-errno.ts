/**
 * Fatal-filesystem errno classification (bug-026 sub-issue B).
 *
 * During the 2026-08-15 disk-full window, workers died with generic
 * "unresponsive"/ETIMEDOUT diagnostics — the ENOSPC errno only surfaced
 * inside stderr-tail strings embedded in the E007 ChildTimeout message
 * (`errors.ts` childTimeout appends "Stderr tail: ..."), never as a raw
 * errno object in the parent process. The classifier therefore matches BOTH
 * shapes:
 *  - (a) `err.code` (NodeJS.ErrnoException) case-insensitively, and
 *  - (b) the error's message text — or any plain string, e.g. a stderr tail.
 *
 * Deliberately NOT placed in state/atomic-write.ts: that module has
 * process.on side effects at module load and imports worker-atomic-writer,
 * and it already throws raw errno errors — classification belongs at catch
 * sites. This module is dependency-free so state/types.ts (type-only) and
 * the team-tool run/doctor surfaces can import it cheaply.
 */

export type FatalFsCause = "enospc" | "edquot" | "emfile" | "enfile";

const FATAL_FS_CODES: ReadonlySet<string> = new Set(["enospc", "edquot", "emfile", "enfile"]);

/** Message-text fallback: catches errno codes embedded in stderr tails /
 *  synthesized error messages where no structured `.code` exists. */
const FATAL_FS_TEXT = /\b(ENOSPC|EDQUOT|EMFILE|ENFILE)\b/;

function classifyCode(code: unknown): FatalFsCause | undefined {
	if (typeof code !== "string") return undefined;
	const normalized = code.toLowerCase();
	return FATAL_FS_CODES.has(normalized) ? (normalized as FatalFsCause) : undefined;
}

function classifyText(text: unknown): FatalFsCause | undefined {
	if (typeof text !== "string") return undefined;
	const match = FATAL_FS_TEXT.exec(text);
	return match ? (match[1]?.toLowerCase() as FatalFsCause) : undefined;
}

/**
 * Classify an unknown error (or a raw string, e.g. a child stderr tail) as a
 * fatal filesystem cause. Returns undefined for non-fs errors. Pure and total:
 * never throws on non-object inputs.
 */
export function classifyFatalFsError(err: unknown): FatalFsCause | undefined {
	if (typeof err === "string") return classifyText(err);
	if (err === null || err === undefined) return undefined;
	const code = classifyCode((err as NodeJS.ErrnoException).code);
	if (code) return code;
	return classifyText((err as { message?: unknown }).message);
}

/**
 * Combined classification for a finished attempt (bug-026 sub-issue B):
 * the assembled attempt error first — a structured errno or a message that
 * embeds one (E007 stderr tails) — then the child's stderr tail. Extracted
 * as a pure seam so the child-executor hook is directly unit-testable.
 */
export function failureCauseForAttempt(error: string | undefined, stderr: string | undefined): FatalFsCause | undefined {
	return classifyFatalFsError(error) ?? classifyFatalFsError(stderr);
}

/** Human label for a fatal fs cause. */
export function fsFailureLabel(cause: FatalFsCause): string {
	return cause === "enospc" || cause === "edquot" ? "disk full" : "too many open files";
}
