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

/** The one-line payload async-runner writes to the runner's stdin. */
export interface StdinBrokerPayload {
	v: 1;
	runId: string;
	socketPath: string;
	token: string;
}

/** Parse + validate one handshake line. Rejects wrong version, wrong run
 * (cross-run containment), and missing/empty fields. Pure. */
export function parseStdinBrokerPayload(raw: string, expectedRunId: string): StdinBrokerPayload | undefined {
	try {
		const obj: unknown = JSON.parse(raw.trim());
		if (!obj || typeof obj !== "object") return undefined;
		const o = obj as Record<string, unknown>;
		if (o.v !== 1) return undefined;
		if (o.runId !== expectedRunId) return undefined;
		if (typeof o.socketPath !== "string" || o.socketPath.length === 0) return undefined;
		if (typeof o.token !== "string" || o.token.length === 0) return undefined;
		return { v: 1, runId: o.runId, socketPath: o.socketPath, token: o.token };
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
