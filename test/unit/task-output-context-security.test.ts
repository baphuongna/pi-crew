import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import { sharedPath, writeTaskSharedOutput } from "../../src/runtime/task-output-context.ts";
import { writeArtifact } from "../../src/state/artifact-store.ts";

const team: TeamConfig = { name: "security", description: "security", source: "builtin", filePath: "security.team.md", roles: [{ name: "executor", agent: "executor" }] };

function isUsableDirectoryLink(linkPath: string): boolean {
	try {
		fs.lstatSync(linkPath);
		fs.realpathSync.native(linkPath);
		return true;
	} catch {
		try {
			fs.unlinkSync(linkPath);
		} catch {
			try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
		}
		return false;
	}
}

function tryDirectorySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return isUsableDirectoryLink(linkPath);
	} catch {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			return isUsableDirectoryLink(linkPath);
		} catch {
			return false;
		}
	}
}

test("artifact and shared output paths reject traversal", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-artifact-traversal-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, goal: "artifact traversal" });
		assert.throws(() => writeArtifact(manifest.artifactsRoot, { kind: "metadata", relativePath: "shared/../../escape.txt", producer: "test", content: "bad" }), /Invalid artifact path/);
		assert.throws(() => sharedPath(manifest, "../../escape.txt"), /Invalid shared artifact name/);
		const result = writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: "results/task.md", producer: "task", content: "ok" });
		const task: TeamTaskState = { id: "task", runId: manifest.runId, title: "Task", role: "executor", agent: "executor", cwd, status: "completed", dependsOn: [], resultArtifact: result };
		assert.throws(() => writeTaskSharedOutput(manifest, { id: "task", role: "executor", task: "do", output: "../../escape.txt" }, task), /Invalid shared artifact name/);
		assert.equal(fs.existsSync(path.join(manifest.artifactsRoot, "..", "escape.txt")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("artifact writes reject symlinked artifacts root escapes", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-artifact-root-symlink-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({ cwd, team, goal: "artifact symlink root" });
		const outside = path.join(cwd, "outside-artifacts");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(manifest.artifactsRoot, { recursive: true, force: true });
		if (!tryDirectorySymlink(outside, manifest.artifactsRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		assert.throws(() => writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: "results/task.md", producer: "task", content: "secret" }), /Path is outside/);
		assert.equal(fs.existsSync(path.join(outside, "results", "task.md")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
