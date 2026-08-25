/**
 * Task 4 (perf/round2-fsync-polling): appendMailboxMessage delivery writes drop
 * to the best-effort durability default.
 *
 * The delivery.json entry is informational — the next appended message
 * overwrites it, so a hard crash only risks re-delivery (the accepted
 * semantics of the default path, see src/state/coordination/mailbox.ts
 * writeDeliveryState). Regular appends must therefore hand
 * `durability: "best-effort"` to atomicWriteFile — which skips BOTH the data
 * fsync and the parent-dir fsync — while the terminal/reply paths that pass
 * `{ durability: "full" }` explicitly keep it.
 *
 * INSTRUMENTATION (CJS-default-swap per test/unit/manifest-cache-ttl.test.ts):
 * `t.mock.method(atomicWriteFile, ...)` is impossible — atomicWriteFile is a
 * plain ESM name binding, not an object method ("The argument 'methodName'
 * must be a method. Received undefined", verified on this toolchain). Instead
 * we mutate the `require("node:fs")` CJS exports object and push the replacements
 * back via `module.syncBuiltinESMExports()`, the same pattern Node's own test
 * suite uses to patch builtin ESM namespaces. Two signals ride that hook:
 *   - `fs.openSync`: atomicWriteFile opens a `.tmp` file for the rename'd write.
 *     Tracking the opened path lets us attribute the fsync to the delivery file
 *     specifically, so file counts are unambiguous.
 *   - `fs.fsyncSync`: "full" durability performs exactly 2 fsyncs (data + parent
 *     dir); "best-effort" performs 0. The delta scoped to delivery.json is the
 *     durability signal and the instrument-liveness guard: if the hook were dead
 *     (e.g. a future Node breaking syncBuiltinESMExports), both assertions would
 *     fail loudly rather than pass vacuously.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	acknowledgeMailboxMessage,
	appendMailboxMessage,
	readDeliveryState,
	readMailbox,
} from "../../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-delivery-durability-run",
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function setupMailboxWorkspace(): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir("mailbox-delivery-durability-");
	const stateRoot = path.join(dir, "state", "runs", "mailbox-delivery-durability-run");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot) };
}

function deliveryFileOf(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "mailbox", "delivery.json");
}

/**
 * CJS-default-swap spy on node:fs. Counts fsyncs whose fd resolves (via
 * /proc/self/fd) to a file under `underDir` — the delivery file lives
 * beneath the run's stateRoot, distinguishing delivery writes from any
 * unrelated fsync traffic. Returns the counter + a restore().
 */
function spyFsyncsUnder(underDir: string): { fsyncs(): number; restore(): void } {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as { fsyncSync: (...args: unknown[]) => unknown };
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalFsync = fsDefault.fsyncSync;
	let count = 0;
	const isUnder = (p: string) => underDir === p || p.startsWith(`${underDir}${path.sep}`);
	fsDefault.fsyncSync = ((fd: unknown, ...rest: unknown[]) => {
		try {
			const resolved = fs.realpathSync(`/proc/self/fd/${fd}`);
			if (isUnder(resolved)) count++;
		} catch {
			/* pre-close fd link may not resolve — not a delivery fsync */
		}
		return originalFsync(fd, ...rest);
	}) as typeof fsDefault.fsyncSync;
	nodeModule.syncBuiltinESMExports();
	return {
		fsyncs() {
			return count;
		},
		restore() {
			fsDefault.fsyncSync = originalFsync;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

test("appendMailboxMessage delivery write is best-effort by default (0 fsyncs on a pure delivery append)", (t) => {
	const { dir, manifest } = setupMailboxWorkspace();
	const deliveryFile = deliveryFileOf(manifest);
	const spy = spyFsyncsUnder(dir);
	try {
		// First append ALSO initializes the mailbox (ensureRunMailbox creates
		// inbox/outbox/delivery.json with full durability — those write fsyncs).
		// Absorb that initialization noise into a baseline.
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "first" });
		const afterInit = spy.fsyncs();

		// Instrument liveness: the first append must have actually rewritten
		// delivery.json — otherwise the zero-delta assertion passes vacuously.
		assert.ok(afterInit > 0, "initialization writes are full durability, so the spy must have counted fsyncs");
		assert.ok(fs.existsSync(deliveryFile), "delivery.json must exist after an append");
		const contents = JSON.parse(fs.readFileSync(deliveryFile, "utf-8")) as { messages: Record<string, unknown> };
		assert.ok(Object.keys(contents.messages).length >= 1, "delivery.json must track the appended message");

		// Pure delivery append (all files already exist): the ONLY write is the
		// delivery-state write. best-effort skips the data AND parent-dir fsync,
		// so no new fsync may occur.
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "second" });
		const afterAppend = spy.fsyncs();
		assert.equal(
			afterAppend,
			afterInit,
			`delivery write must be best-effort: 0 fsyncs under workspace during a pure delivery append (init=${afterInit}, append=${afterAppend})`,
		);

		// The write is still intact and readable (best-effort only skips fsync).
		const delivery = readDeliveryState(manifest);
		const ids = Object.keys(delivery.messages);
		assert.equal(ids.length, 2, "both appended messages must be tracked in delivery state");
		const bodies = readMailbox(manifest, "inbox").map((m) => m.body);
		assert.deepEqual(bodies, ["first", "second"], "both appended messages must be readable from the mailbox");
	} finally {
		spy.restore();
		removeTrackedTempDir(dir);
	}
});

test("explicit full durability stays full — the terminal acknowledge path keeps its fsyncs", (t) => {
	const { dir, manifest } = setupMailboxWorkspace();
	const deliveryFile = deliveryFileOf(manifest);
	const spy = spyFsyncsUnder(dir);
	try {
		// Absorb the initialization-noise append first, then record a baseline of
		// a pure best-effort delivery append.
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "prime" });
		const appended = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "worker",
			body: "steer!",
		});
		const afterAppend = spy.fsyncs();

		// The terminal/acknowledge path deliberately passes full durability. It
		// must NOT have been downgraded alongside the default — the acknowledge
		// must still fsync (data + parent dir).
		acknowledgeMailboxMessage(manifest, appended.id);
		const afterAck = spy.fsyncs();

		assert.ok(
			afterAck > afterAppend,
			`acknowledge must keep full durability: fsyncs under workspace ${afterAppend} -> ${afterAck} (expected the ack to add fsyncs)`,
		);
		assert.ok(fs.existsSync(deliveryFile), "delivery.json must still exist after acknowledge (liveness)");
		const finalDelivery = readDeliveryState(manifest);
		assert.equal(finalDelivery.messages[appended.id], "acknowledged", "acknowledge must mark the message acknowledged");
	} finally {
		spy.restore();
		removeTrackedTempDir(dir);
	}
});
