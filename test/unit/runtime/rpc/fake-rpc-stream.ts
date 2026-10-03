/**
 * fake-rpc-stream.ts — W7 test helper: an injectable RpcSpawnHandle backed by
 * PassThrough streams (NO real pi spawn, per the W7 packet test requirement).
 *
 * The helper plays the server side: it records every line the client writes
 * to "stdin", lets each test script responses/events onto "stdout", and
 * resolves the exit promise whenever the test decides (or on kill).
 */
import { PassThrough } from "node:stream";
import type { RpcSpawnHandle } from "../../../../src/runtime/rpc/frame-client.ts";

export interface FakeRpcServer {
	handle: RpcSpawnHandle;
	/** Every complete LF line the client has written so far. */
	writtenLines(): string[];
	/** Parsed JSON of writtenLines (throws in the test if a line is not JSON). */
	writtenRecords(): Record<string, unknown>[];
	/** Test hook: called for each line the client writes. */
	onLine: ((line: string) => void) | undefined;
	/** Test hook: called when the client ends stdin (orderly shutdown start). */
	onStdinEnd: (() => void) | undefined;
	/** Script one record onto stdout as a strict JSONL line (LF-terminated). */
	emit(record: unknown): void;
	/** Write a RAW string to stdout (framing tests: no auto LF). */
	writeRaw(text: string): void;
	/** Resolve the exit promise + end the streams. */
	exitWith(code: number | null): void;
	/** How many times kill() was called, with which signals. */
	killSignals(): (string | undefined)[];
}

export function createFakeRpcServer(): FakeRpcServer {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const lines: string[] = [];
	const killSignals: (string | undefined)[] = [];
	let stdinBuffer = "";

	let exitResolve: ((code: number | null) => void) | undefined;
	const exit = new Promise<number | null>((resolve) => {
		exitResolve = resolve;
	});

	const server: FakeRpcServer = {
		onLine: undefined,
		onStdinEnd: undefined,
		handle: {
			stdin,
			stdout,
			stderr,
			exit,
			kill(signal) {
				killSignals.push(signal);
				// A killed process dies with a signal (exit code null).
				exitResolve?.(null);
			},
		},
		writtenLines: () => [...lines],
		writtenRecords: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
		emit(record: unknown): void {
			stdout.write(`${JSON.stringify(record)}\n`);
		},
		writeRaw(text: string): void {
			stdout.write(text);
		},
		exitWith(code: number | null): void {
			exitResolve?.(code);
			stdout.end();
			stderr.end();
		},
		killSignals: () => [...killSignals],
	};

	stdin.setEncoding("utf8");
	stdin.on("data", (chunk: string) => {
		stdinBuffer += chunk;
		let newlineAt = stdinBuffer.indexOf("\n");
		while (newlineAt >= 0) {
			const line = stdinBuffer.slice(0, newlineAt);
			stdinBuffer = stdinBuffer.slice(newlineAt + 1);
			lines.push(line);
			server.onLine?.(line);
			newlineAt = stdinBuffer.indexOf("\n");
		}
	});
	// "finish" = the client called stdin.end() (orderly shutdown handshake).
	stdin.on("finish", () => {
		server.onStdinEnd?.();
	});

	return server;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
