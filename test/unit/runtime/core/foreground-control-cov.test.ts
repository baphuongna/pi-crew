import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	foregroundControlPath,
	readForegroundControlStatus,
	startRunInterruptGuard,
	writeForegroundInterruptRequest,
} from "../../../../src/runtime/foreground-control.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string, overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-fg-test",
		team: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp",
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
		...overrides,
	};
}

describe("foregroundControlPath", () => {
	it("returns path inside stateRoot", () => {
		const manifest = makeManifest("/tmp/test-state");
		const p = foregroundControlPath(manifest);
		assert.equal(p, path.join("/tmp/test-state", "foreground-control.json"));
	});
});

describe("readForegroundControlStatus", () => {
	it("returns status with no running tasks or agents", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot);
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.runId, "run-fg-test");
			assert.equal(status.status, "running");
			assert.equal(status.active, true);
			assert.deepEqual(status.runningTasks, []);
			assert.deepEqual(status.runningAgents, []);
			assert.equal(status.lastRequest, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("filters running tasks from the task list", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot);
			const tasks: TeamTaskState[] = [
				{
					id: "t1",
					runId: "run-fg-test",
					stepId: "s1",
					role: "agent",
					agent: "a",
					title: "T1",
					status: "running",
					dependsOn: [],
					cwd: "/tmp",
				},
				{
					id: "t2",
					runId: "run-fg-test",
					stepId: "s2",
					role: "agent",
					agent: "a",
					title: "T2",
					status: "completed",
					dependsOn: [],
					cwd: "/tmp",
				},
			];
			const status = readForegroundControlStatus(manifest, tasks);
			assert.deepEqual(status.runningTasks, ["t1"]);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("reports active=true for running status", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, { status: "running" });
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.active, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("reports active=false for completed status", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, { status: "completed" });
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.active, false);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("includes asyncAlive when async pid is present", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const manifest = makeManifest(stateRoot, {
				async: {
					pid: process.pid,
					logPath: "/tmp/log",
					spawnedAt: new Date().toISOString(),
				},
			});
			const status = readForegroundControlStatus(manifest, []);
			assert.equal(status.asyncPid, process.pid);
			assert.equal(status.asyncAlive, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// F1+F2 regression tests (2026-10-31 verified review).
//
// Both races are CROSS-PROCESS by nature: the producer append and the
// consumer ack are fully synchronous read→mutate→write cycles, so a single
// JS thread can never preempt one mid-RMW — and Node 22 freezes builtin
// ESM namespaces, so fs seams cannot be patched in-process either. These
// tests therefore use the repo's subprocess-harness pattern (see
// test/unit/interrupt-guard-ack.test.ts): spawn real children that import
// the REAL src/runtime/foreground-control.ts via --experimental-strip-types.
//
//   1. F1 — concurrent producers: multiple processes hammering
//      writeForegroundInterruptRequest against the same control file. With
//      the old recursive-mkdir "lock" (zero mutual exclusion) whole-file
//      RMWs overlap and requests are silently dropped.
//   2. F2 — consumer ack vs racing producer: a child cycles fresh
//      startRunInterruptGuard instances (each acks exactly once — the
//      once-per-request gate) while the parent hammers producer appends.
//      The old ack wrote back the stale tick snapshot UNLOCKED, clobbering
//      any append that landed between the guard's tick read and its write.
// ─────────────────────────────────────────────────────────────────────────────

function resolveProjectRoot(): string {
	const self = fileURLToPath(import.meta.url);
	// test/unit/runtime/core/<file> → 5 levels up to the package root.
	return path.resolve(self, "..", "..", "..", "..", "..");
}

async function waitForFiles(dir: string, names: string[], deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (names.every((name) => fs.existsSync(path.join(dir, name)))) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return names.every((name) => fs.existsSync(path.join(dir, name)));
}

/** Subprocess producer: barriers on a `go` file, then writes N requests. */
const PRODUCER_HARNESS_CODE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const stateRoot = process.argv[2];
const projectRoot = process.argv[3];
const workerIndex = process.argv[4];
const writesPerWorker = Number(process.argv[5]);

const { writeForegroundInterruptRequest } = await import(
	pathToFileURL(path.join(projectRoot, "src/runtime/foreground-control.ts")).href
);

// Barrier: signal ready, wait for the parent's go so all workers hit the
// control file at the same moment.
fs.writeFileSync(path.join(stateRoot, "ready-" + workerIndex), "ok");
const deadline = Date.now() + 30000;
while (!fs.existsSync(path.join(stateRoot, "go")) && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 2));
}

const manifest = {
	schemaVersion: 1,
	runId: "fg-lock-race",
	team: "test",
	goal: "test",
	status: "running",
	workspaceMode: "single",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	cwd: stateRoot,
	stateRoot,
	artifactsRoot: path.join(stateRoot, "artifacts"),
	tasksPath: path.join(stateRoot, "tasks"),
	eventsPath: path.join(stateRoot, "events.jsonl"),
	artifacts: [],
};

for (let i = 0; i < writesPerWorker; i++) {
	writeForegroundInterruptRequest(manifest, "w" + workerIndex + "-" + i);
}
fs.writeFileSync(path.join(stateRoot, "done-" + workerIndex), "ok");
process.exit(0);
`;

/** Subprocess consumer: cycles fresh guard instances for ~durationMs. */
const GUARD_CYCLER_HARNESS_CODE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const stateRoot = process.argv[2];
const projectRoot = process.argv[3];
const durationMs = Number(process.argv[4] || "1600");

// Fast ticks so each mounted guard acks quickly.
process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS = "10";

const { startRunInterruptGuard } = await import(
	pathToFileURL(path.join(projectRoot, "src/runtime/foreground-control.ts")).href
);

const eventsPath = path.join(stateRoot, "events.jsonl");
const resultsPath = path.join(stateRoot, "guard-results.json");

let fires = 0;
let mounts = 0;
const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
	mounts++;
	const stop = startRunInterruptGuard({
		manifest: { runId: "fg-ack-race", stateRoot, eventsPath },
		onInterrupt: () => {
			fires++;
		},
	});
	// Fixed 30ms window: 2-3 ticks at the 10ms interval — enough to see (and
	// ack) any unacked request without serializing on per-mount fire waits
	// (each mount acks at most once — the once-per-request gate).
	await new Promise((resolve) => setTimeout(resolve, 30));
	stop();
	await new Promise((resolve) => setTimeout(resolve, 10));
}
fs.writeFileSync(resultsPath, JSON.stringify({ fires, mounts }));
process.exit(0);
`;

describe("foreground-control dir-lock (F1+F2)", () => {
	it("interleaved concurrent producers never drop a request", async () => {
		const tmp = createTrackedTempDir("pi-crew-fg-lock-");
		const children: Array<ReturnType<typeof spawn>> = [];
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			// Pre-create events.jsonl so sync appendEvent never races creation.
			fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "", "utf-8");
			const harnessPath = path.join(stateRoot, "producer-harness.ts");
			fs.writeFileSync(harnessPath, PRODUCER_HARNESS_CODE);

			const projectRoot = resolveProjectRoot();
			const workers = 3;
			const writesPerWorker = 16;
			const stderrByWorker: string[][] = Array.from({ length: workers }, () => []);
			for (let w = 0; w < workers; w++) {
				const child = spawn(
					process.execPath,
					[
						"--experimental-strip-types",
						"--no-warnings",
						harnessPath,
						stateRoot,
						projectRoot,
						String(w),
						String(writesPerWorker),
					],
					{ cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
				);
				child.stderr?.on("data", (chunk: Buffer) => stderrByWorker[w].push(String(chunk)));
				children.push(child);
			}

			// Release the barrier only once every worker is parked on it.
			const ready = await waitForFiles(
				stateRoot,
				Array.from({ length: workers }, (_, w) => `ready-${w}`),
				30_000,
			);
			if (!ready) {
				for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
				assert.fail(
					`producer workers failed to reach the start barrier (stderr: ${JSON.stringify(stderrByWorker.map((chunks) => chunks.join("")))})`,
				);
			}
			fs.writeFileSync(path.join(stateRoot, "go"), "1");

			const done = await waitForFiles(
				stateRoot,
				Array.from({ length: workers }, (_, w) => `done-${w}`),
				30_000,
			);
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			if (!done) {
				assert.fail(
					`producer workers failed to finish their writes (stderr: ${JSON.stringify(stderrByWorker.map((chunks) => chunks.join("")))})`,
				);
			}

			const controlPath = path.join(stateRoot, "foreground-control.json");
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
				requests?: Array<{ reason?: string }>;
			};
			const reasons = (parsed.requests ?? []).map((r) => r.reason ?? "");
			const expected: string[] = [];
			for (let w = 0; w < workers; w++) {
				for (let i = 0; i < writesPerWorker; i++) expected.push(`w${w}-${i}`);
			}
			assert.equal(reasons.length, expected.length, `expected ${expected.length} requests, got ${reasons.length}`);
			assert.deepEqual(
				[...reasons].sort(),
				[...expected].sort(),
				"concurrent producer requests were dropped (F1: lock must serialize whole-file RMWs)",
			);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			removeTrackedTempDir(tmp);
		}
	});

	it("consumer ack under lock does not clobber a racing producer append", { timeout: 60_000 }, async () => {
		const tmp = createTrackedTempDir("pi-crew-fg-ack-");
		let guardChild: ReturnType<typeof spawn> | undefined;
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "", "utf-8");
			const harnessPath = path.join(stateRoot, "guard-harness.ts");
			fs.writeFileSync(harnessPath, GUARD_CYCLER_HARNESS_CODE);
			const projectRoot = resolveProjectRoot();
			const resultsPath = path.join(stateRoot, "guard-results.json");

			// Consumer side: cycles fresh guard instances (each performs exactly
			// one locked ack write) for ~2s.
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", harnessPath, stateRoot, projectRoot, "2000"],
				{
					cwd: projectRoot,
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			guardChild = child;
			const guardStderr: string[] = [];
			child.stderr?.on("data", (chunk: Buffer) => guardStderr.push(String(chunk)));
			const guardExit = new Promise<number>((resolve) => {
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* best-effort */
					}
					resolve(-1);
				}, 45_000);
				child.on("exit", (code) => {
					clearTimeout(timer);
					resolve(code ?? -1);
				});
			});

			// Producer side (this process, real function): hammer appends while
			// the guard child acks. Every returned id MUST survive.
			const manifest = makeManifest(stateRoot, { eventsPath: path.join(stateRoot, "events.jsonl") });
			const produced: string[] = [];
			let lockErrors = 0;
			const hammerDeadline = Date.now() + 30_000;
			while (child.exitCode === null && Date.now() < hammerDeadline) {
				try {
					const req = writeForegroundInterruptRequest(manifest, `ack-race-${produced.length}`);
					produced.push(req.id);
				} catch {
					lockErrors++;
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			const exitCode = await guardExit;
			assert.equal(exitCode, 0, `guard-cycler harness must exit cleanly (stderr: ${JSON.stringify(guardStderr.join(""))})`);
			assert.equal(lockErrors, 0, "producer writes must never fail the lock under normal contention");

			const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8")) as { fires: number; mounts: number };
			// Vacuity guard: without meaningful ack traffic the no-clobber
			// assertion would pass trivially.
			assert.ok(
				results.fires >= 10,
				`guard must have acked a meaningful number of requests (fires=${results.fires}, mounts=${results.mounts})`,
			);

			const controlPath = foregroundControlPath(manifest);
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
				requests?: Array<{ id?: string }>;
			};
			const idsInFile = new Set((parsed.requests ?? []).map((r) => r.id));
			const missing = produced.filter((id) => !idsInFile.has(id));
			assert.deepEqual(missing, [], `producer requests clobbered by consumer acks (F2): ${missing.length}/${produced.length} lost`);
		} finally {
			if (guardChild && guardChild.exitCode === null) guardChild.kill("SIGKILL");
			removeTrackedTempDir(tmp);
		}
	});
});

// Sanity for the locked-ack path in-process: an id-less legacy control file
// still gets its tail request acked (fallback branch of the F2 ack).
describe("startRunInterruptGuard locked ack", () => {
	it("acks an id-less legacy request via the tail fallback", async () => {
		const tmp = createTrackedTempDir("pi-crew-fg-legacy-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const controlPath = path.join(stateRoot, "foreground-control.json");
			// No id field — legacy shape.
			fs.writeFileSync(controlPath, JSON.stringify({ requests: [{ type: "interrupt", acknowledged: false }] }, null, 2));

			let interrupts = 0;
			process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS = "20";
			const stop = startRunInterruptGuard({
				manifest: { runId: "fg-legacy", stateRoot, eventsPath },
				onInterrupt: () => {
					interrupts++;
				},
			});
			try {
				const deadline = Date.now() + 5000;
				while (interrupts === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				assert.equal(interrupts, 1, "guard must fire exactly once on the legacy request");
				const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
					requests?: Array<{ type: string; acknowledged?: boolean }>;
				};
				assert.equal(parsed.requests?.at(-1)?.acknowledged, true, "legacy tail request must be acked");
			} finally {
				stop();
				delete process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS;
			}
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("writeForegroundInterruptRequest", () => {
	it("writes a valid interrupt request", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			const req = writeForegroundInterruptRequest(manifest, "test interrupt");
			assert.equal(req.type, "interrupt");
			assert.equal(req.acknowledged, false);
			assert.equal(req.reason, "test interrupt");
			assert.ok(req.id);
			assert.ok(req.createdAt);

			// Verify file was written
			const controlPath = foregroundControlPath(manifest);
			assert.ok(fs.existsSync(controlPath));
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
			assert.ok(parsed.requests.length >= 1);
			assert.equal(parsed.requests[0].id, req.id);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("appends to existing requests", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });

			const req1 = writeForegroundInterruptRequest(manifest, "first");
			const req2 = writeForegroundInterruptRequest(manifest, "second");

			const controlPath = foregroundControlPath(manifest);
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
			assert.equal(parsed.requests.length, 2);
			assert.equal(parsed.requests[0].id, req1.id);
			assert.equal(parsed.requests[1].id, req2.id);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("uses default reason when none provided", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			const req = writeForegroundInterruptRequest(manifest);
			assert.ok(req.reason.includes("User requested foreground interrupt"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("lastRequest is populated by readForegroundControlStatus after write", () => {
		const tmp = createTrackedTempDir("pi-crew-fg-");
		try {
			const stateRoot = path.join(tmp, "state");
			fs.mkdirSync(stateRoot, { recursive: true });
			const eventsPath = path.join(stateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, "", "utf-8");
			const manifest = makeManifest(stateRoot, { eventsPath });
			writeForegroundInterruptRequest(manifest, "check-last");
			const status = readForegroundControlStatus(manifest, []);
			assert.ok(status.lastRequest);
			assert.equal(status.lastRequest!.type, "interrupt");
			assert.equal(status.lastRequest!.reason, "check-last");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
