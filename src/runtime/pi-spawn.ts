import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export interface PiSpawnCommand {
	command: string;
	args: string[];
}

const PI_PACKAGE_NAMES = [
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
];

function isRunnableNodeScript(filePath: string): boolean {
	return fs.existsSync(filePath) && /\.(?:mjs|cjs|js)$/i.test(filePath);
}

/**
 * Check that a resolved path is within known safe prefixes.
 * Allowed prefixes: npm global bin (APPDATA/npm), project node_modules/.bin,
 * or the current process's execPath directory.
 */
function isWithinAllowedPrefixes(resolvedPath: string): boolean {
	const normalized = path.resolve(resolvedPath).toLowerCase();

	const allowedPrefixes: string[] = [];

	// Current process execPath directory (e.g. node installation)
	try {
		const execDir = path.dirname(fs.realpathSync.native(process.execPath));
		allowedPrefixes.push(execDir.toLowerCase());
		allowedPrefixes.push(path.join(path.dirname(execDir), "lib", "node_modules").toLowerCase());
	} catch { /* ignore */ }

	// npm global bin via APPDATA
	if (process.env.APPDATA) {
		allowedPrefixes.push(path.join(process.env.APPDATA, "npm").toLowerCase());
	}

	const npmPrefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX;
	if (npmPrefix) {
		allowedPrefixes.push(path.resolve(npmPrefix).toLowerCase());
		allowedPrefixes.push(path.join(path.resolve(npmPrefix), "lib", "node_modules").toLowerCase());
	}

	// Project-local node_modules/.bin
	try {
		const projectBin = path.resolve("node_modules", ".bin");
		allowedPrefixes.push(projectBin.toLowerCase());
	} catch { /* ignore */ }

	// User home npm-global
	try {
		const homeNpm = path.join(os.homedir(), ".npm-global", "bin");
		allowedPrefixes.push(homeNpm.toLowerCase());
	} catch { /* ignore */ }

	// User home .local/bin
	try {
		const homeLocal = path.join(os.homedir(), ".local", "bin");
		allowedPrefixes.push(homeLocal.toLowerCase());
	} catch { /* ignore */ }

	return allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		if (!entry) return undefined;
		let dir = path.dirname(fs.realpathSync(entry));
		while (dir !== path.dirname(dir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: string };
				if (pkg.name && PI_PACKAGE_NAMES.includes(pkg.name)) return dir;
			} catch {
				// Continue walking upward.
			}
			dir = path.dirname(dir);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function packageBinScript(packageJsonPath: string): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { bin?: string | Record<string, string> };
		const binPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi ?? Object.values(pkg.bin ?? {})[0];
		if (!binPath) return undefined;
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		return isRunnableNodeScript(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function findPiPackageJsonFrom(startDir: string): string | undefined {
	let dir = startDir;
	while (dir !== path.dirname(dir)) {
		const direct = path.join(dir, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(direct, "utf-8")) as { name?: string };
			if (pkg.name && PI_PACKAGE_NAMES.includes(pkg.name)) return direct;
		} catch {
			// Continue searching upward and in node_modules.
		}
		for (const pkgName of PI_PACKAGE_NAMES) {
			const [scope, name] = pkgName.replace("@", "").split("/");
			const dependency = path.join(dir, "node_modules", `@${scope}`, name, "package.json");
			if (fs.existsSync(dependency)) return dependency;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

/**
 * Discover the real npm global node_modules directory at runtime.
 *
 * Why this exists (Issue #33): on Windows, pi may be installed somewhere
 * other than %APPDATA%\npm — e.g. nvm-windows puts the global node_modules
 * under %NVM_HOME%/<version>/node_modules, Volta under
 * %LOCALAPPDATA%\Volta, fnm under %LOCALAPPDATA%\fnm_multishells. The static
 * %APPDATA%\npm paths in resolvePiCliScript() miss all of those, and the
 * fallback spawn("pi") then fails with ENOENT because child_process.spawn does
 * NOT do PATHEXT resolution on Windows (only exec/execSync via cmd.exe do).
 *
 * `npm root -g` is the canonical way to find the global node_modules dir and
 * works across every npm-based install layout. We run it via execSync, which
 * DOES resolve `npm.cmd` through PATHEXT. Capped at 5s; any failure (npm not
 * on PATH, slow start, etc.) just falls through to the other resolution roots.
 *
 * Memoized: the npm global root does not change during a process lifetime, so
 * this is a one-time ~200ms cost rather than per-worker.
 *
 * @internal — exported for unit-test injection via __setNpmGlobalRootForTest.
 */
let cachedNpmGlobalRoot: string | undefined | null = null;
export function resolveNpmGlobalRoot(): string | undefined {
	if (cachedNpmGlobalRoot !== null) {
		return cachedNpmGlobalRoot ?? undefined;
	}
	let resolved: string | undefined;
	try {
		const out = execSync("npm root -g", {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"], // suppress npm's stderr chatter
			windowsHide: true,
		}).trim();
		resolved = out.length > 0 ? out : undefined;
	} catch {
		resolved = undefined;
	}
	cachedNpmGlobalRoot = resolved ?? null;
	return resolved;
}

/**
 * Given an npm global node_modules root, derive the candidate package dirs for
 * each supported pi scope. Pure + exported so the mapping is unit-testable
 * without spawning npm.
 * @internal
 */
export function buildNpmGlobalPackageDirs(npmGlobalRoot: string): string[] {
	return PI_PACKAGE_NAMES.map((pkgName) => path.join(npmGlobalRoot, ...pkgName.split("/")));
}

/** @internal — test hook: inject a fake global root (or undefined) and reset the memo. */
export function __setNpmGlobalRootForTest(root: string | undefined): void {
	cachedNpmGlobalRoot = root ?? null;
}

function resolvePiCliScript(): string | undefined {
	const argv1 = process.argv[1];
	if (argv1) {
		const argvPath = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
		if (isRunnableNodeScript(argvPath)) return argvPath;
	}

	// npm-global package dirs derived from `npm root -g` — placed BEFORE the
	// %APPDATA%\npm static paths and the cwd/import.meta fallbacks so that a pi
	// install under nvm-windows / Volta / fnm is found even when %APPDATA%\npm
	// doesn't contain it. Covers Issue #33.
	const npmGlobalRoot = resolveNpmGlobalRoot();
	const npmGlobalDirs = npmGlobalRoot ? buildNpmGlobalPackageDirs(npmGlobalRoot) : [];

	const roots = [
		resolvePiPackageRoot(),
		...npmGlobalDirs,
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent") : undefined,
		process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@mariozechner", "pi-coding-agent") : undefined,
		path.dirname(fileURLToPath(import.meta.url)),
		process.cwd(),
	].filter((entry): entry is string => Boolean(entry));

	for (const root of roots) {
		const packageJsonPath = root.endsWith("package.json") ? root : findPiPackageJsonFrom(root) ?? path.join(root, "package.json");
		const script = packageBinScript(packageJsonPath);
		if (script) return script;
	}
	return undefined;
}

function validateExplicitBin(explicit: string): string | undefined {
	const resolved = path.resolve(explicit);
	if (!fs.existsSync(resolved)) return undefined;
	// Reject paths outside allowed safe prefixes
	if (!isWithinAllowedPrefixes(resolved)) {
		throw new Error(
			`PI_TEAMS_PI_BIN path '${resolved}' is outside allowed prefixes. ` +
			`Allowed: npm global bin, project node_modules/.bin, APPDATA/npm, or process execPath directory.`,
		);
	}
	// Reject if symlink points outside expected directories
	try {
		const real = fs.realpathSync(resolved);
		if (!isWithinAllowedPrefixes(real)) {
			throw new Error(
				`PI_TEAMS_PI_BIN symlink target '${real}' is outside allowed prefixes.`,
			);
		}
	} catch (e) {
		if (e instanceof Error && e.message.includes("allowed prefixes")) throw e;
		console.error("[pi-spawn] validateExplicitBin: unexpected realpathSync error:", e);
		return undefined;
	}
	return resolved;
}

export function getPiSpawnCommand(args: string[]): PiSpawnCommand {
	const explicit = process.env.PI_TEAMS_PI_BIN?.trim();
	if (explicit) {
		const validated = validateExplicitBin(explicit);
		if (validated) {
			if (isRunnableNodeScript(validated)) return { command: process.execPath, args: [validated, ...args] };
			return { command: validated, args };
		}
	}
	if (process.platform === "win32") {
		// Windows: resolve via resolvePiCliScript to find the bundled .js entry point
		const script = resolvePiCliScript();
		if (script) return { command: process.execPath, args: [script, ...args] };
	}
	// Linux/macOS: also resolve the full path so child processes can find 'pi' even if
	// PATH is minimal (e.g. in detached background-runner processes). Fall back to "pi"
	// only if resolution fails.
	const script = resolvePiCliScript();
	if (script) return { command: process.execPath, args: [script, ...args] };
	return { command: "pi", args };
}
