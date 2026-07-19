import { existsSync, readFileSync } from "node:fs";
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

let _isWebTerminal: boolean | null = null;

/** Returns true when running in a web-based terminal (gotty, wetty, etc.)
 * where system fonts are not available for PUA rendering. */
export function isWebTerminal(): boolean {
	if (_isWebTerminal !== null) return _isWebTerminal;
	if (process.env.GOTTY || process.env.WEBTERM) {
		_isWebTerminal = true;
		return true;
	}
	if (process.env.TERM === "dumb") {
		_isWebTerminal = true;
		return true;
	}
	try {
		// Check current process and ancestors — gotty is often the grandparent
		// (gotty → tmux → pi), so /proc/self/cgroup may not contain it.
		let pid = process.pid;
		for (let i = 0; i < 6 && pid > 1; i++) {
			const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8");
			if (cgroup.includes("gotty") || cgroup.includes("wetty")) {
				_isWebTerminal = true;
				return true;
			}
			const match = cgroup.match(/\d+:.*:(.*)/);
			// Read PPid from status
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			const ppid = status.match(/^PPid:\s+(\d+)/m);
			pid = ppid ? Number.parseInt(ppid[1], 10) : 1;
		}
	} catch {
		// not Linux or /proc not available
	}
	_isWebTerminal = false;
	return false;
}
