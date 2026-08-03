import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createStreamingOutput, readStreamingOutput } from "../../src/runtime/output/streaming-output.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function tmpManifest(): { dir: string; manifest: TeamRunManifest } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-stream-"));
	return {
		dir,
		manifest: { artifactsRoot: dir } as unknown as TeamRunManifest,
	};
}

test("createStreamingOutput returns handle with correct path pattern", () => {
	const { dir, manifest } = tmpManifest();
	try {
		const handle = createStreamingOutput(manifest, "task-01");
		assert.equal(typeof handle.write, "function");
		assert.equal(typeof handle.close, "function");
		assert.ok(handle.getPath().includes(dir));
		assert.ok(handle.getPath().includes("streaming"));
		assert.ok(handle.getPath().includes("task-01"));
		handle.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("write appends text to file", () => {
	const { dir, manifest } = tmpManifest();
	try {
		const handle = createStreamingOutput(manifest, "task-02");
		handle.write("hello world");
		handle.close();
		assert.equal(readStreamingOutput(manifest, "task-02"), "hello world");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("multiple writes append sequentially", () => {
	const { dir, manifest } = tmpManifest();
	try {
		const handle = createStreamingOutput(manifest, "task-03");
		handle.write("first ");
		handle.write("second ");
		handle.write("third");
		handle.close();
		assert.equal(readStreamingOutput(manifest, "task-03"), "first second third");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("close finalizes file — writes after close are ignored", () => {
	const { dir, manifest } = tmpManifest();
	try {
		const handle = createStreamingOutput(manifest, "task-04");
		handle.write("before close");
		handle.close();
		assert.equal(readStreamingOutput(manifest, "task-04"), "before close");
		handle.write("after close");
		assert.equal(readStreamingOutput(manifest, "task-04"), "before close");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("getPath returns absolute path with streaming/taskId.md", () => {
	const { dir, manifest } = tmpManifest();
	try {
		const handle = createStreamingOutput(manifest, "task-05");
		const p = handle.getPath();
		assert.ok(path.isAbsolute(p));
		assert.ok(p.includes(path.join("streaming", "task-05.md")));
		handle.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
