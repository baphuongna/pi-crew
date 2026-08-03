import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { knowledgePath, readKnowledge } from "../../../../src/extension/knowledge-injection.ts";

/**
 * Option B (preservation) tee-recovery for knowledge.md head-only truncation.
 * The head is kept lossless; when truncation occurs, an absolute-path hint is
 * appended so a worker can `read` the full file for content beyond the head.
 *
 * NOTE: readKnowledge() keeps a module-level mtime+size cache. Because each
 * test uses a unique mkdtemp dir, cache keys (the absolute path) never collide
 * across tests.
 */

test("readKnowledge truncates >2KB and embeds the absolute file path in the marker", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-knowledge-trunc-"));
	try {
		const crewDir = path.join(cwd, ".crew");
		fs.mkdirSync(crewDir, { recursive: true });
		const kPath = knowledgePath(cwd);
		// Sanity: the resolved path must be absolute and point at our file.
		assert.equal(path.isAbsolute(kPath), true, "knowledge path should be absolute");

		const headToken = "UNIQUE_HEAD_TOKEN_7Q";
		// 20_000 ASCII chars of padding → strictly > 2_000 threshold (A+B).
		const big = `${headToken}\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8");

		const out = readKnowledge(cwd);

		// Head content is present (lossless head).
		assert.ok(out.includes(headToken), "head content should survive truncation");

		// Marker text appears (A+B: head is now 2_000 bytes, not 16_000).
		assert.match(out, /<!-- knowledge\.md truncated at 2000 bytes/);

		// The absolute path to the file is embedded in the marker.
		assert.ok(out.includes(kPath), `marker should embed the absolute path; got path=${kPath}`);

		// Path embedded is genuinely absolute and resolvable to the real file.
		assert.equal(path.isAbsolute(kPath), true);
		assert.equal(fs.existsSync(kPath), true, "embedded path must resolve to a real file");

		// Mentions the read tool hint.
		assert.match(out, /use the `read` tool/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readKnowledge does NOT add a truncation marker when content is under threshold", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-knowledge-small-"));
	try {
		const crewDir = path.join(cwd, ".crew");
		fs.mkdirSync(crewDir, { recursive: true });
		const kPath = knowledgePath(cwd);
		// Well under the 2_000 threshold (A+B).
		fs.writeFileSync(kPath, "# Small knowledge\nA short note.\n", "utf-8");

		const out = readKnowledge(cwd);
		assert.equal(out.includes("truncated at"), false, "no marker should appear under threshold");
		assert.ok(out.includes("A short note."));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readKnowledge mtime+size cache re-reads on mtime change (marker appears both reads)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-knowledge-cache-"));
	try {
		const crewDir = path.join(cwd, ".crew");
		fs.mkdirSync(crewDir, { recursive: true });
		const kPath = knowledgePath(cwd);
		assert.equal(path.isAbsolute(kPath), true);

		// First large write with token A.
		const tokenA = "HEAD_TOKEN_ALPHA";
		fs.writeFileSync(kPath, `${tokenA}\n${"a".repeat(20_000)}`, "utf-8");
		const out1 = readKnowledge(cwd);
		assert.ok(out1.includes(tokenA), "first read should contain token A head");
		assert.ok(out1.includes(kPath), "first read marker should embed absolute path");

		// Overwrite with DIFFERENT content (token B) and force a distinct mtime
		// so the (mtimeMs, size) cache key changes and a re-read happens.
		const tokenB = "HEAD_TOKEN_BETA";
		fs.writeFileSync(kPath, `${tokenB}\n${"b".repeat(20_000)}`, "utf-8");
		const futureSec = Math.floor(Date.now() / 1000) + 60;
		fs.utimesSync(kPath, futureSec, futureSec);

		const out2 = readKnowledge(cwd);
		// The new head token proves the cache was bypassed (re-read occurred).
		assert.ok(out2.includes(tokenB), "second read should reflect re-read (token B)");
		assert.equal(out2.includes(tokenA), false, "stale token A must not appear after re-read");
		// Marker still present on the re-read.
		assert.ok(out2.includes(kPath), "second read marker should embed absolute path");
		assert.match(out2, /<!-- knowledge\.md truncated at 2000 bytes/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readKnowledge returns empty string when knowledge file is absent", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-knowledge-absent-"));
	try {
		// No .crew dir, no knowledge.md.
		const out = readKnowledge(cwd);
		assert.equal(out, "");
		assert.equal(out.includes("truncated"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
