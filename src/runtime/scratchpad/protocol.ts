/**
 * Wire protocol between EngineManager (host) and the guest process.
 *
 * Transport: line-delimited JSON on a dedicated pipe (fd 3), never on stdout.
 *
 * Two properties make the channel trustworthy, and both are load-bearing:
 *
 *   1. Separation. The guest's stdout and stderr carry only user output, so a
 *      cell that prints JSON cannot be parsed as protocol traffic. Sharing one
 *      channel would let ordinary output alter the engine's view of a cell.
 *   2. Authentication. Every envelope carries a nonce the host mints at spawn
 *      and the guest erases from its environment before running any cell. Code
 *      inside a cell cannot recover it, so even a deliberate write to fd 3
 *      cannot forge a message.
 *
 * Together they make a cell unable to report its own outcome — it can only run.
 */

export interface HostToGuest {
	run: { type: "run"; cellId: string; code: string };
	abort: { type: "abort"; cellId: string };
	ping: { type: "ping"; id: string };
	host_reply: {
		type: "host_reply";
		id: string;
		status: "ok" | "error";
		payload?: Record<string, unknown>;
		error?: string;
	};
	snapshot: { type: "snapshot"; id: string };
	restore: { type: "restore"; id: string; vars: Record<string, string> };
	list_names: { type: "list_names"; id: string };
}

export type HostToGuestMessage = HostToGuest[keyof HostToGuest];

export interface GuestToHost {
	ready: { type: "ready" };
	stream: { type: "stream"; cellId: string; name: "stdout" | "stderr"; chunk: string };
	done: {
		type: "done";
		cellId: string;
		status: "ok" | "error" | "aborted";
		result?: string;
		error?: { name: string; message: string; stack: string[] };
	};
	pong: { type: "pong"; id: string };
	host_request: {
		// RESERVED for future host bridge (rlm-deep-review-2026-08-12.md §5.2F /
		// J2): guest-side cells would request host services (tools.read,
		// tools.grep) so data enters the namespace WITHOUT crossing the
		// transcript — pi-rlm's core token-saving value proposition. Declared
		// here so the protocol type is stable, but NOT YET WIRED: engine.ts and
		// guest.ts have no host_request dispatcher/handler. Blocked on scratchpad
		// adoption > 0 (do not add a host execution surface nobody calls).
		type: "host_request";
		id: string;
		requestType: string;
		payload: Record<string, unknown>;
	};
	snapshot_result: {
		type: "snapshot_result";
		id: string;
		vars: Record<string, string>;
		failed: { name: string; reason: string }[];
	};
	restore_result: {
		type: "restore_result";
		id: string;
		restored: string[];
		failed: { name: string; reason: string }[];
	};
	names_result: { type: "names_result"; id: string; names: string[] };
}

export type GuestToHostMessage = GuestToHost[keyof GuestToHost];

export const ENVELOPE_KEY = "__rlm";
/** Env var carrying the per-process nonce to the guest. */
export const NONCE_ENV = "PI_RLM_NONCE";
/** Protocol pipe: guest → host. */
export const PROTOCOL_FD = 3;

export function encodeMessage(message: HostToGuestMessage | GuestToHostMessage, nonce?: string): string {
	const envelope: Record<string, unknown> = { [ENVELOPE_KEY]: 1, ...message };
	if (nonce) envelope.n = nonce;
	return `${JSON.stringify(envelope)}\n`;
}

export function decodeMessage<T>(line: string, nonce?: string): T | null {
	if (!line.includes(`"${ENVELOPE_KEY}":1`)) return null;
	try {
		const parsed = JSON.parse(line);
		if (parsed?.[ENVELOPE_KEY] !== 1 || typeof parsed.type !== "string") return null;
		if (nonce && parsed.n !== nonce) return null;
		return parsed as T;
	} catch {
		return null;
	}
}
