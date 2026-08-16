import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deliverGroupJoin, resolveGroupJoinMode, shouldGroupJoin } from "../../../../src/runtime/group-join.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

/**
 * Round 25 (test coverage gaps): `group-join.ts` provides group-join mode
 * resolution, predicate logic, and the deliverGroupJoin delivery path.
 *
 * Tests cover the live exported surface: resolveGroupJoinMode,
 * shouldGroupJoin, and deliverGroupJoin (artifact + mailbox + event writes).
 * The dead GroupJoinManager class was removed (Round 6 F3: 0 production call
 * sites); its class-only tests were deleted with it.
 */

function makeTask(id: string, status: string): any {
	return { id, status, title: `task ${id}` };
}

function makeManifest(dir: string): TeamRunManifest {
	const stateRoot = path.join(dir, "state");
	const artifactsRoot = path.join(dir, "artifacts");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	return {
		schemaVersion: "1.0" as any,
		runId: "run_gj",
		team: "default",
		goal: "test group join",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: dir,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	} as unknown as TeamRunManifest;
}

function readOutbox(manifest: TeamRunManifest): any[] {
	const file = path.join(manifest.stateRoot, "mailbox", "outbox.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

// ─── resolveGroupJoinMode ──────────────────────────────────────────────────

test("resolveGroupJoinMode: returns 'smart' by default", () => {
	assert.equal(resolveGroupJoinMode(undefined), "smart");
});

test("resolveGroupJoinMode: returns configured mode", () => {
	assert.equal(resolveGroupJoinMode({ groupJoin: "off" } as any), "off");
	assert.equal(resolveGroupJoinMode({ groupJoin: "group" } as any), "group");
	assert.equal(resolveGroupJoinMode({ groupJoin: "smart" } as any), "smart");
});

// ─── shouldGroupJoin ───────────────────────────────────────────────────────

test("shouldGroupJoin: 'off' mode always returns false", () => {
	assert.equal(shouldGroupJoin("off", [{ status: "completed" } as any]), false);
	assert.equal(shouldGroupJoin("off", []), false);
});

test("shouldGroupJoin: 'group' mode returns true for any non-empty batch", () => {
	assert.equal(shouldGroupJoin("group", [{ status: "completed" } as any]), true);
	assert.equal(shouldGroupJoin("group", []), false);
});

test("shouldGroupJoin: 'smart' mode returns true only for batch size > 1", () => {
	assert.equal(shouldGroupJoin("smart", []), false);
	assert.equal(shouldGroupJoin("smart", [{ status: "completed" } as any]), false);
	assert.equal(shouldGroupJoin("smart", [{ status: "completed" } as any, { status: "completed" } as any]), true);
});

// ─── deliverGroupJoin (live delivery path) ─────────────────────────────────

test("deliverGroupJoin: returns undefined when batch does not qualify", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-"));
	try {
		const manifest = makeManifest(dir);
		// smart mode with a single task → shouldGroupJoin false → no delivery
		const delivery = deliverGroupJoin({
			manifest,
			mode: "smart",
			batch: [makeTask("01", "completed")],
			allTasks: [makeTask("01", "completed")],
		});
		assert.equal(delivery, undefined);
		assert.equal(readOutbox(manifest).length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("deliverGroupJoin: writes artifact, mailbox message, and completed event", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-"));
	try {
		const manifest = makeManifest(dir);
		const batch = [makeTask("01", "completed"), makeTask("02", "completed")];
		const delivery = deliverGroupJoin({
			manifest,
			mode: "smart",
			batch,
			allTasks: batch,
		});

		assert.ok(delivery);
		assert.ok(delivery.artifact);
		assert.equal(delivery.partial, false);
		assert.deepEqual(delivery.completed.sort(), ["01", "02"]);
		assert.deepEqual(delivery.failed, []);
		assert.deepEqual(delivery.remaining, []);
		assert.equal(delivery.ackRequired, true);
		assert.equal(delivery.ackStatus, "pending");

		// Artifact content is the serialized delivery JSON
		assert.ok(fs.existsSync(delivery.artifact!.path));
		assert.match(fs.readFileSync(delivery.artifact!.path, "utf-8"), /"partial": false/);

		// One outbox message with group_join data carrying the requestId
		const outbox = readOutbox(manifest);
		assert.equal(outbox.length, 1);
		assert.equal(outbox[0].data.kind, "group_join");
		assert.equal(outbox[0].data.requestId, delivery.requestId);
		assert.equal(outbox[0].id, delivery.messageId);

		// Event log records the completion delivery
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.completed/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("deliverGroupJoin: reuses existing mailbox message on repeat delivery", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-"));
	try {
		const manifest = makeManifest(dir);
		const batch = [makeTask("01", "completed"), makeTask("02", "completed")];
		const first = deliverGroupJoin({ manifest, mode: "smart", batch, allTasks: batch });
		assert.ok(first);

		const second = deliverGroupJoin({ manifest, mode: "smart", batch, allTasks: batch });
		assert.ok(second);
		assert.equal(second.messageId, first.messageId);

		// Still exactly one outbox message — the second call reused it
		assert.equal(readOutbox(manifest).length, 1);
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.delivery_reused/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("deliverGroupJoin: partial=true when queued tasks remain, event type reflects it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-"));
	try {
		const manifest = makeManifest(dir);
		// Partial = some members of the delivered batch are still queued/running
		// (remaining is computed from batch members found in allTasks).
		const batch = [makeTask("01", "completed"), makeTask("02", "completed"), makeTask("03", "queued")];
		const delivery = deliverGroupJoin({ manifest, mode: "smart", batch, allTasks: batch });

		assert.ok(delivery);
		assert.equal(delivery.partial, true);
		assert.deepEqual(delivery.remaining, ["03"]);
		assert.match(fs.readFileSync(manifest.eventsPath, "utf-8"), /agent\.group_join\.partial/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
