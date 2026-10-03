/**
 * W2 (Pi 1.0.0 adoption — session-file recovery) unit tests.
 *
 * Covers the session-recovery module contract:
 *   - fixture JSONL matrix: header / model_change / user-assistant pairs /
 *     SIGKILL tails (user-last, toolResult-last, torn final line) — entry
 *     parsing is DELEGATED to the SDK (parseSessionEntries/migrateSessionEntries),
 *     the module only tail-scans for the last COMPLETE assistant record
 *   - deriveSessionPaths identity matrix (per-task dir, manifest session-id,
 *     delegate ":" ids, unsafe ids fail closed, explicit dir override)
 *   - appendWorkerSessionArgs argv wiring (both argv views, after the
 *     `--mode json -p` cluster, idempotent under builder forwarding)
 *   - resolveSessionRecoveryEnabled precedence (env override > explicit flag >
 *     default ON)
 *   - shouldAttemptSessionRecovery crash-path predicate (exitCode null / killed)
 *   - source contract: child-pi.ts settle path actually awaits the recovery
 *     augment before resolve (repo source-contract pattern, cf. HB-003a test)
 *
 * Env hygiene (worker-shell gotcha 2026-08-15): tests snapshot/restore
 * process.env around every case that touches PI_CREW_* so ambient worker env
 * can never skew results.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	appendWorkerSessionArgs,
	deriveSessionPaths,
	recoverLastAssistantFromSession,
	resolveSessionRecoveryEnabled,
	shouldAttemptSessionRecovery,
} from "../../../../src/runtime/child-pi/session-recovery.ts";

// ─── env hygiene ─────────────────────────────────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// ─── fixture builders (SDK session JSONL shapes, version 3) ──────────────────

interface EntryLike {
	type: string;
	[key: string]: unknown;
}

function headerEntry(id = "sess1"): EntryLike {
	return { type: "session", version: 3, id, timestamp: "2026-10-03T10:00:00.000Z", cwd: "/tmp" };
}

function modelChangeEntry(id: string, parentId: string | null): EntryLike {
	return { type: "model_change", id, parentId, timestamp: "2026-10-03T10:00:01.000Z", provider: "anthropic", modelId: "claude-x" };
}

function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>): EntryLike {
	return { type: "message", id, parentId, timestamp: "2026-10-03T10:00:02.000Z", message };
}

function userMessage(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMessage(text: string, stopReason = "stop"): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-x",
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		stopReason,
		timestamp: 2,
	};
}

function toolCallAssistant(stopReason = "toolUse"): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-x",
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		stopReason,
		timestamp: 2,
	};
}

function toolResultMessage(): Record<string, unknown> {
	return { role: "toolResult", content: [], toolCallId: "tc1", timestamp: 3 };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-session-recovery-"));
	tempDirs.push(dir);
	return dir;
}

function writeSessionFile(dir: string, name: string, entries: EntryLike[], opts?: { tornTail?: string }): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	const body = entries.map((e) => JSON.stringify(e)).join("\n");
	// A well-formed file ends with a newline; a torn tail simulates SIGKILL
	// mid-write (unterminated final line).
	const torn = opts?.tornTail;
	fs.writeFileSync(file, torn === undefined ? `${body}\n` : `${body}\n${torn}`, "utf8");
	return file;
}

after(() => {
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

// ─── recoverLastAssistantFromSession: fixture matrix ─────────────────────────

test("recovery: full session (header + model_change + user/assistant pairs) returns the LAST complete assistant", async () => {
	const dir = makeTempDir();
	writeSessionFile(dir, "20261003-1000_task1.jsonl", [
		headerEntry(),
		modelChangeEntry("e1", null),
		messageEntry("e2", "e1", userMessage("do the thing")),
		messageEntry("e3", "e2", assistantMessage("first turn answer")),
		messageEntry("e4", "e3", userMessage("and now?")),
		messageEntry("e5", "e4", assistantMessage("final answer")),
	]);
	const recovered = await recoverLastAssistantFromSession(dir, "task1");
	assert.ok(recovered, "should recover");
	assert.equal(recovered.text, "final answer");
	assert.equal(recovered.sessionId, "task1");
	assert.equal(recovered.stopReason, "stop");
	assert.ok(recovered.sessionFile.endsWith("20261003-1000_task1.jsonl"));
	assert.equal(typeof recovered.timestamp, "string");
});

test("recovery: SIGKILL tail — user record last, no assistant after → returns the PREVIOUS complete assistant", async () => {
	const dir = makeTempDir();
	writeSessionFile(dir, "20261003-1000_task2.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("task")),
		messageEntry("e2", "e1", assistantMessage("partial-run answer")),
		messageEntry("e3", "e2", userMessage("follow-up when killed mid-turn")),
	]);
	const recovered = await recoverLastAssistantFromSession(dir, "task2");
	assert.ok(recovered, "worker died mid-turn — earlier complete turn is recoverable");
	assert.equal(recovered.text, "partial-run answer");
});

test("recovery: SIGKILL tail — toolResult last + textless toolCall assistant → skips to the last assistant WITH text", async () => {
	const dir = makeTempDir();
	writeSessionFile(dir, "20261003-1000_task3.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("task")),
		messageEntry("e2", "e1", assistantMessage("spoken answer first")),
		messageEntry("e3", "e2", userMessage("run a tool")),
		messageEntry("e4", "e3", toolCallAssistant()), // complete but textless
		messageEntry("e5", "e4", toolResultMessage()), // killed before the next assistant
	]);
	const recovered = await recoverLastAssistantFromSession(dir, "task3");
	assert.ok(recovered, "textless tool-turn must not starve recovery");
	assert.equal(recovered.text, "spoken answer first");
	assert.equal(recovered.stopReason, "stop");
});

test("recovery: torn final line (SIGKILL mid-write) is dropped defensively, no throw", async () => {
	const dir = makeTempDir();
	writeSessionFile(
		dir,
		"20261003-1000_task4.jsonl",
		[
			headerEntry(),
			messageEntry("e1", null, userMessage("task")),
			messageEntry("e2", "e1", assistantMessage("durable answer")),
			messageEntry("e3", "e2", userMessage("next turn")),
		],
		{ tornTail: '{"type":"message","id":"e4","parentId":"e3","message":{"role":"assistant","cont' },
	);
	const recovered = await recoverLastAssistantFromSession(dir, "task4");
	assert.ok(recovered, "torn tail must not break recovery");
	assert.equal(recovered.text, "durable answer");
});

test("recovery: dangling assistant stopReason=pending is treated as INCOMPLETE", async () => {
	const dir = makeTempDir();
	writeSessionFile(dir, "20261003-1000_task5.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("task")),
		messageEntry("e2", "e1", assistantMessage("settled answer")),
		messageEntry("e3", "e2", userMessage("again")),
		messageEntry("e4", "e3", assistantMessage("never finished", "pending")),
	]);
	const recovered = await recoverLastAssistantFromSession(dir, "task5");
	assert.ok(recovered, "pending turn is not complete — earlier turn wins");
	assert.equal(recovered.text, "settled answer");
});

test("recovery: user-only session (no assistant ever completed) → null", async () => {
	const dir = makeTempDir();
	writeSessionFile(dir, "20261003-1000_task6.jsonl", [headerEntry(), messageEntry("e1", null, userMessage("killed before first turn"))]);
	const recovered = await recoverLastAssistantFromSession(dir, "task6");
	assert.equal(recovered, null);
});

test("recovery: id-suffixed file wins over a NEWER non-matching file in the same dir", async () => {
	const dir = makeTempDir();
	const other = writeSessionFile(dir, "20261003-1200_otherworker.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("x")),
		messageEntry("e2", "e1", assistantMessage("someone else's answer")),
	]);
	// id-matching file written EARLIER (mtime older) — id match must win.
	const mine = writeSessionFile(dir, "20261003-1000_task7.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("x")),
		messageEntry("e2", "e1", assistantMessage("my answer")),
	]);
	const earlier = new Date(Date.now() - 60_000);
	fs.utimesSync(mine, earlier, earlier);
	fs.utimesSync(other, new Date(), new Date());
	const recovered = await recoverLastAssistantFromSession(dir, "task7");
	assert.ok(recovered);
	assert.equal(recovered.text, "my answer");
	assert.equal(recovered.sessionFile, mine);
});

test("recovery: newest id-matching file wins among matches (retry appended a new file)", async () => {
	const dir = makeTempDir();
	const attempt1 = writeSessionFile(dir, "20261003-1000_task8.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("x")),
		messageEntry("e2", "e1", assistantMessage("attempt 1 answer")),
	]);
	const attempt2 = writeSessionFile(dir, "20261003-1100_task8.jsonl", [
		headerEntry(),
		messageEntry("e1", null, userMessage("x")),
		messageEntry("e2", "e1", assistantMessage("attempt 2 answer")),
	]);
	const earlier = new Date(Date.now() - 120_000);
	fs.utimesSync(attempt1, earlier, earlier);
	fs.utimesSync(attempt2, new Date(), new Date());
	const recovered = await recoverLastAssistantFromSession(dir, "task8");
	assert.ok(recovered);
	assert.equal(recovered.text, "attempt 2 answer");
});

test("recovery: missing dir / empty dir → null (no throw)", async () => {
	assert.equal(await recoverLastAssistantFromSession(path.join(makeTempDir(), "nope"), "task9"), null);
	assert.equal(await recoverLastAssistantFromSession(makeTempDir(), "task10"), null);
});

test("recovery: never hangs past its deadline on a pathological file", async () => {
	const dir = makeTempDir();
	const file = path.join(dir, "20261003-1000_task11.jsonl");
	// A huge single unterminated line: read + drop-tail path stays bounded.
	fs.writeFileSync(file, `${"x".repeat(1024 * 1024)}`, "utf8");
	const started = Date.now();
	const recovered = await recoverLastAssistantFromSession(dir, "task11");
	assert.equal(recovered, null);
	assert.ok(Date.now() - started < 5_000, "must resolve well inside the deadline");
});

// ─── deriveSessionPaths ──────────────────────────────────────────────────────

test("deriveSessionPaths: per-task dir under artifactsRoot, task id as session id", () => {
	const ctx = deriveSessionPaths({ agentId: "01_01-agent", artifactsRoot: "/tmp/run/artifacts" });
	assert.ok(ctx);
	assert.equal(ctx.sessionId, "01_01-agent");
	assert.equal(ctx.sessionDir, path.join("/tmp/run/artifacts", "sessions", "01_01-agent"));
});

test("deriveSessionPaths: explicit sessionId (manifest.sessionId) rides --session-id, dir stays per-task", () => {
	const ctx = deriveSessionPaths({ sessionId: "crew-team20261003", agentId: "02_05-verifier", artifactsRoot: "/tmp/run/artifacts" });
	assert.ok(ctx);
	assert.equal(ctx.sessionId, "crew-team20261003");
	assert.equal(ctx.sessionDir, path.join("/tmp/run/artifacts", "sessions", "02_05-verifier"));
});

test("deriveSessionPaths: delegate id 'parent:child' collapses to the leaf segment", () => {
	const ctx = deriveSessionPaths({ agentId: "01_02-agent:helper", artifactsRoot: "/tmp/run/artifacts" });
	assert.ok(ctx);
	assert.equal(ctx.sessionId, "helper");
	assert.equal(ctx.sessionDir, path.join("/tmp/run/artifacts", "sessions", "helper"));
});

test("deriveSessionPaths: unsafe id (path traversal chars) fails closed → null", () => {
	assert.equal(deriveSessionPaths({ agentId: "../evil", artifactsRoot: "/tmp/run/artifacts" }), null);
	assert.equal(deriveSessionPaths({ sessionId: "a b/c", artifactsRoot: "/tmp/run/artifacts" }), null);
});

test("deriveSessionPaths: no identity / no artifactsRoot → null (custom spawns keep legacy ~/.pi sessions)", () => {
	assert.equal(deriveSessionPaths({ artifactsRoot: "/tmp/run/artifacts" }), null);
	assert.equal(deriveSessionPaths({ agentId: "01_01-agent" }), null);
	assert.equal(deriveSessionPaths({}), null);
});

test("deriveSessionPaths: explicit sessionDir override wins verbatim", () => {
	const ctx = deriveSessionPaths({ agentId: "01_01-agent", artifactsRoot: "/tmp/run/artifacts", sessionDir: "/tmp/elsewhere/sessions" });
	assert.ok(ctx);
	assert.equal(ctx.sessionDir, "/tmp/elsewhere/sessions");
	assert.equal(ctx.sessionId, "01_01-agent");
});

// ─── appendWorkerSessionArgs ─────────────────────────────────────────────────

test("appendWorkerSessionArgs: inserts flags right after the --mode json -p cluster on BOTH argv views", () => {
	const builtArgs = ["--mode", "json", "-p", "--model", "m", "@/tmp/task.md"];
	const spawnArgs = ["/path/to/pi-cli.js", ...builtArgs];
	const appended = appendWorkerSessionArgs(spawnArgs, builtArgs, { sessionId: "task1", sessionDir: "/tmp/sessions/task1" });
	assert.equal(appended, true);
	// builtArgs: flags after the headless cluster, BEFORE the task positional.
	assert.deepEqual(builtArgs.slice(0, 7), ["--mode", "json", "-p", "--session-id", "task1", "--session-dir", "/tmp/sessions/task1"]);
	assert.ok(builtArgs.includes("@/tmp/task.md"));
	// spawnArgs: same flags after [script, --mode, json, -p].
	assert.deepEqual(spawnArgs.slice(0, 8), [
		"/path/to/pi-cli.js",
		"--mode",
		"json",
		"-p",
		"--session-id",
		"task1",
		"--session-dir",
		"/tmp/sessions/task1",
	]);
});

test("appendWorkerSessionArgs: no headless cluster (surface-shaped argv) → flags appended at the end", () => {
	const builtArgs = ["--model", "m"];
	const spawnArgs = ["pi", "--model", "m"];
	appendWorkerSessionArgs(spawnArgs, builtArgs, { sessionId: "t", sessionDir: "/d" });
	assert.deepEqual(builtArgs, ["--model", "m", "--session-id", "t", "--session-dir", "/d"]);
	assert.deepEqual(spawnArgs, ["pi", "--model", "m", "--session-id", "t", "--session-dir", "/d"]);
});

test("appendWorkerSessionArgs: idempotent — already-forwarded flags (future builder wiring) are a no-op", () => {
	const builtArgs = ["--mode", "json", "-p", "--session-id", "task1", "--session-dir", "/d"];
	const spawnArgs = ["/pi.js", ...builtArgs];
	const appended = appendWorkerSessionArgs(spawnArgs, builtArgs, { sessionId: "task1", sessionDir: "/d" });
	assert.equal(appended, false);
	assert.equal(builtArgs.filter((a) => a === "--session-id").length, 1);
	assert.equal(spawnArgs.filter((a) => a === "--session-id").length, 1);
});

// ─── resolveSessionRecoveryEnabled ───────────────────────────────────────────

test("enabled gate: default ON when neither env nor explicit flag is set", () => {
	withEnv({ PI_CREW_SESSION_RECOVERY: undefined }, () => {
		assert.equal(resolveSessionRecoveryEnabled(undefined), true);
		assert.equal(resolveSessionRecoveryEnabled(true), true);
		assert.equal(resolveSessionRecoveryEnabled(false), false);
	});
});

test("enabled gate: env PI_CREW_SESSION_RECOVERY overrides the explicit flag in EITHER direction", () => {
	withEnv({ PI_CREW_SESSION_RECOVERY: "0" }, () => {
		assert.equal(resolveSessionRecoveryEnabled(true), false, "operator kill-switch must beat config ON");
	});
	withEnv({ PI_CREW_SESSION_RECOVERY: "1" }, () => {
		assert.equal(resolveSessionRecoveryEnabled(false), true, "env force-on must beat config OFF");
	});
	withEnv({ PI_CREW_SESSION_RECOVERY: "false" }, () => {
		assert.equal(resolveSessionRecoveryEnabled(undefined), false, "boolean parser accepts 'false'");
	});
});

// ─── shouldAttemptSessionRecovery (exitCode-null / killed predicate) ─────────

test("crash predicate: exitCode null OR killed → attempt; clean exit → skip", () => {
	assert.equal(shouldAttemptSessionRecovery({ exitCode: null }, false), true, "signal death (exit null)");
	assert.equal(shouldAttemptSessionRecovery({ exitCode: 0 }, false), false, "clean exit");
	assert.equal(shouldAttemptSessionRecovery({ exitCode: 1 }, false), false, "non-zero but complete exit");
	assert.equal(shouldAttemptSessionRecovery({ exitCode: 137 }, false), false);
	assert.equal(shouldAttemptSessionRecovery({ exitCode: 0 }, true), true, "hardKilled flag alone qualifies");
	assert.equal(
		shouldAttemptSessionRecovery({ exitCode: 0, exitStatus: { exitCode: null, killed: false } }, false),
		true,
		"explicit exitStatus wins (null)",
	);
	assert.equal(
		shouldAttemptSessionRecovery({ exitCode: 0, exitStatus: { exitCode: 0, killed: true } }, false),
		true,
		"explicit exitStatus wins (killed)",
	);
	assert.equal(
		shouldAttemptSessionRecovery({ exitCode: null, exitStatus: { exitCode: 0, killed: false } }, true),
		false,
		"explicit exitStatus also suppresses (clean + not killed)",
	);
});

// ─── source contract: settle path wiring (cf. HB-003a pattern) ───────────────

test("source contract: child-pi settle awaits session recovery before resolve and threads the flags", () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
	const src = fs.readFileSync(path.join(repoRoot, "src/runtime/child-pi/child-pi.ts"), "utf8");
	// Both resolve branches await the augment and spread it into the result.
	assert.ok(
		src.includes("const recoveredFromSession = await recoverForSettle(result);"),
		"settle must await recoverForSettle before resolve",
	);
	assert.equal(
		src.match(/\.\.\.\(recoveredFromSession \? \{ recoveredFromSession \} : \{\}\),/g)?.length,
		2,
		"both settle branches must spread the recovered record",
	);
	// The spawn-side activation exists and is idempotent.
	assert.ok(src.includes("appendWorkerSessionArgs(spawnSpec.args, builtArgs, workerSession)"), "spawn argv must carry the session flags");
	// The gate honors the disabled config.
	assert.ok(src.includes("resolveSessionRecoveryEnabled(input.sessionRecovery)"), "recovery gate must read the explicit flag");
});
