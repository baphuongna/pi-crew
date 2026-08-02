/**
 * RT-4 test: interrupt guard writes acknowledged:true and uses a gate to
 * prevent re-firing 4×/s.
 *
 * PREVIOUS (broken) test: re-implemented the polling logic as a local tick()
 * function — it NEVER imported startInterruptGuard() from background-runner.ts.
 * If the real guard's gate or ack write was reverted, that test STILL passed
 * (false confirmation).
 *
 * REWRITTEN test: spawns a subprocess harness that imports the REAL
 * startInterruptGuard() from background-runner.ts and exercises it against a
 * real foreground-control.json file on disk.
 *
 * The REAL guard does two things (RT-4 fix):
 *   1. Module-local `interruptHandled` gate — body runs only once per interrupt.
 *   2. acknowledged:true written back synchronously — next tick sees ack and skips.
 *
 * Test modes:
 *   - "normal": write unack'd interrupt, wait several ticks, assert
 *     acknowledged=true AND interruptCount=1.
 *       Revert BOTH (gate + ack): interruptCount > 1 → FAIL.
 *       Revert ack only: acknowledged=false → FAIL.
 *   - "gate-only": after first fire, overwrite control file with acknowledged=false
 *     (simulating ack-write failure). Assert interruptCount=1.
 *       Revert gate only: body re-fires → interruptCount > 1 → FAIL.
 *
 * Together, these cover ALL revert scenarios.
 *
 * @see src/runtime/background-runner.ts startInterruptGuard (RT-4 fix)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function resolveProjectRoot(): string {
	const self = fileURLToPath(import.meta.url);
	return path.resolve(self, "..", "..", "..");
}

/**
 * Subprocess harness code. Written to a temp .ts file and spawned with
 * --experimental-strip-types so it can import the REAL .ts production modules.
 *
 * Mode "normal": standard interrupt → verify ack + single-fire.
 * Mode "gate-only": undo the ack after first fire → verify gate prevents re-fire.
 */
const HARNESS_CODE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const stateRoot = process.argv[2];
const projectRoot = process.argv[3];
const mode = process.argv[4] || "normal";

// ── Import REAL production code ──────────────────────────────────────────
// background-runner.ts auto-runs main() on import; without --cwd/--run-id it
// throws "Usage: ..." which is caught by the module-level catch (harmless).
const { startInterruptGuard } = await import(
\tpathToFileURL(path.join(projectRoot, "src/runtime/background-runner.ts")).href
);

// Use a fast poll interval for quick test feedback (default is 250ms).
process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS = "50";

const controlPath = path.join(stateRoot, "foreground-control.json");
const eventsPath = path.join(stateRoot, "events.jsonl");
const resultsPath = path.join(stateRoot, "results.json");

// Ensure events.jsonl exists so appendEvent can write.
fs.writeFileSync(eventsPath, "");

// Write an unacknowledged interrupt request.
fs.writeFileSync(
\tcontrolPath,
\tJSON.stringify({ requests: [{ type: "interrupt", acknowledged: false, id: "rt4-test" }] }, null, 2),
);

// Start the REAL interrupt guard from background-runner.ts.
const ac = new AbortController();
const stopGuard = startInterruptGuard(
\t{ runId: "rt4-test", stateRoot, eventsPath },
\tac,
\t() => {}, // stopParentGuard stub — no parent guard in harness
);

if (mode === "gate-only") {
\t// Wait for the first fire (50ms interval → fires within ~100ms).
\tawait new Promise((r) => setTimeout(r, 200));

\t// Simulate ack-write failure: overwrite control file with acknowledged=false.
\t// This mimics a transient fs error where the ack write did not persist.
\t// With the gate: body does NOT re-fire (interruptHandled is true).
\t// Without the gate: body re-fires every tick.
\ttry {
\t\tconst current = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
\t\tif (current.requests?.length > 0) {
\t\t\tcurrent.requests[current.requests.length - 1].acknowledged = false;
\t\t}
\t\tfs.writeFileSync(controlPath, JSON.stringify(current, null, 2));
\t} catch {
\t\t/* best-effort */
\t}

\t// Wait for more ticks (enough to detect re-fire without the gate).
\tawait new Promise((r) => setTimeout(r, 500));
} else {
\t// Normal mode: wait enough for multiple guard ticks.
\tawait new Promise((r) => setTimeout(r, 500));
}

stopGuard();

// ── Collect results ─────────────────────────────────────────────────────
let acknowledged = null;
try {
\tconst ackContent = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
\tacknowledged = ackContent.requests?.at(-1)?.acknowledged ?? null;
} catch {
\t/* best-effort */
}

let interruptCount = 0;
try {
\tconst lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\\n").filter(Boolean);
\tfor (const line of lines) {
\t\ttry {
\t\t\tif (JSON.parse(line).type === "async.interrupt_detected") interruptCount++;
\t\t} catch {
\t\t\t/* skip malformed */
\t\t}
\t}
} catch {
\t/* best-effort */
}

fs.writeFileSync(
\tresultsPath,
\tJSON.stringify({ acknowledged, interruptCount, exitCode: process.exitCode }),
);

process.exit(0);
`;

/** Run the harness in the given mode and return the parsed results. */
async function runHarness(
	projectRoot: string,
	mode: string,
): Promise<{ acknowledged: unknown; interruptCount: number; exitCode: number; stderr: string }> {
	const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-rt4-${mode}-`));
	const harnessPath = path.join(stateRoot, "harness.ts");
	const resultsPath = path.join(stateRoot, "results.json");

	try {
		fs.writeFileSync(harnessPath, HARNESS_CODE);

		const child = spawn(
			process.execPath,
			["--experimental-strip-types", harnessPath, stateRoot, projectRoot, mode],
			{
				cwd: projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			},
		);

		const stderrChunks: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		const exitCode = await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
				reject(new Error(`harness (${mode}) did not exit within 30s`));
			}, 30_000);

			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve(code ?? -1);
			});
			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		if (!fs.existsSync(resultsPath)) {
			throw new Error(
				`harness (${mode}) did not write results.json (exit=${exitCode}). ` +
					`Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
			);
		}

		const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8")) as {
			acknowledged: unknown;
			interruptCount: number;
			exitCode: number;
		};

		return {
			...results,
			stderr: Buffer.concat(stderrChunks).toString("utf-8").slice(0, 256),
		};
	} finally {
		try {
			fs.rmSync(stateRoot, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

test("RT-4: REAL interrupt guard writes acknowledged:true + body fires exactly once", async () => {
	const projectRoot = resolveProjectRoot();
	const { acknowledged, interruptCount, stderr } = await runHarness(projectRoot, "normal");

	// The REAL guard must write acknowledged:true back to the control file.
	// Revert scenario: if the ack-write block is removed from startInterruptGuard,
	// the file still has acknowledged=false → this assertion FAILS.
	assert.equal(
		acknowledged,
		true,
		`acknowledged must be true after the REAL guard processes the interrupt ` +
			`(got ${acknowledged}). Without the RT-4 ack write, the guard would re-fire ` +
			`every tick. Stderr: ${stderr}`,
	);

	// The REAL guard's interruptHandled gate + ack write must ensure the body
	// fires exactly once across multiple ticks.
	// Revert scenario: if BOTH the gate AND the ack write are removed, the body
	// re-fires every 50ms tick → interruptCount > 1 → this assertion FAILS.
	assert.equal(
		interruptCount,
		1,
		`interrupt body must fire exactly once (got ${interruptCount}). ` +
			`Without the RT-4 gate + ack, it re-fires every tick (~20×/s at 50ms). ` +
			`Stderr: ${stderr}`,
	);

	console.log(`[RT-4] ✓ REAL guard: acknowledged=true, body fired once (not ${interruptCount})`);
});

test("RT-4: REAL interruptHandled gate prevents re-fire even when ack write fails (defense-in-depth)", async () => {
	const projectRoot = resolveProjectRoot();
	const { interruptCount, stderr } = await runHarness(projectRoot, "gate-only");

	// In gate-only mode, we undo the ack write after the first fire (simulating
	// a transient fs error). The gate (interruptHandled) must still prevent the
	// body from re-firing on subsequent ticks.
	//
	// Revert scenario: if the interruptHandled gate is removed from
	// startInterruptGuard (but ack write kept), the undo'd control file makes
	// the body re-fire every tick → interruptCount > 1 → this assertion FAILS.
	assert.equal(
		interruptCount,
		1,
		`gate must prevent re-fire even when ack write fails: expected 1 execution ` +
			`but got ${interruptCount}. Without the interruptHandled gate, the body ` +
			`re-fires every tick after the ack is undone. Stderr: ${stderr}`,
	);

	console.log(`[RT-4] ✓ REAL gate (defense-in-depth): body fired once even with failed ack`);
});
