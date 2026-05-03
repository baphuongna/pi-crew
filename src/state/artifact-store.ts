import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactDescriptor } from "./types.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { redactSecretString } from "../utils/redaction.ts";

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
	fs.writeFileSync(path.join(artifactsRoot, markerFile), String(nowMs()), "utf-8");
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
		const entries = fs.readdirSync(artifactsRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === markerFile) continue;
			const target = path.join(artifactsRoot, entry.name);
			try {
				const stat = fs.statSync(target);
				if (stat.mtimeMs >= cutoff) continue;
				if (stat.isDirectory()) {
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
	const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalizedRelativePath || normalizedRelativePath.split("/").some((segment) => segment === "..") || path.isAbsolute(normalizedRelativePath)) {
		throw new Error(`Invalid artifact path: ${relativePath}`);
	}
	const base = path.resolve(baseDir);
	const resolved = path.resolve(base, normalizedRelativePath);
	const relative = path.relative(base, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid artifact path: ${relativePath}`);
	return resolved;
}

export function writeArtifact(artifactsRoot: string, options: ArtifactWriteOptions): ArtifactDescriptor {
	const filePath = resolveInside(artifactsRoot, options.relativePath);
	fs.mkdirSync(artifactsRoot, { recursive: true });
	if (fs.lstatSync(artifactsRoot).isSymbolicLink()) throw new Error(`Artifacts root is a symbolic link — not allowed: ${artifactsRoot}`);
	resolveRealContainedPath(path.dirname(artifactsRoot), path.basename(artifactsRoot));
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	resolveRealContainedPath(artifactsRoot, path.dirname(filePath));
	// Compute hash on original content for integrity verification.
	const contentHash = hashContent(options.content);
	const content = redactSecretString(options.content);
	atomicWriteFile(filePath, content);
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
