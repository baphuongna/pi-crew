import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, test } from "node:test";
import {
	buildTaskWorkspaceTree,
	buildWorkspaceTree,
	formatAge,
	formatBytes,
	resolveTaskTreeScope,
} from "../../../../src/runtime/workspace-tree.ts";

// ── Helper: create a temp directory tree ───────────────────────────────

interface TreeEntry {
	[name: string]: string | TreeEntry;
}

async function createTempTree(entries: TreeEntry, base: string): Promise<void> {
	for (const [name, value] of Object.entries(entries)) {
		const fullPath = path.join(base, name);
		if (typeof value === "string") {
			await fs.mkdir(path.dirname(fullPath), { recursive: true });
			await fs.writeFile(fullPath, value, "utf8");
		} else {
			await fs.mkdir(fullPath, { recursive: true });
			await createTempTree(value, fullPath);
		}
	}
}

async function makeTmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-crew-wt-"));
}

// Small delay so mtime differences are observable
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

// ── formatBytes ────────────────────────────────────────────────────────

test("formatBytes handles all units", () => {
	assert.equal(formatBytes(0), "0B");
	assert.equal(formatBytes(512), "512B");
	assert.equal(formatBytes(1024), "1.0KB");
	assert.equal(formatBytes(1048576), "1.0MB");
	assert.equal(formatBytes(1073741824), "1.0GB");
});

// ── formatAge ──────────────────────────────────────────────────────────

test("formatAge handles all ranges", () => {
	assert.equal(formatAge(0), "just now");
	assert.equal(formatAge(30), "just now");
	assert.equal(formatAge(90), "1m");
	assert.equal(formatAge(4000), "1h");
	assert.equal(formatAge(90000), "1d");
	assert.equal(formatAge(86400 * 15), "2w");
});

// ── Basic tree rendering ───────────────────────────────────────────────

test("builds basic tree with files and directories", async () => {
	const dir = await makeTmpDir();
	try {
		await createTempTree(
			{
				src: { "index.ts": "export {}" },
				"readme.md": "# Hello",
			},
			dir,
		);

		const result = await buildWorkspaceTree(dir, {
			maxDepth: 3,
			dirLimit: 12,
			lineCap: 120,
		});

		assert.equal(result.rootPath, dir);
		assert.ok(result.rendered.startsWith("."));
		assert.ok(result.rendered.includes("src/"), `expected src/ in:\n${result.rendered}`);
		assert.ok(result.rendered.includes("readme.md"), `expected readme.md in:\n${result.rendered}`);
		assert.equal(result.truncated, false);
		assert.ok(result.totalLines > 0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Depth limit ────────────────────────────────────────────────────────

test("respects maxDepth: 1 — only direct children", async () => {
	const dir = await makeTmpDir();
	try {
		await createTempTree(
			{
				src: { "deep.ts": "export {}" },
				"top.txt": "hi",
			},
			dir,
		);

		const result = await buildWorkspaceTree(dir, { maxDepth: 1 });
		assert.ok(result.rendered.includes("src/"), "src/ should appear at depth 1");
		assert.ok(!result.rendered.includes("deep.ts"), `deep.ts should NOT appear:\n${result.rendered}`);
		assert.ok(result.rendered.includes("top.txt"));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Directory entry limit ──────────────────────────────────────────────

test("applies per-directory entry limit", async () => {
	const dir = await makeTmpDir();
	try {
		// Create 5 files with staggered mtimes
		const entries: TreeEntry = {};
		for (let i = 0; i < 5; i++) {
			entries[`file${i}.txt`] = `content ${i}`;
		}
		await createTempTree(entries, dir);

		const result = await buildWorkspaceTree(dir, {
			maxDepth: 1,
			dirLimit: 3,
		});
		assert.equal(result.truncated, true, "should be truncated");
		assert.ok(result.rendered.includes("… 2 more"), `expected truncation indicator in:\n${result.rendered}`);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Line cap truncation ────────────────────────────────────────────────

test("truncates when line cap is exceeded", async () => {
	const dir = await makeTmpDir();
	try {
		const entries: TreeEntry = {};
		for (let i = 0; i < 20; i++) {
			entries[`f${String(i).padStart(2, "0")}.txt`] = `x`;
		}
		await createTempTree(entries, dir);

		const result = await buildWorkspaceTree(dir, {
			maxDepth: 2,
			dirLimit: 50,
			lineCap: 5,
		});
		assert.equal(result.truncated, true);
		assert.ok(result.totalLines <= 5, `totalLines=${result.totalLines} should be <= 5`);
		assert.ok(result.rendered.includes("elided"), `expected elided in:\n${result.rendered}`);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Excluded dirs ──────────────────────────────────────────────────────

test("excludes specified directory names", async () => {
	const dir = await makeTmpDir();
	try {
		await createTempTree(
			{
				src: { "main.ts": "export {}" },
				node_modules: { pkg: { "index.js": "module.exports" } },
				".hidden": { "secret.txt": "shh" },
			},
			dir,
		);

		const result = await buildWorkspaceTree(dir, { maxDepth: 3 });
		assert.ok(result.rendered.includes("src/"), "src/ should appear");
		assert.ok(!result.rendered.includes("node_modules"), "node_modules should be excluded");
		assert.ok(!result.rendered.includes(".hidden"), "hidden dirs should be skipped");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Empty directory ────────────────────────────────────────────────────

test("returns valid result for empty directory", async () => {
	const dir = await makeTmpDir();
	try {
		const result = await buildWorkspaceTree(dir, { maxDepth: 3 });
		assert.equal(result.rootPath, dir);
		assert.equal(result.rendered, ".");
		assert.equal(result.truncated, false);
		assert.equal(result.totalLines, 1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── Error handling ─────────────────────────────────────────────────────

test("returns empty result for non-existent path", async () => {
	const result = await buildWorkspaceTree("/non/existent/path/xyz123");
	assert.equal(result.rendered, "");
	assert.equal(result.truncated, false);
	assert.equal(result.totalLines, 0);
});

// ── File metadata in output ────────────────────────────────────────────

// ── Task-scoped tree (R2) ─────────────────────────────────────────────

describe("buildTaskWorkspaceTree — NIT-2 directory-valued focus refinement", () => {
	test("top-level directory read scopes the walk to that directory", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ pi: { "a.ts": "export {}" }, other: { "b.md": "x" } }, dir);
			const r = await buildTaskWorkspaceTree(dir, ["pi"]);
			assert.equal(r.scope.relativePath, "pi");
			assert.ok(r.tree.rootPath.endsWith("pi"), `rootPath=${r.tree.rootPath}`);
			assert.ok(r.tree.rendered.includes("a.ts"), `expected a.ts in:\n${r.tree.rendered}`);
			assert.ok(!r.tree.rendered.includes("b.md"), `b.md must not leak into the scoped tree`);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("directory mixed with a root-level file stays whole-workspace (conservative)", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ pi: { "a.ts": "export {}" }, "README.md": "z" }, dir);
			const r = await buildTaskWorkspaceTree(dir, ["pi", "README.md"]);
			assert.equal(r.scope.relativePath, ".");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("nonexistent top-level path keeps file-path semantics (fail-safe fallback)", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ pi: { "a.ts": "export {}" } }, dir);
			const r = await buildTaskWorkspaceTree(dir, ["ghost"]);
			assert.equal(r.scope.relativePath, ".");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("directory plus file inside it narrows to the directory", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ pi: { "a.ts": "export {}", deep: { "b.ts": "export {}" } } }, dir);
			const r = await buildTaskWorkspaceTree(dir, ["pi", "pi/a.ts"]);
			assert.equal(r.scope.relativePath, "pi");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

test("includes file size and age for files", async () => {
	const dir = await makeTmpDir();
	try {
		await createTempTree({ "data.bin": "hello world content" }, dir);

		const result = await buildWorkspaceTree(dir, { maxDepth: 1 });
		// The file line should contain size (ends with B) and age info
		const fileLine = result.rendered.split("\n").find((l) => l.includes("data.bin"));
		assert.ok(fileLine, "should have a line for data.bin");
		assert.ok(fileLine.includes("B"), `expected size in: ${fileLine}`);
		assert.ok(fileLine.includes("just now") || fileLine.includes("m") || fileLine.includes("h"), `expected age in: ${fileLine}`);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

// ── R2 (adaptive-04): task-scoped subtree ──────────────────────────────

describe("resolveTaskTreeScope — R2 scoping rule (pure, no FS)", () => {
	// Windows CI: path.resolve/dirname return native separators — build the
	// expected rootPath values the same way (relativePath is a posix contract).
	const ROOT = path.resolve("/ws/repo");

	it("no focus paths ⇒ whole workspace (legacy behavior)", () => {
		for (const none of [undefined, false, null, []] as const) {
			const scope = resolveTaskTreeScope("/ws/repo", none);
			assert.equal(scope.rootPath, ROOT);
			assert.equal(scope.relativePath, ".");
		}
	});

	it("single file focus narrows to its directory", () => {
		const scope = resolveTaskTreeScope("/ws/repo", ["src/runtime/tree.ts"]);
		assert.equal(scope.relativePath, "src/runtime");
		assert.equal(scope.rootPath, path.join(ROOT, "src/runtime"));
	});

	it("multiple focuses narrow to their deepest shared directory", () => {
		const scope = resolveTaskTreeScope("/ws/repo", ["src/runtime/a.ts", "src/runtime/deep/b.ts", "src/other/c.ts"]);
		assert.equal(scope.relativePath, "src");
	});

	it("divergent focuses (no shared dir below root) fall back to the whole workspace", () => {
		const scope = resolveTaskTreeScope("/ws/repo", ["src/a.ts", "docs/b.md"]);
		assert.equal(scope.relativePath, ".");
		assert.equal(scope.rootPath, ROOT);
	});

	it("focuses outside the workspace are ignored", () => {
		const onlyOutside = resolveTaskTreeScope("/ws/repo", ["../elsewhere/a.ts", "/abs/other/b.ts"]);
		assert.equal(onlyOutside.relativePath, ".");
		// Outside paths must not veto an in-workspace sibling either.
		const mixed = resolveTaskTreeScope("/ws/repo", ["../elsewhere/a.ts", "src/runtime/b.ts"]);
		assert.equal(mixed.relativePath, "src/runtime");
	});

	it("absolute in-workspace focus paths scope too", () => {
		const scope = resolveTaskTreeScope("/ws/repo", ["/ws/repo/src/x.ts"]);
		assert.equal(scope.relativePath, "src");
	});

	it("glob-style focus (non-existent dir) resolves the literal dir — fallback is the async layer", () => {
		// "src/**/*.ts" has no "/" after the last separator, so dirname = "src/**";
		// the walk root will not exist and buildTaskWorkspaceTree must fall back.
		const scope = resolveTaskTreeScope("/ws/repo", ["src/**/*.ts"]);
		assert.equal(scope.relativePath, "src/**");
	});
});

describe("buildTaskWorkspaceTree — R2 scoped walk", () => {
	it("walks the subtree around the focus files, not the whole workspace", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree(
				{
					src: { runtime: { "focus-file.ts": "export {}" }, "top.ts": "x" },
					unrelated: { "far-away.ts": "y" },
				},
				dir,
			);

			const { tree, scope } = await buildTaskWorkspaceTree(dir, ["src/runtime/focus-file.ts"]);
			assert.equal(scope.relativePath, "src/runtime");
			assert.ok(tree.rendered.includes("focus-file.ts"), `expected focus file in:\n${tree.rendered}`);
			assert.ok(!tree.rendered.includes("far-away.ts"), "scoped walk must not render outside the subtree");
			assert.ok(!tree.rendered.includes("top.ts"), "parent-dir siblings are outside the subtree walk");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("non-existent scope falls back to the whole-workspace walk (fail-safe)", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ src: { "real.ts": "x" }, "root-file.ts": "y" }, dir);

			const { tree, scope } = await buildTaskWorkspaceTree(dir, ["typo-dir/file.ts"]);
			assert.equal(scope.relativePath, ".", "must fall back to the unscoped walk");
			assert.ok(tree.rendered.includes("src/"), `expected full tree in:\n${tree.rendered}`);
			assert.ok(tree.rendered.includes("root-file.ts"));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the legacy walk (defaults) when no focus paths are given", async () => {
		const dir = await makeTmpDir();
		try {
			await createTempTree({ src: { "a.ts": "x" }, docs: { "b.md": "y" } }, dir);

			const { tree, scope } = await buildTaskWorkspaceTree(dir, undefined);
			assert.equal(scope.relativePath, ".");
			assert.ok(tree.rendered.includes("src/"));
			assert.ok(tree.rendered.includes("docs/"));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
