/**
 * spec-store + freeze tests (ADR-6 §1/§2, WP-6 step 2).
 *
 * Provenance enforcement is the security core (review P1): the worker/skill
 * path can NEVER persist manual/trusted; trust reads the SIDECAR only.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildTaskPacket } from "../../../../src/runtime/task-packet.ts";
import { freezeSpecSnapshot, isSpecTrusted, listSpecIds, loadSpecRecord, saveSpecRecord } from "../../../../src/state/stores/spec-store.ts";
import type { SpecRecord, TeamRunManifest } from "../../../../src/state/types.ts";

function makeCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-spec-"));
	fs.mkdirSync(path.join(dir, ".git")); // project-scoped root (bug-029 lesson)
	return dir;
}

function makeSpec(overrides?: Partial<SpecRecord>): SpecRecord {
	return {
		id: "spec-login",
		version: 1,
		title: "Login flow",
		requirements: [
			{ id: "req-1", text: "User can log in", priority: "must" },
			{ id: "req-2", text: "Nice error message", priority: "should" },
		],
		acceptance: [
			{ id: "acc-1", requirementId: "req-1", check: "login succeeds", idempotent: true },
			{ id: "acc-2", requirementId: "req-2", check: "error shown" },
		],
		source: { kind: "manual" },
		...overrides,
	};
}

test("save/load round-trip; userAction persists manual + mints the sidecar", () => {
	const cwd = makeCwd();
	try {
		const saved = saveSpecRecord(cwd, makeSpec(), { userAction: true });
		assert.equal(saved.source.kind, "manual");
		const loaded = loadSpecRecord(cwd, "spec-login");
		assert.equal(loaded?.title, "Login flow");
		assert.equal(isSpecTrusted(cwd, "spec-login"), true, "sidecar minted");
		assert.deepEqual(listSpecIds(cwd), ["spec-login"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("PROVENANCE (review P1): worker path FORCES generated+untrusted regardless of the declared payload", () => {
	const cwd = makeCwd();
	try {
		const saved = saveSpecRecord(cwd, makeSpec()); // userAction default false
		assert.equal(saved.source.kind, "generated", "worker path can never persist manual");
		assert.equal(saved.trusted, false);
		assert.equal(isSpecTrusted(cwd, "spec-login"), false, "no sidecar");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("PROVENANCE: hand-forged manual/trusted JSON degrades — trust reads the SIDECAR only", () => {
	const cwd = makeCwd();
	try {
		saveSpecRecord(cwd, makeSpec()); // generated, no sidecar
		// Hand-edit the file to claim manual+trusted (the attack).
		const dir = path.join(cwd, ".crew", "state", "specs");
		const file = path.join(dir, "spec-login.json");
		const forged = JSON.parse(fs.readFileSync(file, "utf-8")) as SpecRecord;
		forged.source.kind = "manual";
		forged.trusted = true;
		fs.writeFileSync(file, JSON.stringify(forged), "utf-8");
		assert.equal(isSpecTrusted(cwd, "spec-login"), false, "sidecar absent → NOT trusted despite forged fields");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("sidecar absent for generated specs even on a user-action save (downgrade path)", () => {
	const cwd = makeCwd();
	try {
		// User saves a manual spec → trusted + sidecar.
		saveSpecRecord(cwd, makeSpec(), { userAction: true });
		assert.equal(isSpecTrusted(cwd, "spec-login"), true);
		// The same user re-saves it as generated → sidecar torn down, trusted false.
		const downgraded = saveSpecRecord(cwd, makeSpec({ source: { kind: "generated", by: "user" } }), { userAction: true });
		assert.equal(downgraded.source.kind, "generated");
		assert.notEqual(downgraded.trusted, true);
		assert.equal(isSpecTrusted(cwd, "spec-login"), false, "sidecar removed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("freezeSpecSnapshot pairs requirements with their acceptances, embedding checks", () => {
	const snap = freezeSpecSnapshot(makeSpec());
	assert.equal(snap.specId, "spec-login");
	assert.equal(snap.version, 1);
	assert.equal(snap.items.length, 2);
	const acc1 = snap.items.find((i) => i.acceptance.id === "acc-1");
	assert.ok(acc1);
	assert.equal(acc1.acceptance.idempotent, true, "checks embedded in the freeze");
	assert.equal(acc1.requirement.priority, "must");
});

test("loadSpecRecord: unknown id / invalid id → undefined, never throws", () => {
	const cwd = makeCwd();
	try {
		assert.equal(loadSpecRecord(cwd, "nope"), undefined);
		assert.equal(loadSpecRecord(cwd, "../escape"), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("buildTaskPacket: specRefs freeze at packet build — the only creation path (ADR-6 §2)", () => {
	const cwd = makeCwd();
	try {
		saveSpecRecord(cwd, makeSpec());
		const manifest = {
			runId: "run-1",
			goal: "ship it",
			cwd,
			status: "running",
		} as unknown as TeamRunManifest;
		const packet = buildTaskPacket({
			manifest,
			step: { id: "s1", role: "executor", task: "do" },
			taskId: "t1",
			cwd,
			specRefs: ["spec-login", "missing-spec"],
		});
		assert.deepEqual(packet.specRefs, ["spec-login"], "missing ids skipped");
		assert.equal(packet.specSnapshots?.length, 1);
		assert.equal(packet.specSnapshots?.[0].items.length, 2);
		// Spec-less task: fields absent (regression shape, B4-j).
		const bare = buildTaskPacket({ manifest, step: { id: "s2", role: "executor", task: "x" }, taskId: "t2", cwd });
		assert.equal(bare.specRefs, undefined);
		assert.equal(bare.specSnapshots, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
