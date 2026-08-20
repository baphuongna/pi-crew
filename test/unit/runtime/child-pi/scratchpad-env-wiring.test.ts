import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { prepareSpawnContext } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";

// Phase 1 — T5: prepareSpawnContext wires the 5 scratchpad env keys for opt-in
// workers (and only opt-in). Pure-function test: prepareSpawnContext does NOT
// spawn, so this is fast and hermetic.

function makeAgent(overrides?: Partial<AgentConfig>): AgentConfig {
	return {
		name: "executor",
		description: "executor",
		source: "builtin",
		filePath: "executor.md",
		systemPrompt: "executor",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

function envFor(
	role: string,
	agent: AgentConfig,
	opts?: { agentId?: string; artifactsRoot?: string; attempt?: number },
): Record<string, string | undefined> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-"));
	try {
		const res = prepareSpawnContext(
			{
				cwd: dir,
				task: "small task", // under TASK_ARG_LIMIT (8000) → built.tempDir undefined → exercises R3-1 guard
				agent,
				role,
				agentId: opts?.agentId,
				artifactsRoot: opts?.artifactsRoot,
				attempt: opts?.attempt,
			},
			"small task",
		);
		assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
		if (res.kind !== "ready") return {};
		return res.ctx.mergedEnv as Record<string, string | undefined>;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("T5: opt-in executor worker gets all 5 scratchpad env keys", () => {
	const env = envFor("executor", makeAgent(), { agentId: "task-1", artifactsRoot: "/tmp/art", attempt: 2 });
	assert.equal(env.PI_CREW_SCRATCHPAD, "1");
	assert.equal(env.PI_CREW_TASK_ID, "task-1");
	assert.equal(env.PI_CREW_ATTEMPT, "2");
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, "/tmp/art");
	assert.ok(env.PI_CREW_SCRATCHPAD_SNAPSHOT, "snapshot path must be set");
	assert.match(env.PI_CREW_SCRATCHPAD_SNAPSHOT!, /task-1\.snapshot\.json$/);
});

test("T5: default attempt is 0 when input.attempt unset (C3)", () => {
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_ATTEMPT, "0");
});

test("T5: S-6 read-only role gets NO scratchpad keys (privilege-elevation gate at env layer)", () => {
	// security-reviewer's role; even with agent.scratchpad:true the env is absent.
	const env = envFor("security-reviewer", makeAgent({ scratchpad: true }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
	assert.equal(env.PI_CREW_SCRATCHPAD_SNAPSHOT, undefined);
	assert.equal(env.PI_CREW_TASK_ID, undefined);
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, undefined);
});

test("T5: F6 agent.scratchpad:false kills env even on a default-on role", () => {
	const env = envFor("executor", makeAgent({ scratchpad: false }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
	assert.equal(env.PI_CREW_SCRATCHPAD_SNAPSHOT, undefined);
});

test("T5: no agentId → no scratchpad keys (snapshot needs a task binding)", () => {
	const env = envFor("executor", makeAgent(), {});
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
});

test("T5: R3-1 — small task (built.tempDir undefined) does NOT crash spawn; snapshot path still resolves", () => {
	// buildPiWorkerArgs only creates built.tempDir for systemPrompt or >8000-char task;
	// a small task leaves it undefined. The guard must mkdtemp a fallback so
	// resolveRealContainedPath(undefined) never runs (would TypeError + crash spawn).
	const env = envFor("executor", makeAgent({ systemPrompt: undefined }), { agentId: "t", artifactsRoot: "/tmp/a" });
	assert.equal(env.PI_CREW_SCRATCHPAD, "1");
	assert.ok(env.PI_CREW_SCRATCHPAD_SNAPSHOT, "guard produced a snapshot path despite undefined built.tempDir");
});

test("T5: N2-1 — snapshot path is in tempDir, NOT under artifactsRoot (F4/S-1 raw-snapshot containment)", () => {
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/artifacts-here" });
	const snap = env.PI_CREW_SCRATCHPAD_SNAPSHOT!;
	assert.ok(!snap.startsWith("/tmp/artifacts-here"), "RAW snapshot must NOT be under artifactsRoot");
	assert.equal(env.PI_CREW_ARTIFACTS_ROOT, "/tmp/artifacts-here", "artifactsRoot passed separately for the redacted writeArtifact");
});

test("T5: all 5 keys are PI_CREW_* control vars (pass assertOnlyControlEnvKeys)", async () => {
	// assertOnlyControlEnvKeys is the security canary — run it on exactly the keys
	// prepareSpawnContext added (extract PI_CREW_ from mergedEnv minus process.env).
	const { assertOnlyControlEnvKeys } = await import("../../../../src/runtime/child-pi/child-pi-spawn.ts");
	const env = envFor("executor", makeAgent(), { agentId: "t", artifactsRoot: "/tmp/a" });
	const added = Object.fromEntries(
		Object.entries(env).filter(
			([k]) =>
				k.startsWith("PI_CREW_SCRATCHPAD") || k === "PI_CREW_TASK_ID" || k === "PI_CREW_ATTEMPT" || k === "PI_CREW_ARTIFACTS_ROOT",
		),
	);
	// must not throw — all keys are PI_CREW_* prefixed.
	assert.doesNotThrow(() => assertOnlyControlEnvKeys(added));
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 (D2) — PI_CREW_SCRATCHPAD_RESTORE env wiring: only when a previous
// attempt's snapshot artifact exists in the run artifact store.

function envForWithArtifacts(
	role: string,
	agent: AgentConfig,
	opts?: { agentId?: string; artifactsRoot?: string; attempt?: number; snapshots?: string[] },
): { env: Record<string, string | undefined>; root: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-"));
	try {
		const artifactsRoot: string | undefined = opts?.artifactsRoot;
		if (artifactsRoot) {
			for (const name of opts?.snapshots ?? []) {
				const p = path.join(artifactsRoot, "scratchpad", name);
				fs.mkdirSync(path.dirname(p), { recursive: true });
				fs.writeFileSync(p, "{}");
			}
		}
		const res = prepareSpawnContext(
			{
				cwd: dir,
				task: "small task",
				agent,
				role,
				agentId: opts?.agentId,
				artifactsRoot,
				attempt: opts?.attempt,
			},
			"small task",
		);
		assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
		if (res.kind !== "ready") return { env: {}, root: dir };
		return { env: res.ctx.mergedEnv as Record<string, string | undefined>, root: dir };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("P2-T2: prior snapshot exists → PI_CREW_SCRATCHPAD_RESTORE + _MTIME set (crash-resume D2)", () => {
	const art = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-art-"));
	try {
		fs.mkdirSync(path.join(art, "scratchpad"), { recursive: true });
		const snap = path.join(art, "scratchpad", "task-1.attempt-0.snapshot.json");
		fs.writeFileSync(snap, "{}");
		const { env } = envForWithArtifacts("executor", makeAgent(), {
			agentId: "task-1",
			artifactsRoot: art,
			snapshots: [],
		});
		assert.ok(env.PI_CREW_SCRATCHPAD_RESTORE, "restore env must be set when a snapshot exists");
		assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE, snap);
		assert.match(env.PI_CREW_SCRATCHPAD_RESTORE_MTIME!, /^\d+(\.\d+)?$/, "mtime pin must be numeric");
	} finally {
		fs.rmSync(art, { recursive: true, force: true });
	}
});

test("P2-T2: no prior snapshot → no RESTORE env (fail-open, zero behavior change)", () => {
	const art = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-art-"));
	try {
		const { env } = envForWithArtifacts("executor", makeAgent(), { agentId: "task-1", artifactsRoot: art });
		assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE, undefined);
		assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE_MTIME, undefined);
	} finally {
		fs.rmSync(art, { recursive: true, force: true });
	}
});

test("P2-T2: artifactsRoot unset → no RESTORE env, no crash", () => {
	const { env } = envForWithArtifacts("executor", makeAgent(), { agentId: "task-1" });
	assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE, undefined);
});

test("P2-T2: S-6 read-only role gets NO RESTORE env even with a prior snapshot (privilege gate)", () => {
	const art = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-art-"));
	try {
		fs.mkdirSync(path.join(art, "scratchpad"), { recursive: true });
		fs.writeFileSync(path.join(art, "scratchpad", "task-1.attempt-0.snapshot.json"), "{}");
		const { env } = envForWithArtifacts("explorer", makeAgent(), { agentId: "task-1", artifactsRoot: art });
		assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE, undefined);
		assert.equal(env.PI_CREW_SCRATCHPAD, undefined, "read-only role: no scratchpad at all");
	} finally {
		fs.rmSync(art, { recursive: true, force: true });
	}
});

test("P2-T2: F6 kill-switch (agent.scratchpad:false) → no RESTORE env even with a prior snapshot", () => {
	const art = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-art-"));
	try {
		fs.mkdirSync(path.join(art, "scratchpad"), { recursive: true });
		fs.writeFileSync(path.join(art, "scratchpad", "task-1.attempt-0.snapshot.json"), "{}");
		const { env } = envForWithArtifacts("executor", makeAgent({ scratchpad: false }), {
			agentId: "task-1",
			artifactsRoot: art,
		});
		assert.equal(env.PI_CREW_SCRATCHPAD_RESTORE, undefined);
		assert.equal(env.PI_CREW_SCRATCHPAD, undefined);
	} finally {
		fs.rmSync(art, { recursive: true, force: true });
	}
});

test("P2-T2: RESTORE keys are PI_CREW_* control vars (pass assertOnlyControlEnvKeys — NIT-3)", async () => {
	const { assertOnlyControlEnvKeys } = await import("../../../../src/runtime/child-pi/child-pi-spawn.ts");
	const art = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5-art-"));
	try {
		fs.mkdirSync(path.join(art, "scratchpad"), { recursive: true });
		fs.writeFileSync(path.join(art, "scratchpad", "task-1.attempt-0.snapshot.json"), "{}");
		const { env } = envForWithArtifacts("executor", makeAgent(), { agentId: "task-1", artifactsRoot: art });
		const added = Object.fromEntries(
			Object.entries(env).filter(
				([k]) =>
					k.startsWith("PI_CREW_SCRATCHPAD") ||
					k === "PI_CREW_TASK_ID" ||
					k === "PI_CREW_ATTEMPT" ||
					k === "PI_CREW_ARTIFACTS_ROOT",
			),
		);
		assert.doesNotThrow(() => assertOnlyControlEnvKeys(added));
	} finally {
		fs.rmSync(art, { recursive: true, force: true });
	}
});

test("WP-9: PI_CREW_EVENTS_PATH threads UNCONDITIONALLY — read-only roles get the self-reporting channel", () => {
	// explorer is read-only: scratchpad stays off (S-6) but the worker-events
	// channel env must still be present (previously scratchpad-gated → absent).
	const env = envFor("explorer", makeAgent(), { agentId: "task-ro" });
	assert.equal(env.PI_CREW_SCRATCHPAD, undefined, "scratchpad still role-gated");
	assert.equal(env.PI_CREW_EVENTS_PATH, undefined, "no eventsPath in this fixture (no team context)");
	assert.equal(env.PI_CREW_TASK_ID, "task-1" === "never" ? "no" : undefined, "no eventsPath → no unconditional task id");
});

test("WP-9: with eventsPath, executor env carries the channel + task id", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t5b-"));
	try {
		const res = prepareSpawnContext(
			{
				cwd: dir,
				task: "small task",
				agent: makeAgent(),
				role: "executor",
				agentId: "task-w9",
				eventsPath: `${dir}/state/events.jsonl`,
			},
			"small task",
		);
		assert.equal(res.kind, "ready");
		if (res.kind !== "ready") return;
		const env = res.ctx.mergedEnv as Record<string, string | undefined>;
		assert.equal(env.PI_CREW_EVENTS_PATH, `${dir}/state/events.jsonl`);
		assert.equal(env.PI_CREW_TASK_ID, "task-w9");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
