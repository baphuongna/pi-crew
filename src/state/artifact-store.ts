import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactDescriptor } from "./types.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { redactSecretString, redactSecrets } from "../utils/redaction.ts";

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export const CLEANUP_MARKER_FILE = ".last-cleanup";

export interface ArtifactWriteOptions {
	kind: ArtifactDescriptor["kind"];
	relativePath: string;
	content: string;
	producer: string;
	retention?: ArtifactDescriptor["retention"];
}

export interface ArtifactCleanupOptions {
	maxAgeDays: number;
	maxAgeMs?: number;
	markerFile?: string;
	scanGraceMs?: number;
}

function parseAgeDays(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function nowMs(): number {
	return Date.now();
}

function readMarkerMtime(artifactsRoot: string, markerFile: string): number | undefined {
	try {
		return fs.statSync(path.join(artifactsRoot, markerFile)).mtimeMs;
	} catch {
		return undefined;
	}
}

function shouldCleanup(artifactsRoot: string, markerFile: string, scanGraceMs: number): boolean {
	const marker = readMarkerMtime(artifactsRoot, markerFile);
	if (marker === undefined) return true;
	return nowMs() - marker >= scanGraceMs;
}

export function writeCleanupMarker(artifactsRoot: string, markerFile: string): void {
	fs.mkdirSync(artifactsRoot, { recursive: true });
	atomicWriteFile(path.join(artifactsRoot, markerFile), String(nowMs()));
}

export function cleanupOldArtifacts(artifactsRoot: string, options: ArtifactCleanupOptions): void {
	if (!fs.existsSync(artifactsRoot)) return;
	const maxAgeDays = parseAgeDays(options.maxAgeDays);
	if (maxAgeDays === undefined) return;
	const markerFile = options.markerFile ?? CLEANUP_MARKER_FILE;
	const scanGraceMs = options.scanGraceMs ?? 24 * 60 * 60 * 1000;
	if (!shouldCleanup(artifactsRoot, markerFile, scanGraceMs)) return;
	const maxAgeMs = options.maxAgeMs ?? maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = nowMs() - maxAgeMs;
	let didCleanup = false;
	try {
		// FIX: Use { withFileTypes: true } to get Dirent objects (with isDirectory/isFile
		// info), avoiding the need for a separate statSync per entry just to check the
		// type. We still need statSync for mtime, but only on entries that passed the
		// marker-file and symlink filters.
		const entries = fs.readdirSync(artifactsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === markerFile) continue;
			if (entry.isSymbolicLink()) continue; // skip symlinks — could escape artifactsRoot
			const target = path.join(artifactsRoot, entry.name);
			try {
				const stat = fs.statSync(target);
				if (stat.mtimeMs >= cutoff) continue;
				// Use Dirent info instead of stat.isDirectory() to save a stat call
				if (entry.isDirectory()) {
					fs.rmSync(target, { recursive: true, force: true });
				} else {
					fs.unlinkSync(target);
				}
				didCleanup = true;
			} catch {
				// Ignore cleanup races and permission issues in best-effort mode.
			}
		}
		writeCleanupMarker(artifactsRoot, markerFile);
	} catch {
		// Ignore unreadable roots in best-effort mode.
	}
	if (!didCleanup) writeCleanupMarker(artifactsRoot, markerFile);
}

function resolveInside(baseDir: string, relativePath: string): string {
	// Check if baseDir is a symlink on every call to prevent symlink attacks
	try {
		if (fs.lstatSync(baseDir).isSymbolicLink()) throw new Error(`Artifacts root is a symbolic link — not allowed: ${baseDir}`);
	} catch (err) {
		// If lstatSync fails because baseDir doesn't exist yet, that's fine —
		// it will be created by writeArtifact. Any other error should propagate.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalizedRelativePath || normalizedRelativePath.split("/").some((segment) => segment === "..") || path.isAbsolute(normalizedRelativePath)) {
		throw new Error(`Invalid artifact path: ${relativePath}`);
	}
	// Use resolveRealContainedPath to resolve symlinks before checking containment,
	// preventing TOCTOU attacks where intermediate directories are replaced with symlinks.
	return resolveRealContainedPath(baseDir, normalizedRelativePath);
}

export function writeArtifact(artifactsRoot: string, options: ArtifactWriteOptions): ArtifactDescriptor {
	// FIX: Create the artifactsRoot BEFORE calling resolveInside/resolveRealContainedPath,
	// which open() the path to validate symlinks (fails with ENOENT if not yet created).
	// Also reject symlinks in baseDir at this point (catches both pre-existing symlinks
	// and the case where baseDir was created by mkdirSync as a regular dir).
	fs.mkdirSync(artifactsRoot, { recursive: true });
	if (fs.lstatSync(artifactsRoot).isSymbolicLink()) {
		throw new Error(`Artifacts root is a symbolic link — not allowed: ${artifactsRoot}`);
	}
	const filePath = resolveInside(artifactsRoot, options.relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	resolveRealContainedPath(artifactsRoot, path.dirname(filePath));
	let content = options.content;
	// Structural JSON redaction first — catches quoted-JSON secrets
	// ("api_key":"sk-...") and nested keys that flat redactSecretString misses.
	// The flat scan below still catches free-text patterns (Bearer/JWT/Auth
	// headers) that may live inside JSON string values. See security review M2.
	const trimmed = content.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(content);
			content = JSON.stringify(redactSecrets(parsed));
		} catch {
			// not valid JSON — fall through to flat redaction only
		}
	}
	content = redactSecretString(content);
	atomicWriteFile(filePath, content);
	// Compute hash on written bytes for integrity verification.
	// Read back the actual file content to handle atomicWrite fallback path
	// where the written content might differ from the input (e.g., concurrent writes).
	const writtenContent = fs.readFileSync(filePath, "utf-8");
	const contentHash = hashContent(writtenContent);
	const stats = fs.statSync(filePath);
	return {
		kind: options.kind,
		path: filePath,
		createdAt: new Date().toISOString(),
		producer: options.producer,
		sizeBytes: stats.size,
		contentHash,
		retention: options.retention ?? "run",
	};
}
