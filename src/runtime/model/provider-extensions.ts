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

// R5-L3 (Round 5 LOW-3): FIFO cap at insertion (mirrors knowledgeCache in
// knowledge-injection.ts). Entries are only removed when a re-access sees a
// changed mtime, so distinct settings paths (e.g. per-test temp roots) would
// otherwise accumulate for the process lifetime.
const MAX_PROVIDER_EXTENSION_CACHE = 64;

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
 * GH #61: normalize a DIRECTORY `pi.extensions` entry to the entry FILE that
 * Pi's own package auto-load registers. Pi's chain (package-manager
 * `collectAutoExtensionEntries` → `resolveExtensionEntries`) resolves a
 * directory to its nested pi-manifest entries, else `index.ts`/`index.js`.
 * If pi-crew injects the directory as-is, the child worker loads the same
 * extension twice under two path identities (".../dist" via --extension vs
 * ".../dist/index.js" via package auto-discovery) and pi's
 * detectExtensionConflicts kills the worker at startup (exit 1, every tool
 * reported as conflicting). Always inject the FILE identity.
 */
function resolveExtensionDirEntry(dir: string, depth = 0): string | undefined {
	if (depth > 2) return undefined; // guard pathological nesting loops
	const pkgJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(pkgJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { pi?: { extensions?: string[] } };
			const piExts = pkg.pi?.extensions;
			if (Array.isArray(piExts) && piExts.length > 0) {
				for (const rel of piExts) {
					const abs = path.resolve(dir, rel);
					if (!fs.existsSync(abs)) continue;
					return fs.statSync(abs).isDirectory() ? resolveExtensionDirEntry(abs, depth + 1) : abs;
				}
			}
		} catch {
			/* malformed package.json — fall through to index probes */
		}
	}
	// Order mirrors Pi's resolveExtensionEntries EXACTLY for the first two
	// (index.ts → index.js): when Pi's auto-load registers the extension, the
	// injected identity MUST match its pick. index.mjs and package.json `main`
	// are fallbacks for packages Pi's auto-load would NOT register at all (it
	// checks neither) — a single injected instance there cannot conflict, and
	// `main` preserves the legacy jiti dir-loading behaviour (GH #61 follow-up).
	for (const name of ["index.ts", "index.js"]) {
		const abs = path.join(dir, name);
		if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
	}
	const mjs = path.join(dir, "index.mjs");
	if (fs.existsSync(mjs) && fs.statSync(mjs).isFile()) return mjs;
	if (fs.existsSync(pkgJsonPath)) {
		try {
			const main = (JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { main?: string }).main;
			if (main) {
				const abs = path.resolve(dir, main);
				if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
			}
		} catch {
			/* malformed package.json — skip */
		}
	}
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
					if (!fs.existsSync(abs)) continue;
					// GH #61: a DIRECTORY entry (e.g. pi-web-access "./dist") must be
				// normalized to the file identity Pi's auto-load uses — injecting the
				// raw dir double-loads the extension in child workers (tool conflicts,
				// exit 1). An unresolvable dir is SKIPPED, matching Pi's own view of
				// the package (its auto-load would not register it either).
					if (fs.statSync(abs).isDirectory()) {
						const entry = resolveExtensionDirEntry(abs);
						if (entry) return entry;
						continue;
					}
					return abs;
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
		if (cache.size > MAX_PROVIDER_EXTENSION_CACHE) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
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
