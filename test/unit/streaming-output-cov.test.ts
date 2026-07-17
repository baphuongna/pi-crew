import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { createStreamingOutput, readStreamingOutput } from "../../src/runtime/streaming-output.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(artifactsRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-stream-test",
		team: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp",
		stateRoot: "/tmp/state",
		artifactsRoot,
		tasksPath: "/tmp/tasks",
		eventsPath: "/tmp/events",
		artifacts: [],
	};
}

describe("createStreamingOutput", () => {
	it("creates a handle and flushes on close", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			const handle = createStreamingOutput(manifest, "task_01");
			handle.write("hello ");
			handle.write("world");
			handle.close();
			const content = readStreamingOutput(manifest, "task_01");
			assert.equal(content, "hello world");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("getPath returns expected file path", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			const handle = createStreamingOutput(manifest, "task_01");
			const p = handle.getPath();
			assert.ok(p.includes("streaming"));
			assert.ok(p.endsWith("task_01.md"));
			handle.close();
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("throws on invalid taskId", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			assert.throws(() => createStreamingOutput(manifest, "../evil"), /Invalid taskId/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("write after close is a no-op", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			const handle = createStreamingOutput(manifest, "task_02");
			handle.write("before");
			handle.close();
			handle.write("after-close"); // should be ignored
			const content = readStreamingOutput(manifest, "task_02");
			assert.equal(content, "before");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("flushes buffer when content exceeds 4096 bytes", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			const handle = createStreamingOutput(manifest, "task_03");
			// Write >4096 chars to trigger auto-flush (buffer check is > 4096)
			const bigChunk = "x".repeat(2048);
			handle.write(bigChunk);
			handle.write(bigChunk);
			handle.write("extra"); // 2048 + 2048 + 5 = 4101 > 4096 triggers flush
			const p = handle.getPath();
			assert.ok(fs.existsSync(p), "file should exist after auto-flush");
			handle.close();
			const content = readStreamingOutput(manifest, "task_03");
			assert.equal(content.length, 4101);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("readStreamingOutput", () => {
	it("returns empty string for invalid taskId", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			assert.equal(readStreamingOutput(manifest, "../bad"), "");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns empty string when file does not exist", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			assert.equal(readStreamingOutput(manifest, "nonexistent_task"), "");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("reads content written by createStreamingOutput", () => {
		const tmp = createTrackedTempDir("pi-crew-stream-");
		try {
			const manifest = makeManifest(tmp);
			const handle = createStreamingOutput(manifest, "task_read");
			handle.write("test content");
			handle.close();
			assert.equal(readStreamingOutput(manifest, "task_read"), "test content");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
