#!/usr/bin/env node
/**
 * TB-4: Fake pi fixture for child-process integration tests.
 *
 * Emulates enough of the real `pi --mode json -p <task>` wire protocol that
 * pi-crew's `child-pi.ts` can spawn it, parse its stdout, and react to its
 * exit / SIGTERM the same way it would react to the real binary.
 *
 * Wire format (one JSON object per line on stdout):
 *   { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }
 *   { type: "message_end", usage: { input, output, cost, turns } }
 *
 * Behavior knobs (selected via CLI flags):
 *   --emit-count=N    emit N message/message_end pairs before exiting (default 1)
 *   --idle-ms=N       sleep N ms between emits (default 0)
 *   --exit-code=N     override exit code (default 0)
 *   --fail-mode       emit a non-JSON garbage line first to exercise the parser's fallback
 *   --stdin-echo      mirror any stdin input back to stdout (default off)
 *
 * SIGTERM handling:
 *   - Drain remaining stdout (best-effort, 250ms)
 *   - Emit a final {type: "cancelled"} event so parent readers can tell the
 *     shutdown was cooperative rather than a crash
 *   - Exit 143 (SIGTERM conventional exit code)
 */

import process from "node:process";

// ── Args parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
	const opts = { emitCount: 1, idleMs: 0, exitCode: 0, failMode: false, stdinEcho: false };
	const taskParts = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--emit-count") opts.emitCount = Number(argv[++i]) || 1;
		else if (a === "--idle-ms") opts.idleMs = Number(argv[++i]) || 0;
		else if (a === "--exit-code") opts.exitCode = Number(argv[++i]) || 0;
		else if (a === "--fail-mode") opts.failMode = true;
		else if (a === "--stdin-echo") opts.stdinEcho = true;
		else if (a === "--mode" || a === "--model" || a === "--tools" || a === "--exclude-tools" || a === "--extension" || a === "--thinking") {
			// Swallow known pi flags (value is next arg, if any)
			if (argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
		} else if (a === "--no-session" || a === "--no-extensions" || a === "--no-tools") {
			// boolean flags — ignore
		} else if (a.startsWith("--")) {
			// Unknown flag — ignore (real pi would reject, but fixture must not)
		} else if (!a.startsWith("-")) {
			taskParts.push(a);
		}
	}
	opts.task = taskParts.join(" ");
	return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── State for SIGTERM handling ──────────────────────────────────────────
let cancelled = false;
let activeTimers = new Set();

function safeExit(code) {
	// Best-effort drain: stop emitting new events, flush pending writes.
	for (const t of activeTimers) clearTimeout(t);
	activeTimers.clear();
	if (cancelled) {
		try {
			process.stdout.write(JSON.stringify({ type: "cancelled" }) + "\n");
		} catch {
			/* EPIPE on closed parent — ignore */
		}
		process.exit(143);
	} else {
		process.exit(code);
	}
}

// ── Signal handlers ─────────────────────────────────────────────────────
process.on("SIGTERM", () => {
	cancelled = true;
	// Give parent a moment to observe the cooperative-cancel event, then exit.
	setTimeout(() => safeExit(opts.exitCode), 250).unref();
});
process.on("SIGINT", () => {
	cancelled = true;
	safeExit(opts.exitCode);
});

// ── stdin echo (optional, used by tests that want to drive the fixture) ─
if (opts.stdinEcho) {
	let buf = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		buf += chunk;
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			process.stdout.write(line + "\n");
		}
	});
	process.stdin.on("end", () => {
		if (buf.trim()) process.stdout.write(buf + "\n");
		// stdin-echo mode: the fixture's job is to echo stdin. Once stdin closes,
		// we're done — exit cleanly without emitting the default messages.
		// Use setImmediate to let the write drain through stdout.
		setImmediate(() => safeExit(opts.exitCode));
	});
	// Skip the default emit loop entirely in stdin-echo mode.
	opts.emitCount = 0;
	opts.runDefaultLoop = false;
}

// Default to running the emit loop unless stdin-echo opted out.
if (opts.runDefaultLoop !== false) opts.runDefaultLoop = true;

// ── Optional garbage line to exercise parser fallback ───────────────────
if (opts.failMode) {
	process.stdout.write("not-a-json-line\n");
}

// ── Emit N message/message_end pairs ────────────────────────────────────
async function emitOne(i) {
	if (cancelled) return;
	const text = `[fake-pi] ${opts.task || "(no task)"} #${i + 1}`;
	const msg = { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
	const end = {
		type: "message_end",
		usage: { input: 10, output: text.length, cost: 0.0001, turns: 1 },
	};
	process.stdout.write(JSON.stringify(msg) + "\n");
	await sleep(opts.idleMs);
	if (cancelled) return;
	process.stdout.write(JSON.stringify(end) + "\n");
}

function sleep(ms) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const t = setTimeout(() => {
			activeTimers.delete(t);
			resolve();
		}, ms);
		activeTimers.add(t);
		// NOTE: do NOT unref() — the timer is what keeps the loop alive
		// while the emit chain is awaiting. unref'ing causes the process
		// to exit before the chain completes when stdout is piped.
	});
}

(async () => {
	if (!opts.runDefaultLoop) return; // stdin-echo mode handles its own lifecycle
	for (let i = 0; i < opts.emitCount; i++) {
		await emitOne(i);
		if (cancelled) break;
	}
	safeExit(opts.exitCode);
})().catch((error) => {
	process.stderr.write(`[fake-pi] unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
	safeExit(1);
});
