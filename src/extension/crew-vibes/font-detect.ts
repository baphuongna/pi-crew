import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Detect whether the crew-vibes PUA font (U+E700..U+E70F) file exists
 * on disk.  This is a *best-effort* heuristic — file existence does NOT
 * guarantee the terminal can render PUA glyphs (many terminals have their
 * own font stacks).  For reliable animation, braille fallback frames are
 * used by default; PUA frames are only activated when the user explicitly
 * enables them via config (speed.indicatorStyle = "pua").
 */

function fontPath(): string {
	const os = platform();
	const home = homedir();
	if (os === "darwin") return join(home, "Library", "Fonts", "crew-vibes.ttf");
	if (os === "linux") return join(home, ".local", "share", "fonts", "crew-vibes.ttf");
	if (os === "win32") {
		const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return join(local, "Microsoft", "Windows", "Fonts", "crew-vibes.ttf");
	}
	return "";
}

let _hasFontFile: boolean | null = null;

/** Returns true when crew-vibes.ttf exists in the platform font directory. */
export function hasCrewFontFile(): boolean {
	if (_hasFontFile !== null) return _hasFontFile;
	const p = fontPath();
	_hasFontFile = p !== "" && existsSync(p);
	return _hasFontFile;
}
