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

export function resolveRealContainedPath(baseDir: string, targetPath: string): string {
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
			throw new Error(`Path does not exist: ${resolved}`);
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
	if (!normalized || normalized.split("/").some((segment) => segment === "..") || path.isAbsolute(normalized)) throw new Error(`Invalid ${kind}: ${relativePath}`);
	return resolveContainedPath(baseDir, path.resolve(baseDir, normalized));
}
