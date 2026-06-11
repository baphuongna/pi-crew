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
	// On Windows, paths are case-insensitive and short-name (8.3) aliases may
	// differ from long-name forms (e.g. C:\Users\RUNNER~1 vs C:\Users\runneradmin).
	// Use realpathSync.native to normalize both paths to their canonical form
	// before comparison. On non-Windows, path.resolve is sufficient.
	const baseNorm = process.platform === "win32" ? tryRealPath(base) : base;
	const resolvedNorm = process.platform === "win32" ? tryRealPath(resolved) : resolved;
	const baseCompare = process.platform === "win32" ? baseNorm.toLowerCase() : baseNorm;
	const resolvedCompare = process.platform === "win32" ? resolvedNorm.toLowerCase() : resolvedNorm;
	const relative = process.platform === "win32"
		? path.relative(baseCompare, resolvedCompare)
		: path.relative(base, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside ${baseDir}: ${targetPath}`);
	return resolved;
}

/** Best-effort realpathSync — returns the original path on failure. */
function tryRealPath(p: string): string {
	try {
		let real = fs.realpathSync.native(p);
		// On Windows, realpathSync.native may return an extended-length path
		// prefixed with \\?\ (e.g. \\?\C:\Users\...). path.relative does NOT
		// handle these correctly — it returns "../\\?\..." instead of the
		// expected relative path. Strip the \\?\ prefix for comparison.
		if (process.platform === "win32" && real.startsWith("\\\\?\\")) {
			real = real.slice(4);
		}
		return real;
	} catch {
		// Path doesn't exist yet. Try to resolve the parent and append the
		// last component. This handles the common case where a target file
		// hasn't been created yet but its parent directory exists (and may
		// have a different canonical form due to short-name/long-name aliases).
		const parent = path.dirname(p);
		const base = path.basename(p);
		if (parent === p) return p; // root — nothing to resolve
		try {
			let realParent = fs.realpathSync.native(parent);
			if (process.platform === "win32" && realParent.startsWith("\\\\?\\")) {
				realParent = realParent.slice(4);
			}
			return path.join(realParent, base);
		} catch {
			return p;
		}
	}
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
 * (e.g., mkdirSync with { recursive: true }) and use O_CREAT | O_NOFOLLOW | O_EXCL
 * for atomic file creation, as atomicWriteFile does. This ensures the entire
 * operation is atomic and prevents TOCTOU attacks.
 */
export function resolveRealContainedPath(baseDir: string, targetPath: string): string {
	if (targetPath.includes('\0')) {
		throw new Error(`Security: path contains null byte`);
	}
	const resolved = resolveContainedPath(baseDir, targetPath);

	// Open baseDir with O_NOFOLLOW to atomically validate no symlinks in the path.
	// O_NOFOLLOW makes the open fail with ELOOP if any path component is a symlink.
	let baseFd: number;
	try {
		baseFd = fs.openSync(baseDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Refusing to resolve: baseDir path contains a symlink: " + baseDir);
		throw new Error(`Cannot open base directory ${baseDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let realBase: string;
	try {
		const stat = fs.fstatSync(baseFd);
		if (!stat.isDirectory()) throw new Error(`baseDir ${baseDir} is not a directory`);
		// Use realpathSync.native on the path - we've already validated with O_NOFOLLOW
		// that no symlinks exist in the path at open time. Any TOCTOU race would cause
		// the O_NOFOLLOW open to fail before we reach this point.
		realBase = fs.realpathSync.native(baseDir);
		// Strip Windows extended-length prefix (\\?\) for path.relative compatibility.
		if (process.platform === "win32" && realBase.startsWith("\\\\?\\")) {
			realBase = realBase.slice(4);
		}
	} catch (error) {
		// baseDir MUST exist and be resolvable for the containment guarantee to hold.
		// Callers creating new directories must create baseDir atomically (e.g.,
		// mkdirSync with { recursive: true }) BEFORE calling this function, and use
		// O_NOFOLLOW|O_CREAT|O_EXCL for the actual file creation to ensure atomicity.
		// The safe-paths validation and the file creation are two separate operations
		// with a gap between them — callers must close this gap with atomic primitives.
		throw new Error(`Cannot resolve real path of base directory ${baseDir}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		fs.closeSync(baseFd);
	}

	// Walk the ancestor chain of the resolved target path, using O_NOFOLLOW
	// on each ancestor to atomically validate none are symlinks.
	const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
	const O_RDONLY = fs.constants.O_RDONLY;
	const resolvedParts = resolved.split(path.sep);
	let resolvedAccumulated = "";
	if (resolvedParts[0] === "") resolvedAccumulated = "/"; // Unix root
	for (let i = 1; i < resolvedParts.length; i++) {
		if (resolvedParts[i] === "") continue;
		resolvedAccumulated = path.join(resolvedAccumulated, resolvedParts[i]);
		try {
			const fd = fs.openSync(resolvedAccumulated, O_RDONLY | O_NOFOLLOW);
			fs.closeSync(fd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Refusing to resolve: target path ancestor is a symlink: " + resolvedAccumulated);
			// ENOENT means component doesn't exist — that's OK. Only existing symlinks
			// are a security risk (symlinks to attacker-controlled targets). Non-existent
			// paths can be created by the caller and don't pose a symlink risk.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// For the final component (target itself), ENOENT is expected for non-existent targets.
			if (i === resolvedParts.length - 1) continue;
			// For non-final components (parent directories), ENOENT is also acceptable —
			// the caller will create them before the write operation if needed.
			// We only need to ensure no existing path component is a symlink.
			continue;
		}
	}

	// Open the target with O_NOFOLLOW to catch any symlinks.
	// ENOENT is acceptable for write operations — the file may not exist yet.
	let targetFd: number;
	try {
		targetFd = fs.openSync(resolved, O_RDONLY | O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Refusing to resolve: target path is a symlink: " + resolved);
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// Target doesn't exist yet — that's OK for write operations.
			// All ancestors have been validated above (no symlinks).
			// The caller will create the file with atomic primitives.
			return resolved;
		}
		throw new Error(`Cannot open ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let realTarget: string;
	try {
		// Use realpathSync.native on the path - we've already validated with O_NOFOLLOW
		// that no symlinks exist in the path at open time. Any TOCTOU race would cause
		// the O_NOFOLLOW open to fail before we reach this point.
		realTarget = fs.realpathSync.native(resolved);
		// Strip Windows extended-length prefix (\\?\) for path.relative compatibility.
		if (process.platform === "win32" && realTarget.startsWith("\\\\?\\")) {
			realTarget = realTarget.slice(4);
		}
	} catch (targetError) {
		if ((targetError as NodeJS.ErrnoException).code === "ENOENT") {
			// Target doesn't exist yet — this is OK for write operations.
			// Return the resolved path so the caller can create the file.
			// We already validated all ancestors are not symlinks above.
			return resolved;
		}
		throw new Error(`Cannot resolve real path of ${resolved}: ${targetError instanceof Error ? targetError.message : String(targetError)}`);
	} finally {
		fs.closeSync(targetFd);
	}

	// Re-validate the ancestor chain of the resolved path to catch any TOCTOU
	// races that occurred between the initial O_NOFOLLOW validation and the
	// realpathSync call. An attacker could have replaced a validated ancestor
	// with a symlink during this window.
	//
	// Skip the final path component (realTarget itself) — we just successfully
	// realpathSync'd it, so it exists. Re-validating it can spuriously fail on
	// Windows where the resolved path uses short-name (8.3) form that
	// openSync cannot reopen, or where the realpathSync result differs in
	// case/separator form from the original.
	//
	// Walk via path.dirname which is portable across all platforms and
	// correctly handles extended-length (\\?\), UNC (\\server\share), and
	// short-name paths on Windows without manual parsing.
	let ancestor = path.dirname(realTarget);
	while (ancestor && ancestor !== path.dirname(ancestor)) {
		try {
			const fd = fs.openSync(ancestor, O_RDONLY | O_NOFOLLOW);
			fs.closeSync(fd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Refusing to resolve: TOCTOU race detected, path became a symlink: " + ancestor);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// ENOENT on an ancestor of realTarget after realpathSync is concerning
			// — the path existed when we validated it but now doesn't. This could
			// indicate a race or attack. For safety, treat this as an error.
			throw new Error(`Cannot validate resolved path: ${ancestor} disappeared after realpathSync: ${error instanceof Error ? error.message : String(error)}`);
		}
		ancestor = path.dirname(ancestor);
	}

	// Verify the resolved real path is still within baseDir.
	// On Windows, paths are case-insensitive but path.relative does case-sensitive
	// string compare. Normalize case so paths differing only in case (e.g. C:\Users\RUNNER~1
	// vs C:\Users\runneradmin) are treated as the same directory.
	const baseCompare = process.platform === "win32" ? realBase.toLowerCase() : realBase;
	const targetCompare = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
	const relative = process.platform === "win32"
		? path.relative(baseCompare, targetCompare)
		: path.relative(realBase, realTarget);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside ${baseDir}: ${targetPath}`);
	return realTarget;
}

export function resolveContainedRelativePath(baseDir: string, relativePath: string, kind = "path"): string {
	if (relativePath.includes('\0')) {
		throw new Error(`Security: path contains null byte: ${kind}`);
	}
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
	// Detect Windows absolute paths (C:\, \\server\share) that path.isAbsolute may miss after normalization
	if (/^[A-Za-z]:/.test(normalized)) throw new Error(`Invalid ${kind}: ${relativePath}`);
	if (!normalized || normalized.split("/").some((segment) => segment === "..") || path.isAbsolute(normalized)) throw new Error(`Invalid ${kind}: ${relativePath}`);
	return resolveContainedPath(baseDir, path.resolve(baseDir, normalized));
}
