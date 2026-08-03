import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildWorkspaceTree, formatAge, formatBytes } from "../../../../src/runtime/workspace-tree.ts";

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
