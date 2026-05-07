import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function validateBlobHash(hash: string): void {
	if (!SHA256_HEX.test(hash)) throw new Error(`Invalid blob hash: ${hash}`);
}

const BLOBS_DIR = "blobs";
const BLOB_META_DIR = "blob-metadata";
const SHA256_PREFIX = "sha256";

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
	const content = typeof input.content === "string" ? input.content : input.content;
	const hash = sha256Of(content);
	const algorithm = SHA256_PREFIX;
	const blobDir = path.join(artifactsRoot, BLOBS_DIR, algorithm);
	const metaDir = path.join(artifactsRoot, BLOB_META_DIR);
	fs.mkdirSync(blobDir, { recursive: true });
	fs.mkdirSync(metaDir, { recursive: true });

	const blobPath = path.join(blobDir, hash);
	if (!fs.existsSync(blobPath)) {
		fs.writeFileSync(blobPath, content, typeof input.content === "string" ? "utf-8" : undefined);
	}

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
	fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

	return { hash, algorithm, blobPath: resolveRealContainedPath(artifactsRoot, blobPath), metadataPath: resolveRealContainedPath(artifactsRoot, metadataPath), sizeBytes: metadata.sizeBytes };
}

/**
 * Read a content-addressed blob by hash.
 * Validates hash format and enforces path containment.
 */
export function readBlob(artifactsRoot: string, hash: string): Buffer | undefined {
	validateBlobHash(hash);
	const blobDir = path.join(artifactsRoot, BLOBS_DIR, SHA256_PREFIX);
	const blobPath = resolveRealContainedPath(blobDir, hash);
	return fs.readFileSync(blobPath);
}

/**
 * Read blob metadata by hash.
 * Validates hash format and enforces path containment.
 */
export function readBlobMetadata(artifactsRoot: string, hash: string): BlobMetadata | undefined {
	validateBlobHash(hash);
	const metaDir = path.join(artifactsRoot, BLOB_META_DIR);
	const metaPath = resolveRealContainedPath(metaDir, `${hash}.json`);
	return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BlobMetadata;
}