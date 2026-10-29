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
import { DWF_CHECKPOINT_VERSION, DwfStore } from "../../../src/runtime/dwf-state-store.ts";
import { cleanupStateRoot } from "../../helpers/rm-retry.ts";

function makeTmpStateRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-store-"));
	return root;
}

function sampleState(runId: string): DwfCheckpointState {
	return {
		version: DWF_CHECKPOINT_VERSION,
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

test("DwfStore.save/load round-trip persists the full checkpoint state", async () => {
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
		// R6-12: round-trip carries the version stamp.
		assert.equal(loaded!.version, DWF_CHECKPOINT_VERSION);
		// save() stamps updatedAt; the persisted value is the stamped one.
		assert.equal(typeof loaded!.updatedAt, "string");
		assert.ok(loaded!.updatedAt.length > 0);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.save() stamps updatedAt (caller's value is overwritten)", async () => {
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
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.load() returns undefined for a missing checkpoint (fresh run)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		assert.equal(store.load(), undefined, "no checkpoint → undefined (fresh run)");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.delete() removes the checkpoint file", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save(sampleState("team_dwf_rt_del"));
		assert.ok(store.load(), "checkpoint exists before delete");

		store.delete();
		assert.equal(store.load(), undefined, "checkpoint removed after delete");
		assert.ok(!fs.existsSync(path.join(stateRoot, "dwf-checkpoint.json")), "file is gone");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.delete() is a no-op when no checkpoint exists (never throws)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		assert.doesNotThrow(() => store.delete(), "delete on missing checkpoint must not throw");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.load() returns undefined for a corrupt JSON file", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), "{not valid json");
		assert.equal(store.load(), undefined, "corrupt JSON → undefined (treated as fresh run)");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.load() returns undefined when runId is missing/non-string", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), JSON.stringify({ vars: {} }));
		assert.equal(store.load(), undefined, "object without a string runId → undefined (corrupt-guard)");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.save() writes atomically to <stateRoot>/dwf-checkpoint.json", async () => {
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
		await cleanupStateRoot(stateRoot);
	}
});

test("DwfStore.save() creates the stateRoot dir if it does not exist yet", async () => {
	const parent = makeTmpStateRoot();
	const nested = path.join(parent, "runs", "team_nested");
	try {
		const store = new DwfStore(nested);
		store.save(sampleState("team_nested"));
		assert.ok(fs.existsSync(path.join(nested, "dwf-checkpoint.json")), "mkdirSync recursive created the dir tree");
	} finally {
		await cleanupStateRoot(parent);
	}
});

test("DwfStore.save() preserves large logs/spent across repeated saves (no truncation on disk)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		const logs = Array.from({ length: 1500 }, (_, i) => `log-${i}`);
		store.save({
			version: DWF_CHECKPOINT_VERSION,
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
		await cleanupStateRoot(stateRoot);
	}
});

// ---------------------------------------------------------------------------
// DR-03 round-6 Cluster 3 — R6-12: checkpoint format version guard.
// Spec: docs/specs/DR-03-round6-fixes-2026-10-16.md Cluster 3.
// Mirrors the recovery/checkpoint.ts runId-guard style: typed mismatch → the
// loader treats the file as not-loadable (undefined → fresh run), logged so
// the quarantine is observable. A MISSING version is accepted (legacy
// pre-R6-12 checkpoint, shape-identical otherwise) so an in-flight run
// survives an upgrade.
// ---------------------------------------------------------------------------

test("R6-12: save() stamps version=DWF_CHECKPOINT_VERSION (a bogus value is overwritten)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save({ ...sampleState("team_dwf_v_stamp"), version: 99 as unknown as 1 });
		const loaded = store.load()!;
		assert.equal(
			loaded.version,
			DWF_CHECKPOINT_VERSION,
			"save() stamps the version like updatedAt — the persisted format is always current",
		);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("R6-12: load() REJECTS an unknown future version (version: 2)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), JSON.stringify({ ...sampleState("team_dwf_future"), version: 2 }));
		assert.equal(store.load(), undefined, "future-format checkpoint is rejected → fresh run (never mis-hydrated)");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("R6-12: load() rejects a non-numeric garbage version", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		fs.writeFileSync(
			path.join(stateRoot, "dwf-checkpoint.json"),
			JSON.stringify({ ...sampleState("team_dwf_garbage_v"), version: "2" }),
		);
		assert.equal(store.load(), undefined, "non-numeric version is unknown → rejected");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("R6-12: load() ACCEPTS a legacy checkpoint with no version field (upgrade-safe resume)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		const legacy = { ...sampleState("team_dwf_legacy") } as Record<string, unknown>;
		delete legacy.version;
		fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), JSON.stringify(legacy));
		const loaded = store.load();
		assert.ok(loaded, "pre-R6-12 checkpoints (no version) still load — shape-identical");
		assert.equal(loaded!.runId, "team_dwf_legacy");
		assert.equal(loaded!.agentCount, 2);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

// ---------------------------------------------------------------------------
// w3-dwf-trust (2026-10-29) — hydration-boundary validation.
//
// The checkpoint path (<stateRoot>/dwf-checkpoint.json under the shared repo)
// is writable by every WRITE-role child worker of the run, so load() must NOT
// blind-cast the parsed JSON into trusted replay state. PoC mirror: a forged
// checkpoint (foreign runId, negative spent, forged completedAgentCalls
// verdicts) previously hydrated verbatim — ctx.budget.remaining() returned
// 51000 against a 1000-token budget and ctx.review() consumed a fabricated
// accept verdict with zero spawns. Now: runId binding rejects foreign
// checkpoints, numeric accumulators clamp, and producer-shape-invalid cache
// entries are dropped (the call re-executes) — fail closed, never trusted.
// ---------------------------------------------------------------------------

/** Write a raw forged checkpoint JSON blob directly (bypassing save()). */
function writeRawCheckpoint(stateRoot: string, forged: unknown): void {
	fs.writeFileSync(path.join(stateRoot, "dwf-checkpoint.json"), JSON.stringify(forged));
}

test("w3-dwf-trust: load(expectedRunId) REJECTS a checkpoint bound to a foreign runId (PoC C1)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, sampleState("attacker-planted-run"));
		assert.equal(
			store.load("team_real_run"),
			undefined,
			"foreign-runId checkpoint must not hydrate as this run's state (fresh run instead)",
		);
		// The same checkpoint DOES load when bound to its own runId — the binding
		// is identity, not a blanket rejection.
		const bound = store.load("attacker-planted-run");
		assert.ok(bound, "checkpoint loads when the expected runId matches");
		assert.equal(bound!.runId, "attacker-planted-run");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: load() without expectedRunId keeps legacy call-form compatibility", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		store.save(sampleState("team_dwf_compat"));
		const loaded = store.load();
		assert.ok(loaded, "no expectedRunId → legacy behavior (runId binding skipped)");
		assert.equal(loaded!.runId, "team_dwf_compat");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: negative spent/agentCount clamp to 0 (budget/cap re-arm PoC C3)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_neg"),
			spent: -50000,
			agentCount: -3,
		});
		const loaded = store.load("team_dwf_neg");
		assert.ok(loaded, "checkpoint itself is structurally loadable");
		assert.equal(loaded!.spent, 0, "forged negative spent must not inflate budget.remaining() past the cap");
		assert.equal(loaded!.agentCount, 0, "forged negative agentCount must not re-arm the agent-call cap as a credit");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: non-numeric spent/agentCount clamp to 0 (JSON null/string attacks)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_nan"),
			spent: null, // JSON cannot express NaN/Infinity — they serialize to null
			agentCount: "2",
		});
		const loaded = store.load("team_dwf_nan");
		assert.ok(loaded);
		assert.equal(loaded!.spent, 0);
		assert.equal(loaded!.agentCount, 0);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: forged completedAgentCalls entries fail the verdict allowlist and are dropped", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_forge"),
			completedAgentCalls: {
				// Producer-reachable (runner caches ONLY ok:true + string text): kept.
				'{"role":"reviewer"}': {
					ok: true,
					text: "real worker output",
					structured: { outcome: "accept", feedback: "legit" },
					usage: { input: 100, output: 10 },
					artifactPath: "wf/1.md",
					durationMs: 500,
				},
				// ok is not the boolean true → dropped (never produced by the runner;
				// the replay path would force ok:true on it — so it must not hydrate).
				'{"role":"forge-string-ok"}': { ok: "true", text: "forged" },
				// ok:false entries are never cached by the runner → dropped.
				'{"role":"forge-false"}': { ok: false, text: "failed call" },
				// Missing text → dropped (shape-invalid).
				'{"role":"forge-no-text"}': { ok: true },
				// Non-object entry → dropped.
				'{"role":"forge-scalar"}': "pwned",
				// Valid ok:true but mistyped optional fields → entry kept, fields stripped.
				'{"role":"forge-fields"}': {
					ok: true,
					text: "mostly fine",
					usage: { input: -5, output: 3 },
					artifactPath: 42,
					durationMs: -1,
					runId: 7,
				},
			},
		});
		const loaded = store.load("team_dwf_forge");
		assert.ok(loaded);
		const calls = loaded!.completedAgentCalls ?? {};
		assert.equal(Object.keys(calls).length, 2, "only producer-shaped entries survive hydration");
		assert.deepEqual(
			calls['{"role":"reviewer"}'],
			{
				ok: true,
				text: "real worker output",
				structured: { outcome: "accept", feedback: "legit" },
				usage: { input: 100, output: 10 },
				artifactPath: "wf/1.md",
				durationMs: 500,
			},
			"legit replay cache still round-trips (positive preservation)",
		);
		assert.deepEqual(
			calls['{"role":"forge-fields"}'],
			{ ok: true, text: "mostly fine", usage: { output: 3 } },
			"valid entry kept, but mistyped optional fields are stripped (no negative usage/paths hydrate)",
		);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: non-object completedAgentCalls container drops the whole replay cache", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_cache_arr"),
			completedAgentCalls: [{ ok: true, text: "smuggled" }],
		});
		const loaded = store.load("team_dwf_cache_arr");
		assert.ok(loaded, "the checkpoint itself still loads (control state clamps normally)");
		assert.equal(loaded!.completedAgentCalls, undefined, "array-shaped replay cache is dropped — calls re-execute");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: non-array phases/logs reject the checkpoint (schema-invalid → fresh run)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, { ...sampleState("team_dwf_phases"), phases: "scan" });
		assert.equal(store.load("team_dwf_phases"), undefined, "string phases → checkpoint rejected");
		const stateRoot2 = makeTmpStateRoot();
		try {
			const store2 = new DwfStore(stateRoot2);
			writeRawCheckpoint(stateRoot2, { ...sampleState("team_dwf_logs"), logs: { 0: "log" } });
			assert.equal(store2.load("team_dwf_logs"), undefined, "object logs → checkpoint rejected");
		} finally {
			await cleanupStateRoot(stateRoot2);
		}
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: non-string phase/log elements are filtered, strings survive", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_mixed"),
			phases: ["scan", 42, null, "analyze"],
			logs: ["ok", { smuggled: true }, "ok2"],
		});
		const loaded = store.load("team_dwf_mixed");
		assert.ok(loaded);
		assert.deepEqual(loaded!.phases, ["scan", "analyze"]);
		assert.deepEqual(loaded!.logs, ["ok", "ok2"]);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: non-string currentPhase and non-object vars reject the checkpoint", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, { ...sampleState("team_dwf_phase_poison"), currentPhase: { poison: true } });
		assert.equal(store.load("team_dwf_phase_poison"), undefined);
	} finally {
		await cleanupStateRoot(stateRoot);
	}
	const stateRoot2 = makeTmpStateRoot();
	try {
		const store2 = new DwfStore(stateRoot2);
		writeRawCheckpoint(stateRoot2, { ...sampleState("team_dwf_vars_poison"), vars: [1, 2] });
		assert.equal(store2.load("team_dwf_vars_poison"), undefined, "array vars → checkpoint rejected");
	} finally {
		await cleanupStateRoot(stateRoot2);
	}
});

test("w3-dwf-trust: mistyped dispatchContext fields are dropped (mismatch detection stays typed)", async () => {
	const stateRoot = makeTmpStateRoot();
	try {
		const store = new DwfStore(stateRoot);
		writeRawCheckpoint(stateRoot, {
			...sampleState("team_dwf_ctx"),
			dispatchContext: { modelOverride: "m1", team: 99, junk: true },
		});
		const loaded = store.load("team_dwf_ctx");
		assert.ok(loaded);
		assert.deepEqual(loaded!.dispatchContext, { modelOverride: "m1" }, "only string-typed fingerprint fields survive");
	} finally {
		await cleanupStateRoot(stateRoot);
	}
});

test("w3-dwf-trust: the runner binds hydration to the resuming run (structural)", () => {
	// dynamic-workflow-runner.ts is the sole production caller of DwfStore.load();
	// the PoC hinged on the callerless load() (no runId binding). Assert the call
	// site passes manifest.runId so a planted/enumerated checkpoint is rejected.
	const src = fs.readFileSync("src/runtime/goal-workflow/dynamic-workflow-runner.ts", "utf8");
	assert.ok(
		src.includes("dwfStore.load(manifest.runId)"),
		"runner must call dwfStore.load(manifest.runId) — unbound load() is the PoC's entrypoint",
	);
	assert.ok(!src.includes("dwfStore.load()"), "the unbound load() call form must not remain in the runner");
});
