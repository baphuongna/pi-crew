import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { importRunBundle } from "../../src/extension/run-import.ts";

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

function bundle(runId: string) {
	return {
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
		manifest: {
			schemaVersion: 1,
			runId,
			team: "default",
			goal: "import",
			status: "completed",
			workspaceMode: "single",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: process.cwd(),
			stateRoot: "state",
			artifactsRoot: "artifacts",
			tasksPath: "tasks.json",
			eventsPath: "events.jsonl",
			artifacts: [],
		},
		tasks: [],
		events: [],
		artifactPaths: [],
	};
}

test("importRunBundle rejects unsafe run ids", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-import-safe-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const bundlePath = path.join(cwd, "bundle.json");
		fs.writeFileSync(bundlePath, JSON.stringify(bundle("../outside")), "utf-8");
		assert.throws(() => importRunBundle(cwd, bundlePath), /Invalid runId/);
		assert.equal(fs.existsSync(path.join(cwd, "outside", "run-export.json")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("importRunBundle rejects symlinked imports root", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-import-root-symlink-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const bundlePath = path.join(cwd, "bundle.json");
		const runId = "safe_root_run";
		fs.writeFileSync(bundlePath, JSON.stringify(bundle(runId)), "utf-8");
		const outside = path.join(cwd, "outside-imports-root");
		fs.mkdirSync(outside, { recursive: true });
		const importsRoot = path.join(cwd, ".crew", "imports");
		if (!tryDirectorySymlink(outside, importsRoot)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		assert.throws(() => importRunBundle(cwd, bundlePath), /Invalid import root|Path is outside/);
		assert.equal(fs.existsSync(path.join(outside, runId, "run-export.json")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("importRunBundle rejects symlinked import directories", (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-import-symlink-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew", "imports"), { recursive: true });
		const bundlePath = path.join(cwd, "bundle.json");
		const runId = "safe_run";
		fs.writeFileSync(bundlePath, JSON.stringify(bundle(runId)), "utf-8");
		const outside = path.join(cwd, "outside-import");
		fs.mkdirSync(outside, { recursive: true });
		const importDir = path.join(cwd, ".crew", "imports", runId);
		if (!tryDirectorySymlink(outside, importDir)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		assert.throws(() => importRunBundle(cwd, bundlePath), /Invalid import directory|Path is outside/);
		assert.equal(fs.existsSync(path.join(outside, "run-export.json")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
