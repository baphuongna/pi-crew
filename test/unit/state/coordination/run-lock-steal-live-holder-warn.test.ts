/**
 * Review-round MAJOR 2 (MEDIUM, 2026-09-17 review of the F01–F20 remediation
 * wave): the staleMs steal backstop must be LOUD when it steals a lock whose
 * holder is still a LIVE acquisition of this process.
 *
 * CONTEXT (docs/decisions/2026-09-17-run-lock-async-ownership.md): a critical
 * section that legitimately exceeds staleMs (fsync stalls, loaded machine —
 * this session observed load avg 6–7) is stale-stealable by design, and the
 * steal re-breaks async↔async mutual exclusion for the remainder of that
 * critical section. The ADR documents the tradeoff; what was missing is
 * observability: the steal used to be SILENT, so the violation window could
 * never be diagnosed from logs.
 *
 * CONTRACT (this file pins it): when the async acquire loop forcibly removes a
 * lock whose verdict says heldByLiveInProcess === true, it must emit
 * logInternalError("locks.steal-live-holder", …, "warn") — console.error is
 * observable, so the test captures it.
 *
 * Determinism: contender starts only after the holder has ENTERED its critical
 * section (deferred gate, same pattern as run-lock-async-async-mutual-exclusion
 * .test.ts), and the holder sleeps past staleMs so readLockSnapshot's isStale
 * wins over heldByLiveInProcess — exactly the MAJOR 2 condition.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { withRunLock } from "../../../../src/state/coordination/locks.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function mkManifest(stateRoot: string): TeamRunManifest {
	return {
		runId: "steal-live-holder-warn",
		team: "test",
		workflow: "default",
		goal: "test",
		stateRoot,
		cwd: "/tmp",
		artifactsRoot: path.join(stateRoot, "artifacts"),
		status: "running",
		tasks: [],
		artifacts: [],
		eventsPath: path.join(stateRoot, "events.jsonl"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		manifestPath: path.join(stateRoot, "manifest.json"),
		createdAt: new Date().toISOString(),
		startedAt: Date.now(),
		turnCount: 0,
	} as unknown as TeamRunManifest;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("staleMs steal of a live in-process holder logs locks.steal-live-holder (warn)", async () => {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steal-live-warn-"));
	const manifest = mkManifest(stateRoot);
	const staleMs = 60;

	const captured: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		captured.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	try {
		let contenderEntered = false;
		const holder = createDeferred();

		// Holder: a live async acquisition whose critical section exceeds staleMs.
		const first = withRunLock(
			manifest,
			async () => {
				holder.resolve(); // entered critical section — safe to launch contender
				await sleep(staleMs * 3); // lock file is now stale while holder is ALIVE
			},
			{ staleMs },
		);
		await holder.promise;

		// Contender: same process, second async context. readLockSnapshot returns
		// { canSteal: true (isStale), heldByLiveInProcess: true } → the steal path
		// fires — which must be logged, not silent.
		const second = withRunLock(
			manifest,
			async () => {
				contenderEntered = true;
			},
			{ staleMs },
		);
		await Promise.all([first, second]);

		assert.ok(contenderEntered, "contender must have entered (steal path taken)");
		assert.ok(
			captured.some((line) => line.includes("[pi-crew:locks.steal-live-holder]")),
			`steal of a live in-process holder must emit locks.steal-live-holder warn; captured: ${JSON.stringify(captured)}`,
		);
	} finally {
		console.error = originalError;
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});
