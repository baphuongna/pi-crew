import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createResultWatcher } from "../../src/extension/result-watcher.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("result watcher primes existing JSON results and emits completion payloads", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-result-watcher-"));
	const emitted: unknown[] = [];
	try {
		fs.writeFileSync(path.join(dir, "one.json"), JSON.stringify({ runId: "one", status: "completed" }), "utf-8");
		const watcher = createResultWatcher({ emit: (_event, data) => emitted.push(data) }, dir);
		watcher.prime();
		await wait(20);
		watcher.stop();
		assert.deepEqual(emitted, [{ runId: "one", status: "completed" }]);
		assert.equal(fs.existsSync(path.join(dir, "one.json")), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("result watcher dedupes duplicate completion payloads within ttl", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-result-watcher-dedupe-"));
	const emitted: unknown[] = [];
	try {
		fs.writeFileSync(path.join(dir, "one.json"), JSON.stringify({ runId: "same", status: "completed" }), "utf-8");
		fs.writeFileSync(path.join(dir, "two.json"), JSON.stringify({ runId: "same", status: "completed" }), "utf-8");
		const watcher = createResultWatcher({ emit: (_event, data) => emitted.push(data) }, dir, { completionTtlMs: 60_000 });
		watcher.prime();
		await wait(30);
		watcher.stop();
		assert.equal(emitted.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("result watcher suppresses stale primed results", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-result-watcher-stale-"));
	const emitted: unknown[] = [];
	try {
		fs.writeFileSync(path.join(dir, "stale.json"), JSON.stringify({ runId: "stale", status: "completed" }), "utf-8");
		const watcher = createResultWatcher({ emit: (_event, data) => emitted.push(data) }, dir, { isCurrent: () => false });
		watcher.prime();
		await wait(20);
		watcher.stop();
		assert.deepEqual(emitted, []);
		assert.equal(fs.existsSync(path.join(dir, "stale.json")), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("result watcher does not restart when generation is stale", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-result-watcher-stale-restart-"));
	let watchCalls = 0;
	let current = true;
	try {
		const watcher = createResultWatcher({ emit: () => {} }, dir, {
			isCurrent: () => current,
			watch: (_resultsDir, _listener, onError) => {
				watchCalls += 1;
				onError();
				return null;
			},
		});
		watcher.start();
		await wait(50);
		assert.equal(watchCalls, 1);
		current = false;
		await wait(3500);
		assert.equal(watchCalls, 1);
		watcher.stop();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("result watcher restarts after watch error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-result-watcher-restart-"));
	let watchCalls = 0;
	const emitted: unknown[] = [];
	try {
		const watcher = createResultWatcher({ emit: (_event, data) => emitted.push(data) }, dir, {
			watch: (_resultsDir, _listener, onError) => {
				watchCalls += 1;
				onError();
				return null;
			},
		});
		watcher.start();
		await wait(50);
		assert.equal(watchCalls, 1);
		await wait(3500);
		assert.equal(watchCalls >= 2, true);
		watcher.stop();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});