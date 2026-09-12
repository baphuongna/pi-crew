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
 * the runner.
 */

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
