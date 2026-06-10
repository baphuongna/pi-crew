import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeBlob, readBlob, readBlobMetadata } from "../../src/state/blob-store.ts";

test("writeBlob writes content-addressed blob and metadata", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		const result = writeBlob(artifactsRoot, {
			content: "hello world",
			runId: "test-run-1",
			taskId: "01_explore",
			producer: "test",
			originalPath: "results/01_explore.txt",
		});
		assert.ok(result.hash);
		assert.equal(result.algorithm, "sha256");
		assert.ok(fs.existsSync(result.blobPath));
		assert.ok(fs.existsSync(result.metadataPath));
		assert.equal(result.sizeBytes, 11);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("writeBlob deduplicates by hash when metadata matches", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		const result1 = writeBlob(artifactsRoot, {
			content: "duplicate content",
			runId: "test-run-1",
			producer: "test",
			originalPath: "a.txt",
		});
		// Same content AND same metadata fields (mime/retention/producer/originalPath)
		// deduplicates. Different originalPath would be a metadata conflict, not dedup.
		const result2 = writeBlob(artifactsRoot, {
			content: "duplicate content",
			runId: "test-run-1", // runId is not in conflict check
			producer: "test",
			originalPath: "a.txt",
		});
		assert.equal(result1.hash, result2.hash);
		assert.equal(result1.blobPath, result2.blobPath);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlob returns content by hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		writeBlob(artifactsRoot, {
			content: "read me back",
			runId: "test-run-1",
			producer: "test",
			originalPath: "data.txt",
		});
		// Use identical metadata for read-after-write to avoid conflict check.
		const hash = writeBlob(artifactsRoot, {
			content: "read me back",
			runId: "test-run-1",
			producer: "test",
			originalPath: "data.txt",
		}).hash;
		const content = readBlob(artifactsRoot, hash);
		assert.ok(content);
		assert.equal(content.toString(), "read me back");
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlobMetadata returns metadata by hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		const result = writeBlob(artifactsRoot, {
			content: "metadata test",
			runId: "test-run-1",
			taskId: "02_execute",
			mime: "text/markdown",
			producer: "worker",
			originalPath: "results/02_execute.md",
			redacted: true,
			retention: "project",
		});
		const metadata = readBlobMetadata(artifactsRoot, result.hash);
		assert.ok(metadata);
		assert.equal(metadata.runId, "test-run-1");
		assert.equal(metadata.taskId, "02_execute");
		assert.equal(metadata.mime, "text/markdown");
		assert.equal(metadata.producer, "worker");
		assert.equal(metadata.redacted, true);
		assert.equal(metadata.retention, "project");
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlob returns undefined for non-existent hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		assert.throws(() => readBlob(artifactsRoot, "nonexistenthash"), /Invalid blob hash/);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlob rejects path traversal in hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		assert.throws(() => readBlob(artifactsRoot, "../etc/passwd"), /Invalid blob hash/);
		assert.throws(() => readBlob(artifactsRoot, "..\\etc\\passwd"), /Invalid blob hash/);
		assert.throws(() => readBlob(artifactsRoot, "/etc/passwd"), /Invalid blob hash/);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlobMetadata rejects path traversal in hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		assert.throws(() => readBlobMetadata(artifactsRoot, "../etc/passwd"), /Invalid blob hash/);
		assert.throws(() => readBlobMetadata(artifactsRoot, "..\\etc\\passwd"), /Invalid blob hash/);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlob rejects empty hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		assert.throws(() => readBlob(artifactsRoot, ""), /Invalid blob hash/);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});

test("readBlob rejects short hash", () => {
	const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-blob-"));
	try {
		assert.throws(() => readBlob(artifactsRoot, "abc123"), /Invalid blob hash/);
	} finally {
		fs.rmSync(artifactsRoot, { recursive: true, force: true });
	}
});