/**
 * rpc-worker.test.ts — W7 (P2-3): runRpcWorker end-to-end against a scripted
 * fake RPC stream (NO real pi spawn), plus the transport/dialog env resolvers
 * (the packet's "config precedence" cases).
 *
 * The fake server plays rpc-mode.js: it answers the `prompt` command, streams
 * a `message_end` assistant record + `agent_settled`, and exits 0 when the
 * client ends stdin (orderly shutdown).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRpcWorkerArgv,
	RPC_DIALOG_ANSWER_ENV,
	resolveDialogAnswerPolicy,
	resolveWorkerTransport,
	runRpcWorker,
	WORKER_TRANSPORT_ENV,
} from "../../../../src/runtime/rpc/rpc-worker.ts";
import { createFakeRpcServer, delay, type FakeRpcServer } from "./fake-rpc-stream.ts";

/** Script a well-behaved fake server: prompt → response → assistant msg → settle. */
function scriptHappyPath(fake: FakeRpcServer, finalText = "the final answer", opts: { settle?: boolean } = {}) {
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
			fake.emit({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: finalText }] },
			});
			if (opts.settle !== false) fake.emit({ type: "agent_settled" });
		} else if (record.type === "abort") {
			fake.emit({ id: record.id, type: "response", command: "abort", success: true });
			fake.emit({ type: "agent_settled" });
		}
	};
	fake.onStdinEnd = () => {
		setTimeout(() => fake.exitWith(0), 5);
	};
}

function runWith(fake: FakeRpcServer, overrides: Parameters<typeof runRpcWorker>[0]["rpc"] = {}) {
	return runRpcWorker({
		task: "do the thing",
		rpc: { spawnFn: () => fake.handle, commandTimeoutMs: 400, stopTimeoutMs: 300, ...overrides },
	});
}

test("happy path: prompt sent first, settle observed, orderly exit, result mapped", async () => {
	const fake = createFakeRpcServer();
	scriptHappyPath(fake, "done: 3 files");
	const result = await runWith(fake);
	// First frame on stdin must be the prompt command carrying the task.
	const first = fake.writtenRecords()[0];
	assert.equal(first.type, "prompt");
	assert.equal(first.message, "do the thing");
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.rawFinalText, "done: 3 files");
	assert.notEqual(result.stdout, "");
	assert.ok(result.stdout.includes("agent_settled"));
});

test("live-fire argv (probe GREEN 2026-10-04): --mode rpc --no-session, model appended raw, override wins", async () => {
	// Pure builder contract — the argv the live-fire probe validated.
	assert.deepEqual(buildRpcWorkerArgv(undefined), ["--mode", "rpc", "--no-session"]);
	assert.deepEqual(buildRpcWorkerArgv("zai/glm-5.3:high"), ["--mode", "rpc", "--no-session", "--model", "zai/glm-5.3:high"]);
	// Behavioral: runRpcWorker builds it from input.model when the caller
	// does not pass a wholesale argv override (probe1b scenario: exit 0,
	// rawFinalText "OK", 24 ui-requests drained against real pi).
	const fake = createFakeRpcServer();
	scriptHappyPath(fake, "OK");
	const captured: { argv?: string[] } = {};
	await runRpcWorker({
		task: "x",
		model: "chiase/deepseek-v4.1-flash",
		rpc: {
			spawnFn: (argv) => {
				captured.argv = argv;
				return fake.handle;
			},
			commandTimeoutMs: 400,
			stopTimeoutMs: 300,
		},
	});
	assert.deepEqual(captured.argv, ["--mode", "rpc", "--no-session", "--model", "chiase/deepseek-v4.1-flash"]);
});

test("assistant text: only assistant message_end records become rawFinalText", async () => {
	const fake = createFakeRpcServer();
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
			fake.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "noise" }] } });
			fake.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "part 1" },
						{ type: "text", text: "part 2" },
					],
				},
			});
			fake.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_call", name: "bash" }] } });
			fake.emit({ type: "agent_settled" });
		}
	};
	fake.onStdinEnd = () => setTimeout(() => fake.exitWith(0), 5);
	const result = await runWith(fake);
	// user record ignored; multi-part text joined; text-less assistant does not clobber.
	assert.equal(result.rawFinalText, "part 1\npart 2");
});

test("abort: signal abort sends the RPC abort command, marks result aborted", async () => {
	const fake = createFakeRpcServer();
	scriptHappyPath(fake, "partial work", { settle: false });
	const controller = new AbortController();
	const promise = runRpcWorker({
		task: "long task",
		signal: controller.signal,
		rpc: { spawnFn: () => fake.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 },
	});
	await delay(15); // let the prompt + message_end land
	controller.abort();
	const result = await promise;
	assert.equal(result.aborted, true);
	assert.equal(result.rawFinalText, "partial work");
	const types = fake.writtenRecords().map((r) => r.type);
	assert.ok(types.includes("abort"), "RPC abort command must be sent");
	assert.equal(result.error, undefined);
});

test("prompt rejection: server error becomes result.error, transport still stops cleanly", async () => {
	const fake = createFakeRpcServer();
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: false, error: "no model" });
			fake.emit({ type: "agent_settled" });
		}
	};
	fake.onStdinEnd = () => setTimeout(() => fake.exitWith(1), 5);
	const result = await runWith(fake);
	assert.match(result.error ?? "", /no model/);
	assert.equal(result.rawFinalText, undefined);
});

test("dialog auto-answer flows through runRpcWorker (default env → cancel)", async () => {
	const savedDialog = process.env[RPC_DIALOG_ANSWER_ENV];
	delete process.env[RPC_DIALOG_ANSWER_ENV];
	const savedTransport = process.env[WORKER_TRANSPORT_ENV];
	delete process.env[WORKER_TRANSPORT_ENV];
	try {
		const fake = createFakeRpcServer();
		fake.onLine = (line) => {
			const record = JSON.parse(line) as { id?: string; type?: string };
			if (record.type === "prompt") {
				fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
				fake.emit({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "ok?", message: "m" });
				fake.emit({ type: "agent_settled" });
			}
		};
		fake.onStdinEnd = () => setTimeout(() => fake.exitWith(0), 5);
		const result = await runWith(fake);
		assert.equal(result.exitCode, 0);
		const uiResponse = fake.writtenRecords().find((r) => r.type === "extension_ui_response");
		assert.deepEqual(uiResponse, { type: "extension_ui_response", id: "ask-1", cancelled: true });
	} finally {
		if (savedDialog !== undefined) process.env[RPC_DIALOG_ANSWER_ENV] = savedDialog;
		if (savedTransport !== undefined) process.env[WORKER_TRANSPORT_ENV] = savedTransport;
	}
});

test("resolvers: resolveWorkerTransport fails safe to stdio (config precedence)", () => {
	const read = (value: string | undefined) => (name: string) => (name === WORKER_TRANSPORT_ENV ? value : undefined);
	assert.equal(resolveWorkerTransport(read(undefined)), "stdio", "unset → default stdio");
	assert.equal(resolveWorkerTransport(read("rpc")), "rpc");
	assert.equal(resolveWorkerTransport(read("  rpc  ")), "rpc", "trimmed exact match");
	assert.equal(resolveWorkerTransport(read("RPC")), "stdio", "case-sensitive failsafe");
	assert.equal(resolveWorkerTransport(read("stdio")), "stdio");
	assert.equal(resolveWorkerTransport(read("garbage")), "stdio");
	assert.equal(resolveWorkerTransport(read("")), "stdio");
});

test("resolvers: resolveDialogAnswerPolicy fails safe to cancel", () => {
	const read = (value: string | undefined) => (name: string) => (name === RPC_DIALOG_ANSWER_ENV ? value : undefined);
	assert.equal(resolveDialogAnswerPolicy(read(undefined)), "cancel");
	assert.equal(resolveDialogAnswerPolicy(read("cancel")), "cancel");
	assert.equal(resolveDialogAnswerPolicy(read("block")), "block");
	assert.equal(resolveDialogAnswerPolicy(read("bloc")), "cancel", "invalid → failsafe cancel");
	assert.equal(resolveDialogAnswerPolicy(read("approve")), "cancel", "auto-approve does not exist");
});

test("resolvers: live env wiring (getCrewEnv-backed default reader)", () => {
	const savedTransport = process.env[WORKER_TRANSPORT_ENV];
	const savedDialog = process.env[RPC_DIALOG_ANSWER_ENV];
	try {
		delete process.env[WORKER_TRANSPORT_ENV];
		assert.equal(resolveWorkerTransport(), "stdio");
		process.env[WORKER_TRANSPORT_ENV] = "rpc";
		assert.equal(resolveWorkerTransport(), "rpc");
		delete process.env[RPC_DIALOG_ANSWER_ENV];
		assert.equal(resolveDialogAnswerPolicy(), "cancel");
		process.env[RPC_DIALOG_ANSWER_ENV] = "block";
		assert.equal(resolveDialogAnswerPolicy(), "block");
	} finally {
		if (savedTransport === undefined) delete process.env[WORKER_TRANSPORT_ENV];
		else process.env[WORKER_TRANSPORT_ENV] = savedTransport;
		if (savedDialog === undefined) delete process.env[RPC_DIALOG_ANSWER_ENV];
		else process.env[RPC_DIALOG_ANSWER_ENV] = savedDialog;
	}
});
