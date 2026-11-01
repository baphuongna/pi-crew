/**
 * crew-broker-respond-cross-process.test.ts — HƯỚNG A cross-process E2E
 * (ADR Option 3, run team_20261101000805_8fe294ff11954460, 2026-11-01).
 *
 * INTERNAL COVER for the leader's probe8 foreign-session acceptance: the
 * responder is NOT the broker-host process, and delivery is judged by a
 * reader process that holds ONLY the worker-context singular verify key.
 * This is the FINDING-B incident topology (a cross-process responder's rows
 * failing the w1a gate) reproduced in miniature, plus the hướng A fix proof.
 *
 * Topology under test (the gap-3 / scheduler-host shape):
 *  - BROKER HOST: this test process (embedded broker; binds the DISPATCHER's
 *    public key from a FRESH keypair — the dispatcher is a DIFFERENT process,
 *    exactly the async-run topology where the runner hosts the broker and the
 *    scheduler/dispatcher lives elsewhere).
 *  - DISPATCHER process (spawned): holds the dispatcher PRIVATE key, runs the
 *    full CR flow over the real socket (challenge → sign nonce∥canonical →
 *    append) on ONE connection, then attempts a nonce REPLAY from a SECOND
 *    connection (must fail — nonces are per-connection).
 *  - READER process (spawned, ×2): a fresh worker-context reader — env
 *    PI_CREW_MAILBOX_VERIFY_KEY (singular) = the broker host's public key and
 *    NOTHING else (no in-process keypair can exist in a fresh process that
 *    never signs). INERT-READER LESSON: without the env the reader keeps
 *    every row and the drop path is unreproducible.
 *  - STRANGER process (spawned): a third process that signs a shape-valid
 *    response row with its OWN heap keypair and appends it RAW to the task
 *    inbox file (fs.appendFileSync — "tự append thô fs").
 *
 * Proven end-to-end:
 *  1. the dispatcher process's CR append makes the BROKER append a row that
 *     DELIVERS in the worker-context reader (hướng A closes the cross-process
 *     responder gap — probe8's foreign-session DELIVER expectation);
 *  2. the stranger's properly-signed row DROPS as noise in that same reader
 *     (w1a key-possession constraint holds — a third process cannot forge
 *     delivery even with a well-formed signature);
 *  3. the nonce replay from a second connection is rejected (auth).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import {
	COORDINATION_VERIFY_KEY_ENV,
	COORDINATION_VERIFY_KEYS_ENV,
	getMailboxVerifyKeyPublic,
	verifyMailboxRowSig,
} from "../../../../src/state/coordination/mailbox.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { getBrokerSocketPath } from "../../../../src/utils/socket-path.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const TEAM: TeamConfig = {
	name: "respond-xproc",
	description: "hướng A cross-process tests",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "executor", description: "worker role" }],
};

const WORKFLOW: WorkflowConfig = {
	name: "respond-xproc-flow",
	description: "single step",
	source: "builtin",
	filePath: "builtin",
	steps: [{ id: "one", role: "worker", task: "cross-process respond delivery" }],
};

// ----------------------------------------------------------------------------
// Child-process harnesses (0.11.55 foreign-signer discipline: import via
// pathToFileURL — an absolute win32 path is not a valid ESM specifier)
// ----------------------------------------------------------------------------

/** DISPATCHER process: full CR flow on ONE connection using the dispatcher
 *  PRIVATE key it was handed (pkcs8 DER base64), then a nonce REPLAY attempt
 *  from a SECOND connection. Writes { append, replay } JSON to outPath. */
const DISPATCHER_SIGNER_HARNESS = `
import { createPrivateKey, sign as edSign } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { pathToFileURL } from "node:url";
const [, , parsersPath, ndjsonPath, socketPath, paramsPath, privB64, outPath] = process.argv;
const { respondAppendSignInput } = await import(pathToFileURL(parsersPath).href);
const { encodeBrokerFrame, NdjsonDecoder } = await import(pathToFileURL(ndjsonPath).href);
const params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
const priv = createPrivateKey({ key: Buffer.from(privB64, "base64"), format: "der", type: "pkcs8" });
const state = {};
try {
	// Phase 1 — challenge → sign → append, ONE connection (per-connection nonce).
	const append = await new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const dec = new NdjsonDecoder();
		const timer = setTimeout(() => reject(new Error("phase1 timeout")), 15000);
		sock.once("connect", () => sock.write(encodeBrokerFrame({ id: "c1", method: "respond.challenge", params: { runId: params.runId } })));
		sock.on("data", (c) => {
			for (const f of dec.push(Buffer.isBuffer(c) ? c : Buffer.from(c))) {
				if (!f || typeof f !== "object") continue;
				if (f.id === "c1") {
					const nonce = f.result && f.result.nonce;
					if (!nonce) { clearTimeout(timer); sock.destroy(); reject(new Error("no nonce")); return; }
					const sig = edSign(null, Buffer.from(respondAppendSignInput(nonce, params), "utf8"), priv).toString("base64");
					state.nonce = nonce;
					state.sig = sig;
					sock.write(encodeBrokerFrame({ id: "a1", method: "respond.append", params: { ...params, nonce, sig } }));
				} else if (f.id === "a1") {
					clearTimeout(timer); sock.destroy();
					resolve({ append: f.result ?? { error: f.error ?? null } });
				}
			}
		});
		sock.on("error", (e) => { clearTimeout(timer); reject(e); });
	});
	// Phase 2 — REPLAY the exact (nonce, sig) from a brand-new connection: the
	// nonce is bound to the ORIGINAL connection, this must fail auth.
	const replay = await new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const dec = new NdjsonDecoder();
		const timer = setTimeout(() => reject(new Error("phase2 timeout")), 15000);
		sock.once("connect", () => sock.write(encodeBrokerFrame({ id: "r1", method: "respond.append", params: { ...params, nonce: state.nonce, sig: state.sig } })));
		sock.on("data", (c) => {
			for (const f of dec.push(Buffer.isBuffer(c) ? c : Buffer.from(c))) {
				if (f && typeof f === "object" && f.id === "r1") {
					clearTimeout(timer); sock.destroy();
					resolve(f.error ? f.error.code : "unexpected-success");
				}
			}
		});
		sock.on("error", (e) => { clearTimeout(timer); reject(e); });
	});
	fs.writeFileSync(outPath, JSON.stringify({ ...append, replay }));
} catch (e) {
	fs.writeFileSync(outPath, JSON.stringify({ harnessError: String(e) }));
	process.exit(3);
}
`;

/** READER process: fresh worker-context reader — the ONLY verify material it
 *  holds is the singular env key handed to it. Reports the ids/kinds it sees
 *  (rows failing the w1a gate are dropped before they can appear). */
const READER_HARNESS = `
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
const [, , mailboxModulePath, stateRoot, runId, taskId, outPath] = process.argv;
const mailbox = await import(pathToFileURL(mailboxModulePath).href);
const manifest = { stateRoot, runId };
const msgs = mailbox.readMailbox(manifest, "inbox", taskId);
fs.writeFileSync(outPath, JSON.stringify({ ids: msgs.map((m) => m.id), kinds: msgs.map((m) => m.kind) }));
`;

/** STRANGER process: signs a shape-valid response row with ITS OWN heap
 *  keypair and appends it RAW to the task inbox file. Reports its public key. */
const STRANGER_SIGNER_HARNESS = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const [, , mailboxModulePath, stateRoot, runId, taskId, questionId, outPath] = process.argv;
const mailbox = await import(pathToFileURL(mailboxModulePath).href);
const row = {
	id: "msg_xproc_stranger",
	runId,
	direction: "inbox",
	from: "leader",
	to: taskId,
	taskId,
	body: "stranger forged response (cross-process)",
	createdAt: new Date().toISOString(),
	status: "queued",
	kind: "response",
	priority: "normal",
	deliveryMode: "next_turn",
	questionId,
	requestId: "req_xproc_stranger",
};
const signed = mailbox.signMailboxMessage(row);
const inboxPath = path.join(stateRoot, "mailbox", "tasks", taskId, "inbox.jsonl");
fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
fs.appendFileSync(inboxPath, JSON.stringify(signed) + "\\n");
fs.writeFileSync(outPath, JSON.stringify({ pub: mailbox.getMailboxVerifyKeyPublic(), id: signed.id }));
`;

/** Spawn a harness child ASYNCHRONOUSLY — never spawnSync: the embedded broker
 *  lives in THIS process, and a sync spawn blocks its event loop, so no RPC
 *  child could ever get an answer (found the hard way while writing this
 *  test). Resolves with { status, stdout, stderr } once the child exits. */
function runHarness(
	harnessSource: string,
	args: string[],
	opts?: { env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string; status: number | null }> {
	return new Promise((resolve) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-xproc-"));
		const harnessPath = path.join(dir, "harness.ts");
		fs.writeFileSync(harnessPath, harnessSource);
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", harnessPath, ...args], {
			timeout: 60_000,
			...(opts?.env !== undefined ? { env: opts.env } : {}),
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c: Buffer) => {
			stdout += c.toString("utf8");
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (err: Error) => {
			fs.rmSync(dir, { recursive: true, force: true });
			resolve({ stdout, stderr: `${stderr}${String(err)}`, status: null });
		});
		child.on("close", (status: number | null) => {
			// Best-effort scratch cleanup — the harness dir is disposable.
			fs.rmSync(dir, { recursive: true, force: true });
			resolve({ stdout, stderr, status });
		});
	});
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

// ----------------------------------------------------------------------------

test("cross-process: foreign-dispatcher CR append DELIVERS broker-signed row in a worker-context reader; stranger raw-fs row DROPS; nonce replay from a second connection fails", async () => {
	const srcRoot = fileURLToPath(new URL("../../../../src", import.meta.url));
	const parsersPath = path.join(srcRoot, "runtime", "broker", "protocol", "request-parsers.ts");
	const ndjsonPath = path.join(srcRoot, "utils", "ndjson.ts");
	const mailboxModulePath = path.join(srcRoot, "state", "coordination", "mailbox.ts");

	// The DISPATCHER keypair lives in a FRESH key — the dispatcher process is
	// NOT the broker host (gap-3 / scheduler-host topology).
	const dispatcher = generateKeyPairSync("ed25519");
	const dispatcherPub = Buffer.from(dispatcher.publicKey.export({ type: "spki", format: "der" })).toString("base64");
	const dispatcherPriv = Buffer.from(dispatcher.privateKey.export({ type: "pkcs8", format: "der" })).toString("base64");

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-xproc-run-"));
	const created = createRunManifest({
		cwd,
		team: TEAM,
		workflow: WORKFLOW,
		goal: "hướng A cross-process E2E",
		dispatcherVerifyKey: dispatcherPub,
	});
	saveRunManifest(created.manifest);
	const manifest: TeamRunManifest = created.manifest;
	const taskId = created.tasks[0]!.id;
	const questionId = `q-xproc-${randomBytes(3).toString("hex")}`;
	saveRunTasks(
		manifest,
		created.tasks.map((t) =>
			t.id === taskId
				? {
						...t,
						status: "waiting" as const,
						waiting: { questionId, askedAt: new Date().toISOString(), deadline: Date.now() + 600_000 },
					}
				: t,
		),
	);
	const socketPath = getBrokerSocketPath(manifest.sessionId ?? `xproc-${randomBytes(4).toString("hex")}`);
	const brokerPub = getMailboxVerifyKeyPublic(); // broker host == this process
	const broker = new CrewBroker({
		sessionId: manifest.sessionId ?? "session-respond-xproc",
		socketPath,
		enabled: true,
		cwd,
		dispatcherVerifyKey: dispatcherPub,
	});
	const taskInbox = path.join(manifest.stateRoot, "mailbox", "tasks", taskId, "inbox.jsonl");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-xproc-io-"));
	try {
		await broker.start();

		// --- Dispatcher process: CR append + cross-connection replay attempt.
		const paramsPath = path.join(scratch, "params.json");
		const signerOut = path.join(scratch, "signer-out.json");
		fs.writeFileSync(
			paramsPath,
			JSON.stringify({
				runId: manifest.runId,
				taskId,
				questionId,
				body: "dispatcher answers from a separate process",
				priority: "normal",
				deliveryMode: "next_turn",
				requestId: questionId,
			}),
		);
		const signer = await runHarness(DISPATCHER_SIGNER_HARNESS, [
			parsersPath,
			ndjsonPath,
			socketPath,
			paramsPath,
			dispatcherPriv,
			signerOut,
		]);
		assert.equal(signer.status, 0, `dispatcher signer failed: ${signer.stderr}${signer.stdout}`);
		const appendResult = readJson(signerOut) as {
			append?: { messageId?: string; auth?: string } | { error?: unknown };
			harnessError?: string;
			replay?: string;
		};
		assert.equal(appendResult.harnessError, undefined, "no harness error");
		const messageId = (appendResult.append as { messageId?: string } | undefined)?.messageId;
		assert.ok(messageId, `dispatcher CR append succeeded cross-process: ${JSON.stringify(appendResult)}`);
		assert.equal((appendResult.append as { auth?: string } | undefined)?.auth, "challenge-response");
		assert.equal(appendResult.replay, "auth", `nonce replay from a second connection must fail auth: ${JSON.stringify(appendResult)}`);

		// --- Reader process #1 (worker context, singular env key ONLY).
		const readerEnv = {
			...process.env,
			[COORDINATION_VERIFY_KEY_ENV]: brokerPub,
		};
		delete (readerEnv as Record<string, string | undefined>)[COORDINATION_VERIFY_KEYS_ENV];
		const readVia = async (tag: string): Promise<{ ids: string[]; kinds: string[] }> => {
			const out = path.join(scratch, `reader-${tag}.json`);
			const r = await runHarness(READER_HARNESS, [mailboxModulePath, manifest.stateRoot, manifest.runId, taskId, out], {
				env: readerEnv,
			});
			assert.equal(r.status, 0, `reader (${tag}) failed: ${r.stderr}${r.stdout}`);
			return readJson(out) as unknown as { ids: string[]; kinds: string[] };
		};
		const seen1 = await readVia("1");
		assert.deepEqual(seen1.ids, [messageId], "broker-signed row DELIVERS in the worker-context reader process");
		assert.deepEqual(seen1.kinds, ["response"]);

		// --- Stranger process: raw-fs signed response row (third keypair).
		const strangerOut = path.join(scratch, "stranger-out.json");
		const stranger = await runHarness(STRANGER_SIGNER_HARNESS, [
			mailboxModulePath,
			manifest.stateRoot,
			manifest.runId,
			taskId,
			questionId,
			strangerOut,
		]);
		assert.equal(stranger.status, 0, `stranger signer failed: ${stranger.stderr}${stranger.stdout}`);
		const strangerInfo = readJson(strangerOut) as { pub: string; id: string };

		// --- Reader process #2 (FRESH reader — no shared parse state): the
		// stranger row must be absent; the broker row still present.
		const seen2 = await readVia("2");
		assert.deepEqual(seen2.ids, [messageId], "stranger-signed row DROPS as noise; broker row still DELIVERS");

		// --- Raw-bytes corroboration: the stranger row is well-formed and
		// verifies under ITS OWN key — it drops on key possession, not shape.
		const raw = fs
			.readFileSync(taskInbox, "utf8")
			.split(/\r?\n/)
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		assert.equal(raw.length, 2, "both rows are on disk");
		const strangerRow = raw.find((r) => r.id === strangerInfo.id)!;
		const brokerRow = raw.find((r) => r.id === messageId)!;
		assert.ok(strangerRow && brokerRow);
		assert.equal(verifyMailboxRowSig(strangerRow, [strangerInfo.pub]), true, "sanity: stranger row verifies under its own key");
		assert.equal(verifyMailboxRowSig(strangerRow, [brokerPub]), false, "stranger row does not verify under the broker key");
		assert.equal(verifyMailboxRowSig(brokerRow, [brokerPub]), true, "broker row verifies under the broker key");
		assert.equal(brokerRow.from, "leader");
		assert.equal(brokerRow.questionId, questionId);
	} finally {
		await broker.stop();
		await removeDirWithRetry(scratch);
		await removeDirWithRetry(cwd);
	}
});
