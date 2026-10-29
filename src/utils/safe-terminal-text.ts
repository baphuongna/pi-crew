/**
 * safe-terminal-text.ts — neutralize terminal escape sequences in untrusted
 * text (w7a-render, 2026-10-29).
 *
 * Worker-derived strings (inline-panel transcript text/tool names, theme
 * filenames under ~/.pi/agent/themes, inspect error excerpts) can carry
 * OSC/APC/DCS/SOS string sequences (OSC 52 clipboard writes, OSC 8
 * hyperlinks, OSC 0 title sets) and CSI/C1 sequences (screen clear, cursor
 * moves, DA1 response spoofing) that pi-tui writes to the operator terminal
 * verbatim — pi-tui zero-widths escape payloads, so its visible-width crash
 * guard never trips and an in-window payload reaches terminal.write
 * byte-for-byte.
 *
 * Unlike `sanitizeUntrustedLine` (utils/visual.ts) — the single-line sink
 * helper that maps ALL C0/C1 controls (including newlines) to spaces — this
 * helper preserves printable structure (newlines, tabs) so multi-line
 * transcript text keeps its shape; it ONLY removes escape-sequence bytes:
 *  - OSC/APC/DCS/SOS string sequences, BEL- (`\u0007`), ST- (`ESC \`) and
 *    C1-ST- (`\u009C`) terminated;
 *  - CSI and other ESC-intermediate sequences, including the C1 CSI form
 *    (`\u009B`);
 *  - a final sweep removes any residual ESC/C1 introducer bytes (e.g.
 *    sequences truncated mid-stream by compaction) so no control byte can
 *    survive.
 * SGR color sequences are stripped too: trusted components (pi-tui theme
 * adapters) apply their own styling AFTER this boundary, so no
 * worker-supplied styling byte survives.
 */

/**
 * OSC (`ESC ]`), APC (`ESC _`), DCS (`ESC P`), SOS (`ESC X`) and PM (`ESC ^`)
 * string sequences … BEL / ST (`ESC \`)/ C1-ST (`\u009C`) terminators.
 */
const TERMINAL_STRING_SEQUENCE_RE =
	/(?:\u001B[\]_PX^][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

/** Residual ESC/C1 introducer bytes (truncated sequences, malformed forms). */
const RESIDUAL_INTRODUCER_RE = /[\u001B\u009B\u009C]/g;

/** Fast path: a string without any introducer byte cannot carry a sequence. */
function hasIntroducer(value: string): boolean {
	return value.includes("\u001B") || value.includes("\u009B") || value.includes("\u009C");
}

/** True when the value contains bytes that only appear inside escape sequences. */
export function hasTerminalEscapeBytes(value: string): boolean {
	return hasIntroducer(value);
}

/**
 * Neutralize terminal escape sequences in untrusted text.
 * Returns a string with zero ESC/C1 control bytes: OSC/APC/DCS/SOS payloads
 * are removed wholesale (when terminated), CSI/ESC-intermediate sequences are
 * removed, and any residual introducer byte is dropped. Printable text
 * (including newlines/tabs) passes through unchanged.
 */
export function stripTerminalSequences(value: string): string {
	if (!hasIntroducer(value)) return value;
	return value.replace(TERMINAL_STRING_SEQUENCE_RE, "").replace(RESIDUAL_INTRODUCER_RE, "");
}
