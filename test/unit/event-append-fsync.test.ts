/**
 * P0-4 regression guard: async event append fsync reduction — correctness.
 *
 * The fix: the pid lock file + .seq sidecar are written best-effort (disposable),
 * and the data fsync mirrors the sync path's F3a rule (terminal events only).
 * Non-terminal async appends drop from 5 fsyncs to 0; terminal events keep the
 * single data fsync.
 *
 * The fsync *count* reduction is proven structurally (atomicWriteFile's
 * best-effort path skips fsyncSync — covered by atomic-write tests — and the
 * data `if (isTerminal) await fd.sync()` mirrors the already-tested sync F3a).
 * This test guards that correctness is preserved: events still persist + seq
 * stays monotonic after the durability relaxation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { appendEventAsync, readEvents } from "../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";

const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

function buildManifest(cwd: string) {
	return createRunManifest({
		cwd,
		team: { name: "fsync-team", description: "", source: "builtin", filePath: "", roles: [{ name: "explorer", agent: "explorer" }] },
		workflow: { name: "fsync", description: "", source: "builtin", filePath: "", steps: [] },
		goal: "fsync",
	}).manifest;
}

test("P0-4: non-terminal then terminal appends all persist with monotonic seq", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fsync-correct-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	// Non-terminal events (F3a: no data fsync) + one terminal event (data fsync).
	for (let i = 0; i < 5; i++) {
		await appendEventAsync(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, taskId: "t1", message: `p${i}` });
	}
	await appendEventAsync(manifest.eventsPath, { type: "run.completed", runId: manifest.runId });

	const events = readEvents(manifest.eventsPath);
	assert.equal(events.length, 7, "run.created + 5 progress + 1 completed all persisted");
	// seq (metadata.seq) monotonic.
	const seqs = events.map((e) => (e.metadata as { seq?: number } | undefined)?.seq ?? 0);
	for (let i = 1; i < seqs.length; i++) {
		assert.ok(seqs[i]! > seqs[i - 1]!, `seq monotonic: ${seqs.join(",")}`);
	}
	assert.equal(events[6]!.type, "run.completed", "terminal event persisted (durable)");
});

test("P0-4: appendEventAsync preserves the F3a terminal-fsync invariant (terminal readable immediately)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fsync-terminal-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	// A terminal event must be durably fsync'd (the F3a mirror keeps it) so it
	// survives a crash. Within the process it's immediately readable.
	await appendEventAsync(manifest.eventsPath, { type: "run.failed", runId: manifest.runId });
	const events = readEvents(manifest.eventsPath);
	assert.equal(events.length, 2, "run.created + run.failed");
	assert.equal(events[1]!.type, "run.failed");
});
