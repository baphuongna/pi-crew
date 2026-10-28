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
 */

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

/** Read the FIRST stdin line with a hard cap. Resolves undefined for: no
 * stdin / TTY / silence past the timeout / oversize / error. Never throws,
 * never destroys stdin (leaves it paused for the rest of boot). */
export function readStdinFirstLine(timeoutMs = 2000): Promise<string | undefined> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		if (!stdin || stdin.isTTY || stdin.destroyed || !stdin.readable) {
			resolve(undefined);
			return;
		}
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.removeListener("data", onData);
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		let buf = "";
		const onData = (chunk: Buffer | string): void => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				stdin.pause();
				finish(buf.slice(0, nl));
			} else if (buf.length > 64 * 1024) {
				finish(undefined);
			}
		};
		stdin.on("data", onData);
		stdin.on("end", () => finish(buf.length > 0 ? buf : undefined));
		stdin.on("error", () => finish(undefined));
	});
}
