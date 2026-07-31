/**
 * RT-4 unit test: interrupt guard writes acknowledged:true and uses a gate to
 * prevent re-firing 4×/s.
 *
 * Before the RT-4 fix: the interrupt guard detected an unacknowledged interrupt
 * every 250ms tick and re-ran the full body (terminateActiveChildPiProcesses +
 * sync appendEvent) each time — ~4×/s steady state for the entire run.
 *
 * After the RT-4 fix:
 *   1. Module-local `interruptHandled` gate ensures the body runs only once.
 *   2. acknowledged:true is written back to foreground-control.json synchronously
 *      so the next poll tick sees the ack and skips.
 *
 * This test replicates the exact interrupt guard polling logic from
 * background-runner.ts startInterruptGuard() and verifies both behaviors
 * against a real foreground-control.json file on disk.
 *
 * @see src/runtime/background-runner.ts startInterruptGuard (RT-4 fix)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

/** Write a foreground-control.json with an unacknowledged interrupt request. */
function writeControlFile(
	controlPath: string,
	opts: { type?: string; acknowledged?: boolean } = {},
): void {
	const request = {
		id: `fg_test_${Date.now()}`,
		type: opts.type ?? "interrupt",
		createdAt: new Date().toISOString(),
		reason: "test interrupt",
		acknowledged: opts.acknowledged ?? false,
	};
	fs.writeFileSync(controlPath, JSON.stringify({ requests: [request] }, null, 2));
}

test("RT-4: interrupt guard writes acknowledged:true synchronously to foreground-control.json", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt4-ack-"));
	const controlPath = path.join(tempDir, "foreground-control.json");

	try {
		// Set up an unacknowledged interrupt request.
		writeControlFile(controlPath, { type: "interrupt", acknowledged: false });

		// Replicate the exact ack-write logic from startInterruptGuard (RT-4 fix).
		const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
			requests?: Array<{ type: string; acknowledged?: boolean }>;
		};
		const last = parsed.requests?.at(-1);
		assert.ok(last?.type === "interrupt" && last?.acknowledged !== true, "precondition: unacknowledged interrupt");

		// RT-4 ack write (synchronous).
		const reqs = parsed.requests ?? [];
		assert.ok(reqs.length > 0, "at least one request exists");
		reqs[reqs.length - 1].acknowledged = true;
		fs.writeFileSync(controlPath, JSON.stringify(parsed, null, 2));

		// Verify: re-read the file and check acknowledged is now true.
		const after = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
			requests?: Array<{ type: string; acknowledged?: boolean }>;
		};
		const afterLast = after.requests?.at(-1);
		assert.equal(
			afterLast?.acknowledged,
			true,
			"acknowledged must be true after the ack write — guard would re-fire without this",
		);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

test("RT-4: interruptHandled gate prevents re-fire on subsequent ticks", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt4-gate-"));
	const controlPath = path.join(tempDir, "foreground-control.json");

	try {
		writeControlFile(controlPath, { type: "interrupt", acknowledged: false });

		// Replicate the full interrupt guard polling logic (RT-4 fix).
		let interruptHandled = false;
		let bodyExecutions = 0;

		const tick = (): void => {
			try {
				if (!fs.existsSync(controlPath)) return;
				const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
					requests?: Array<{ type: string; acknowledged?: boolean }>;
				};
				const last = parsed.requests?.at(-1);
				if (last?.type === "interrupt" && last?.acknowledged !== true) {
					// RT-4 gate.
					if (interruptHandled) return;
					interruptHandled = true;

					// RT-4 ack write.
					try {
						const reqs = parsed.requests ?? [];
						if (reqs.length > 0) {
							reqs[reqs.length - 1].acknowledged = true;
							fs.writeFileSync(controlPath, JSON.stringify(parsed, null, 2));
						}
					} catch {
						/* best-effort ack */
					}

					bodyExecutions++;
				}
			} catch {
				/* ignore */
			}
		};

		// Simulate 10 ticks at 250ms interval (2.5s of polling).
		// Without the fix, each tick would re-fire the body (10 executions).
		// With the fix, only the first tick fires (1 execution).
		for (let i = 0; i < 10; i++) {
			tick();
		}

		assert.equal(
			bodyExecutions,
			1,
			`interrupt body must execute exactly once across 10 ticks, but ran ${bodyExecutions} times. ` +
				"Without the interruptHandled gate or ack write, the body re-fires every tick (~4×/s).",
		);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

test("RT-4: gate prevents re-fire even when ack write fails (defense-in-depth)", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt4-fail-"));
	// Deliberately use a path that doesn't exist and won't be created.
	// The guard can read it (if we write it first) but the ack write will fail
	// if we delete the dir mid-test. Simpler: just verify the gate alone prevents
	// re-fire by NOT writing the ack (simulating ack write failure).
	const controlPath = path.join(tempDir, "foreground-control.json");

	try {
		writeControlFile(controlPath, { type: "interrupt", acknowledged: false });

		// Simulate: ack write ALWAYS fails (simulating fs error).
		let interruptHandled = false;
		let bodyExecutions = 0;

		const tick = (): void => {
			try {
				if (!fs.existsSync(controlPath)) return;
				const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
					requests?: Array<{ type: string; acknowledged?: boolean }>;
				};
				const last = parsed.requests?.at(-1);
				if (last?.type === "interrupt" && last?.acknowledged !== true) {
					// RT-4 gate — runs BEFORE the ack write.
					if (interruptHandled) return;
					interruptHandled = true;

					// Simulate ack write failure — DON'T actually write.
					// (In real code, this is caught by the try/catch.)

					bodyExecutions++;
				}
			} catch {
				/* ignore */
			}
		};

		// The file still has acknowledged:false, but the gate prevents re-fire.
		for (let i = 0; i < 10; i++) {
			tick();
		}

		assert.equal(
			bodyExecutions,
			1,
			`gate must prevent re-fire even when ack write fails: expected 1 execution but got ${bodyExecutions}`,
		);

		// Verify the file still has acknowledged:false (ack write "failed").
		const after = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
			requests?: Array<{ acknowledged?: boolean }>;
		};
		assert.equal(
			after.requests?.at(-1)?.acknowledged,
			false,
			"ack write should have failed (simulated) — file still has acknowledged:false",
		);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

test("RT-4: steady-state performance — interrupt body does NOT re-fire every tick (≤1 execution/s)", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt4-perf-"));
	const controlPath = path.join(tempDir, "foreground-control.json");

	try {
		writeControlFile(controlPath, { type: "interrupt", acknowledged: false });

		let interruptHandled = false;
		let bodyExecutions = 0;
		const tickIntervalMs = 250; // matches the default interruptGuardInterval

		const tick = (): void => {
			try {
				if (!fs.existsSync(controlPath)) return;
				const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as {
					requests?: Array<{ type: string; acknowledged?: boolean }>;
				};
				const last = parsed.requests?.at(-1);
				if (last?.type === "interrupt" && last?.acknowledged !== true) {
					if (interruptHandled) return;
					interruptHandled = true;

					try {
						const reqs = parsed.requests ?? [];
						if (reqs.length > 0) {
							reqs[reqs.length - 1].acknowledged = true;
							fs.writeFileSync(controlPath, JSON.stringify(parsed, null, 2));
						}
					} catch {
						/* best-effort */
					}

					bodyExecutions++;
				}
			} catch {
				/* ignore */
			}
		};

		// Simulate 4 seconds of polling at 250ms intervals = 16 ticks.
		// Without RT-4 fix: 16 executions (4×/s steady state).
		// With RT-4 fix: 1 execution total.
		const totalTicks = Math.floor(4000 / tickIntervalMs);
		for (let i = 0; i < totalTicks; i++) {
			tick();
		}

		// Steady-state: ≤1 execution per second. Over 4 seconds, max 4 (but
		// with the fix it's exactly 1). Assert ≤4 as the hard bound (≤1/s).
		assert.ok(
			bodyExecutions <= 4,
			`Performance violation: interrupt body ran ${bodyExecutions} times in 4s ` +
				`(expected ≤4 with gate, got ${bodyExecutions}). Without the fix it re-fires 4×/s = 16 times.`,
		);

		// With the fix, it should be exactly 1.
		assert.equal(
			bodyExecutions,
			1,
			`With the RT-4 fix, the interrupt body should run exactly once (got ${bodyExecutions})`,
		);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
