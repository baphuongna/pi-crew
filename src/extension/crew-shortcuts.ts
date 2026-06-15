/**
 * Crew keyboard shortcuts (Round 13 UX).
 *
 * Registers a small set of keyboard shortcuts for fast access to the most
 * useful pi-crew overlays. Keys are chosen to avoid collisions with Pi's
 * built-in keymap (see analysis of pi-tui core/keybindings defaults):
 *
 *   alt+s → open the pi-crew settings overlay (config + theme picker)
 *
 * `alt+<letter>` combos are safe: Pi only binds `alt+v`, `alt+enter`, and the
 * alt+arrow navigation keys. `alt+s` is mnemonic (settings) and free.
 *
 * Shortcuts are guarded by `hasUI` so they never fire in print/RPC mode, and
 * by the optional `registerShortcut` API so older Pi versions degrade
 * gracefully (no-op).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;

interface ShortcutRegistration {
	/** Pi KeyId, e.g. "alt+s". */
	key: KeyId;
	description: string;
	handler: ShortcutHandler;
}

const CREW_SHORTCUTS: ReadonlyArray<ShortcutRegistration> = [
	{
		key: "alt+s",
		description: "pi-crew: open settings (config + theme picker)",
		// Lazy-import the overlay so this module stays lightweight at load time
		// (avoids pulling the full commands.ts dependency tree into every
		// process that imports this module, e.g. the unit test).
		handler: async (ctx) => {
			const { openTeamSettingsOverlay } = await import("./registration/commands.ts");
			await openTeamSettingsOverlay(ctx);
		},
	},
];

/**
 * Register all crew keyboard shortcuts on a Pi instance. Safe to call once at
 * extension load. No-ops when `registerShortcut` is unavailable (older Pi).
 */
export function registerCrewShortcuts(
	pi: { registerShortcut?: (shortcut: KeyId, options: { description?: string; handler: ShortcutHandler }) => void },
): void {
	for (const sc of CREW_SHORTCUTS) {
		pi.registerShortcut?.(sc.key, { description: sc.description, handler: sc.handler });
	}
}

/** Exported for tests / introspection. */
export const CREW_SHORTCUT_KEYS: readonly KeyId[] = CREW_SHORTCUTS.map((s) => s.key);
