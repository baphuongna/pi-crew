import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
	classifyChange,
	computeContentHash,
	computeFingerprintDelta,
	computeStructuralSignature,
	type FileFingerprint,
	fingerprintFile,
	loadFingerprintBaseline,
	saveFingerprintBaseline,
} from "../../src/utils/fingerprint.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

describe("computeContentHash", () => {
	it("returns a SHA-256 hex string for an existing file", () => {
		const tmp = createTrackedTempDir("pi-crew-fp-");
		try {
			const filePath = path.join(tmp, "test.txt");
			writeFileSync(filePath, "hello world");
			const hash = computeContentHash(filePath);
			assert.match(hash, /^[0-9a-f]{64}$/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns consistent hash for same content", () => {
		const tmp = createTrackedTempDir("pi-crew-fp-");
		try {
			const filePath = path.join(tmp, "test.txt");
			writeFileSync(filePath, "same content");
			const h1 = computeContentHash(filePath);
			const h2 = computeContentHash(filePath);
			assert.equal(h1, h2);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns different hashes for different content", () => {
		const tmp = createTrackedTempDir("pi-crew-fp-");
		try {
			const f1 = path.join(tmp, "a.txt");
			const f2 = path.join(tmp, "b.txt");
			writeFileSync(f1, "content a");
			writeFileSync(f2, "content b");
			assert.notEqual(computeContentHash(f1), computeContentHash(f2));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns empty string for non-existent file", () => {
		const hash = computeContentHash("/nonexistent/path/file.txt");
		assert.equal(hash, "");
	});
});

describe("computeStructuralSignature", () => {
	it("captures function declarations", () => {
		const content = `
// comment
export function foo() { return 1; }
export async function bar() { return 2; }
`;
		const sig = computeStructuralSignature(content, "test.ts");
		assert.ok(sig.length > 0, "Should produce a non-empty hash");
		assert.match(sig, /^[0-9a-f]{64}$/);
	});

	it("captures import declarations", () => {
		const content = `import { foo } from "bar";\nconst x = 1;\n`;
		const sig = computeStructuralSignature(content, "test.ts");
		assert.ok(sig.length > 0);
	});

	it("skips comments and empty lines", () => {
		const content = `
// this is a comment
/* block comment */
* continuation
   (indented empty-ish)

`;
		const sig = computeStructuralSignature(content, "test.ts");
		// All lines are comments or empty, structural array should be empty → hash of empty string
		assert.ok(sig.length > 0);
	});

	it("captures class and interface declarations", () => {
		const content = `
export interface MyType { x: number; }
export class MyClass {
  public method() {}
}
`;
		const sig = computeStructuralSignature(content, "test.ts");
		assert.match(sig, /^[0-9a-f]{64}$/);
	});

	it("produces different signatures for structurally different code", () => {
		const c1 = "export function alpha() {}\n";
		const c2 = "export function beta() {}\n";
		const s1 = computeStructuralSignature(c1, "a.ts");
		const s2 = computeStructuralSignature(c2, "b.ts");
		assert.notEqual(s1, s2);
	});

	it("produces same signature for code differing only in whitespace/comments", () => {
		const c1 = "export function foo() { return 1; }\n";
		const c2 = "// a comment\nexport function foo() { return 1; }\n\n";
		// Both have the same structural line, so signature should be identical
		assert.equal(computeStructuralSignature(c1, "a.ts"), computeStructuralSignature(c2, "b.ts"));
	});
});

describe("classifyChange", () => {
	it("returns STRUCTURAL for new file (no previous)", () => {
		const current: FileFingerprint = {
			path: "a.ts",
			contentHash: "abc",
			structuralSignature: "def",
			lastModified: Date.now(),
			changeClass: "NONE",
		};
		assert.equal(classifyChange(undefined, current), "STRUCTURAL");
	});

	it("returns NONE when content hash is identical", () => {
		const prev: FileFingerprint = {
			path: "a.ts",
			contentHash: "abc",
			structuralSignature: "def",
			lastModified: 1,
			changeClass: "NONE",
		};
		const cur: FileFingerprint = { ...prev, lastModified: 2 };
		assert.equal(classifyChange(prev, cur), "NONE");
	});

	it("returns COSMETIC when content changed but structure unchanged", () => {
		const prev: FileFingerprint = {
			path: "a.ts",
			contentHash: "abc",
			structuralSignature: "same",
			lastModified: 1,
			changeClass: "NONE",
		};
		const cur: FileFingerprint = { ...prev, contentHash: "xyz" };
		assert.equal(classifyChange(prev, cur), "COSMETIC");
	});

	it("returns STRUCTURAL when both content and structure changed", () => {
		const prev: FileFingerprint = {
			path: "a.ts",
			contentHash: "abc",
			structuralSignature: "sig1",
			lastModified: 1,
			changeClass: "NONE",
		};
		const cur: FileFingerprint = {
			...prev,
			contentHash: "xyz",
			structuralSignature: "sig2",
		};
		assert.equal(classifyChange(prev, cur), "STRUCTURAL");
	});
});

describe("fingerprintFile", () => {
	it("produces a valid fingerprint for a real file", () => {
		const tmp = createTrackedTempDir("pi-crew-fp-");
		try {
			const filePath = path.join(tmp, "sample.ts");
			writeFileSync(filePath, "export function test() { return 1; }");
			const fp = fingerprintFile(filePath);
			assert.equal(fp.path, filePath);
			assert.match(fp.contentHash, /^[0-9a-f]{64}$/);
			assert.match(fp.structuralSignature, /^[0-9a-f]{64}$/);
			assert.ok(fp.lastModified > 0);
			assert.equal(fp.changeClass, "NONE");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("loadFingerprintBaseline + saveFingerprintBaseline", () => {
	it("round-trips fingerprints through disk", () => {
		const tmp = createTrackedTempDir("pi-crew-fp-");
		try {
			const storePath = path.join(tmp, "baseline.json");
			const fps = new Map<string, FileFingerprint>();
			fps.set("a.ts", {
				path: "a.ts",
				contentHash: "hash1",
				structuralSignature: "sig1",
				lastModified: 1000,
				changeClass: "NONE",
			});
			fps.set("b.ts", {
				path: "b.ts",
				contentHash: "hash2",
				structuralSignature: "sig2",
				lastModified: 2000,
				changeClass: "STRUCTURAL",
			});

			saveFingerprintBaseline(storePath, fps);
			const loaded = loadFingerprintBaseline(storePath);

			assert.equal(loaded.size, 2);
			assert.equal(loaded.get("a.ts")!.contentHash, "hash1");
			assert.equal(loaded.get("b.ts")!.changeClass, "STRUCTURAL");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns empty map for non-existent store", () => {
		const map = loadFingerprintBaseline("/nonexistent/baseline.json");
		assert.equal(map.size, 0);
	});
});

describe("computeFingerprintDelta", () => {
	it("detects added files", () => {
		const baseline = new Map<string, FileFingerprint>();
		const current = new Map<string, FileFingerprint>([
			[
				"new.ts",
				{
					path: "new.ts",
					contentHash: "h",
					structuralSignature: "s",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const delta = computeFingerprintDelta(baseline, current);
		assert.deepEqual(delta.added, ["new.ts"]);
		assert.equal(delta.removed.length, 0);
		assert.equal(delta.modified.length, 0);
	});

	it("detects removed files", () => {
		const baseline = new Map<string, FileFingerprint>([
			[
				"old.ts",
				{
					path: "old.ts",
					contentHash: "h",
					structuralSignature: "s",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const current = new Map<string, FileFingerprint>();
		const delta = computeFingerprintDelta(baseline, current);
		assert.deepEqual(delta.removed, ["old.ts"]);
		assert.equal(delta.added.length, 0);
	});

	it("detects structural modifications", () => {
		const baseline = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h1",
					structuralSignature: "s1",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const current = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h2",
					structuralSignature: "s2",
					lastModified: 2,
					changeClass: "NONE",
				},
			],
		]);
		const delta = computeFingerprintDelta(baseline, current);
		assert.equal(delta.modified.length, 1);
		assert.equal(delta.modified[0]!.changeClass, "STRUCTURAL");
		assert.equal(delta.unchanged, 0);
	});

	it("counts cosmetic changes as unchanged", () => {
		const baseline = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h1",
					structuralSignature: "s1",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const current = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h2",
					structuralSignature: "s1",
					lastModified: 2,
					changeClass: "NONE",
				},
			],
		]);
		const delta = computeFingerprintDelta(baseline, current);
		assert.equal(delta.unchanged, 1);
		assert.equal(delta.modified.length, 0);
	});

	it("detects completely unchanged files", () => {
		const baseline = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h1",
					structuralSignature: "s1",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const current = new Map<string, FileFingerprint>([
			[
				"a.ts",
				{
					path: "a.ts",
					contentHash: "h1",
					structuralSignature: "s1",
					lastModified: 1,
					changeClass: "NONE",
				},
			],
		]);
		const delta = computeFingerprintDelta(baseline, current);
		assert.equal(delta.unchanged, 1);
		assert.equal(delta.added.length, 0);
		assert.equal(delta.removed.length, 0);
		assert.equal(delta.modified.length, 0);
	});
});
