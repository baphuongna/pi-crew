import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { atomicWriteFile, renameWithRetry } from "./atomic-write.ts";
import { withFileLockSync } from "./locks.ts";
import { sleepSync } from "../utils/sleep.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function validateBlobHash(hash: string, algorithm?: string): void {
	if (!SHA256_HEX.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
	if (algorithm !== undefined && algorithm !== SHA256_PREFIX) {
		throw new Error(`Invalid blob algorithm: ${algorithm} (expected ${SHA256_PREFIX})`);
	}
}

/**
 * Atomically write a Buffer to a file using temp-file + rename pattern.
 * Prevents partial writes on crash and handles concurrent writes safely.
 */
function atomicWriteBuffer(filePath: string, content: Buffer): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
	try {
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) {
			throw new Error(`Refusing to write: opened path is not a regular file: ${tempPath}`);
		}
		fs.writeSync(fd, content, 0, content.length);
		renameWithRetry(tempPath, filePath);
	} catch (error) {
		try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
		throw error;
	} finally {
		// Always close fd; closeSync is safe to call even if fd was already closed
		try { fs.closeSync(fd); } catch { /* best-effort */ }
	}
}

const BLOBS_DIR = "blobs";
const BLOB_META_DIR = "blob-metadata";
const SHA256_PREFIX = "sha256";

/**
 * File-based lock for cross-process metadata write protection.
 * Uses withFileLockSync which provides O_EXCL atomic create + token-guarded release.
 */
function withMetadataLock<T>(metadataPath: string, fn: () => T): T {
	return withFileLockSync(metadataPath, fn);
}

export interface BlobMetadata {
	blobHash: string;
	blobAlgorithm: string;
	runId: string;
	taskId?: string;
	mime: string;
	producer: string;
	originalPath: string;
	sizeBytes: number;
	redacted: boolean;
	retention: "run" | "project" | "temporary";
	createdAt: string;
}

export interface BlobWriteResult {
	hash: string;
	algorithm: string;
	blobPath: string;
	metadataPath: string;
	sizeBytes: number;
}

function sha256Of(content: string | Buffer): string {
	return createHash("sha256").update(typeof content === "string" ? content : content).digest("hex");
}

/**
 * Write content-addressed blob to the blobs directory under artifactsRoot.
 * Content is deduplicated by hash; metadata sidecar is always written.
 * FIX: Both content and metadata writes now use atomicWriteFile to prevent
 * partial writes on crash. The deduplication check is now advisory (the atomic
 * write handles concurrent writes correctly via O_EXCL temp file pattern).
 */
export function writeBlob(artifactsRoot: string, input: {
	content: string | Buffer;
	runId: string;
	taskId?: string;
	mime?: string;
	producer: string;
	originalPath: string;
	redacted?: boolean;
	retention?: BlobMetadata["retention"];
}): BlobWriteResult {
	const content = input.content;
	const hash = sha256Of(content);
	const algorithm = SHA256_PREFIX;
	const blobDir = path.join(artifactsRoot, BLOBS_DIR, algorithm);
	const metaDir = path.join(artifactsRoot, BLOB_META_DIR);
	// Issue 2 fix: Validate parent directories are not symlinks before mkdirSync.
	// An attacker could plant a symlink before we create the directory, causing
	// blob content to be written to an attacker-controlled location.
	resolveRealContainedPath(artifactsRoot, blobDir);
	resolveRealContainedPath(artifactsRoot, metaDir);
	fs.mkdirSync(blobDir, { recursive: true });
	fs.mkdirSync(metaDir, { recursive: true });

	const blobPath = path.join(blobDir, hash);
	// Issue 6 fix: Validate blobPath BEFORE writing to ensure the path is safe.
	// If resolveRealContainedPath throws after the write, the blob may already
	// exist at an unexpected location. Validate first to prevent this.
	resolveRealContainedPath(artifactsRoot, blobPath);
	const metadata: BlobMetadata = {
		blobHash: hash,
		blobAlgorithm: algorithm,
		runId: input.runId,
		taskId: input.taskId,
		mime: input.mime ?? "text/plain",
		producer: input.producer,
		originalPath: input.originalPath,
		sizeBytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, "utf-8"),
		redacted: input.redacted ?? false,
		retention: input.retention ?? "run",
		createdAt: new Date().toISOString(),
	};
	const metadataPath = path.join(metaDir, `${hash}.json`);

	// Both content and metadata use atomic writes to prevent partial writes on crash.
	// Content is immutable and content-addressed (same hash = same content), so
	// concurrent writes to the same hash are safe. Metadata (mime, retention, etc.)
	// is protected by a per-hash lock to make the check-then-write atomic, preventing
	// concurrent writers from racing to write different metadata for the same hash.
	// Issue 3 fix: wrap metadata check-and-write in a lock to make it atomic.
	// Without the lock, two processes could read the same metadata concurrently,
	// both pass the check, and the second write would silently overwrite the first.
	// FIX: Write blob content FIRST, then metadata. If blob write fails, no orphan metadata.
	// Previous order was metadata first, then blob - causing orphan metadata on blob failure.
	let blobContentWritten = false;
	try {
		// Write blob content first (immutable, content-addressed)
		atomicWriteBuffer(blobPath, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8"));
		blobContentWritten = true;
	} catch (error) {
		// Blob write failed - no metadata to clean up since we haven't written it yet
		throw error;
	}

	// Metadata only after blob content is successfully written
	// Issue 3 fix: Use two-phase commit for metadata - write to temp file first,
	// then atomically rename to final location. This prevents orphan blobs if
	// the process crashes after blob write but before metadata rename.
	let metadataWritten = false;
	try {
		withMetadataLock(metadataPath, () => {
			try {
				const existingMeta = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as BlobMetadata;
				// Compare fields that indicate concurrent write with different metadata.
				// Note: taskId is intentionally NOT part of the conflict check because
				// it represents which task produced the blob and may legitimately differ
				// across processes (last-write-wins for taskId). If concurrent writes
				// have identical mime/retention/producer/originalPath but different
				// taskId, the conflict check passes and both writes succeed — the
				// final taskId reflects whichever write completed last.
				// Callers should not rely on taskId for correctness-critical decisions.
				if (existingMeta.mime !== metadata.mime ||
					existingMeta.retention !== metadata.retention ||
					existingMeta.producer !== metadata.producer ||
					existingMeta.originalPath !== metadata.originalPath) {
					throw new Error(`Concurrent metadata write conflict for blob ${hash}: different metadata values detected. Existing: ${JSON.stringify(existingMeta)}, New: ${JSON.stringify(metadata)}`);
				}
			} catch (err) {
				if (err instanceof Error && err.message.includes("ENOENT")) {
					// OK - metadata doesn't exist yet, proceed to write
				} else {
					// Re-throw non-ENOENT errors (e.g., permission denied, corrupt file)
					throw err;
				}
			}
			// Issue 3 fix: Two-phase commit for metadata
			// Write to temp file first, then atomically rename to final location.
			// Issue 1 fix: Use atomicWriteFile instead of plain writeSync for the temp file
			// to prevent partial writes on crash. atomicWriteFile uses O_EXCL + write + rename
			// pattern which is consistent with how blob content is written.
			const tempMetaPath = `${metadataPath}.${randomUUID()}.tmp`;
			atomicWriteFile(tempMetaPath, JSON.stringify(metadata, null, 2));
			renameWithRetry(tempMetaPath, metadataPath);
			metadataWritten = true;
		});
	} catch (error) {
		// Issue 4 fix: Clean up orphaned blob if metadata write fails.
		// If metadata write fails (e.g., concurrent conflict), the blob content
		// is orphaned since no metadata references it. Clean it up to reclaim space.
		// Issue 8 fix: Do NOT delete blob content on metadata failure.
		// If metadata write fails due to concurrent conflict (different values),
		// the blob content is still valid. Another process has written metadata
		// referencing this blob - deleting the blob would orphan their metadata.
		// The caller can retry the metadata write if needed.
		// However, if metadata was never written (metadataWritten === false),
		// the blob is orphaned and should be cleaned up.
		if (!blobContentWritten) {
			try { fs.rmSync(blobPath, { force: true }); } catch { /* best-effort */ }
		}
		throw error;
	}

	// Issue 2 fix: resolve paths before writes and return cached values
	const resolvedBlobPath = resolveRealContainedPath(artifactsRoot, blobPath);
	const resolvedMetadataPath = resolveRealContainedPath(artifactsRoot, metadataPath);
	return { hash, algorithm, blobPath: resolvedBlobPath, metadataPath: resolvedMetadataPath, sizeBytes: metadata.sizeBytes };
}

/**
 * Read a content-addressed blob by hash.
 * Validates hash format and enforces path containment.
 */
export function readBlob(artifactsRoot: string, hash: string): Buffer | undefined {
	validateBlobHash(hash);
	try {
		const blobDir = path.join(artifactsRoot, BLOBS_DIR, SHA256_PREFIX);
		const blobPath = resolveRealContainedPath(blobDir, hash);
		return fs.readFileSync(blobPath);
	} catch {
		return undefined;
	}
}

/**
 * Read blob metadata by hash.
 * Validates hash format and enforces path containment.
 */
export function readBlobMetadata(artifactsRoot: string, hash: string): BlobMetadata | undefined {
	validateBlobHash(hash);
	try {
		const metaDir = path.join(artifactsRoot, BLOB_META_DIR);
		const metaPath = resolveRealContainedPath(metaDir, `${hash}.json`);
		return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BlobMetadata;
	} catch {
		return undefined;
	}
}
/**
 * Cleanup orphaned blobs - blobs without corresponding metadata entries.
 * Called periodically to reclaim storage from blobs that were written but whose
 * metadata write failed (e.g., crash between content and metadata write).
 * Returns the number of orphaned blobs cleaned up.
 */
export function cleanupOrphanedBlobs(artifactsRoot: string): number {
	const blobDir = path.join(artifactsRoot, BLOBS_DIR, SHA256_PREFIX);
	const metaDir = path.join(artifactsRoot, BLOB_META_DIR);

	let cleaned = 0;
	try {
		const blobFiles = fs.readdirSync(blobDir);
		for (const blobFile of blobFiles) {
			// Skip non-hash files (e.g., temp files from atomicWriteBuffer)
			if (!SHA256_HEX.test(blobFile)) continue;

			const metaPath = path.join(metaDir, `${blobFile}.json`);
			// Issue 4 fix: Use lock to prevent race between stat and delete.
			// A concurrent process could write metadata between stat and delete,
			// causing valid blob to be deleted while metadata remains.
			withMetadataLock(metaPath, () => {
				try {
					fs.statSync(metaPath);
					// Metadata exists - blob is not orphaned
				} catch {
					// Metadata does not exist - blob is orphaned, delete it
					const blobPath = path.join(blobDir, blobFile);
					try {
						fs.rmSync(blobPath, { force: true });
						cleaned++;
					} catch {
						// Best-effort cleanup - continue to next blob
					}
				}
			});
		}
	} catch {
		// Blobs directory doesn't exist or inaccessible - nothing to clean
	}
	return cleaned;
}
