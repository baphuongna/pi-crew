import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { serialize } from "node:v8";
import { SNAPSHOT_MAX_BYTES } from "../../../src/prompt/scratchpad-lifecycle.ts";
import { EngineManager } from "../../../src/runtime/scratchpad/engine.ts";
import { findLatestScratchpadSnapshot } from "../../../src/runtime/scratchpad/snapshot-lookup.ts";
import { writeArtifact } from "../../../src/state/stores/artifact-store.ts";

// Phase 2 — P2-T5: end-to-end restore across an attempt boundary (D1/D4/D6/D13).
// Deterministic, in-process: engine1 executes + snapshots → writeArtifact (real
// redaction) → findLatestScratchpadSnapshot → engine2.restoreState → execute
// sees the revived vars. Pins the cross-attempt contract on the real engine,
// not a mock.

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeArtifacts(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "p2-e2e-"));
	roots.push(root);
	const artifacts = path.join(root, "artifacts");
	fs.mkdirSync(path.join(artifacts, "scratchpad"), { recursive: true });
	return artifacts;
}

function makeEngine(): EngineManager {
	return new EngineManager({
		env: { PI_CREW_KIND: "subagent", PI_CREW_PARENT_PID: String(process.pid), PI_CREW_GUEST: "1" },
	});
}

/** Flush engine1's namespace into a redacted artifact, mirroring the lifecycle. */
async function flushToArtifact(engine: EngineManager, artifacts: string, taskId: string, attempt: number): Promise<void> {
	const tempPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p2-e2e-snap-")), `${taskId}.snapshot.json`);
	roots.push(path.dirname(tempPath));
	const snap = await engine.snapshotState(tempPath);
	assert.ok(snap, "snapshotState must succeed while running");
	await writeArtifact(artifacts, {
		kind: "result",
		relativePath: `scratchpad/${taskId}.attempt-${attempt}.snapshot.json`,
		content: await fs.promises.readFile(tempPath, "utf8"),
		producer: taskId,
	});
}

describe("P2-T5 restore end-to-end (D1/D4/D6/D13)", () => {
	it("cross-attempt: engine2 revives engine1's vars from the artifact (D1)", async () => {
		const artifacts = makeArtifacts();
		const engine1 = makeEngine();
		try {
			await engine1.execute("const data = { count: 41, items: [1,2,3] }; data.count + 1");
			await flushToArtifact(engine1, artifacts, "task-e2e", 0);
		} finally {
			await engine1.kill();
		}
		// locate the just-written artifact via the production lookup
		const hit = findLatestScratchpadSnapshot(artifacts, "task-e2e");
		assert.ok(hit, "lookup must find the artifact");
		assert.equal(hit.attempt, 0);
		// restore into a fresh engine
		const engine2 = makeEngine();
		try {
			const r = await engine2.restoreState(hit.path);
			assert.ok(r, "restoreState must succeed");
			assert.ok(r.restored.includes("data"), "data var must be in restored list");
			// the revived cell sees the prior namespace
			const res = await engine2.execute("data.count");
			assert.match(String(res.result), /41/);
		} finally {
			await engine2.kill();
		}
	});

	it('D4: a redacted secret-keyed var restores as the literal placeholder "***" (MAJOR-S2)', async () => {
		const artifacts = makeArtifacts();
		// Plant a snapshot whose apiKey was redacted to "***" by writeArtifact.
		// (Simulate post-redaction content: vars.base64 of {data}, vars.apiKey="***".)
		const dataB64 = serialize({ ok: true }).toString("base64");
		const content = JSON.stringify({ version: 1, vars: { data: dataB64, apiKey: "***" }, failed: [] });
		const file = path.join(artifacts, "scratchpad", "task-redact.attempt-0.snapshot.json");
		fs.writeFileSync(file, content);
		const hit = findLatestScratchpadSnapshot(artifacts, "task-redact");
		assert.ok(hit);
		const engine = makeEngine();
		try {
			const r = await engine.restoreState(hit.path);
			assert.ok(r);
			assert.ok(r.restored.includes("data"), "benign var restored");
			assert.ok(r.restored.includes("apiKey"), "redacted var restored as placeholder (D4 special-case)");
			const res = await engine.execute("String(apiKey)");
			assert.equal(String(res.result).trim().replace(/['"]/g, ""), "***");
		} finally {
			await engine.kill();
		}
	});

	it("D13: a base64 var corrupted by flat redaction lands in failed[] (MINOR-S4)", async () => {
		const artifacts = makeArtifacts();
		// A base64 payload that, after a flat "***" injection, no longer round-trips.
		const good = serialize("hello world").toString("base64");
		const corrupted = good.slice(0, 3) + "***" + good.slice(3); // invalid base64 round-trip
		const content = JSON.stringify({ version: 1, vars: { good: good, bad: corrupted }, failed: [] });
		const file = path.join(artifacts, "scratchpad", "task-rt.attempt-0.snapshot.json");
		fs.writeFileSync(file, content);
		const hit = findLatestScratchpadSnapshot(artifacts, "task-rt");
		assert.ok(hit);
		const engine = makeEngine();
		try {
			const r = await engine.restoreState(hit.path);
			assert.ok(r);
			assert.ok(r.restored.includes("good"), "clean var restored");
			assert.ok(
				r.failed.some((f) => f.name === "bad"),
				"corrupted var must land in failed (not silent wrong value)",
			);
		} finally {
			await engine.kill();
		}
	});

	it("D6 read-side: restore refuses a file larger than SNAPSHOT_MAX_BYTES", async () => {
		const artifacts = makeArtifacts();
		// NIT-E2E-2: importing SNAPSHOT_MAX_BYTES from lifecycle also acts as a
		// drift-pin against engine.ts's private copy (same 4MB value, no shared
		// const to avoid a lifecycle↔engine cycle).
		const file = path.join(artifacts, "scratchpad", "task-big.attempt-0.snapshot.json");
		fs.writeFileSync(file, Buffer.alloc(SNAPSHOT_MAX_BYTES + 100, "x"));
		const hit = findLatestScratchpadSnapshot(artifacts, "task-big");
		assert.ok(hit);
		const engine = makeEngine();
		try {
			const r = await engine.restoreState(hit.path);
			assert.equal(r, null, "oversized file must be refused (fail-open, no restore)");
		} finally {
			await engine.kill();
		}
	});

	it("D6 per-var: a single var larger than the per-var cap lands in failed[]", async () => {
		const artifacts = makeArtifacts();
		// A single ~1MB var — well above the guest per-var cap (256 KiB) but under
		// the file cap. Must be rejected per-var, not restored.
		const bigB64 = serialize("y".repeat(1024 * 1024)).toString("base64");
		const content = JSON.stringify({ version: 1, vars: { huge: bigB64, tiny: serialize(1).toString("base64") }, failed: [] });
		const file = path.join(artifacts, "scratchpad", "task-pervar.attempt-0.snapshot.json");
		fs.writeFileSync(file, content);
		const hit = findLatestScratchpadSnapshot(artifacts, "task-pervar");
		assert.ok(hit);
		const engine = makeEngine();
		try {
			const r = await engine.restoreState(hit.path);
			assert.ok(r);
			assert.ok(r.restored.includes("tiny"), "small var restored");
			assert.ok(
				r.failed.some((f) => f.name === "huge"),
				"oversized var rejected per-var",
			);
		} finally {
			await engine.kill();
		}
	});
});
