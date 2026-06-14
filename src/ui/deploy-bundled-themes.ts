/**
 * Deploy pi-crew's bundled themes to ~/.pi/agent/themes/ so Pi's theme
 * loader discovers them (Pi scans that directory for custom themes).
 *
 * Best-effort and idempotent: compares content to avoid unnecessary writes,
 * logs errors but never crashes registration.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot, userPiRoot } from "../utils/paths.ts";

/** Directory containing pi-crew's bundled theme JSON files. */
function bundledThemesDir(): string {
	return path.join(packageRoot(), "themes");
}

/** Target directory: ~/.pi/agent/themes/ (where Pi loads custom themes from). */
function customThemesDir(): string {
	return path.join(userPiRoot(), "themes");
}

function readIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Copy bundled themes to ~/.pi/agent/themes/, skipping files whose content
 * already matches (idempotent). Returns the number of themes deployed/updated.
 *
 * Safe to call on every registration. Never throws.
 */
export function deployBundledThemes(): number {
	try {
		const srcDir = bundledThemesDir();
		const dstDir = customThemesDir();

		if (!fs.existsSync(srcDir)) return 0;

		const files = (fs.readdirSync(srcDir) as string[]).filter((f) => f.endsWith(".json"));
		if (files.length === 0) return 0;

		// Ensure target directory exists
		fs.mkdirSync(dstDir, { recursive: true });

		let deployed = 0;
		for (const file of files) {
			const srcPath = path.join(srcDir, file);
			const dstPath = path.join(dstDir, file);
			const srcContent = fs.readFileSync(srcPath, "utf8");
			const dstContent = readIfExists(dstPath);

			// Skip if content matches exactly (idempotent — no churn)
			if (dstContent !== undefined && dstContent === srcContent) continue;

			try {
				fs.writeFileSync(dstPath, srcContent, "utf8");
				deployed++;
			} catch {
				// Individual file write failure — skip but continue
			}
		}

		return deployed;
	} catch {
		return 0;
	}
}
