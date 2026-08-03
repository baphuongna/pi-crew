/**
 * provider-extensions.ts — discover Pi provider extensions automatically.
 *
 * WHY: pi-crew spawns child-pi workers with `--no-extensions` (security
 * posture: prevent untrusted user extensions from auto-loading). But that
 * made extension-registered PROVIDERS (e.g. pi-commandcode-provider, installed
 * via `pi install npm:...`) unresolvable inside subagents — every model from
 * those providers fell back and died with 429s. Pi DOES load explicitly-passed
 * `--extension <path>` even after `--no-extensions`, so the fix is to discover
 * the user's installed provider packages and pass them explicitly.
 *
 * This module reads Pi's own package registry (`~/.pi/agent/settings.json`
 * `packages` field + the npm install dir) and resolves each package to its
 * extension entry point. That's the SANCTIONED channel — the user explicitly
 * installed these via `pi install`, so they are trusted (unlike arbitrary
 * `~/.pi/agent/extensions/*.ts` which may be tool extensions with deps that
 * fail in child contexts).
 *
 * SECURITY: only packages the USER installed are auto-loaded. Project-local
 * packages and `.pi/agent/extensions/*.ts` are NOT auto-discovered here (the
 * existing SEC-1 gate in discover-agents.ts still strips project agents).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { userPiRoot } from "../../utils/paths.ts";

export interface DiscoveredProviderExtension {
	/** Package specifier as written in settings.json packages (e.g. "npm:pi-commandcode-provider"). */
	spec: string;
	/** Resolved absolute path to the extension entry point. */
	entryPath: string;
}

/**
 * Resolve the extension entry point for an installed Pi package.
 * Order: package.json `pi.extensions` (array) → `index.ts` → `index.mjs` → `index.js` → `src/index.ts`.
 * Returns undefined when the package has no resolvable entry point.
 */
function resolvePackageEntry(pkgDir: string): string | undefined {
	const pkgJsonPath = path.join(pkgDir, "package.json");
	if (fs.existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
				pi?: { extensions?: string[] };
				type?: string;
				main?: string;
			};
			const piExts = pkg.pi?.extensions;
			if (Array.isArray(piExts) && piExts.length > 0) {
				for (const rel of piExts) {
					const abs = path.resolve(pkgDir, rel);
					if (fs.existsSync(abs)) return abs;
				}
			}
			// Fall back to `main` when it points at a loadable entry (rare for extensions).
			if (pkg.main?.endsWith(".ts")) {
				const abs = path.resolve(pkgDir, pkg.main);
				if (fs.existsSync(abs)) return abs;
			}
		} catch {
			/* malformed package.json — fall through to filename probes */
		}
	}
	for (const name of ["index.ts", "index.mjs", "index.js", "src/index.ts"]) {
		const abs = path.join(pkgDir, name);
		if (fs.existsSync(abs)) return abs;
	}
	return undefined;
}

/**
 * Discover provider extension entry points from Pi's installed package registry.
 * Reads `~/.pi/agent/settings.json` → `packages` (npm: specs only — local
 * relative paths are the pi-crew extension itself and other local work, which
 * children already handle) and resolves each against `~/.pi/agent/npm/node_modules/`.
 *
 * Non-npm specs (local paths, git URLs) are skipped: they are not part of the
 * npm registry dir and resolving them is outside this module's scope.
 */
export function discoverProviderExtensions(settingsPath?: string): DiscoveredProviderExtension[] {
	const root = userPiRoot();
	const settingsFile = settingsPath ?? path.join(root, "settings.json");
	const out: DiscoveredProviderExtension[] = [];
	if (!fs.existsSync(settingsFile)) return out;
	let settings: { packages?: string[] };
	try {
		settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { packages?: string[] };
	} catch {
		return out;
	}
	// The npm registry dir lives beside settings.json (same agent root). When a
	// custom settingsPath is supplied (tests), derive npmBase from IT so the
	// package resolution stays consistent with the settings file being read.
	const baseDir = path.dirname(settingsFile);
	const npmBase = path.join(baseDir, "npm", "node_modules");
	for (const spec of settings.packages ?? []) {
		if (typeof spec !== "string") continue;
		// Only npm: specs resolve into the npm registry dir. Skip local path
		// packages (e.g. "../../source/my_pi/pi-crew") and git specs.
		if (!spec.startsWith("npm:")) continue;
		const pkgName = spec.slice(4);
		// Scoped packages: "@scope/name" → "@scope/name"; plain: "name".
		const pkgDir = path.join(npmBase, pkgName);
		if (!fs.existsSync(pkgDir)) continue;
		const entryPath = resolvePackageEntry(pkgDir);
		if (entryPath) out.push({ spec, entryPath });
	}
	return out;
}

/**
 * Convenience: absolute entry paths of all discovered provider extensions.
 */
export function discoverProviderExtensionPaths(settingsPath?: string): string[] {
	return discoverProviderExtensions(settingsPath).map((e) => e.entryPath);
}
