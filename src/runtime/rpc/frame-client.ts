/**
 * frame-client.ts — W7 (P2-3): strict-LF JSONL frame client for the pi RPC mode.
 *
 * WHY NOT the SDK's `RpcClient` (deviation recorded in README.md / review §R2.5):
 *  1. It has NO public API to answer `extension_ui_request` records
 *     (`send`/`process` are private; handleLine dispatches non-response records
 *     to event listeners only) — answering dialogs is design gate 2.
 *  2. Its `start()` spawns `node <cliPath|dist/cli.js>` cwd-relative — NOT the
 *     host pi binary the stdio transport resolves via getPiSpawnCommand, so the
 *     two transports would run different pi versions.
 *  3. The process is not injectable — the W7 packet REQUIRES fake-stream tests
 *     (no real pi spawn), which RpcClient makes impossible.
 * The PROTOCOL SURFACE is still the SDK's: every record type here is imported
 * from `@earendil-works/pi-coding-agent` (RpcCommand/RpcResponse/
 * RpcExtensionUIRequest/RpcExtensionUIResponse), and the framing follows the
 * SDK's own jsonl spec.
 *
 * FRAMING (SDK modes/rpc/jsonl.d.ts): records are LF-only. Payload strings may
 * contain U+2028/U+2029, so splitting MUST be on "\n" ONLY — Node's readline
 * splits on those separators too and is therefore NOT strict JSONL framing.
 * This module hand-rolls the ~15-line splitter for exactly that reason.
 *
 * Robustness contract (prototype, but honest): a malformed line is COUNTED and
 * dropped — never thrown; a matching valid frame afterwards still resolves.
 */

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { logInternalError } from "../../utils/internal-error.ts";
import { getPiSpawnCommand } from "../pi-spawn.ts";
import { createUiRequestPolicy, type DialogAnswerPolicy, type UiRequestCounters } from "./ui-request-policy.ts";

/** Cap on retained raw stdout/stderr text (prototype memory guard). */
const RAW_OUTPUT_CAP_CHARS = 1_000_000;
/** Default per-command response timeout — mirrors the SDK RpcClient's 30s. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Default orderly-shutdown window before SIGKILL fallback. */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/** Process handle the frame client drives. Injectable for fake-stream tests. */
export interface RpcSpawnHandle {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	/** Resolves with the exit code (null when killed by signal). */
	exit: Promise<number | null>;
	/** Send a signal. Must be idempotent-safe (client guards to kill once). */
	kill(signal?: NodeJS.Signals): void;
}

/** Spawn function: receives the pi argv (after `--mode rpc` etc.), returns a handle. */
export type RpcSpawnFn = (argv: string[]) => RpcSpawnHandle;

/** Default spawner: host pi binary (PI_TEAMS_PI_BIN aware) with piped stdio. */
function defaultSpawnFn(argv: string[]): RpcSpawnHandle {
	const { command, args } = getPiSpawnCommand(argv);
	const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
	return {
		stdin: child.stdin as Writable,
		stdout: child.stdout as Readable,
		stderr: child.stderr as Readable,
		exit: new Promise<number | null>((resolve) => {
			child.once("exit", (code) => resolve(code));
		}),
		kill: (signal?: NodeJS.Signals) => {
			try {
				child.kill(signal ?? "SIGKILL");
			} catch (error) {
				logInternalError("rpc-frame-client.kill", error, "child.kill failed", "warn");
			}
		},
	};
}

/** Combined transport counters (frame client + ui-request policy). */
export interface RpcTransportCounters extends UiRequestCounters {
	/** Frames that failed JSON.parse (or were empty lines). */
	malformedFrames: number;
	/** Response records matched to a pending command. */
	responsesMatched: number;
	/** Response records with an unknown/duplicate id (dropped). */
	responsesUnmatched: number;
}

export interface RpcFrameClientOptions {
	/** Injectable spawner (tests pass a fake-stream factory). Default: host pi binary. */
	spawnFn?: RpcSpawnFn;
	/** pi argv WITHOUT the binary (client prepends nothing; default ["--mode","rpc"]). */
	argv?: string[];
	/** GATE 2 dialog policy. Default "cancel" (universal safe answer). */
	dialogPolicy?: DialogAnswerPolicy;
	/** Per-command response timeout (ms). Default 30_000. */
	commandTimeoutMs?: number;
	/** Orderly-shutdown timeout before SIGKILL (ms). Default 5_000. */
	stopTimeoutMs?: number;
	/** Non-response, non-ui-request records (agent session events, extension_error). */
	onEvent?: (event: unknown) => void;
}

interface PendingCommand {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcFrameClient {
	/** Send a command; resolves with the success response, rejects on error/timeout. */
	sendCommand(command: RpcCommand): Promise<unknown>;
	/** Write an extension_ui_response directly (policy uses this). */
	sendUiResponse(response: RpcExtensionUIResponse): void;
	/** Counters snapshot (fresh object). */
	counters(): RpcTransportCounters;
	/** Retained raw stdout text (capped). */
	stdoutText(): string;
	/** Retained raw stderr text (capped). */
	stderrText(): string;
	/** The exit promise (resolves when the process exits). */
	exited(): Promise<number | null>;
	/** Orderly stop: end stdin → wait exit → SIGKILL fallback. Idempotent. */
	stop(): Promise<void>;
}

function appendCapped(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > RAW_OUTPUT_CAP_CHARS ? next.slice(0, RAW_OUTPUT_CAP_CHARS) : next;
}

export function createRpcFrameClient(options: RpcFrameClientOptions = {}): RpcFrameClient {
	const spawnFn = options.spawnFn ?? defaultSpawnFn;
	const argv = options.argv ?? ["--mode", "rpc"];
	const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

	const handle = spawnFn(argv);

	let stdoutText = "";
	let stderrText = "";
	let malformedFrames = 0;
	let responsesMatched = 0;
	let responsesUnmatched = 0;
	let killed = false;
	let stopPromise: Promise<void> | undefined;

	const pending = new Map<string, PendingCommand>();
	let sequence = 0;

	const uiPolicy = createUiRequestPolicy({
		dialogPolicy: options.dialogPolicy ?? "cancel",
		writeResponse: (response) => writeUiResponse(response),
		onWarn: (message) => logInternalError("rpc-frame-client.ui-policy", new Error(message), undefined, "warn"),
	});

	function writeLine(record: unknown): void {
		try {
			// void-append: the write is fire-and-forget; stream errors are
			// handled by the stdin "error" listener below.
			handle.stdin.write(`${JSON.stringify(record)}\n`);
		} catch (error) {
			logInternalError("rpc-frame-client.write", error, "stdin write failed", "warn");
		}
	}

	function writeUiResponse(response: RpcExtensionUIRequest | RpcExtensionUIResponse): void {
		writeLine(response);
	}

	function failPending(error: Error): void {
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	}

	function handleLine(line: string): void {
		if (line.length === 0) {
			malformedFrames++;
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			malformedFrames++;
			logInternalError("rpc-frame-client.frame", new Error(`malformed frame dropped (${line.length} chars)`), undefined, "warn");
			return;
		}
		const record = parsed as Record<string, unknown>;
		if (record && record.type === "response") {
			const id = typeof record.id === "string" ? record.id : undefined;
			const entry = id !== undefined ? pending.get(id) : undefined;
			if (id === undefined || entry === undefined) {
				responsesUnmatched++;
				return;
			}
			pending.delete(id);
			clearTimeout(entry.timer);
			responsesMatched++;
			if (record.success === false) {
				entry.reject(new Error(`rpc command failed: ${String(record.error ?? "unknown error")}`));
			} else {
				entry.resolve(record);
			}
			return;
		}
		if (record && record.type === "extension_ui_request") {
			// Gate 1 + Gate 2 live here (count+drop / auto-answer).
			uiPolicy.handle(parsed as RpcExtensionUIRequest);
			return;
		}
		// Agent session events (`message_start`, `agent_settled`, ...) and
		// anything else the server emits (e.g. extension_error).
		options.onEvent?.(parsed);
	}

	function waitExitWithin(ms: number): Promise<boolean> {
		return Promise.race([handle.exit.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
	}

	function killOnce(): void {
		if (killed) return;
		killed = true;
		handle.kill("SIGKILL");
	}

	// ── stdout pump: STRICT LF-only framing (see module header). ──────────
	let buffer = "";
	handle.stdout.setEncoding("utf8");
	handle.stdout.on("data", (chunk: string) => {
		stdoutText = appendCapped(stdoutText, chunk);
		buffer += chunk;
		let newlineAt = buffer.indexOf("\n");
		while (newlineAt >= 0) {
			const line = buffer.slice(0, newlineAt);
			buffer = buffer.slice(newlineAt + 1);
			handleLine(line);
			newlineAt = buffer.indexOf("\n");
		}
	});
	// Final flush + pending-failure. "end" covers orderly EOF; "close" also
	// fires on destroy() (killed stream) where "end" never does — both paths
	// must drain the leftover buffer and fail any still-pending commands.
	let streamFinalized = false;
	function finalizeStream(): void {
		if (streamFinalized) return;
		streamFinalized = true;
		if (buffer.length > 0) {
			// Final line without trailing LF: the server always writes LF, so a
			// non-empty remainder means an abrupt cut — try to parse it anyway
			// (a complete JSON object missing only the terminator is usable),
			// otherwise it lands in malformedFrames.
			const line = buffer;
			buffer = "";
			handleLine(line);
		}
		failPending(new Error("rpc transport: stdout closed before response"));
	}
	handle.stdout.on("end", () => finalizeStream());
	handle.stdout.on("close", () => finalizeStream());
	handle.stdout.on("error", (error) => {
		logInternalError("rpc-frame-client.stdout", error, undefined, "warn");
		failPending(new Error(`rpc transport: stdout error: ${error.message}`));
	});

	handle.stderr.setEncoding("utf8");
	handle.stderr.on("data", (chunk: string) => {
		stderrText = appendCapped(stderrText, chunk);
	});
	handle.stderr.on("error", (error) => {
		logInternalError("rpc-frame-client.stderr", error, undefined, "warn");
	});

	// A dead stdin (EPIPE when the child exits first) must not crash the host.
	handle.stdin.on("error", (error) => {
		logInternalError("rpc-frame-client.stdin", error, undefined, "warn");
	});

	const client: RpcFrameClient = {
		sendCommand(command: RpcCommand): Promise<unknown> {
			sequence++;
			const id = `pi-crew-rpc-${sequence}`;
			const record = { id, ...command } as RpcCommand;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`rpc command timeout after ${commandTimeoutMs}ms: ${command.type}`));
				}, commandTimeoutMs);
				pending.set(id, { resolve, reject, timer });
				writeLine(record);
			});
		},
		sendUiResponse(response: RpcExtensionUIResponse): void {
			writeUiResponse(response);
		},
		counters(): RpcTransportCounters {
			return {
				...uiPolicy.counters(),
				malformedFrames,
				responsesMatched,
				responsesUnmatched,
			};
		},
		stdoutText: () => stdoutText,
		stderrText: () => stderrText,
		exited: () => handle.exit,
		stop(): Promise<void> {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				// Orderly shutdown (rpc-mode.js onInputEnd → server shutdown,
				// exit 0 per R2 live evidence): close stdin, wait, then kill.
				try {
					handle.stdin.end();
				} catch (error) {
					logInternalError("rpc-frame-client.stop", error, "stdin.end failed", "warn");
				}
				const exitedCleanly = await waitExitWithin(stopTimeoutMs);
				if (!exitedCleanly) {
					killOnce();
					await waitExitWithin(2_000);
				}
				failPending(new Error("rpc transport stopped"));
			})();
			return stopPromise;
		},
	};
	return client;
}
