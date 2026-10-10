#!/usr/bin/env node
/**
 * U14: Fake pi RPC fixture for child-pi protocol v2 tests.
 *
 * Emulates the `pi --mode rpc` wire contract well enough that BOTH the SDK's
 * RpcClient (the real wire owner) and pi-crew's rpc transport
 * (child-pi-rpc.ts) can be exercised hermetically — no real pi binary, no
 * provider credentials. Mirrors the LIVE-verified semantics from the U14 PoC
 * (/tmp/pi-crew-rpc-poc, round 8) and verify rounds 9/10:
 *
 *   - prompt          → { disposition: "started" } (or "queued" while a run is
 *                       live — pi-crew always sends streamingBehavior, so a
 *                       mid-run prompt queues as a followUp, never errors);
 *                       "handled" only with --handled-first-prompt.
 *   - steer           → { disposition: "started" } while a run is streaming,
 *                       { disposition: "queued" } when idle (PoC nuance 1:
 *                       idle steer QUEUES, it does not error — a stale idle
 *                       steer would inject into the NEXT run).
 *   - abort           → receipt is SETTLE-GATED: the response only goes out
 *                       AFTER the in-flight run settles (verify round 9 P1)
 *                       and carries NO data payload; an agent_settled event
 *                       with aborted:true follows.
 *   - clear_queue     → drops queued steering/followUp, returns their texts.
 *   - every command response: { type: "response", id, success: true, data }
 *   - stdin close     → orderly dispose, exit 0 (PoC: ~73ms; here immediate).
 *   - SIGTERM         → exit 143, no children spawned → no orphans.
 *   - unknown command → success:false response (stream keeps living).
 *
 * Behavior knobs (CLI flags, all swallowed by the real argv builder too):
 *   --run-ms=N          artificial run duration before settling (default 50)
 *   --turns=N           turn_end events per run (default 1)
 *   --turn-end-phase=P  emit turn_end "pre" (before agent_settled, i.e. while
 *                       streaming) or "post" (after settle, i.e. idle) —
 *                       default "pre"
 *   --garbage-first     write a malformed stdout line at boot (malformed-line
 *                       survival regression)
 *   --ui-spam           emit extension_ui_request events at boot (consumer
 *                       type-filter regression)
 *   --stale-steer       make the FIRST clear_queue return one stale steering
 *                       text (clear-before-prompt hygiene regression)
 *   --handled-first-prompt  first prompt answers disposition "handled"
 *   --log=PATH          append a JSONL trace of every received command (with
 *                       monotonic timestamps) for order assertions
 */

import * as fs from "node:fs";
import process from "node:process";

function parseArgs(argv) {
	const opts = { runMs: 50, turns: 1, turnEndPhase: "pre", garbageFirst: false, uiSpam: false, staleSteer: false, handledFirstPrompt: false, log: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--run-ms") opts.runMs = Number(argv[++i]) || 50;
		else if (a === "--turns") opts.turns = Number(argv[++i]) || 1;
		else if (a === "--turn-end-phase") opts.turnEndPhase = argv[++i] === "post" ? "post" : "pre";
		else if (a === "--garbage-first") opts.garbageFirst = true;
		else if (a === "--ui-spam") opts.uiSpam = true;
		else if (a === "--stale-steer") opts.staleSteer = true;
		else if (a === "--handled-first-prompt") opts.handledFirstPrompt = true;
		else if (a === "--log") opts.log = argv[++i];
		else if (a.startsWith("--")) {
			// Swallow known pi flags WITH values (mirror fake-pi.mjs tolerance).
			const valued = ["--model", "--tools", "--exclude-tools", "--extension", "--thinking", "--session-id", "--session-dir", "--name", "--append-system-prompt", "--system-prompt", "--skill", "--provider"];
			if (valued.includes(a) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
		}
		// positionals (e.g. leftover @task.md) are ignored — the task rides
		// the prompt command in rpc mode.
	}
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
const t0 = Date.now();

function trace(kind, extra) {
	if (!opts.log) return;
	try {
		fs.appendFileSync(opts.log, JSON.stringify({ kind, t: Date.now() - t0, ...extra }) + "\n", "utf-8");
	} catch {
		/* best effort */
	}
}

function emit(obj) {
	try {
		process.stdout.write(JSON.stringify(obj) + "\n");
	} catch {
		/* EPIPE on closed parent — ignore */
	}
}

function respond(id, data, success = true) {
	// Trace the RAW response payload too — the abort-receipt test asserts the
	// settle-gated response carries no data payload from here.
	trace("response", { id, success, ...(data !== undefined ? { data } : {}) });
	emit({ type: "response", id, success, ...(data !== undefined ? { data } : {}) });
}

// ── Run state ────────────────────────────────────────────────────────────
let running = false;
let runSeq = 0;
let aborting = false;
const queuedFollowUps = [];
let queuedSteering = [];
let firstPrompt = true;
let clearQueueCalls = 0;

function settleRun(aborted) {
	running = false;
	emit({ type: "agent_settled", ...(aborted ? { aborted: true } : {}) });
	// "post" phase: turn_end AFTER the settle — the agent is IDLE here. This is
	// exactly the PoC nuance 1 hazard window a consumer's isStreaming gate must
	// reject (an idle steer QUEUES into the NEXT run).
	if (opts.turnEndPhase === "post" && !aborted) {
		for (let i = 0; i < opts.turns; i++) emit({ type: "turn_end" });
	}
	trace("settled", { aborted: !!aborted, runSeq });
	if (queuedFollowUps.length > 0 && !aborting) {
		const next = queuedFollowUps.shift();
		startRun(next.id, next.message, 0);
	}
}

function startRun(id, message, runMsOverride) {
	running = true;
	runSeq += 1;
	const runMs = runMsOverride ?? opts.runMs;
	trace("run-start", { runSeq, runMs });
	setTimeout(() => {
		const text = `[fake-pi-rpc] ${message}`;
		emit({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
		emit({ type: "message_end", usage: { input: 10, output: text.length, cost: 0.0001, turns: opts.turns }, message: { role: "assistant", content: [{ type: "text", text }], stopReason: aborted_placeholder_stop(), usage: { input: 10, output: text.length } } });
		if (opts.turnEndPhase === "pre") {
			for (let i = 0; i < opts.turns; i++) emit({ type: "turn_end" });
		}
		settleRun(false);
	}, runMs);
}

function aborted_placeholder_stop() {
	return "stop";
}

// ── Boot noise knobs ─────────────────────────────────────────────────────
if (opts.garbageFirst) {
	process.stdout.write("not-a-json-line{\n");
}
if (opts.uiSpam) {
	for (let i = 0; i < 11; i++) {
		emit({ type: "extension_ui_request", id: `ui-${i}`, payload: { spam: i } });
	}
}

// ── stdin JSONL command loop ─────────────────────────────────────────────
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	const lines = buf.split("\n");
	buf = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let cmd;
		try {
			cmd = JSON.parse(line);
		} catch {
			// Malformed COMMAND line (not stdout) — PoC: parse-error response,
			// stream stays alive. The RpcClient never sends these, but keep the
			// survival contract explicit.
			emit({ type: "response", id: null, success: false, error: "parse error" });
			continue;
		}
		handleCommand(cmd).catch((error) => {
			process.stderr.write(`[fake-pi-rpc] handler error: ${error?.stack ?? String(error)}\n`);
		});
	}
});

async function handleCommand(cmd) {
	const type = cmd?.type;
	trace("command", { type });
	switch (type) {
		case "prompt": {
			if (firstPrompt && opts.handledFirstPrompt) {
				firstPrompt = false;
				respond(cmd.id, { disposition: "handled" });
				return;
			}
			firstPrompt = false;
			if (running) {
				queuedFollowUps.push({ id: cmd.id, message: cmd.message });
				respond(cmd.id, { disposition: "queued" });
				return;
			}
			startRun(cmd.id, cmd.message);
			respond(cmd.id, { disposition: "started" });
			return;
		}
		case "steer": {
			// PoC nuance 1: idle steer QUEUES (no error) — it would inject into
			// the NEXT run; that is exactly what pi-crew's isStreaming gate +
			// clear-before-prompt hygiene defend against.
			const disposition = running ? "started" : "queued";
			if (!running) queuedSteering.push(cmd.message);
			respond(cmd.id, { disposition });
			return;
		}
		case "follow_up": {
			queuedFollowUps.push({ id: cmd.id, message: cmd.message });
			respond(cmd.id, { disposition: running ? "queued" : "handled" });
			if (!running && queuedFollowUps.length > 0) {
				const next = queuedFollowUps.shift();
				startRun(next.id, next.message, 0);
			}
			return;
		}
		case "abort": {
			if (!running) {
				// Settle-gated even in the trivial case: respond AFTER the
				// (already-finished) settle with NO payload (verify round 9 P1).
				respond(cmd.id, {});
				emit({ type: "agent_settled", aborted: true });
				return;
			}
			// SETTLE-GATED: hold the receipt until the in-flight run settles.
			aborting = true;
			const waitStarted = Date.now();
			const awaitSettle = () => {
				if (running && Date.now() - waitStarted < 30_000) {
					setTimeout(awaitSettle, 25);
					return;
				}
				respond(cmd.id, {}); // no data payload — the P1 contract
				aborting = false;
			};
			awaitSettle();
			return;
		}
		case "clear_queue": {
			clearQueueCalls += 1;
			const steering = queuedSteering;
			queuedSteering = [];
			if (opts.staleSteer && clearQueueCalls === 1) {
				steering.push("stale idle-steer from a previous run");
			}
			const followUp = queuedFollowUps.splice(0, queuedFollowUps.length).map((q) => q.message);
			respond(cmd.id, { steering, followUp });
			return;
		}
		case "get_session_stats": {
			respond(cmd.id, { tokens: { input: 10, output: 10 }, cost: 0.0001 });
			return;
		}
		default: {
			respond(cmd.id, { error: `unknown command: ${String(type)}` }, false);
		}
	}
}

// ── Shutdown semantics ───────────────────────────────────────────────────
process.stdin.on("end", () => {
	// PoC: stdin close → orderly dispose → exit 0.
	trace("stdin-end", {});
	setImmediate(() => process.exit(0));
});

process.on("SIGTERM", () => {
	// PoC: exit 143, no orphaned children (this fixture never spawns any).
	trace("sigterm", {});
	process.exit(143);
});
process.on("SIGINT", () => process.exit(130));
