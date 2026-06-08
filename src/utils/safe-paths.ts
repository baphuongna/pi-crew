import * as fs from "node:fs";
import * as path from "node:path";

export function isSafePathId(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(value);
}

export function assertSafePathId(kind: string, value: string): string {
	if (!isSafePathId(value)) throw new Error(`Invalid ${kind}: ${value}`);
	return value;
}

export function resolveContainedPath(baseDir: string, targetPath: string): string {
	if (targetPath.includes('\0')) {
		throw new Error(`Security: path contains null byte`);
	}
	const base = path.resolve(baseDir);
	const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(base, targetPath);
	const relative = path.relative(base, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside ${baseDir}: ${targetPath}`);
	return resolved;
}

/**
 * Resolve a target path to its real (symlink-resolved) absolute path while
 * guaranteeing the result stays inside `baseDir`.
 *
 * ## Security model — asymmetric ancestor handling
 *
 * `baseDir` and `targetPath` are validated with different policies because
 * they play different roles:
 *
 * - **baseDir** (the container): all ancestors MUST exist and MUST NOT be
 *   symlinks. We refuse to operate if any component is missing or symlinked,
 *   because a symlinked container could point the caller outside the
 *   intended trust boundary (e.g. `/var/run -> /run` resolving into an
 *   attacker-controlled directory).
 *
 * - **targetPath** (the contained file): the FINAL component may be
 *   non-existent (for write operations creating a new file) and EXISTING
 *   ancestors of the target may also be missing. We DO require that any
 *   ancestor that DOES exist must not be a symlink — an attacker who can
 *   create a directory in the container must not be able to redirect the
 *   file being created.
 *
 * This asymmetry is intentional: callers that need to create a new file
 * pass a non-existent targetPath. Callers that operate on an existing file
 * get full symlink protection. Callers MUST NOT pass a symlinked
 * intermediate component; if you need to, use `resolveContainedPath`
 * instead (which only checks the resolved path, not the chain).
 *
 * Throws on:
 *   - null byte in targetPath
 *   - targetPath resolves outside baseDir
 *   - any existing ancestor (base or target) is a symlink
 *   - baseDir itself does not exist
 *
 * Returns the resolved real path on success, or the resolved (but not
 * realpathed) path when the target does not exist yet.
 *
 * NOTE: There is a race condition window between validation and use where an
 * attacker could create a directory component after validation but before the
 * file is created. Callers MUST create parent directories atomically
 * (e.g., mkdirSync with { recursive: true }) or use O_CREAT with O_NOFOLLOW
 * flags in the actual file operation to minimize this window.
 */
export function resolveRealContainedPath(baseDir: string, targetPath: string): string {
	if (targetPath.includes('\0')) {
	  throw new Error(`Security: path contains null byte`);
	}
	const resolved = resolveContainedPath(baseDir, targetPath);
	// Walk the full ancestor chain of baseDir and verify none are symlinks.
	// This must be done BEFORE realpathSync to prevent TOCTOU attacks where
	// an attacker replaces a directory with a symlink between our realpath calls.
	const absoluteBase = path.resolve(baseDir);
	const baseParts = absoluteBase.split(path.sep);
	let accumulated = "";
	if (baseParts[0] === "") accumulated = "/"; // Unix root
	for (let i = 1; i < baseParts.length; i++) {
		if (baseParts[i] === "") continue;
		accumulated = path.join(accumulated, baseParts[i]);
		try {
			const stat = fs.lstatSync(accumulated);
			if (stat.isSymbolicLink()) throw new Error("Refusing to resolve: baseDir ancestor is a symlink: " + accumulated);
		} catch (e) {
			if (e instanceof Error && e.message.includes("symlink")) throw e;
			// Component doesn't exist — cannot validate ancestor chain safely
			throw new Error(`Cannot validate path safety: ancestor does not exist: ${accumulated}`);
		}
	}
	let realBase: string;
	try {
		realBase = fs.realpathSync.native(baseDir);
	} catch (baseError) {
		throw new Error(`Cannot resolve real path of base directory ${baseDir}: ${baseError instanceof Error ? baseError.message : String(baseError)}`);
	}
	// Now walk the full ancestor chain of the resolved target path and verify
	// none are symlinks before calling realpathSync on the target.
	const resolvedParts = resolved.split(path.sep);
	let resolvedAccumulated = "";
	if (resolvedParts[0] === "") resolvedAccumulated = "/"; // Unix root
	for (let i = 1; i < resolvedParts.length; i++) {
		if (resolvedParts[i] === "") continue;
		resolvedAccumulated = path.join(resolvedAccumulated, resolvedParts[i]);
		try {
			const stat = fs.lstatSync(resolvedAccumulated);
			if (stat.isSymbolicLink()) throw new Error("Refusing to resolve: target path ancestor is a symlink: " + resolvedAccumulated);
		} catch (e) {
			if (e instanceof Error && e.message.includes("symlink")) throw e;
			// Component doesn't exist — skip validation for this component.
			// Only existing symlinks are a security risk; non-existent paths
			// will be caught by realpathSync or the caller's filesystem access.
			continue;
		}
	}
	let realTarget: string;
	try {
		realTarget = fs.realpathSync.native(resolved);
	} catch (targetError) {
		if ((targetError as NodeJS.ErrnoException).code === "ENOENT") {
			// Target doesn't exist yet — this is OK for write operations.
			// Return the resolved path so the caller can create the file.
			// We already validated all ancestors are not symlinks above.
			return resolved;
		}
		throw new Error(`Cannot resolve real path of ${resolved}: ${targetError instanceof Error ? targetError.message : String(targetError)}`);
	}
	const relative = path.relative(realBase, realTarget);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside ${baseDir}: ${targetPath}`);
	return realTarget;
}

export function resolveContainedRelativePath(baseDir: string, relativePath: string, kind = "path"): string {
	if (relativePath.includes('\0')) {
		throw new Error(`Security: path contains null byte: ${kind}`);
	}
	const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	// Detect Windows absolute paths (C:\, \\server\share) that path.isAbsolute may miss after normalization
	if (/^[A-Za-z]:/.test(normalized)) throw new Error(`Invalid ${kind}: ${relativePath}`);
	if (!normalized || normalized.split("/").some((segment) => segment === "..") || path.isAbsolute(normalized)) throw new Error(`Invalid ${kind}: ${relativePath}`);
	return resolveContainedPath(baseDir, path.resolve(baseDir, normalized));
}
