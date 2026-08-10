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
import { packageRoot, userPiRoot } from "../../utils/paths.ts";

export interface DiscoveredProviderExtension {
	/** Package specifier as written in settings.json packages (e.g. "npm:pi-commandcode-provider"). */
	spec: string;
	/** Resolved absolute path to the extension entry point. */
	entryPath: string;
}

/**
 * PERF-3: discoverProviderExtensions() reads settings.json + per-package
 * existsSync/readFileSync on EVERY call (called 4x per discoverAgents cache
 * miss). Cache the result keyed on the settings.json path + mtime: while the
 * file is unchanged the result is returned without any fs reads beyond one
 * statSync. If settings.json is missing (statSync throws) the cache entry is
 * left untouched so a later call re-checks. Keyed by path so distinct settings
 * files (e.g. per-test temp roots) never share entries; mtime invalidation
 * covers the only mutation channel (settings.json edits) — the original has no
 * TTL, and none is needed.
 */
const cache = new Map<string, { mtimeMs: number; result: DiscoveredProviderExtension[] }>();

function cachedResult(settingsPath: string): { mtimeMs: number; result: DiscoveredProviderExtension[] } | undefined {
	const entry = cache.get(settingsPath);
	if (!entry) return undefined;
	try {
		if (fs.statSync(settingsPath).mtimeMs === entry.mtimeMs) return entry;
	} catch {
		// settings.json missing/unreadable — cannot confirm unchanged.
	}
	cache.delete(settingsPath);
	return undefined;
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
 * Reads `~/.pi/agent/settings.json` → `packages` and resolves each spec:
 *   - `npm:<name>`      → `~/.pi/agent/npm/node_modules/<name>/`
 *   - local path spec   → resolved relative to the settings.json dir (the way
 *     `pi install <local-path>` records them), e.g. "../../src/foo"
 *   - git:/file: specs   → skipped (not resolvable on disk)
 *
 * Both npm: and local-path specs are SANCTIONED channels — the user wrote them
 * into settings.json (directly or via `pi install`), so they are trusted at the
 * same level. This is distinct from project-sourced AGENT extensions
 * (`.crew/agents/*.md` `extensions:` frontmatter), which are repo-adjacent
 * untrusted data and stay gated by SEC-1 in discover-agents.ts.
 */
export function discoverProviderExtensions(settingsPath?: string): DiscoveredProviderExtension[] {
	const root = userPiRoot();
	const settingsFile = settingsPath ?? path.join(root, "settings.json");

	// PERF-3: reuse the cached result while settings.json's mtime is unchanged.
	const hit = cachedResult(settingsFile);
	if (hit) return hit.result;

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
		let pkgDir: string;
		if (spec.startsWith("npm:")) {
			// Scoped packages: "@scope/name" → "@scope/name"; plain: "name".
			pkgDir = path.join(npmBase, spec.slice(4));
		} else if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) {
			// Local path spec — resolve relative to the settings.json dir, matching
			// how `pi install <local-path>` records it. Same trust level as npm:
			// (user wrote it into settings.json). Not to be confused with project
			// AGENT extensions (.crew/agents/* frontmatter) — those stay SEC-1 gated.
			pkgDir = path.resolve(baseDir, spec);
		} else {
			// git:/file:/http: specs etc. — not resolvable on disk, skip.
			continue;
		}
		if (!fs.existsSync(pkgDir)) continue;
		// Skip self: pi-crew's own package is a settings package (the orchestrator
		// extension the parent loads), but a child WORKER must not re-load it — it
		// would register the team tool / observability / MCP wiring intended for
		// the orchestrator process, not a worker. Provider + adapter extensions
		// (pi-other-provider, pi-mcp-adapter, pi-rlm, ...) stay.
		if (path.resolve(pkgDir) === path.resolve(packageRoot())) continue;
		const entryPath = resolvePackageEntry(pkgDir);
		if (entryPath) out.push({ spec, entryPath });
	}
	// Cache the resolved result keyed on the settings.json path + mtime.
	try {
		cache.set(settingsFile, { mtimeMs: fs.statSync(settingsFile).mtimeMs, result: out });
	} catch {
		cache.delete(settingsFile);
	}
	return out;
}

/**
 * Convenience: absolute entry paths of all discovered provider extensions.
 */
export function discoverProviderExtensionPaths(settingsPath?: string): string[] {
	return discoverProviderExtensions(settingsPath).map((e) => e.entryPath);
}
