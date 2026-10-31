/**
 * FINDING B (2026-10-31) — w1a cross-process verify-key distribution:
 * child-pi-spawn must hand every team worker the PLURAL verify-key set
 * (PI_CREW_MAILBOX_VERIFY_KEYS) alongside the legacy singular key, so rows
 * signed by the run's DISPATCHER session (respond / steering fs-fallback in
 * async runs) verify instead of dropping as noise (ask poll 480s timeout).
 *
 * Pure-function test (pattern: child-pi-env-ask.test.ts): prepareSpawnContext
 * does NOT spawn — assertions target builtEnv, NOT mergedEnv, so ambient
 * PI_CREW_* env cannot produce false passes/fails (the runner scrubs the
 * crew-family env for the test process; the relay-match cases below set and
 * restore their vars explicitly).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { prepareSpawnContext } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";
import {
	COORDINATION_VERIFY_KEY_ENV,
	COORDINATION_VERIFY_KEYS_ENV,
	getMailboxVerifyKeyPublic,
} from "../../../../src/state/coordination/mailbox.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

function makeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "executor",
		source: "builtin",
		filePath: "executor.md",
		systemPrompt: "executor",
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

interface SpawnEnvResult {
	builtEnv: Record<string, string | undefined>;
}

/** Build the spawn context and return its per-call built.env control vars. */
async function builtEnvFor(opts: {
	eventsPath?: string;
	runId?: string;
	dispatcherVerifyKey?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<SpawnEnvResult> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-findingb-spawn-"));
	after(async () => {
		await cleanupStateRoot(dir);
	});
	const res = prepareSpawnContext(
		{
			cwd: dir,
			task: "small task",
			agent: makeAgent(),
			agentId: "01_task-a",
			eventsPath: opts.eventsPath,
			runId: opts.runId,
			dispatcherVerifyKey: opts.dispatcherVerifyKey,
		},
		"small task",
		opts.env,
	);
	assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
	if (res.kind !== "ready") return { builtEnv: {} };
	return { builtEnv: res.ctx.builtEnv as Record<string, string | undefined> };
}

/** Set crew-family env vars for one test (restored via after()). */
function withEnv(vars: Record<string, string | undefined>): void {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(vars)) {
		saved.set(key, process.env[key]);
		if (vars[key] === undefined) delete process.env[key];
		else process.env[key] = vars[key];
	}
	after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

test("FINDING B: dispatcherVerifyKey threads into PI_CREW_MAILBOX_VERIFY_KEYS (leader spawn)", async () => {
	const eventsPath = "/tmp/pi-crew-findingb-state-run-x/events.jsonl";
	const dispatcherKey = await realForeignPublicKeyB64();
	const { builtEnv } = await builtEnvFor({ eventsPath, runId: "run-x", dispatcherVerifyKey: dispatcherKey });
	// Leader/runner spawn (no same-run relay): plural set = [dispatcher key]…
	assert.equal(builtEnv[COORDINATION_VERIFY_KEYS_ENV], dispatcherKey, "plural verify-key set carries the dispatcher key");
	// …and the singular spawner-key semantics are UNCHANGED (own process key).
	assert.equal(builtEnv[COORDINATION_VERIFY_KEY_ENV], getMailboxVerifyKeyPublic());
});

test("FINDING B: nested same-run grandchild merges + dedupes inherited plural keys", async () => {
	// This process acts as a WORKER of run-x spawning a same-run grandchild:
	// singular env key + matching PI_CREW_BROKER_RUN_ID → relay-match ON.
	const eventsPath = "/tmp/pi-crew-findingb-nested/events.jsonl";
	const inheritedA = await realForeignPublicKeyB64();
	const inheritedB = await realForeignPublicKeyB64();
	withEnv({
		[COORDINATION_VERIFY_KEY_ENV]: inheritedA,
		[COORDINATION_VERIFY_KEYS_ENV]: `${inheritedA},${inheritedB}`,
		PI_CREW_BROKER_RUN_ID: "run-x",
	});
	const dispatcherKey = await realForeignPublicKeyB64();
	const { builtEnv } = await builtEnvFor({ eventsPath, runId: "run-x", dispatcherVerifyKey: dispatcherKey });
	// Inherited plural keys first (order preserved), dispatcher key appended,
	// duplicate of inheritedA dropped by the dedupe.
	assert.equal(
		builtEnv[COORDINATION_VERIFY_KEYS_ENV],
		[inheritedA, inheritedB, dispatcherKey].join(","),
		"plural set = deduped(inherited plural, dispatcher key)",
	);
	// Relay-match keeps the singular relay semantics unchanged.
	assert.equal(builtEnv[COORDINATION_VERIFY_KEY_ENV], inheritedA);
});

test("FINDING B: NO relay match → inherited plural keys never leak into another run's child", async () => {
	const eventsPath = "/tmp/pi-crew-findingb-noleak/events.jsonl";
	const foreignRunKey = await realForeignPublicKeyB64();
	// PI_CREW_BROKER_RUN_ID ≠ input.runId → this process is NOT a same-run
	// worker; its plural env belongs to a DIFFERENT run and must not leak.
	withEnv({
		[COORDINATION_VERIFY_KEY_ENV]: foreignRunKey,
		[COORDINATION_VERIFY_KEYS_ENV]: foreignRunKey,
		PI_CREW_BROKER_RUN_ID: "run-other",
	});
	const dispatcherKey = await realForeignPublicKeyB64();
	const { builtEnv } = await builtEnvFor({ eventsPath, runId: "run-x", dispatcherVerifyKey: dispatcherKey });
	assert.equal(builtEnv[COORDINATION_VERIFY_KEYS_ENV], dispatcherKey, "only the dispatcher key — no cross-run leak");
	// No relay match → singular = this process's own key (unchanged semantics).
	assert.equal(builtEnv[COORDINATION_VERIFY_KEY_ENV], getMailboxVerifyKeyPublic());
});

test("FINDING B: legacy spawns without dispatcherVerifyKey keep the plural var unset", async () => {
	const eventsPath = "/tmp/pi-crew-findingb-legacy/events.jsonl";
	const { builtEnv } = await builtEnvFor({ eventsPath, runId: "run-x" });
	assert.equal(builtEnv[COORDINATION_VERIFY_KEYS_ENV], undefined, "no dispatcher key → plural var unset (pre-fix child env)");
	assert.equal(typeof builtEnv[COORDINATION_VERIFY_KEY_ENV], "string", "singular var still handed (unchanged)");
});

/** A REAL distinct public key generated in a separate node process — keeps the
 *  fixture keys honest (a same-process keypair would collide with the merged
 *  in-process verify set and could false-pass the dedupe assertions). */
async function realForeignPublicKeyB64(): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-findingb-key-"));
	after(async () => {
		await cleanupStateRoot(dir);
	});
	const harness = path.join(dir, "key.ts");
	fs.writeFileSync(
		harness,
		`import { generateKeyPairSync } from "node:crypto";\nconst { publicKey } = generateKeyPairSync("ed25519");\nprocess.stdout.write(Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64"));\n`,
	);
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", harness], {
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(child.status, 0, `key harness failed: ${child.stderr}`);
	assert.ok(child.stdout && child.stdout.length > 0, "key harness printed a public key");
	return child.stdout.trim();
}
