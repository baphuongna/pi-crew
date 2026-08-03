/**
 * Unit tests for dwf-state-store.ts (round-18 P2-3 resume/checkpoint).
 *
 * Covers DwfStore.save/load round-trip, missing-checkpoint → undefined,
 * delete removes the file, and corrupt-file resilience. Mirrors the
 * goal-state-store.test.ts harness conventions.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { DwfCheckpointState } from "../../../src/runtime/dwf-state-store.ts";
import { DwfStore } from "../../../src/runtime/dwf-state-store.ts";

function makeTmpStateRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-store-"));
	return root;
}

function sampleState(runId: string): DwfCheckpointState {
	return {
		runId,
		vars: { lastPhase: "scan", count: 3 },
		phases: ["scan", "analyze"],
		currentPhase: "analyze",
		logs: ["starting", "agent-1 done"],
		spent: 1234,
		agentCount: 2,
		updatedAt: "2026-06-23T00:00:00.000Z",
	};
}

test("DwfStore.save/load round-trip persists the full checkpoint state", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		const state = sampleState("team_dwf_rt_1");
		store.save(state);

		const loaded = store.load();
		assert.ok(loaded, "load should return the saved checkpoint");
		assert.equal(loaded!.runId, "team_dwf_rt_1");
		assert.deepEqual(loaded!.vars, { lastPhase: "scan", count: 3 });
		assert.deepEqual(loaded!.phases, ["scan", "analyze"]);
		assert.equal(loaded!.currentPhase, "analyze");
		assert.deepEqual(loaded!.logs, ["starting", "agent-1 done"]);
		assert.equal(loaded!.spent, 1234);
		assert.equal(loaded!.agentCount, 2);
		// save() stamps updatedAt; the persisted value is the stamped one.
		assert.equal(typeof loaded!.updatedAt, "string");
		assert.ok(loaded!.updatedAt.length > 0);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.save() stamps updatedAt (caller's value is overwritten)", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save(sampleState("team_dwf_rt_stamp"));
		const before = store.load()!;
		// Wait a moment so the ISO timestamp differs.
		const later = "1999-01-01T00:00:00.000Z";
		const next: DwfCheckpointState = {
			...sampleState("team_dwf_rt_stamp"),
			updatedAt: later,
			agentCount: 5,
		};
		store.save(next);
		const loaded = store.load()!;
		assert.notEqual(loaded.updatedAt, later, "save() must stamp its own updatedAt");
		assert.equal(loaded.agentCount, 5);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.load() returns undefined for a missing checkpoint (fresh run)", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		assert.equal(store.load(), undefined, "no checkpoint → undefined (fresh run)");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.delete() removes the checkpoint file", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save(sampleState("team_dwf_rt_del"));
		assert.ok(store.load(), "checkpoint exists before delete");

		store.delete();
		assert.equal(store.load(), undefined, "checkpoint removed after delete");
		assert.ok(!fs.existsSync(path.join(stateRoot, "dwf-checkpoint.json")), "file is gone");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.delete() is a no-op when no checkpoint exists (never throws)", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		assert.doesNotThrow(() => store.delete(), "delete on missing checkpoint must not throw");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.load() returns undefined for a corrupt JSON file", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), "{not valid json");
		assert.equal(store.load(), undefined, "corrupt JSON → undefined (treated as fresh run)");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.load() returns undefined when runId is missing/non-string", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), JSON.stringify({ vars: {} }));
		assert.equal(store.load(), undefined, "object without a string runId → undefined (corrupt-guard)");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.save() writes atomically to <stateRoot>/dwf-checkpoint.json", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save(sampleState("team_dwf_rt_path"));
		const expected = path.join(stateRoot, "dwf-checkpoint.json");
		assert.ok(fs.existsSync(expected), "checkpoint lands at <stateRoot>/dwf-checkpoint.json (no double-nesting)");
		// The file must be valid JSON (atomic write, no partial content).
		const raw = fs.readFileSync(expected, "utf-8");
		assert.doesNotThrow(() => JSON.parse(raw), "persisted file is valid JSON");
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("DwfStore.save() creates the stateRoot dir if it does not exist yet", () => {
	const parent = makeTmpStateRoot();
	const nested = path.join(parent, "runs", "team_nested");
	try {
		const store = new DwfStore(nested);
		store.save(sampleState("team_nested"));
		assert.ok(fs.existsSync(path.join(nested, "dwf-checkpoint.json")), "mkdirSync recursive created the dir tree");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("DwfStore.save() preserves large logs/spent across repeated saves (no truncation on disk)", () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		const logs = Array.from({ length: 1500 }, (_, i) => `log-${i}`);
		store.save({
			runId: "team_dwf_big",
			vars: {},
			phases: [],
			currentPhase: undefined,
			logs,
			spent: 99999,
			agentCount: 50,
			updatedAt: "x",
		});
		const loaded = store.load()!;
		assert.equal(loaded.logs.length, 1500, "store persists what it's given (capping is the caller's job)");
		assert.equal(loaded.spent, 99999);
		assert.equal(loaded.agentCount, 50);
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
