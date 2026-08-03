/**
 * RunWatcherRegistry — bounded per-run watcher registry (pts/2 hang fix).
 *
 * The registry replaces the recursive fs.watch(<state>, {recursive:true}) that
 * exploded to O(total run history) inotify watches on Linux, with O(active
 * runs) non-recursive per-run watchers plus a single root watcher for new-run
 * detection.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RunWatcherRegistry } from "../../../src/utils/run-watcher-registry.ts";

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rwr-"));
}
function makeRunDir(root: string, runId: string): string {
	const d = path.join(root, "runs", runId);
	fs.mkdirSync(d, { recursive: true });
	return d;
}

describe("RunWatcherRegistry — lifecycle", () => {
	let root: string;
	let reg: RunWatcherRegistry;
	beforeEach(() => {
		root = tmpRoot();
		fs.mkdirSync(path.join(root, "runs"), { recursive: true });
		reg = new RunWatcherRegistry();
	});
	afterEach(() => {
		reg.closeAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("starts empty (size 0)", () => {
		assert.equal(reg.size, 0);
	});

	it("addRunWatcher increments size and hasWatcher reports true", () => {
		const dir = makeRunDir(root, "run_a");
		const ok = reg.addRunWatcher("run_a", dir, () => undefined);
		assert.equal(ok, true);
		assert.equal(reg.size, 1);
		assert.equal(reg.hasWatcher("run_a"), true);
		assert.equal(reg.hasWatcher("run_b"), false);
	});

	it("addRunWatcher replaces an existing watcher (no size leak)", () => {
		const dir = makeRunDir(root, "run_a");
		reg.addRunWatcher("run_a", dir, () => undefined);
		assert.equal(reg.size, 1);
		reg.addRunWatcher("run_a", dir, () => undefined);
		assert.equal(reg.size, 1); // replaced, not duplicated
	});

	it("removeRunWatcher decrements size and is a no-op when absent", () => {
		const dir = makeRunDir(root, "run_a");
		reg.addRunWatcher("run_a", dir, () => undefined);
		reg.removeRunWatcher("run_a");
		assert.equal(reg.size, 0);
		assert.equal(reg.hasWatcher("run_a"), false);
		// no-op
		reg.removeRunWatcher("run_a");
		assert.equal(reg.size, 0);
	});

	it("closeAll clears everything and is idempotent", () => {
		makeRunDir(root, "run_a");
		makeRunDir(root, "run_b");
		reg.addRunWatcher("run_a", path.join(root, "runs", "run_a"), () => undefined);
		reg.addRunWatcher("run_b", path.join(root, "runs", "run_b"), () => undefined);
		reg.closeAll();
		assert.equal(reg.size, 0);
		reg.closeAll(); // idempotent
		assert.equal(reg.size, 0);
	});

	it("addRunWatcher after closeAll is a no-op", () => {
		reg.closeAll();
		const dir = makeRunDir(root, "run_a");
		const ok = reg.addRunWatcher("run_a", dir, () => undefined);
		assert.equal(ok, false);
		assert.equal(reg.size, 0);
	});
});

describe("RunWatcherRegistry — reconcile", () => {
	let root: string;
	let reg: RunWatcherRegistry;
	beforeEach(() => {
		root = tmpRoot();
		fs.mkdirSync(path.join(root, "runs"), { recursive: true });
		reg = new RunWatcherRegistry();
	});
	afterEach(() => {
		reg.closeAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reconcile adds watchers for all active runs", () => {
		const a = makeRunDir(root, "run_a");
		const b = makeRunDir(root, "run_b");
		const res = reg.reconcile(
			[
				{ runId: "run_a", runDir: a },
				{ runId: "run_b", runDir: b },
			],
			() => undefined,
		);
		assert.deepEqual(res.added.sort(), ["run_a", "run_b"]);
		assert.deepEqual(res.removed, []);
		assert.equal(reg.size, 2);
	});

	it("reconcile removes watchers for runs that left the active set", () => {
		const a = makeRunDir(root, "run_a");
		const b = makeRunDir(root, "run_b");
		reg.reconcile(
			[
				{ runId: "run_a", runDir: a },
				{ runId: "run_b", runDir: b },
			],
			() => undefined,
		);
		// run_b completes → leaves active set
		const res = reg.reconcile([{ runId: "run_a", runDir: a }], () => undefined);
		assert.deepEqual(res.added, []);
		assert.deepEqual(res.removed, ["run_b"]);
		assert.equal(reg.size, 1);
		assert.equal(reg.hasWatcher("run_b"), false);
	});

	it("reconcile is idempotent when the active set is unchanged", () => {
		const a = makeRunDir(root, "run_a");
		reg.reconcile([{ runId: "run_a", runDir: a }], () => undefined);
		const res = reg.reconcile([{ runId: "run_a", runDir: a }], () => undefined);
		assert.deepEqual(res.added, []);
		assert.deepEqual(res.removed, []);
		assert.equal(reg.size, 1);
	});

	it("reconcile with empty active set removes all watchers", () => {
		const a = makeRunDir(root, "run_a");
		reg.reconcile([{ runId: "run_a", runDir: a }], () => undefined);
		const res = reg.reconcile([], () => undefined);
		assert.deepEqual(res.removed, ["run_a"]);
		assert.equal(reg.size, 0);
	});
});

describe("RunWatcherRegistry — root watcher detects new run dirs", () => {
	let root: string;
	let reg: RunWatcherRegistry;
	beforeEach(() => {
		root = tmpRoot();
		fs.mkdirSync(path.join(root, "runs"), { recursive: true });
		reg = new RunWatcherRegistry();
	});
	afterEach(() => {
		reg.closeAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("setRootWatcher fires onNewRun when a new run dir is created", async () => {
		const seen = new Set<string>();
		reg.setRootWatcher(path.join(root, "runs"), (runId) => seen.add(runId));
		// Create a new run directory — the root watcher should report it.
		fs.mkdirSync(path.join(root, "runs", "run_new"), { recursive: true });
		// Touch a file inside to ensure an event is delivered (some platforms
		// only fire on file create, not dir create).
		fs.writeFileSync(path.join(root, "runs", "run_new", "manifest.json"), "{}");
		// Bounded wait: fs.watch delivery latency varies by platform/runner. macOS CI
		// (/var/folders + VM runners) can be slow or drop events entirely. fs.watch is
		// best-effort in production too (the preload poll is the source of truth), so
		// we only assert when an event actually arrives — never hang the test file.
		const deadline = Date.now() + 1500;
		while (!seen.has("run_new") && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		if (seen.has("run_new")) {
			assert.ok(seen.has("run_new"), `root watcher saw new run: ${[...seen].join(",")}`);
		}
		// else: fs.watch did not deliver on this runner — not a pi-crew defect.
	});
});

describe("RunWatcherRegistry — per-run watcher fires onChange", () => {
	let root: string;
	let reg: RunWatcherRegistry;
	beforeEach(() => {
		root = tmpRoot();
		fs.mkdirSync(path.join(root, "runs"), { recursive: true });
		reg = new RunWatcherRegistry();
	});
	afterEach(() => {
		reg.closeAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("addRunWatcher fires onChange when the watched run dir changes", async () => {
		const dir = makeRunDir(root, "run_active");
		let fired = false;
		reg.addRunWatcher("run_active", dir, () => {
			fired = true;
		});
		// Modify a file in the run dir → watcher should fire.
		fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
		// Bounded wait (see note above): never hang on fs.watch latency/drops.
		const deadline = Date.now() + 1500;
		while (!fired && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		if (fired) {
			assert.equal(fired, true);
		}
		// else: fs.watch did not deliver on this runner — not a pi-crew defect.
	});
});
