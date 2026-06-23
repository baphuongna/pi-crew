/**
 * Robust resolution + async loading of the @earendil-works/pi-coding-agent
 * peer dependency. Fixes the "Cannot find module '@earendil-works/pi-coding-agent'"
 * crash that blocks ALL team runs when pi-crew and pi are installed in
 * SEPARATE node_modules trees.
 *
 * PROBLEM (Windows / global installs — reported 2026-06-17)
 * pi-crew is a pi EXTENSION. pi installs extensions under
 * `~/.pi/agent/npm/node_modules/<ext>/`, but pi itself (the
 * @earendil-works/pi-coding-agent package that extensions import from)
 * usually lives in a DIFFERENT node_modules tree — a global one (nvm,
 * %APPDATA%\npm, Volta, fnm, pnpm-global). Node's resolver only walks UP
 * through ancestor `node_modules` of the importing file, so a file under
 * `~/.pi/agent/npm/node_modules/pi-crew/...` CANNOT resolve a peer dep
 * installed under `~/.nvm/.../lib/node_modules/`. Every static
 * `import { X } from "@earendil-works/pi-coding-agent"` that executes inside
 * a SPAWNED CHILD PROCESS (the detached background team runner started by
 * async-runner.spawnBackgroundTeamRun) therefore crashes at module load,
 * leaving all team runs permanently `queued`.
 *
 * ADDITIONAL CONSTRAINT (verified empirically 2026-06-17)
 * pi-coding-agent ships as ESM-only (`"type":"module"`, exports map has only
 * an `import` condition). CJS `require()` / `createRequire(dir)(name)` fails
 * with ERR_PACKAGE_PATH_NOT_EXPORTED under plain node AND under jiti/tsx. The
 * ONLY working load mechanism is a dynamic `import()` of the resolved ESM
 * entry file URL. Hence: sync resolution of the DIR, async load of the MODULE.
 *
 * APPROACH
 *  - resolvePeerDep()     (sync)  — find the install dir across many layouts.
 *  - primePeerDep()       (async) — dynamic-import the resolved entry, cache
 *                                   the module namespace. Memoized. Called
 *                                   once per process during bootstrap.
 *  - getAgentDir()        (sync)  — read the cached module's getAgentDir.
 *                                   Falls back to a computed default if the
 *                                   cache was never primed, so it NEVER throws.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNpmGlobalRoot } from "./pi-spawn.ts";

/**
 * The pi-coding-agent peer dependency package name(s) we can be loaded by.
 * @earendil-works is the canonical scope; @mariozechner is the historical fork.
 */
export const PEER_DEP_NAMES = [
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
] as const;

/**
 * Env var a parent pi-crew process sets on spawned children so they can resolve
 * the peer dep WITHOUT running `npm root -g` (~200ms probe). The resolver
 * checks this FIRST. Absent (older parent, direct invocation, tests) → falls
 * through to the probing strategies. Also lets users override the resolution
 * explicitly as a last-resort fix.
 */
export const PEER_DEP_DIR_ENV = "PI_CREW_PEER_DEP_DIR";

type PeerDepModule = typeof import("@earendil-works/pi-coding-agent");

interface ResolvedPeerDep {
	dir: string;
	name: string;
	/** file:// URL of the ESM entry (exports["."].import || main). */
	mainUrl: string;
}

let cachedResolve: ResolvedPeerDep | undefined | null = null;
let cachedModule: PeerDepModule | undefined;
let primingPromise: Promise<PeerDepModule> | undefined;

/**
 * Build the ordered list of "resolution bases" — paths to seed
 * `createRequire(...).resolve()` from. Node walks UP `node_modules` from each
 * base's directory, so any base inside (or beside) the peer dep's package
 * tree will find it. Pure given env/process inputs; exported for unit tests.
 */
export function peerDepResolutionBases(): string[] {
	const bases: string[] = [];

	// 0. Parent-provided hint (fastest — no probe). Set by async-runner.
	const envHint = process.env[PEER_DEP_DIR_ENV]?.trim();
	if (envHint) bases.push(path.resolve(envHint));

	// 1. This file's location — works when pi-crew and pi-coding-agent share a
	//    node_modules ancestor (the common co-located install).
	bases.push(fileURLToPath(import.meta.url));

	// 2. The entry script. In the PARENT (main pi process) argv[1] is pi's CLI
	//    script, which lives INSIDE pi-coding-agent's package → resolves. In a
	//    SPAWNED CHILD argv[1] is a pi-crew script → cheap miss, falls through.
	const argv1 = process.argv[1];
	if (argv1) bases.push(path.resolve(argv1));

	// 3. The Node binary's global node_modules. Covers nvm / nvm-windows /
	//    Volta / fnm where pi-coding-agent is `npm i -g`'d: node is at
	//    <prefix>/bin/node and globals live at <prefix>/lib/node_modules.
	try {
		const execDir = path.dirname(fs.realpathSync.native(process.execPath));
		bases.push(path.join(path.dirname(execDir), "lib", "node_modules"));
		// Some layouts (Windows global, or a bare node_modules sibling of bin).
		bases.push(path.join(execDir, "node_modules"));
	} catch {
		/* realpath best-effort */
	}

	// 4. `npm root -g` — the canonical cross-layout global root (memoized in
	//    pi-spawn.ts, ~200ms once). Derive the scoped package dirs from it.
	const npmRoot = resolveNpmGlobalRoot();
	if (npmRoot) {
		for (const pkgName of PEER_DEP_NAMES) {
			bases.push(path.join(npmRoot, ...pkgName.split("/")));
		}
	}

	// 5. Windows %APPDATA%\npm static layout (legacy npm-global, pre-npm-root-g).
	if (process.env.APPDATA) {
		bases.push(path.join(process.env.APPDATA, "npm", "node_modules"));
	}

	return bases;
}

/** Pull the ESM entry path out of package.json (exports import || main). */
function extractEsmMain(pkg: unknown): string | undefined {
	if (!pkg || typeof pkg !== "object") return undefined;
	const p = pkg as Record<string, unknown>;
	const exp = p.exports;
	if (exp && typeof exp === "object") {
		const dot = (exp as Record<string, unknown>)["."];
		if (dot && typeof dot === "object") {
			const d = dot as Record<string, unknown>;
			const rel = d.import ?? d.default ?? d.module;
			if (typeof rel === "string") return rel;
		} else if (typeof dot === "string") {
			return dot;
		}
	}
	const main = p.main;
	return typeof main === "string" ? main : undefined;
}

/**
 * Walk the node_modules resolution algorithm MANUALLY from `start` looking for
 * any of `names`. We do NOT use createRequire/require.resolve here because
 * pi-coding-agent ships an ESM-only package with a restrictive exports map
 * (only the `.` import condition) — `require.resolve("<pkg>/package.json")`
 * and `require.resolve("<pkg>")` both throw ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Reading package.json directly from the walked dir sidesteps the exports map
 * entirely (exports only governs subpath IMPORTS, not raw file reads).
 *
 * At each directory we check BOTH `<dir>/node_modules/<pkg>` (the standard
 * container case) AND `<dir>/<pkg>` (handles a base that IS a node_modules
 * dir, e.g. the output of `npm root -g`), then walk up to root.
 */
function findPackageDir(
	start: string,
	names: readonly string[],
): { dir: string; name: string } | undefined {
	let dir = path.resolve(start);
	try {
		if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
	} catch {
		/* treat as directory */
	}
	while (true) {
		for (const name of names) {
			const segs = name.split("/");
			const candidates = [
				path.join(dir, "node_modules", ...segs, "package.json"),
				path.join(dir, ...segs, "package.json"),
			];
			for (const pkgJson of candidates) {
				try {
					const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
					if (pkg?.name === name) {
						return { dir: path.dirname(pkgJson), name };
					}
				} catch {
					/* not present at this candidate */
				}
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}
	return undefined;
}

function tryResolveFrom(base: string): ResolvedPeerDep | undefined {
	const found = findPackageDir(base, PEER_DEP_NAMES);
	if (!found) return undefined;
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(found.dir, "package.json"), "utf-8"),
		);
		const mainRel = extractEsmMain(pkg);
		if (!mainRel) return undefined;
		const mainAbs = path.resolve(found.dir, mainRel);
		if (!fs.existsSync(mainAbs)) return undefined;
		return { dir: found.dir, name: found.name, mainUrl: pathToFileURL(mainAbs).href };
	} catch {
		return undefined;
	}
}

/** Resolve the peer dep install dir + ESM entry URL. Memoized (sync). */
export function resolvePeerDep(): ResolvedPeerDep | undefined {
	if (cachedResolve !== null) return cachedResolve ?? undefined;
	for (const base of peerDepResolutionBases()) {
		const found = tryResolveFrom(base);
		if (found) {
			cachedResolve = found;
			return found;
		}
	}
	cachedResolve = null; // mark attempted-and-failed; don't re-probe per call
	return undefined;
}

/** Just the install directory (for env-hint propagation to children). */
export function resolvePeerDepDir(): string | undefined {
	return resolvePeerDep()?.dir;
}

/**
 * Dynamic-import the peer dep module, caching the namespace. Memoized via a
 * shared promise so concurrent callers share one load. On failure the promise
 * is cleared so a later caller can retry. Safe to call repeatedly.
 */
export function primePeerDep(): Promise<PeerDepModule> {
	if (cachedModule) return Promise.resolve(cachedModule);
	if (primingPromise) return primingPromise;
	primingPromise = (async () => {
		const resolved = resolvePeerDep();
		if (!resolved) {
			throw new Error(buildMissingMessage());
		}
		// LAZY: defer dynamic import of module to its call site.
		cachedModule = (await import(resolved.mainUrl)) as PeerDepModule;
		return cachedModule;
	})();
	// Clear on failure so a later caller can retry (e.g. after env fix).
	primingPromise.catch(() => {
		primingPromise = undefined;
	});
	return primingPromise;
}

/** Async module accessor (primes if needed). */
export async function loadPeerDep(): Promise<PeerDepModule> {
	return primePeerDep();
}

function buildMissingMessage(): string {
	return (
		`pi-crew could not resolve the @earendil-works/pi-coding-agent peer dependency.\n` +
		`This usually means pi-crew and pi are installed in separate node_modules trees\n` +
		`(e.g. pi-crew under ~/.pi/agent/npm/ but pi under an nvm/Volta/fnm global scope).\n` +
		`Resolution bases tried:\n` +
		peerDepResolutionBases().map((b) => `  - ${b}`).join("\n") +
		`\nFix: install pi-crew in the SAME scope as pi, e.g.\n` +
		`  npm install -g @earendil-works/pi-crew\n` +
		`or set the env var ${PEER_DEP_DIR_ENV}=<path to the pi-coding-agent package dir>.`
	);
}

/**
 * Read the user agent dir via the REAL peer-dep getAgentDir (fork-aware:
 * correct for pi, tau, and renamed forks). Sync; reads the primed cache.
 *
 * If the cache was never primed (e.g. called before bootstrap completes, or
 * prime failed), falls back to a computed default so it NEVER throws. The
 * default matches standard pi (`~/.pi/agent`) and respects the
 * `PI_CODING_AGENT_DIR` override — correct for the overwhelmingly common
 * case. Forks rely on the primed real function (register.ts primes at startup).
 */
export function getAgentDir(): string {
	if (cachedModule?.getAgentDir) {
		try {
			return cachedModule.getAgentDir();
		} catch {
			/* fall through to computed default */
		}
	}
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** @internal — reset all caches for unit tests. */
export function __resetPeerDepCacheForTest(): void {
	cachedResolve = null;
	cachedModule = undefined;
	primingPromise = undefined;
}
