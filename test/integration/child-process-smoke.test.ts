/**
 * TB-4: real child-process integration test for pi-crew's child-pi spawn
 * path. Spawns test/fixtures/fake-pi.mjs (which emulates pi's wire format)
 * using the same Node.js child_process API child-pi.ts uses, and verifies:
 *   1. Valid JSON-line events on stdout are parsed correctly.
 *   2. Multiple message/message_end pairs arrive in order.
 *   3. The fixture handles SIGTERM cooperatively (emits a `cancelled`
 *      event + exits 143) so parent readers can distinguish a cooperative
 *      cancel from a crash.
 *   4. A SIGKILL'd child is detected via the 'exit' event with code=null.
 *
 * This is intentionally a low-level test (raw child_process, no child-pi.ts
 * wrapper) so the assertions stay focused on the wire contract, not on
 * pi-crew's specific handling logic — keeping the test resilient to
 * refactors of child-pi.ts.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

/** Spawn the fixture and return a helper that captures lines until done. */
async function runFixture(
	args: string[],
	options: {
		timeoutMs?: number;
		emitCount?: number;
	} = {},
): Promise<{ child: ChildProcess; lines: string[]; exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [FIXTURE_PATH, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const lines: string[] = [];
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Fixture hung after ${options.timeoutMs ?? 10_000}ms`));
		}, options.timeoutMs ?? 10_000);

		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (line.trim()) lines.push(line);
			}
		});
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ child, lines, exitCode: code, signal, stderr });
		});
	});
}

// ── 1. Single message round-trip parses correctly ───────────────────────
test("fake-pi fixture emits a single message/message_end pair on stdout", async () => {
	const { lines, exitCode, stderr } = await runFixture(["--mode", "json", "-p", "hello"], {
		timeoutMs: 5_000,
	});
	assert.equal(exitCode, 0, `fake-pi exits 0 on success (stderr=${stderr})`);
	assert.equal(lines.length, 2, `expected 2 JSON lines, got ${lines.length}: ${lines.join("|")}`);
	const msg = JSON.parse(lines[0]!);
	const end = JSON.parse(lines[1]!);
	assert.equal(msg.type, "message");
	assert.equal(msg.message.role, "assistant");
	assert.equal(msg.message.content[0].type, "text");
	assert.ok(msg.message.content[0].text.includes("hello"));
	assert.equal(end.type, "message_end");
	assert.equal(typeof end.usage.input, "number");
	assert.equal(typeof end.usage.output, "number");
});

// ── 2. Multiple pairs arrive in order ────────────────────────────────────
test("fake-pi fixture emits multiple message pairs in deterministic order", async () => {
	const { lines, exitCode } = await runFixture(["--mode", "json", "-p", "loop", "--emit-count", "3"], { timeoutMs: 5_000 });
	assert.equal(exitCode, 0);
	assert.ok(lines.length >= 6, `expected >=6 lines (3 pairs), got ${lines.length}`);
	const types = lines.map((l) => JSON.parse(l).type);
	for (let i = 0; i < types.length; i += 2) {
		assert.equal(types[i], "message", `line ${i} should be a message`);
		assert.equal(types[i + 1], "message_end", `line ${i + 1} should be a message_end`);
	}
});

// ── 3. SIGTERM cooperative shutdown ─────────────────────────────────────
test("fake-pi fixture handles SIGTERM cooperatively (emits cancelled + exits 143)", async () => {
	const child = spawn(process.execPath, [FIXTURE_PATH, "--mode", "json", "-p", "long", "--emit-count", "20", "--idle-ms", "100"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const collectedLines: string[] = [];
	let cancelledSeen = false;
	child.stdout?.setEncoding("utf-8");
	child.stdout?.on("data", (chunk: string) => {
		for (const line of chunk.split("\n")) {
			if (!line.trim()) continue;
			collectedLines.push(line);
			try {
				const obj = JSON.parse(line);
				if (obj.type === "cancelled") cancelledSeen = true;
			} catch {
				/* ignore non-JSON */
			}
		}
	});

	// Wait until at least 2 lines arrive (one message pair).
	const startTime = Date.now();
	while (collectedLines.length < 2 && Date.now() - startTime < 3_000) {
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(collectedLines.length >= 2, `should have emitted at least one pair before SIGTERM, got ${collectedLines.length}`);
	assert.equal(cancelledSeen, false, "cancelled event must not fire before SIGTERM");

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	child.kill("SIGTERM");
	const exitInfo = await exitPromise;
	// Cooperative cancel needs a brief moment to flush the cancelled event.
	await new Promise((r) => setTimeout(r, 100));

	assert.equal(exitInfo.code, 143, `SIGTERM should yield exit code 143, got ${exitInfo.code}`);
	assert.ok(cancelledSeen, "SIGTERM must trigger a cooperative 'cancelled' event on stdout");
});

// ── 4. SIGKILL is observed as exit-code=null (no cooperative cancel) ────
test("fake-pi fixture reports exit-code=null when SIGKILL'd (crash path)", async () => {
	const child = spawn(process.execPath, [FIXTURE_PATH, "--mode", "json", "-p", "forever", "--emit-count", "50", "--idle-ms", "500"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Let it start emitting, then SIGKILL.
	await new Promise((r) => setTimeout(r, 200));
	const exitInfo: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolve) => {
		child.kill("SIGKILL");
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	// Node reports SIGKILL as signal='SIGKILL' with code=null.
	assert.equal(exitInfo.code, null, "SIGKILL must produce code=null");
	assert.equal(exitInfo.signal, "SIGKILL");
});

// ── 5. Garbage line in --fail-mode does not crash the fixture ───────────
test("fake-pi fixture survives emitting a non-JSON garbage line first (parser fallback)", async () => {
	const { lines, exitCode } = await runFixture(["--mode", "json", "-p", "fail", "--fail-mode"], { timeoutMs: 5_000 });
	assert.equal(exitCode, 0, "fixture must still exit 0 after garbage line");
	assert.equal(lines[0], "not-a-json-line", "garbage line must be emitted first");
	const msg = JSON.parse(lines[1]!);
	assert.equal(msg.type, "message");
	const end = JSON.parse(lines[2]!);
	assert.equal(end.type, "message_end");
});

// ── 6. Fixture file is portable + exists at expected path ────────────────
test("fake-pi fixture lives at test/fixtures/fake-pi.mjs and is inside the repo", () => {
	assert.ok(fs.existsSync(FIXTURE_PATH), `fixture not found at ${FIXTURE_PATH}`);
	const stat = fs.statSync(FIXTURE_PATH);
	assert.ok(stat.isFile());
	const repoRoot = path.resolve(path.dirname(FIXTURE_PATH), "..", "..");
	assert.ok(FIXTURE_PATH.startsWith(repoRoot + path.sep), "fixture must be inside the repo");
	const lower = FIXTURE_PATH.toLowerCase();
	assert.ok(!lower.includes(`${path.sep}dist${path.sep}`));
	assert.ok(!lower.includes(`${path.sep}node_modules${path.sep}`));
});

// ── 7. stdin-echo path is exercised ─────────────────────────────────────
test("fake-pi fixture mirrors stdin back to stdout in --stdin-echo mode", async () => {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [FIXTURE_PATH, "--stdin-echo"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const collectedLines: string[] = [];
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (line.trim()) collectedLines.push(line);
			}
		});

		child.stdin?.write('{"cmd":"one"}\n');
		child.stdin?.write('{"cmd":"two"}\n');
		child.stdin?.end();

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("stdin-echo fixture hung"));
		}, 5_000);

		child.on("exit", (code) => {
			clearTimeout(timer);
			try {
				assert.equal(code, 0, "stdin-echo mode exits 0 cleanly after stdin closes");
				// Wait a beat for the readline/data events to flush before asserting
				// (the child exits on stdin 'end', but stdout data may still be in flight).
				setImmediate(() => {
					try {
						assert.ok(collectedLines.includes('{"cmd":"one"}'), "first stdin line must be echoed");
						assert.ok(collectedLines.includes('{"cmd":"two"}'), "second stdin line must be echoed");
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			} catch (error) {
				reject(error);
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
});
