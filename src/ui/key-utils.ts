/**
 * key-utils.ts — Centralised key matching helpers.
 *
 * Pi 0.81+'s TUI input layer (`@earendil-works/pi-tui`) ships a `matchesKey()`
 * helper that handles multiple terminal key encodings: legacy CSI escapes
 * (`\x1b[A`), application cursor mode (`\x1bOA`), and Kitty keyboard protocol
 * variants. Pi-crew components previously compared against raw escape bytes
 * (`data === "\x1b[A"`), which silently failed on terminals that emit the
 * alternate encodings. This module wraps `matchesKey` with a single
 * `keyOf()` helper so overlay code reads naturally while picking up the
 * terminal-aware match logic for free.
 *
 * Returns the canonical KeyId when matchesKey recognises it, otherwise the
 * raw input string so callers can fall through to ASCII-letter shortcuts.
 */
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export type PiKeyName = KeyId | string;

const COMMON_IDS: readonly KeyId[] = [
	"up",
	"down",
	"left",
	"right",
	"enter",
	"escape",
	"tab",
	"shift+tab",
	"space",
	"backspace",
	"home",
	"end",
	"pageUp",
	"pageDown",
];

export function keyOf(data: string): KeyId | string {
	for (const id of COMMON_IDS) {
		if (matchesKey(data, id)) return id;
	}
	return data;
}
