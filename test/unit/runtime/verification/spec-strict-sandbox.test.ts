/**
 * spec-strict-sandbox tests (ADR-6 §4 + erratum §11, WP-6 step 4 + round-1 fixes).
 *
 * Provenance v2: trust = USER store + digest-bound sidecar, frozen into the
 * snapshot at dispatch (trustedAtFreeze). HOME is isolated per test.
 *
 * Covers: sandbox env has NO provider keys / broker tokens (captured env),
 * digest/exit semantics, timeout group-kill, wrapper-launch failure fails
 * CLOSED, netns isolation, survivor group-kill on passing checks, output-capped
 * distinct outcome, strict evaluator outcomes incl. BOTH provenance negative
 * ACs + TOCTOU (post-freeze sidecar delete), scaffold/already-failed skips,
 * and the §5 reject-start matrix (incl. step-level + DWF + unresolved refs).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { specStrictRejectReason } from "../../../../src/extension/team-tool/run-intent.ts";
import { BASE_ALLOWLIST } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";
import { evaluateSpecStrict, parseSpecEvidenceFooter } from "../../../../src/runtime/task-runner/spec-evidence.ts";
import { buildSpecSandboxEnv, runSpecCheck, SPEC_SANDBOX_LIMITS } from "../../../../src/runtime/verification/spec-sandbox.ts";
import { freezeSpecSnapshot, isSpecTrusted, loadSpecRecord, saveSpecRecord } from "../../../../src/state/stores/spec-store.ts";
import type { SpecRecord } from "../../../../src/state/types.ts";

const IS_LINUX = process.platform === "linux";

/** B4(g) CI note: some Linux hosts (GitHub ubuntu-24.04 runners with AppArmor
 *  `apparmor_restrict_unprivileged_userns=1`) deny `unshare -rn` — the
 *  wrapper then exits non-zero and every strict check fails CLOSED (the
 *  designed outcome). Executable-sandbox tests assert POSITIVE execution and
 *  are skipped where the namespace is unavailable; the fail-closed outcome
 *  itself is pinned by the launch-failure/platform tests below. */
const SANDBOX_EXEC_OK = await (async () => {
	if (!IS_LINUX) return false;
	try {
		const probe = await runSpecCheck({ command: "true" }, { cwd: os.tmpdir() });
		return probe.outcome === "passed";
	} catch {
		return false;
	}
})();
const skipIfNoUserns = (t: { skip: (msg: string) => void }) => {
	if (!SANDBOX_EXEC_OK) t.skip("unshare -rn unavailable on this host — strict checks fail closed here by design (B4-g)");
};
const REAL_HOME = process.env.HOME;

function makeCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-specstrict-"));
	fs.mkdirSync(path.join(dir, ".git")); // project-scoped root (bug-029 lesson)
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-spec-home-"));
	process.env.HOME = home; // isolate the USER store
	return dir;
}

function cleanup(cwd: string): void {
	if (REAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = REAL_HOME;
	fs.rmSync(cwd, { recursive: true, force: true });
}

function strictSpec(overrides?: Partial<SpecRecord>): SpecRecord {
	return {
		id: "spec-strict",
		version: 1,
		title: "Strict-checked spec",
		requirements: [{ id: "req-1", text: "Output is deterministic", priority: "must" }],
		acceptance: [
			{
				id: "acc-1",
				requirementId: "req-1",
				check: "echo ok digest-stable",
				command: "printf ok",
				expectedDigest: createHash("sha256").update("ok", "utf8").digest("hex"),
				idempotent: true,
			},
		],
		source: { kind: "manual" },
		...overrides,
	};
}

/** Mint via the USER path + freeze — the legit strict pipeline. */
function mintAndFreeze(cwd: string, record: SpecRecord) {
	saveSpecRecord(cwd, record, { userAction: true });
	return freezeSpecSnapshot(loadSpecRecord(cwd, record.id) as SpecRecord, cwd);
}

// ── Sandbox env ──────────────────────────────────────────────────────────

test("sandbox env: BASE_ALLOWLIST pattern MINUS credential keys — no provider keys, no broker tokens", () => {
	const dirty: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin",
		HOME: "/home/x",
		ANTHROPIC_API_KEY: "sk-secret",
		OPENAI_API_KEY: "sk-secret",
		GITHUB_TOKEN: "gh-secret",
		PI_CREW_BROKER_SOCKET: "/run/broker.sock",
		PI_CREW_BROKER_TOKEN: "broker-secret",
		MY_APP_CREDENTIAL: "cred",
	};
	const env = buildSpecSandboxEnv(dirty as unknown as NodeJS.ProcessEnv);
	assert.ok(env.PATH, "PATH preserved");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "provider key stripped");
	assert.equal(env.OPENAI_API_KEY, undefined, "provider key stripped");
	assert.equal(env.GITHUB_TOKEN, undefined, "token stripped");
	assert.equal(env.PI_CREW_BROKER_SOCKET, undefined, "broker socket stripped");
	assert.equal(env.PI_CREW_BROKER_TOKEN, undefined, "broker token stripped");
	assert.equal(env.MY_APP_CREDENTIAL, undefined, "credential-shaped key stripped");
	assert.equal(env.FORCE_COLOR, "0");
});

test("sandbox env: result key-set is EXACTLY the non-credential selection + FORCE_COLOR (no resurrection, round-2)", () => {
	const env = buildSpecSandboxEnv({ ...process.env, ANTHROPIC_API_KEY: "x", X_AUTHORIZATION: "y" } as unknown as NodeJS.ProcessEnv);
	const expected = new Set<string>();
	for (const key of BASE_ALLOWLIST) {
		if (/(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_BEARER|^PI_CREW_BROKER)/i.test(key)) continue;
		if (process.env[key] !== undefined) expected.add(key);
	}
	expected.add("FORCE_COLOR");
	assert.deepEqual(new Set(Object.keys(env)), expected, "no key outside the scrubbed selection can ever appear");
});

test("sandbox env: scrubber RESULT is authoritative (round-1: merge-back resurrected scrubbed keys)", () => {
	// A secret-shaped key that CREDENTIAL_KEY_PATTERN does NOT match but the
	// generic isSecretKey deny-list does — must still be absent from the result.
	const env = buildSpecSandboxEnv({ PATH: "/bin", HOME: "/h", X_AUTHORIZATION: "bearer x" } as unknown as NodeJS.ProcessEnv);
	assert.equal(env.X_AUTHORIZATION, undefined, "deny-list scrub is the result, not merged back");
});

// ── Executable sandbox (Linux; fail-closed elsewhere) ─────────────────────

test("sandbox: deterministic command passes digest+exit check", async (t) => {
	skipIfNoUserns(t);
	const cwd = makeCwd();
	try {
		const out = await runSpecCheck(
			{ command: "printf ok", expectedDigest: createHash("sha256").update("ok", "utf8").digest("hex") },
			{ cwd },
		);
		assert.equal(out.outcome, "passed");
		assert.equal(out.exitCode, 0);
	} finally {
		cleanup(cwd);
	}
});

test("sandbox: digest mismatch fails the check (digest-only payload)", async (t) => {
	skipIfNoUserns(t);
	const out = await runSpecCheck({ command: "printf tampered", expectedDigest: "0".repeat(64) }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "digest-mismatch");
	assert.match(out.actualDigest ?? "", /^[0-9a-f]{64}$/, "actual digest present, raw output never persisted");
});

test("sandbox: exit-code mismatch fails the check (compound commands keep shell semantics)", async (t) => {
	skipIfNoUserns(t);
	const out = await runSpecCheck(
		{ command: "printf nope; exit 7", expectedDigest: undefined, expectedExitCode: 0 },
		{ cwd: os.tmpdir() },
	);
	assert.equal(out.outcome, "exit-mismatch");
	assert.equal(out.exitCode, 7);
});

test("sandbox: wall-clock timeout kills the process GROUP (SIGTERM→SIGKILL escalation)", async (t) => {
	skipIfNoUserns(t);
	const out = await runSpecCheck({ command: "sleep 300" }, { cwd: os.tmpdir(), limits: { wallClockMs: 800, sigkillGraceMs: 200 } });
	assert.equal(out.outcome, "timeout");
	assert.ok(out.durationMs < 10_000, `killed promptly (durationMs=${out.durationMs})`);
});

test("sandbox: wrapper-launch failure FAILS CLOSED (never runs without isolation)", async () => {
	if (!IS_LINUX) return;
	const out = await runSpecCheck({ command: "printf ok" }, { cwd: os.tmpdir(), wrapperOverride: "definitely-missing-unshare-wrapper" });
	assert.equal(out.outcome, "launch-failed");
});

test("sandbox: non-Linux platform fails closed (no unshare equivalent — platform honesty)", async () => {
	if (IS_LINUX) return;
	const out = await runSpecCheck({ command: "printf ok" }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "launch-failed");
});

test("sandbox: network is isolated — outbound TCP connect fails inside unshare -rn", { timeout: 30_000 }, async (t) => {
	skipIfNoUserns(t);
	const probe = `bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'`;
	const out = await runSpecCheck({ command: probe, expectedExitCode: 0 }, { cwd: os.tmpdir() });
	assert.equal(out.outcome, "exit-mismatch", "TCP connect failed inside the isolated netns");
	assert.equal(out.exitCode, 1);
});

test("sandbox: survivor processes are group-killed on a PASSING check (round-1)", { timeout: 20_000 }, async (t) => {
	skipIfNoUserns(t);
	const cwd = makeCwd();
	try {
		const marker = path.join(cwd, "survivor-marker");
		const out = await runSpecCheck({ command: `sh -c 'sleep 2 && touch "$0"' '${marker}' & exit 0` }, { cwd });
		assert.equal(out.outcome, "passed", "the check itself passed");
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal(fs.existsSync(marker), false, "backgrounded survivor was group-killed with the check");
	} finally {
		cleanup(cwd);
	}
});

test("sandbox: output-capped is a DISTINCT outcome — capped stdout + expectedDigest never fake-compares (round-1)", async (t) => {
	skipIfNoUserns(t);
	const out = await runSpecCheck(
		{ command: `head -c 3000000 /dev/zero | tr '\\0' 'x'`, expectedDigest: "f".repeat(64) },
		{ cwd: os.tmpdir(), limits: { maxOutputBytes: 1024 * 1024 } },
	);
	assert.equal(out.outcome, "output-capped", "capped buffer → honest distinct failure, not silent digest-mismatch");
	assert.equal(out.stdoutCapped, true);
});

// ── Strict evaluator (platform-independent paths) ─────────────────────────

test("strict: user-minted spec + idempotent digest check → machine-check passes", async (t) => {
	if (!IS_LINUX) return t.skip("non-Linux");
	skipIfNoUserns(t);
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		assert.equal(snap.trustedAtFreeze, true, "user mint freezes trusted");
		const footer = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: digest stable across runs\n");
		const result = await evaluateSpecStrict([snap], footer, { cwd });
		assert.equal(result.strict.passed, true);
		assert.equal(result.badge, undefined);
		assert.deepEqual(
			result.strict.checks.map((c) => c.result),
			["passed"],
		);
	} finally {
		cleanup(cwd);
	}
});

test("strict NEGATIVE AC 1: worker-authored (generated) spec degrades — trustedAtFreeze false, never re-runs", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec({ source: { kind: "manual" }, trusted: true }); // forged payload
		saveSpecRecord(cwd, record); // worker path → workspace store, forced generated
		const snap = freezeSpecSnapshot(loadSpecRecord(cwd, "spec-strict") as SpecRecord, cwd);
		assert.equal(snap.trustedAtFreeze, false);
		const footer = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: covered\n");
		const result = await evaluateSpecStrict([snap], footer, { cwd });
		assert.deepEqual(
			result.strict.checks.map((c) => c.result),
			["degraded-untrusted-spec"],
			"NEW-2: generated-spec commands are never re-executed by root",
		);
		assert.equal(result.badge, "unverified");
		assert.equal(result.strict.passed, true, "degrade is the compromise path — badge, not fail");
	} finally {
		cleanup(cwd);
	}
});

test("strict NEGATIVE AC 2: hand-forged WORKSPACE json+sidecar pair ALSO degrades (user store only)", async () => {
	const cwd = makeCwd();
	try {
		// The attacker writes BOTH files into the worker-writable workspace store.
		const dir = path.join(cwd, ".crew", "state", "specs");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "spec-strict.json"), JSON.stringify(strictSpec()));
		fs.writeFileSync(path.join(dir, "spec-strict.trusted"), `${"a".repeat(64)}\n`);
		const snap = freezeSpecSnapshot(loadSpecRecord(cwd, "spec-strict") as SpecRecord, cwd);
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: forged but covered\n"), { cwd });
		assert.equal(snap.trustedAtFreeze, false, "workspace sidecars mint NOTHING");
		assert.equal(result.strict.checks[0].result, "degraded-untrusted-spec");
	} finally {
		cleanup(cwd);
	}
});

test("strict TOCTOU (round-1): post-freeze sidecar deletion cannot change a running task's trust", async (t) => {
	if (!IS_LINUX) return t.skip("non-Linux");
	skipIfNoUserns(t);
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		assert.equal(snap.trustedAtFreeze, true);
		// Attacker deletes the sidecar between dispatch and finalize.
		const slug = fs.readdirSync(path.join(process.env.HOME ?? "", ".pi", "agent", "specs"))[0];
		fs.rmSync(path.join(process.env.HOME ?? "", ".pi", "agent", "specs", slug, "spec-strict.trusted"));
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\n"), { cwd });
		assert.equal(result.strict.checks[0].result, "passed", "the gate reads the FROZEN bit — machine-check ran despite live tampering");
	} finally {
		cleanup(cwd);
	}
});

test("strict: scaffold mode skips machine-checks — degraded-scaffold-mode (round-1 P2)", async () => {
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\n"), { cwd, mode: "scaffold" });
		assert.equal(result.strict.checks[0].result, "degraded-scaffold-mode");
		assert.equal(result.strict.passed, true, "degrade badges, never fails");
		assert.equal(result.badge, "unverified");
	} finally {
		cleanup(cwd);
	}
});

test("strict: already-failed task skips machine-checks — degraded-already-failed (round-1 P3)", async () => {
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\n"), {
			cwd,
			alreadyFailed: true,
		});
		assert.equal(result.strict.checks[0].result, "degraded-already-failed");
	} finally {
		cleanup(cwd);
	}
});

test("strict: non-idempotent must → degraded-non-idempotent + badge (no re-run)", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec({
			acceptance: [
				{ id: "acc-1", requirementId: "req-1", check: "db migration", command: "psql -c 'insert ...'", idempotent: false },
			],
		});
		const snap = mintAndFreeze(cwd, record);
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: migration applied\n"), { cwd });
		assert.equal(result.strict.checks[0].result, "degraded-non-idempotent");
		assert.equal(result.badge, "unverified");
	} finally {
		cleanup(cwd);
	}
});

test("strict: must without command → degraded-no-command (cannot machine-check)", async () => {
	const cwd = makeCwd();
	try {
		const record = strictSpec({ acceptance: [{ id: "acc-1", requirementId: "req-1", check: "manual review only" }] });
		const snap = mintAndFreeze(cwd, record);
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: reviewed\n"), { cwd });
		assert.equal(result.strict.checks[0].result, "degraded-no-command");
	} finally {
		cleanup(cwd);
	}
});

test("strict: digest mismatch in a trusted idempotent check FAILS the gate (B4 strict)", async (t) => {
	if (!IS_LINUX) return t.skip("non-Linux");
	skipIfNoUserns(t);
	const cwd = makeCwd();
	try {
		const record = strictSpec({ acceptance: [{ ...strictSpec().acceptance[0], expectedDigest: "f".repeat(64) }] });
		const snap = mintAndFreeze(cwd, record);
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\n"), { cwd });
		assert.equal(result.strict.passed, false);
		assert.equal(result.strict.checks[0].result, "failed");
		assert.equal(result.strict.checks[0].outcome, "digest-mismatch");
	} finally {
		cleanup(cwd);
	}
});

test("strict: missing footer with musts FAILS (coverage gap fails strict — B4-c strict column)", async () => {
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("done, no footer"), { cwd });
		assert.equal(result.strict.passed, false);
		assert.deepEqual(result.missingMustIds, ["acc-1"]);
	} finally {
		cleanup(cwd);
	}
});

test("strict: unknown id cited FAILS the gate", async () => {
	const cwd = makeCwd();
	try {
		const snap = mintAndFreeze(cwd, strictSpec());
		const result = await evaluateSpecStrict([snap], parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\nacc-ghost: invented\n"), {
			cwd,
		});
		assert.equal(result.strict.passed, false);
		assert.deepEqual(result.unknownIds, ["acc-ghost"]);
	} finally {
		cleanup(cwd);
	}
});

test("strict: spec-less task → not applicable, never fails (regression guard)", async () => {
	const result = await evaluateSpecStrict(undefined, parseSpecEvidenceFooter("no specs at all"), { cwd: os.tmpdir() });
	assert.equal(result.applicable, false);
	assert.equal(result.strict.passed, true);
});

// ── §5 reject-start (workflow OR step level, DWF, unresolved refs) ─────────

const wfBase = { name: "wf", description: "", source: "user" as const, filePath: "/tmp/wf.workflow.md" };

test("reject-start matrix: strict without verifier rejected; with verifier or non-strict allowed", () => {
	assert.ok(specStrictRejectReason({ ...wfBase, specStrict: true, steps: [{ id: "s1", role: "executor", task: "x" }] }));
	assert.equal(
		specStrictRejectReason({
			...wfBase,
			specStrict: true,
			steps: [
				{ id: "s1", role: "executor", task: "x" },
				{ id: "s2", role: "verifier", task: "y" },
			],
		}),
		undefined,
	);
	assert.equal(
		specStrictRejectReason({ ...wfBase, steps: [{ id: "s1", role: "executor", task: "x" }] }),
		undefined,
		"non-strict unaffected",
	);
});

test("reject-start: STEP-level specStrict without verifier ALSO rejected (round-1 P3)", () => {
	const reason = specStrictRejectReason({
		...wfBase,
		steps: [{ id: "s1", role: "executor", task: "x", specStrict: true }],
	});
	assert.ok(reason, "per-step flag cannot bypass the verifier requirement");
});

test("reject-start: DWF + strict gets the DWF-specific message (structurally verifier-less)", () => {
	const reason = specStrictRejectReason({
		...wfBase,
		runtime: "dynamic",
		specStrict: true,
		dynamicScript: "/tmp/x.dwf.ts",
		steps: [],
	});
	assert.ok(reason?.includes("dynamic workflows"), reason);
});

test("reject-start: strict workflow with unresolvable specRefs rejects at START (round-1 P2)", () => {
	const cwd = makeCwd();
	try {
		saveSpecRecord(cwd, strictSpec()); // generated only — resolvable
		const reason = specStrictRejectReason(
			{
				...wfBase,
				specStrict: true,
				steps: [
					{ id: "s1", role: "executor", task: "x", specRefs: ["spec-strict", "ghost-spec"] },
					{ id: "s2", role: "verifier", task: "y" },
				],
			},
			cwd,
		);
		assert.ok(reason?.includes("ghost-spec"), reason);
		// Resolvable refs → allowed.
		assert.equal(
			specStrictRejectReason(
				{
					...wfBase,
					specStrict: true,
					steps: [
						{ id: "s1", role: "executor", task: "x", specRefs: ["spec-strict"] },
						{ id: "s2", role: "verifier", task: "y" },
					],
				},
				cwd,
			),
			undefined,
		);
	} finally {
		cleanup(cwd);
	}
});

// ── Guard: store trust API sanity under isolated HOME ─────────────────────

test("isSpecTrusted: invalid id never throws", () => {
	const cwd = makeCwd();
	try {
		assert.equal(isSpecTrusted(cwd, "../escape"), false);
	} finally {
		cleanup(cwd);
	}
});

test("SPEC_SANDBOX_LIMITS: ceilings match the ADR §4 values", () => {
	assert.equal(SPEC_SANDBOX_LIMITS.addressSpaceKb, 262_144);
	assert.equal(SPEC_SANDBOX_LIMITS.cpuSeconds, 30);
	assert.equal(SPEC_SANDBOX_LIMITS.wallClockMs, 60_000);
});
