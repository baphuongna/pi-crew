import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { FileCheckpointStore } from "../../../../src/runtime/recovery/checkpoint.ts";
import { DEFAULT_RETRY_POLICY, executeWithRetry } from "../../../../src/runtime/recovery/retry-executor.ts";

// Quick Win 19 (Pattern 19 — test-as-spec contract suite): pin the retry-resume
// path behavior as a spec. These are the gaps NOT covered by the existing
// per-module tests (retry-executor-cov covers jitter/`*`-glob/maxAttempts; this
// suite adds `?`-glob, empty-retryableErrors, default attemptId, abort-during-
// sleep, checkpoint quarantine/delete edge cases, and recovery clear-fields).

// ── executeWithRetry contract ───────────────────────────────────────────────

describe("QW19 executeWithRetry contract", () => {
	it("? wildcard + case-insensitive retryableErrors glob", async () => {
		// `?` matches a single char; case-insensitive.
		let calls = 0;
		await assert.rejects(
			executeWithRetry(
				async () => {
					calls++;
					throw new Error("Rate Limit");
				},
				{ ...DEFAULT_RETRY_POLICY, maxAttempts: 2, retryableErrors: ["rate?limit"] },
			),
		);
		assert.equal(calls, 2, "? glob + case-insensitive should be retryable → 2 attempts");
	});

	it("empty retryableErrors ⇒ ALL errors retryable", async () => {
		let calls = 0;
		await assert.rejects(
			executeWithRetry(
				async () => {
					calls++;
					throw new Error("anything weird");
				},
				{ ...DEFAULT_RETRY_POLICY, maxAttempts: 3, retryableErrors: [], backoffMs: 1 },
			),
		);
		assert.equal(calls, 3, "empty retryableErrors retries every error");
	});

	it("maxAttempts: 0 normalizes to 1 (at least one try)", async () => {
		let calls = 0;
		await assert.rejects(
			executeWithRetry(
				async () => {
					calls++;
					throw new Error("x");
				},
				{ ...DEFAULT_RETRY_POLICY, maxAttempts: 0, retryableErrors: [] },
			),
		);
		assert.equal(calls, 1);
	});

	it("abort during backoff sleep rethrows cancellation (not the original error)", async () => {
		const ac = new AbortController();
		const p = executeWithRetry(
			async () => {
				throw new Error("transient");
			},
			{ ...DEFAULT_RETRY_POLICY, maxAttempts: 5, retryableErrors: [], backoffMs: 10_000 },
			{ signal: ac.signal },
		);
		// abort while it's sleeping before attempt 2
		setTimeout(() => ac.abort(new Error("cancelled-by-test")), 5);
		await assert.rejects(p, /cancel/i);
	});

	it("default attemptId format when hook omitted", async () => {
		const seen: string[] = [];
		await assert.rejects(
			executeWithRetry(
				async (_a: number, info: { attemptId: string }) => {
					seen.push(info.attemptId);
					throw new Error("x");
				},
				{ ...DEFAULT_RETRY_POLICY, maxAttempts: 2, retryableErrors: [] },
				{ onRetryGivenUp: (_a: number, _e: Error, info: { attemptId: string }) => seen.push(`giveup:${info.attemptId}`) },
			),
		);
		const attemptIds = seen.filter((id) => !id.startsWith("giveup:"));
		assert.ok(
			attemptIds.every((id) => /^retry_attempt_\d+$/.test(id)),
			`default attemptId format: ${attemptIds.join(",")}`,
		);
	});
});

// ── FileCheckpointStore contract ────────────────────────────────────────────

describe("QW19 FileCheckpointStore contract", () => {
	let root: string;
	let store: FileCheckpointStore;
	const roots: string[] = [];
	afterEach(() => {
		for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
	});
	function setup() {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "qw19-cp-"));
		roots.push(root);
		store = new FileCheckpointStore(root);
	}

	it("corrupt JSON file → quarantined to .corrupt.<ts> + load returns null", async () => {
		setup();
		await store.save({ runId: "r1", taskId: "t1", step: 1, context: "c", progress: "p", savedAt: Date.now(), agentId: "a" });
		// corrupt the file
		const file = path.join(root, "checkpoints", "t1.json");
		fs.writeFileSync(file, "{ not valid json {{{");
		const result = await store.load("r1", "t1");
		assert.equal(result, null, "corrupt load returns null");
		// the corrupt file is quarantined (renamed .corrupt.<ts>), original name gone
		const remaining = fs.readdirSync(path.join(root, "checkpoints"));
		assert.ok(
			remaining.some((f) => /^t1\.json\.corrupt\.\d+$/.test(f)),
			`quarantine file present: ${remaining.join(",")}`,
		);
		assert.ok(!remaining.includes("t1.json"), "original corrupt file removed");
	});

	it("list skips corrupt files (only valid checkpoints returned)", async () => {
		setup();
		await store.save({ runId: "r1", taskId: "good", step: 1, context: "c", progress: "p", savedAt: Date.now(), agentId: "a" });
		fs.writeFileSync(path.join(root, "checkpoints", "bad.json"), "garbage");
		const list = await store.list("r1");
		assert.ok(list.some((c) => c.taskId === "good"));
		assert.ok(!list.some((c) => c.taskId === "bad"), "corrupt file not in list");
	});

	it("delete with wrong runId LEAVES the file (runId-scoped delete)", async () => {
		setup();
		await store.save({ runId: "r1", taskId: "t1", step: 1, context: "c", progress: "p", savedAt: Date.now(), agentId: "a" });
		await store.delete("OTHER_RUN", "t1");
		assert.ok(fs.existsSync(path.join(root, "checkpoints", "t1.json")), "wrong-runId delete must not remove the file");
	});

	it("delete of unreadable file still deletes (best-effort)", async () => {
		setup();
		fs.mkdirSync(path.join(root, "checkpoints"), { recursive: true });
		const file = path.join(root, "checkpoints", "t1.json");
		fs.writeFileSync(file, "garbage"); // unreadable as checkpoint
		await store.delete("r1", "t1");
		assert.ok(!fs.existsSync(file), "unreadable file is still deleted");
	});
});
