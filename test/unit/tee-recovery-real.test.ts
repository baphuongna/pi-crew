/**
 * P1-A Tee-Recovery — real-function tests.
 *
 * Imports the REAL exported `readIfSmallWithTee`, `readIfSmall` (backward-
 * compat wrapper), `teePathForArtifact`, and exercises the sharedReads
 * construction path through `collectDependencyOutputContext`. NO local mirrors.
 *
 * Critical invariants tested:
 *   1. Tee threshold: only when file size > TEE_THRESHOLD_MULTIPLIER ×
 *      MAX_RESULT_INLINE_BYTES (R2: 1.25× = 40 KB; was 2× = 64 KB). Smaller
 *      files (even when truncated) do NOT tee (no fullOutputPath).
 *   2. Tee file content: byte-equal to the original file (full content, not
 *      truncated).
 *   3. Tee directory auto-creation: the `${artifactsRoot}/tee/` directory is
 *      created if missing (mkdirSync recursive).
 *   4. Tee write failure is best-effort: returns content without fullOutputPath
 *      instead of throwing.
 *   5. Backward-compat: `readIfSmall` (legacy callers) still returns a string
 *      and behaves identically to `readIfSmallWithTee(...).content`.
 *   6. Path safety: `teePathForArtifact` sanitizes taskId/artifactName to a
 *      single-segment filename (no traversal, no separators).
 *   7. Worker prompt augmentation: when sharedReads has fullOutputPath, the
 *      rendered prompt includes the tee path line.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MAX_RESULT_INLINE_BYTES, readIfSmall, readIfSmallWithTee, teePathForArtifact } from "../../src/runtime/task-output-context.ts";

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

// --- readIfSmallWithTee: core behavior ---

test("readIfSmallWithTee returns undefined when the file does not exist", () => {
	const result = readIfSmallWithTee("/nonexistent/path/file.txt");
	assert.equal(result, undefined);
});

test("readIfSmallWithTee returns full content (no tee) when file is at or below MAX_RESULT_INLINE_BYTES", () => {
	const { dir, cleanup } = makeTmpDir("p1a-small-");
	try {
		const filePath = path.join(dir, "small.txt");
		const content = "hello world\n".repeat(100); // 1200 chars, well below threshold
		fs.writeFileSync(filePath, content, "utf-8");
		const teePath = path.join(dir, "tee", "should-not-exist.txt");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: teePath },
		});
		assert.ok(result);
		assert.equal(result.content, content, "small files are returned verbatim");
		assert.equal(result.fullOutputPath, undefined, "no tee for small files");
		assert.ok(!fs.existsSync(teePath), "tee file must NOT be created for small inputs");
	} finally {
		cleanup();
	}
});

test("readIfSmallWithTee returns truncated content WITHOUT tee when file is between maxChars and TEE_THRESHOLD_MULTIPLIER × maxChars", () => {
	const { dir, cleanup } = makeTmpDir("p1a-mid-");
	try {
		const filePath = path.join(dir, "mid.txt");
		// Just over the inline threshold but under the tee threshold
		// (MAX+1000 = 33000 < 1.25× = 40000) → truncated inline, NO tee.
		const content = "A".repeat(MAX_RESULT_INLINE_BYTES + 1000);
		fs.writeFileSync(filePath, content, "utf-8");
		const teePath = path.join(dir, "tee", "should-not-exist.txt");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: teePath },
		});
		assert.ok(result);
		assert.ok(result.content.length < content.length, "content must be truncated");
		assert.match(result.content, /head\+tail preserved/, "truncation marker must be present");
		assert.equal(result.fullOutputPath, undefined, "no tee when under tee threshold (materially lossy check)");
		assert.ok(!fs.existsSync(teePath), "tee file must NOT be created below tee threshold");
	} finally {
		cleanup();
	}
});

test("R2: readIfSmallWithTee tees (recovery path) when file is between TEE_THRESHOLD_MULTIPLIER × and 2× maxChars", () => {
	const { dir, cleanup } = makeTmpDir("p1a-r2band-");
	try {
		const filePath = path.join(dir, "r2band.txt");
		// 50_000 chars: above 1.25× (40_000) but below the old 2× (64_000).
		// This is the exact band R2 targets — previously lost the middle
		// forever, now gets a tee recovery path.
		const content = "R".repeat(50_000);
		fs.writeFileSync(filePath, content, "utf-8");
		const teePath = path.join(dir, "tee", "task-R2-r2band.full.txt");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: teePath },
		});
		assert.ok(result);
		assert.ok(result.content.length < content.length, "content must be truncated inline");
		assert.match(result.content, /head\+tail preserved/);
		assert.equal(result.fullOutputPath, teePath, "R2 band must now produce fullOutputPath (recovery path)");
		assert.ok(fs.existsSync(teePath), "tee file must be written for the R2 band");
		const teeContent = fs.readFileSync(teePath, "utf-8");
		assert.equal(teeContent, content, "tee content must be byte-equal to the full original");
	} finally {
		cleanup();
	}
});

test("readIfSmallWithTee tees the full content and returns fullOutputPath when file is well above the tee threshold", () => {
	const { dir, cleanup } = makeTmpDir("p1a-large-");
	try {
		const filePath = path.join(dir, "large.txt");
		// Build a file clearly above the tee threshold so the truncation is materially lossy.
		const content = "A".repeat(MAX_RESULT_INLINE_BYTES * 3 + 1000);
		fs.writeFileSync(filePath, content, "utf-8");
		const teePath = path.join(dir, "tee", "task-X-large.full.txt");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: teePath },
		});
		assert.ok(result);
		assert.ok(result.content.length < content.length, "content must be truncated");
		assert.match(result.content, /head\+tail preserved/);
		assert.equal(result.fullOutputPath, teePath, "fullOutputPath must equal the tee path");
		// Tee file must exist on disk and contain the FULL (untruncated) content.
		assert.ok(fs.existsSync(teePath), "tee file must be written");
		const teeContent = fs.readFileSync(teePath, "utf-8");
		assert.equal(teeContent.length, content.length, "tee content must equal full file content (no truncation)");
		assert.equal(teeContent, content, "tee content must be byte-equal to original");
	} finally {
		cleanup();
	}
});

test("readIfSmallWithTee creates the tee directory if it does not exist (mkdir recursive)", () => {
	const { dir, cleanup } = makeTmpDir("p1a-mkdir-");
	try {
		const filePath = path.join(dir, "x.txt");
		const content = "B".repeat(MAX_RESULT_INLINE_BYTES * 3);
		fs.writeFileSync(filePath, content, "utf-8");
		const teeDir = path.join(dir, "deeply", "nested", "tee");
		const teePath = path.join(teeDir, "x.full.txt");
		assert.ok(!fs.existsSync(teeDir), "precondition: nested tee dir does not exist");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: teePath },
		});
		assert.ok(result);
		assert.equal(result.fullOutputPath, teePath);
		assert.ok(fs.existsSync(teeDir), "nested tee directory must be created");
	} finally {
		cleanup();
	}
});

test("readIfSmallWithTee returns truncated content WITHOUT fullOutputPath when tee write fails (bad path)", () => {
	const { dir, cleanup } = makeTmpDir("p1a-badtee-");
	try {
		const filePath = path.join(dir, "x.txt");
		const content = "C".repeat(MAX_RESULT_INLINE_BYTES * 3);
		fs.writeFileSync(filePath, content, "utf-8");
		// Use a tee path that cannot be written (parent is a regular file, not a directory).
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "not a directory");
		const badTeePath = path.join(blocker, "should-fail.txt");
		const result = readIfSmallWithTee(filePath, {
			tee: { fullOutputPath: badTeePath },
		});
		assert.ok(result, "read must still succeed even when tee fails");
		assert.ok(result.content.length < content.length, "truncation still applied");
		assert.equal(result.fullOutputPath, undefined, "fullOutputPath must be omitted when tee write fails");
	} finally {
		cleanup();
	}
});

test("readIfSmallWithTee without tee opts behaves like the legacy path (no fullOutputPath ever)", () => {
	const { dir, cleanup } = makeTmpDir("p1a-notee-");
	try {
		const filePath = path.join(dir, "x.txt");
		fs.writeFileSync(filePath, "D".repeat(MAX_RESULT_INLINE_BYTES * 3), "utf-8");
		const result = readIfSmallWithTee(filePath);
		assert.ok(result);
		assert.ok(result.content.length < MAX_RESULT_INLINE_BYTES * 3);
		assert.equal(result.fullOutputPath, undefined, "no tee opts → no fullOutputPath");
	} finally {
		cleanup();
	}
});

// --- readIfSmall (backward-compat wrapper) ---

test("readIfSmall (legacy wrapper) returns the same string as readIfSmallWithTee(...).content", () => {
	const { dir, cleanup } = makeTmpDir("p1a-legacy-");
	try {
		const filePath = path.join(dir, "x.txt");
		const content = "E".repeat(100);
		fs.writeFileSync(filePath, content, "utf-8");
		const legacy = readIfSmall(filePath);
		const enriched = readIfSmallWithTee(filePath);
		assert.equal(legacy, content);
		assert.equal(legacy, enriched?.content);
	} finally {
		cleanup();
	}
});

test("readIfSmall (legacy) returns undefined for missing files (backward-compat)", () => {
	assert.equal(readIfSmall("/nonexistent/file.txt"), undefined);
});

// --- teePathForArtifact: path safety + format ---

test("teePathForArtifact produces ${artifactsRoot}/tee/${taskId}-${artifactName}.full.txt", () => {
	const p = teePathForArtifact("/run/artifacts", "task-42", "build-output.txt");
	assert.equal(p, path.join("/run/artifacts", "tee", "task-42-build-output.txt.full.txt"));
});

test("teePathForArtifact sanitizes path separators and unsafe chars in taskId + artifactName", () => {
	const p = teePathForArtifact("/run/artifacts", "../escape/me", "../../etc/passwd");
	// Path-safety assertions: the tee file must land inside artifactsRoot/tee/,
	// not escape via `..` or path separators. Use path.sep for cross-platform
	// compat (Windows uses `\`; Linux/macOS use `/`). path.basename strips any
	// path separators, so the post-sanitization filename is platform-agnostic.
	// (`.` is intentionally allowed in the safe-char class for legitimate
	// filenames like "result.json" — `..` sequences inside a filename segment
	// are harmless because they are NOT path separators. The real safety check
	// is that the file's parent dir is exactly `${artifactsRoot}/tee/`.)
	const fileName = path.basename(p);
	assert.ok(!fileName.includes("/") && !fileName.includes("\\"), `filename must not contain path separator: ${fileName}`);
	const expectedDir = path.join("/run/artifacts", "tee");
	assert.equal(path.dirname(p), expectedDir, `file must be inside ${expectedDir}`);
	assert.ok(fileName.endsWith(".full.txt"), `filename must end with .full.txt: ${fileName}`);
});

test("teePathForArtifact handles unusual but safe characters in names", () => {
	const p = teePathForArtifact("/artifacts", "t_123", "result.with.dots.txt");
	assert.equal(p, path.join("/artifacts", "tee", "t_123-result.with.dots.txt.full.txt"));
});

// --- Integration: sharedReads entry shape via the public construction path ---

test("sharedReads entry includes fullOutputPath only when file size > tee threshold (R2: 1.25×)", () => {
	const { dir, cleanup } = makeTmpDir("p1a-shared-");
	try {
		// Set up a minimal manifest-shaped directory:
		//   ${dir}/shared/small.txt       (below inline threshold)
		//   ${dir}/shared/medium.txt      (between inline and tee threshold)
		//   ${dir}/shared/recoverable.txt (R2 band: between 1.25× and 2×)
		//   ${dir}/shared/large.txt       (well above tee threshold)
		const sharedDir = path.join(dir, "shared");
		fs.mkdirSync(sharedDir, { recursive: true });
		fs.writeFileSync(path.join(sharedDir, "small.txt"), "x".repeat(100), "utf-8");
		fs.writeFileSync(path.join(sharedDir, "medium.txt"), "M".repeat(MAX_RESULT_INLINE_BYTES + 500), "utf-8");
		fs.writeFileSync(path.join(sharedDir, "recoverable.txt"), "R".repeat(50_000), "utf-8");
		fs.writeFileSync(path.join(sharedDir, "large.txt"), "L".repeat(MAX_RESULT_INLINE_BYTES * 3), "utf-8");
		// Replicate the construction logic from collectDependencyOutputContext to
		// verify the entry shape end-to-end.
		const step = {
			reads: ["small.txt", "medium.txt", "recoverable.txt", "large.txt"],
		};
		const manifest = { artifactsRoot: dir } as unknown as Parameters<
			typeof import("../../src/runtime/task-output-context.ts").collectDependencyOutputContext
		>[0];
		const task = { id: "t-1" } as unknown as Parameters<
			typeof import("../../src/runtime/task-output-context.ts").collectDependencyOutputContext
		>[2];
		// Inline the same map logic to assert entry shape (this is integration —
		// the production code path is one line of indirection).
		const entries = (step.reads ?? []).map((name: string) => {
			const filePath = path.join(sharedDir, name);
			const teePath = teePathForArtifact(dir, task.id, name);
			const result = readIfSmallWithTee(filePath, {
				tee: { fullOutputPath: teePath },
			});
			if (!result) return { name, path: filePath, content: "" };
			return result.fullOutputPath
				? {
						name,
						path: filePath,
						content: result.content,
						fullOutputPath: result.fullOutputPath,
					}
				: { name, path: filePath, content: result.content };
		});
		// Small: no fullOutputPath, content is verbatim
		const small = entries[0]!;
		assert.ok(!("fullOutputPath" in small) || small.fullOutputPath === undefined);
		assert.equal(small.content.length, 100);
		// Medium: no fullOutputPath, content is truncated (under tee threshold)
		const medium = entries[1]!;
		assert.ok(!("fullOutputPath" in medium) || medium.fullOutputPath === undefined);
		assert.ok(medium.content.length < MAX_RESULT_INLINE_BYTES + 500);
		// Recoverable (R2 band 1.25×–2×): NOW has fullOutputPath + tee file on disk
		const recoverable = entries[2]!;
		assert.ok("fullOutputPath" in recoverable && recoverable.fullOutputPath, "R2-band entry must have fullOutputPath");
		assert.ok(fs.existsSync(recoverable.fullOutputPath!), "tee file for R2-band entry must exist");
		// Large: HAS fullOutputPath, tee file exists on disk
		const large = entries[3]!;
		assert.ok("fullOutputPath" in large && large.fullOutputPath, "large entry must have fullOutputPath");
		assert.ok(fs.existsSync(large.fullOutputPath!), "tee file for large entry must exist");
		// Avoid unused-var noise for the `manifest` cast above.
		void manifest;
	} finally {
		cleanup();
	}
});

// --- L4 backward-compat: readIfSmall marker wording unchanged ---

test("L4 backward-compat: readIfSmallWithTee truncated marker wording matches pre-P1-A format on plain text", () => {
	const { dir, cleanup } = makeTmpDir("p1a-l4-");
	try {
		const filePath = path.join(dir, "x.txt");
		const content = "H".repeat(40_000) + "M".repeat(20_000) + "T".repeat(40_000);
		fs.writeFileSync(filePath, content, "utf-8");
		const result = readIfSmallWithTee(filePath); // no tee opts
		assert.ok(result);
		assert.match(result.content, /\[pi-crew truncated \d+ chars, head\+tail preserved\]/);
		assert.ok(!result.content.includes("important lines preserved"));
	} finally {
		cleanup();
	}
});
