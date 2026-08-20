/**
 * computeSpecGate wiring tests (round-1 P3: the finalize-time spec wiring is
 * now unit-testable without a full finalizeTaskResult harness).
 *
 * Covers: footer union across result sources, strict failure → gateError +
 * spec.check_failed events, already-failed prefixing/skipping, scaffold mode,
 * unresolved refs (spec.freeze_failed + badge/fail), spec-less untouched.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { computeSpecGate } from "../../../../src/runtime/task-runner/spec-evidence.ts";
import { freezeSpecSnapshot, loadSpecRecord, saveSpecRecord } from "../../../../src/state/stores/spec-store.ts";
import type { TaskPacket } from "../../../../src/state/types.ts";

const REAL_HOME = process.env.HOME;

// B4(g): hosts without unprivileged userns (GH ubuntu-24.04 runners) fail
// every strict check CLOSED by design — positive-execution test skips there.
const SANDBOX_EXEC_OK = await (async () => {
	if (process.platform !== "linux") return false;
	try {
		const { runSpecCheck } = await import("../../../../src/runtime/verification/spec-sandbox.ts");
		const probe = await runSpecCheck({ command: "true" }, { cwd: os.tmpdir() });
		return probe.outcome === "passed";
	} catch {
		return false;
	}
})();

function makeCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gate-"));
	fs.mkdirSync(path.join(dir, ".git"));
	process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gate-home-"));
	return dir;
}

function cleanup(cwd: string): void {
	if (REAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = REAL_HOME;
	fs.rmSync(cwd, { recursive: true, force: true });
}

function packetWith(overrides: Partial<TaskPacket>): TaskPacket {
	return {
		objective: "obj",
		scope: "workspace",
		scopePath: "/repo",
		repo: "/repo",
		branchPolicy: "read-only",
		acceptanceTests: [],
		commitPolicy: "forbidden",
		reportingContract: "markdown",
		escalationPolicy: "ask",
		constraints: [],
		expectedArtifacts: [],
		verification: { requiredGreenLevel: "none", commands: [], allowManualEvidence: true },
		...overrides,
	};
}

const GOOD_FOOTER = "SPEC-EVIDENCE:\nacc-1: ran the check\n";

function snapshotsFor(cwd: string, trusted: boolean) {
	const record = {
		id: "spec-a",
		version: 1,
		title: "A",
		requirements: [{ id: "req-1", text: "must do", priority: "must" as const }],
		acceptance: [
			{
				id: "acc-1",
				requirementId: "req-1",
				check: "printf ok",
				command: "printf ok",
				expectedDigest: createHash("sha256").update("ok", "utf8").digest("hex"),
				idempotent: true,
			},
		],
		source: { kind: trusted ? ("manual" as const) : ("generated" as const) },
	};
	if (trusted) {
		saveSpecRecord(cwd, record, { userAction: true });
		return [freezeSpecSnapshot(loadSpecRecord(cwd, "spec-a") as typeof record, cwd)];
	}
	saveSpecRecord(cwd, record);
	return [freezeSpecSnapshot(loadSpecRecord(cwd, "spec-a") as typeof record, cwd)];
}

test("spec-less packet → gate untouched (B4-j regression shape)", async () => {
	const out = await computeSpecGate({
		packet: packetWith({}),
		finalStdout: "plain result",
		sandboxCwd: "/tmp",
		runtimeKind: "child",
		alreadyFailed: false,
	});
	assert.equal(out.specGate, undefined);
	assert.deepEqual(out.events, []);
	assert.equal(out.gateError, undefined);
});

test("footer UNION: finalText empty but footer in finalStdout is still found (round-1 P3)", async () => {
	const cwd = makeCwd();
	try {
		const snaps = snapshotsFor(cwd, false);
		const packet = packetWith({ specRefs: ["spec-a"], specSnapshots: snaps });
		const out = await computeSpecGate({
			packet,
			finalText: "",
			finalStdout: `summary text\n\n${GOOD_FOOTER}`,
			sandboxCwd: cwd,
			runtimeKind: "child",
			alreadyFailed: false,
		});
		assert.equal(out.specGate?.badge, undefined, "footer in finalStdout counted — no missing-musts badge");
	} finally {
		cleanup(cwd);
	}
});

test("non-strict coverage gap → badge, NO gateError, task.completed path unaffected", async () => {
	const cwd = makeCwd();
	try {
		const snaps = snapshotsFor(cwd, false);
		const packet = packetWith({ specRefs: ["spec-a"], specSnapshots: snaps });
		const out = await computeSpecGate({ packet, finalText: "no footer", sandboxCwd: cwd, runtimeKind: "child", alreadyFailed: false });
		assert.equal(out.specGate?.badge, "unverified");
		assert.equal(out.gateError, undefined, "non-strict NEVER blocks");
	} finally {
		cleanup(cwd);
	}
});

test("unresolved refs: non-strict → badge + spec.freeze_failed; strict → gateError (fail-closed freeze)", async () => {
	const cwd = makeCwd();
	try {
		const base = { specRefs: ["ghost"], specSnapshots: [], unresolvedSpecRefs: ["ghost"] } as Partial<TaskPacket>;
		const loose = await computeSpecGate({
			packet: packetWith(base),
			finalText: GOOD_FOOTER,
			sandboxCwd: cwd,
			runtimeKind: "child",
			alreadyFailed: false,
		});
		assert.equal(loose.specGate?.badge, "unverified");
		assert.ok(loose.events.some((e) => e.type === "spec.freeze_failed"));
		assert.equal(loose.gateError, undefined);

		const strict = await computeSpecGate({
			packet: packetWith({ ...base, specStrict: true }),
			finalText: GOOD_FOOTER,
			sandboxCwd: cwd,
			runtimeKind: "child",
			alreadyFailed: false,
		});
		assert.ok(strict.gateError?.includes("ghost"), strict.gateError);
		assert.ok(strict.events.some((e) => e.type === "spec.freeze_failed"));
	} finally {
		cleanup(cwd);
	}
});

test("strict machine-check failure → gateError + spec.check_failed event (digest-only payload)", async (t) => {
	if (process.platform !== "linux") return t.skip("non-Linux");
	if (!SANDBOX_EXEC_OK) t.skip("unshare -rn unavailable — strict checks fail closed here by design (B4-g)");
	const cwd = makeCwd();
	try {
		const snaps = snapshotsFor(cwd, true);
		// Tamper the frozen expectedDigest so the machine-check fails.
		const bad = [
			{
				...snaps[0],
				items: [{ ...snaps[0].items[0], acceptance: { ...snaps[0].items[0].acceptance, expectedDigest: "f".repeat(64) } }],
			},
		];
		const packet = packetWith({ specRefs: ["spec-a"], specSnapshots: bad, specStrict: true });
		const out = await computeSpecGate({ packet, finalText: GOOD_FOOTER, sandboxCwd: cwd, runtimeKind: "child", alreadyFailed: false });
		assert.ok(out.gateError?.includes("digest-mismatch"), out.gateError);
		const evt = out.events.find((e) => e.type === "spec.check_failed");
		assert.ok(evt, "spec.check_failed emitted");
		assert.equal(evt?.data.acceptanceId, "acc-1");
		assert.match(String(evt?.data.actualDigest), /^[0-9a-f]{64}$/);
		assert.equal(evt?.data.stdout, undefined, "leak discipline — no raw output in events");
	} finally {
		cleanup(cwd);
	}
});

test("strict + already-failed task: machine-checks skipped (degraded-already-failed), coverage gap still gates", async () => {
	const cwd = makeCwd();
	try {
		const snaps = snapshotsFor(cwd, true);
		const packet = packetWith({ specRefs: ["spec-a"], specSnapshots: snaps, specStrict: true });
		// Footer present, coverage complete — only machine-checks would run.
		const out = await computeSpecGate({ packet, finalText: GOOD_FOOTER, sandboxCwd: cwd, runtimeKind: "child", alreadyFailed: true });
		assert.equal(out.gateError, undefined, "no NEW failure from checks that cannot un-fail the task");
		assert.equal(out.specGate?.strict?.checks[0].result, "degraded-already-failed");
		assert.equal(out.specGate?.badge, "unverified", "degrade badges");
		// Coverage gap on an already-failed task still records the gate failure.
		const out2 = await computeSpecGate({ packet, finalText: "no footer", sandboxCwd: cwd, runtimeKind: "child", alreadyFailed: true });
		assert.ok(out2.gateError?.includes("missing must-acceptance"), out2.gateError);
	} finally {
		cleanup(cwd);
	}
});

test("scaffold mode: machine-checks degrade, coverage still evaluated (disable switches reach the sandbox)", async () => {
	const cwd = makeCwd();
	try {
		const snaps = snapshotsFor(cwd, true);
		const packet = packetWith({ specRefs: ["spec-a"], specSnapshots: snaps, specStrict: true });
		const out = await computeSpecGate({
			packet,
			finalText: GOOD_FOOTER,
			sandboxCwd: cwd,
			runtimeKind: "scaffold",
			alreadyFailed: false,
		});
		assert.equal(out.specGate?.strict?.checks[0].result, "degraded-scaffold-mode");
		assert.equal(out.gateError, undefined);
		assert.equal(out.specGate?.badge, "unverified");
	} finally {
		cleanup(cwd);
	}
});
