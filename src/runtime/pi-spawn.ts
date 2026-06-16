import * as fs from "node:fs";
import * as os from "node:os";
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

function resolvePiCliScript(): string | undefined {
	const argv1 = process.argv[1];
	if (argv1) {
		const argvPath = path.isAbsolute(argv1) ? argv1 : path.resolve(argv1);
		if (isRunnableNodeScript(argvPath)) return argvPath;
	}

	const roots = [
		resolvePiPackageRoot(),
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

function resolveWindowsPiCmd(): string | undefined {
	// On Windows, 'pi' is installed as 'pi.cmd' in the npm global bin directory.
	// Node.js child_process.spawn does NOT auto-append .cmd/.bat from PATHEXT
	// (unlike execSync/exec), and spawning .cmd files directly fails with EINVAL.
	// So we always resolve to the underlying cli.js entry point.
	// See: https://github.com/baphuongna/pi-crew/issues/33
	const appdata = process.env.APPDATA;
	if (!appdata) return undefined;

	const npmGlobalBin = path.join(appdata, "npm");

	// Always resolve the pi-coding-agent cli.js directly
	const cliJs = path.join(
		npmGlobalBin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js",
	);
	if (fs.existsSync(cliJs)) return cliJs;

	// Fallback: try @mariozechner scope
	const cliJs2 = path.join(
		npmGlobalBin, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js",
	);
	if (fs.existsSync(cliJs2)) return cliJs2;

	return undefined;
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

	// On Windows, always resolve via APPDATA first — resolvePiCliScript may fail
	// when pi-crew is loaded as an extension (argv1 doesn't point into pi package).
	if (process.platform === "win32") {
		const winCmd = resolveWindowsPiCmd();
		if (winCmd) return { command: process.execPath, args: [winCmd, ...args] };
	}

	// Linux/macOS (or Windows fallback if APPDATA resolution failed):
	// try resolvePiCliScript, which works when argv1 points into the pi package.
	const script = resolvePiCliScript();
	if (script) return { command: process.execPath, args: [script, ...args] };

	// Final fallback: bare "pi" (works on Linux/macOS with shebang; will fail on Windows).
	return { command: "pi", args };
}
