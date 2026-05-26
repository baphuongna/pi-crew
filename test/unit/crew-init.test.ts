/**
 * Tests for P0: Auto-setup .crew directory and .gitignore.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// We test the modules directly via dynamic import so they resolve
// relative to the source tree correctly.
const { ensureCrewDirectory } = await import("../../src/state/crew-init.ts");
const { updateGitignore } = await import(
	"../../src/state/gitignore-manager.ts"
);

function makeTempProject(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-crew-crew-init-test-"),
	);
	// Add a .git marker so projectCrewRoot resolves to .crew/ inside this dir
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// --- crew-init tests ---

test("ensureCrewDirectory creates required directory structure", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const crewRoot = path.join(dir, ".crew");
		const expectedDirs = [
			".crew",
			".crew/state/runs",
			".crew/state/subagents",
			".crew/artifacts",
			".crew/cache",
			".crew/graphs",
			".crew/audit",
		];
		for (const sub of expectedDirs) {
			assert.ok(
				fs.statSync(path.join(dir, sub)).isDirectory(),
				`Expected directory: ${sub}`,
			);
		}
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory creates .gitkeep placeholders", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const crewRoot = path.join(dir, ".crew");
		const placeholders = [
			"artifacts/.gitkeep",
			"cache/.gitkeep",
			"graphs/.gitkeep",
			"audit/.gitkeep",
		];
		for (const p of placeholders) {
			const fullPath = path.join(crewRoot, p);
			assert.ok(fs.existsSync(fullPath), `Expected placeholder: ${p}`);
			assert.equal(fs.readFileSync(fullPath, "utf-8"), "");
		}
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory writes README.md", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const readmePath = path.join(dir, ".crew", "README.md");
		assert.ok(fs.existsSync(readmePath), "README.md should exist");
		const content = fs.readFileSync(readmePath, "utf-8");
		assert.ok(
			content.includes("pi-crew"),
			"README should mention pi-crew",
		);
		assert.ok(
			content.includes("state/runs"),
			"README should describe state/runs",
		);
	} finally {
		cleanup(dir);
	}
});

test("ensureCrewDirectory is idempotent", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const readmeBefore = fs.readFileSync(
			path.join(dir, ".crew", "README.md"),
			"utf-8",
		);
		// Call again — should not throw
		await ensureCrewDirectory(dir);
		const readmeAfter = fs.readFileSync(
			path.join(dir, ".crew", "README.md"),
			"utf-8",
		);
		// README content should be the same (overwritten with same content)
		assert.equal(readmeBefore, readmeAfter);
		// Directories should still exist
		assert.ok(
			fs.statSync(path.join(dir, ".crew", "state", "runs")).isDirectory(),
		);
	} finally {
		cleanup(dir);
	}
});

// --- gitignore-manager tests ---

test("updateGitignore creates .gitignore if it doesn't exist", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-crew-gitignore-test-"),
	);
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		assert.ok(fs.existsSync(gitignorePath));
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"), "Should contain /.crew/");
		assert.ok(
			content.includes("!.crew/artifacts/"),
			"Should contain !.crew/artifacts/",
		);
		assert.ok(
			content.includes("!.crew/graphs/.gitkeep"),
			"Should contain !.crew/graphs/.gitkeep",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore adds entries to existing .gitignore", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-crew-gitignore-test-"),
	);
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		fs.writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf-8");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		// Existing content preserved
		assert.ok(content.includes("node_modules/"));
		assert.ok(content.includes("dist/"));
		// New entries added
		assert.ok(content.includes("/.crew/"));
		assert.ok(content.includes("!.crew/artifacts/"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore does not duplicate existing entries", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-crew-gitignore-test-"),
	);
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		await updateGitignore(gitignorePath);
		const content1 = fs.readFileSync(gitignorePath, "utf-8");
		await updateGitignore(gitignorePath);
		const content2 = fs.readFileSync(gitignorePath, "utf-8");
		assert.equal(content1, content2, "Content should not change on second call");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("updateGitignore preserves existing content", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-crew-gitignore-test-"),
	);
	try {
		const gitignorePath = path.join(dir, ".gitignore");
		const existingContent = "# My project\n*.log\nbuild/\n";
		fs.writeFileSync(gitignorePath, existingContent, "utf-8");
		await updateGitignore(gitignorePath);
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.startsWith("# My project\n*.log\nbuild/"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureCrewDirectory updates .gitignore in project root", async () => {
	const dir = makeTempProject();
	try {
		await ensureCrewDirectory(dir);
		const gitignorePath = path.join(dir, ".gitignore");
		assert.ok(fs.existsSync(gitignorePath), ".gitignore should be created");
		const content = fs.readFileSync(gitignorePath, "utf-8");
		assert.ok(content.includes("/.crew/"));
		assert.ok(content.includes("!.crew/artifacts/"));
	} finally {
		cleanup(dir);
	}
});
