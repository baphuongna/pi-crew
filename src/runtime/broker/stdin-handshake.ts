/**
 * stdin-handshake.ts — F4 (2026-09-12 live battery): broker credentials for
 * the DETACHED background runner travel on STDIN (heap → pipe → heap).
 *
 * Why stdin: the env route is CLOSED BY DESIGN — BACKGROUND_RUNNER_ENV_ALLOWLIST
 * cannot carry PI_CREW_BROKER_TOKEN (secret-suffixed names are rejected by the
 * sanitizeEnvSecrets validator, and a PI_CREW_BROKER_* glob is flagged
 * isDangerousGlob), and the token must NEVER be written to disk (invariant,
 * lifecycle-handlers.ts:990). Without this handshake every async-run worker
 * loses ask/message/mailbox/steer coordination and silently falls back to
 * "proceed with best judgment".
 *
 * Pure protocol pieces live here (not in background-runner.ts, which runs
 * `await main()` at module scope) so tests can import them without booting
 * the runner. buildBrokerStdinLine additionally carries ONE LOUD oversize
 * diagnostic (FIX-3, 2026-10-28) — stderr-only, never throws, never blocks
 * the write.
 *
 * FD-3 TRANSPORT (2026-10-28, LOW-1 root-cause fix): brokered child-pi
 * workers (real `pi` processes) CANNOT use fd0 for this handshake — pi@1.0.4
 * `readPipedStdin()` (dist/main.js:52-65) consumes ALL piped stdin as PROMPT
 * CONTENT in every mode except --mode rpc, so an fd0 handshake raced it
 * three ways (token JSON merged into the prompt = secret leak; stream-ended
 * creds-less silence; reader pause() before EOF → pi's await readPipedStdin()
 * deadlock → SIGTERM exit 0 with ~0 stdout — the 0.11.46/47 live incident).
 * The spawn side therefore adds a DEDICATED pipe as stdio entry 4 (fd 3) and
 * writes the payload there (child-pi-spawn.ts/child-pi.ts); readFirstLineFromFd
 * below is the worker-side reader for that pipe. fd0 stays "ignore"
 * (pre-0.11.46 shape). The detached background RUNNER keeps the fd0 route —
 * it is a plain node process whose stdin is dedicated to the handshake
 * (readStdinFirstLine, unchanged); only the child-pi (pi binary) path needed
 * the dedicated fd.
 */

import * as fs from "node:fs";
import { logInternalError } from "../../utils/internal-error.ts";

/** The one-line payload async-runner writes to the runner's stdin carrying
 * PER-TASK compound tokens. v2 (ADR-0 2026-08-17 item 6): wait.* accepts
 * task-scoped (compound) tokens ONLY — the legacy bare-runId token
 * authenticates the connection but waitAuthError rejects its parks with
 * `forbidden`. The dispatching session pre-mints a compound token for every
 * task in the manifest (they exist before dispatch); dynamic-workflow tasks
 * planned inside the runner get NO creds (follow-up: broker mint RPC). */
export interface StdinBrokerPayload {
	v: 2;
	runId: string;
	socketPath: string;
	tasks: Record<string, string>;
}

/** Parse + validate one handshake line. Rejects wrong version, wrong run
 * (cross-run containment), and missing/empty fields. Pure. */
export function parseStdinBrokerPayload(raw: string, expectedRunId: string): StdinBrokerPayload | undefined {
	try {
		const obj: unknown = JSON.parse(raw.trim());
		if (!obj || typeof obj !== "object") return undefined;
		const o = obj as Record<string, unknown>;
		if (o.v !== 2) return undefined;
		if (o.runId !== expectedRunId) return undefined;
		if (typeof o.socketPath !== "string" || o.socketPath.length === 0) return undefined;
		const tasks = o.tasks;
		if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return undefined;
		for (const [id, tok] of Object.entries(tasks)) {
			if (id.length === 0 || typeof tok !== "string" || tok.length === 0) return undefined;
		}
		return { v: 2, runId: o.runId, socketPath: o.socketPath, tasks: tasks as Record<string, string> };
	} catch {
		return undefined;
	}
}

/** LOW-1 residual closure (2026-10-27): the ONE line a spawner writes to a
 * worker's stdin carrying PER-TASK compound broker tokens. Moved here from
 * async-runner.ts (which re-exports for API stability) so BOTH writer sides —
 * the detached background runner AND the main child-pi spawn path — share the
 * pure protocol piece and cannot drift from the reader parser below (a
 * writer/reader drift silently breaks coordination). Compound (runId+taskId)
 * tokens only: wait.* rejects bare-runId tokens (ADR-0 item 6).
 *
 * FIX-3 (2026-10-28): LOUD oversize diagnostic at the single construction
 * point shared by BOTH writers. The worker-side reader (readStdinFirstLine)
 * aborts once its buffer passes 64 KiB without a newline — a payload built
 * from ~2.5k tasks (~131 KiB observed live) silently loses EVERY task's
 * broker creds (ask/message/mailbox/steer degrade to file-poll) with zero
 * trace in production. Warn at 60 KiB (below the reader cap, far above any
 * sane task fanout) — NOT gated on PI_CREW_DEBUG: this is a "your creds
 * will be lost" operational alarm, not a debug trace. The line is still
 * returned (and written by the caller) — never blocked. */
export const BROKER_STDIN_LINE_WARN_BYTES = 60 * 1024;

export function buildBrokerStdinLine(runId: string, socketPath: string, tasks: Record<string, string>): string {
	const line = `${JSON.stringify({ v: 2, runId, socketPath, tasks })}\n`;
	if (line.length > BROKER_STDIN_LINE_WARN_BYTES) {
		logInternalError(
			"stdin-handshake.oversize-payload",
			new Error(
				`broker stdin handshake line is ${line.length} bytes — the worker reader aborts past 64 KiB, so EVERY task loses its broker creds (ask/message/mailbox/steer fall back to file-poll)`,
			),
			`${Object.keys(tasks).length} tasks on run ${runId}; shrink the task fanout or split the run`,
			"warn",
		);
	}
	return line;
}

/** Dedicated handshake fd for brokered child-pi workers: spawn stdio entry
 *  4 (spawnOptions.stdio = ["ignore","pipe","pipe","pipe"]). fd0 stays
 *  "ignore" — the pre-0.11.46 shape — so pi@1.0.4 readPipedStdin can never
 *  race or merge the credential into the worker prompt (LOW-1 root cause,
 *  see the module docblock). */
export const BROKER_HANDSHAKE_FD = 3;

/** Read the FIRST line off a byte stream with a hard cap. Shared core of
 * BOTH transports (fd0 for the detached runner, fd3 for child-pi workers).
 * Resolves undefined for: silence past the timeout / oversize / stream
 * error / empty EOF. Never throws, never destroys the stream (pauses it
 * only after a first line was consumed — probe-verified 2026-10-28:
 * destroy()/closeSync on an fs fd-stream is fragile on the error path
 * (SIGABRT on EINVAL with autoClose) and a plain pause releases the loop on
 * the payload/EOF shapes; the only shape that outlives the timeout is an
 * open silent pipe, which a same-version parent can never produce — the
 * spawner writes payload + end() synchronously in the spawn tick). */
function readFirstLineFromStream(
	stream: Pick<NodeJS.ReadableStream, "on" | "removeListener" | "pause">,
	timeoutMs: number,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream.removeListener("data", onData);
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		let buf = "";
		const onData = (chunk: Buffer | string): void => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				stream.pause();
				finish(buf.slice(0, nl));
			} else if (buf.length > 64 * 1024) {
				finish(undefined);
			}
		};
		stream.on("data", onData);
		stream.on("end", () => finish(buf.length > 0 ? buf : undefined));
		stream.on("error", () => finish(undefined));
	});
}

/** Read the FIRST stdin line with a hard cap. Resolves undefined for: no
 * stdin / TTY / silence past the timeout / oversize / error. Never throws,
 * never destroys stdin (leaves it paused for the rest of boot). Detached
 * background-runner transport ONLY (see module docblock — pi workers read
 * the dedicated fd3 pipe via readFirstLineFromFd). */
export function readStdinFirstLine(timeoutMs = 2000): Promise<string | undefined> {
	const stdin = process.stdin;
	if (!stdin || stdin.isTTY || stdin.destroyed || !stdin.readable) {
		return Promise.resolve(undefined);
	}
	return readFirstLineFromStream(stdin, timeoutMs);
}

/** Read the FIRST line from a raw file descriptor — the worker-side reader
 * of the DEDICATED fd3 handshake pipe (BROKER_HANDSHAKE_FD). Same bounded
 * contract as readStdinFirstLine (2s default timeout, 64 KiB cap, never
 * throws): a missing/closed/unreadable fd (old-parent skew: gate flag set
 * but no 4th stdio entry), an EINVAL read on a non-readable fd, silence
 * past the timeout, oversize, or error all resolve undefined — the caller
 * proceeds creds-less exactly like a broker-less spawn. win32: immediate
 * undefined (extra-fd spawn plumbing differs there and the broker is
 * auto-disabled on Windows anyway). The fd is never closed by this reader
 * (autoClose: false — it belongs to the spawn stdio table, and closing an
 * fd under an active stream poll is what crashes Node's fs streams). */
export function readFirstLineFromFd(fd: number, timeoutMs = 2000): Promise<string | undefined> {
	if (process.platform === "win32") {
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		let stream: fs.ReadStream;
		try {
			// fd option ⇒ the path argument is only a label, never opened.
			stream = fs.createReadStream("", { fd, autoClose: false });
		} catch {
			resolve(undefined);
			return;
		}
		readFirstLineFromStream(stream, timeoutMs).then(resolve, () => resolve(undefined));
	});
}
