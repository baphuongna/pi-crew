/**
 * pi-rlm guest — Node port (spike).
 *
 * The persistent evaluator process for the pi-crew scratchpad spike. Owns the
 * namespace and runs cells against it: each cell executes inside a `with`
 * block over a proxy, so ordinary assignments become namespace entries and
 * ordinary reads resolve against them. Writes are refused once the owning cell
 * has been cancelled, which keeps a cancelled cell's still-running
 * continuation from mutating state a later cell is using.
 *
 * Output is tagged with the cell that produced it; snapshot, restore and
 * listing requests are served over the same protocol pipe.
 *
 * SPIKE deviations from pi-rlm's Bun guest:
 *   - NO Bun, NO Bun.$ guard, NO host bridge (rlm/tools handles). The spike
 *     only proves patterns 01 (namespace), 04 (transform), 05 (incremental
 *     bindings), 08 (snapshot) and 09 (revive) on Node.
 *   - bun:jsc serialize/deserialize -> node:v8 (serialize returns a Buffer in
 *     Node, so base64 is direct — no ArrayBuffer slicing).
 *   - Bun.inspect for cell results  -> node:util inspect.
 *
 * Runs as: node --experimental-strip-types guest.ts  (spawned by EngineManager)
 *
 * Protocol traffic leaves on fd 3 and carries a nonce, so cell output can be
 * neither mistaken for nor forged into a protocol message.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { format, inspect } from "node:util";
import { deserialize, serialize } from "node:v8";
import { decodeMessage, encodeMessage, type GuestToHostMessage, type HostToGuestMessage, NONCE_ENV, PROTOCOL_FD } from "./protocol.ts";
import { transformCell } from "./transform.ts";

// ── identity: nonce + unguessable internal names ─────────────────────────────
// The nonce is removed from the environment immediately so cell code cannot
// read it back and forge protocol traffic on fd 3.

const NONCE = process.env[NONCE_ENV] ?? "";
delete process.env[NONCE_ENV];
if (!NONCE) {
	writeSync(2, "pi-rlm guest started without a protocol nonce\n");
	process.exit(2);
}

const SCOPE_NAME = `__rlm_scope_${NONCE}`;
const CTX_NAME = `__rlm_ctx_${NONCE}`;
const INTERNAL_NAMES = new Set([SCOPE_NAME, CTX_NAME]);

// A pipe fd can be non-blocking: writeSync may write partially or throw EAGAIN
// when the host has not drained yet. Loop until the whole frame is out, or a
// half-written line would corrupt the protocol stream.
const backoff = new Int32Array(new SharedArrayBuffer(4));

function writeAllSync(fd: number, text: string): void {
	const buffer = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		try {
			offset += writeSync(fd, buffer, offset, buffer.length - offset);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EAGAIN" || code === "EWOULDBLOCK") {
				Atomics.wait(backoff, 0, 0, 1);
				continue;
			}
			if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
				try {
					writeSync(2, "[guest] protocol pipe closed; exiting\n");
					// biome-ignore lint/suspicious/noEmptyBlockStatements: exit path — nothing left to report to.
				} catch {}
				// The host closed the protocol pipe (killed or disposed this engine).
				// Nothing left to report to; exit quietly instead of crashing with an
				// uncaught error the host would surface as a spurious failure.
				process.exit(0);
			}
			throw error;
		}
	}
}

function send(message: GuestToHostMessage): void {
	writeAllSync(PROTOCOL_FD, encodeMessage(message, NONCE));
}

// ── namespace, cell context ──────────────────────────────────────────────────

type Namespace = Record<string, unknown>;
const namespace: Namespace = Object.create(null);

/** D6 per-var restore cap (guest-side, NIT-5): a single decoded var larger than
 *  this is rejected → failed[] (bounds v8.deserialize amplification). Default
 *  256 KiB — documented in README; pinned by P2-T5. */
const MAX_RESTORE_VAR_BYTES = 256 * 1024;

interface CellContext {
	cellId: string;
	/** Set when this cell is aborted; its later writes are discarded. */
	aborted: boolean;
	result?: { value: unknown };
	setResult(value: unknown): void;
}

const cellStorage = new AsyncLocalStorage<CellContext>();
let activeCell: CellContext | undefined;

function makeCellContext(cellId: string): CellContext {
	const ctx: CellContext = {
		cellId,
		aborted: false,
		setResult(value: unknown) {
			if (!ctx.aborted) ctx.result = { value };
		},
	};
	return ctx;
}

function makeScopeProxy(ctx: CellContext): Namespace {
	return new Proxy(namespace, {
		has(_target, key) {
			// Only the wrapper's own parameters are hidden, so user names — including
			// __-prefixed ones — resolve and persist normally.
			if (typeof key !== "string") return false;
			return !INTERNAL_NAMES.has(key);
		},
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return (globalThis as Record<string, unknown>)[key];
		},
		set(target, key, value) {
			// Writes from an aborted cell's orphaned continuation are dropped;
			// writes from cells that are merely older are not.
			if (typeof key === "string" && !ctx.aborted) target[key] = value;
			return true;
		},
	});
}

// ── user output capture ──────────────────────────────────────────────────────
// In Node, console methods route through process.stdout.write, but replacing
// them directly keeps the attribution identical to pi-rlm's. AsyncLocalStorage
// keeps attribution correct for output emitted by an orphaned continuation
// after its cell was aborted.

function emit(name: "stdout" | "stderr", text: string): void {
	const owner = cellStorage.getStore() ?? activeCell;
	send({ type: "stream", cellId: owner?.cellId ?? "", name, chunk: text });
}

function captureWrite(name: "stdout" | "stderr") {
	return (chunk: unknown, ...rest: unknown[]): boolean => {
		const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
		emit(name, text);
		const callback = rest.find((r) => typeof r === "function") as (() => void) | undefined;
		callback?.();
		return true;
	};
}

process.stdout.write = captureWrite("stdout") as typeof process.stdout.write;
process.stderr.write = captureWrite("stderr") as typeof process.stderr.write;

function consoleWriter(name: "stdout" | "stderr") {
	return (...args: unknown[]): void => {
		emit(name, `${format(...args)}\n`);
	};
}

const consoleOut = consoleWriter("stdout");
const consoleErr = consoleWriter("stderr");
console.log = consoleOut;
console.info = consoleOut;
console.debug = consoleOut;
console.dir = consoleOut;
console.warn = consoleErr;
console.error = consoleErr;
console.trace = consoleErr;

// ── bootstrap bindings ───────────────────────────────────────────────────────
// pi-rlm mounts rlm/tools/Bun handles here. The spike has no host bridge, so
// nothing is installed — but the hook is kept (and re-run after restore) for
// fidelity with the port plan: a later phase wires real bindings here.

const INTERNAL_BINDINGS = new Map<string, unknown>();

function installBootstrapBindings(): void {
	// Spike: no host bridge, no Bun — nothing to mount.
}

installBootstrapBindings();

// ── cell execution ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noEmptyBlockStatements: async arrow is only a constructor carrier.
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

const liveCells = new Map<string, CellContext>();

async function runCell(cellId: string, code: string): Promise<void> {
	const ctx = makeCellContext(cellId);
	activeCell = ctx;
	liveCells.set(cellId, ctx);

	let done: GuestToHostMessage;
	try {
		const { body } = transformCell(code, { ctxName: CTX_NAME });
		// Sloppy-mode wrapper so `with` is legal (AsyncFunction bodies are always
		// sloppy, even inside a strict ESM strip-types module); async for
		// top-level await.
		const wrapper = new AsyncFunction(SCOPE_NAME, CTX_NAME, `with (${SCOPE_NAME}) { ${body}\n }`);
		await cellStorage.run(ctx, () => wrapper(makeScopeProxy(ctx), ctx));
		done = {
			type: "done",
			cellId,
			status: ctx.aborted ? "aborted" : "ok",
			result: !ctx.aborted && ctx.result && ctx.result.value !== undefined ? inspect(ctx.result.value) : undefined,
		};
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		done = {
			type: "done",
			cellId,
			status: ctx.aborted ? "aborted" : "error",
			error: { name: err.name, message: err.message, stack: (err.stack ?? "").split("\n") },
		};
	} finally {
		if (activeCell === ctx) activeCell = undefined;
		liveCells.delete(cellId);
	}
	send(done);
}

function abortCell(cellId: string): void {
	const ctx = liveCells.get(cellId);
	if (ctx) ctx.aborted = true;
}

// ── snapshot / restore / names ───────────────────────────────────────────────

function snapshotNamespace(): { vars: Record<string, string>; failed: { name: string; reason: string }[] } {
	const vars: Record<string, string> = {};
	const failed: { name: string; reason: string }[] = [];
	for (const [name, value] of Object.entries(namespace)) {
		if (INTERNAL_BINDINGS.get(name) === value) continue;
		try {
			// node:v8 serialize returns a Buffer — base64 direct, no slicing.
			// Functions/classes throw ("could not be cloned"); they land in
			// `failed` instead of crashing the snapshot.
			vars[name] = serialize(value).toString("base64");
		} catch (error) {
			failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { vars, failed };
}

function restoreNamespace(vars: Record<string, string>): {
	restored: string[];
	failed: { name: string; reason: string }[];
} {
	const restored: string[] = [];
	const failed: { name: string; reason: string }[] = [];
	for (const [name, encoded] of Object.entries(vars)) {
		// D4 (MAJOR-S2): a redacted secret arrives as the literal "***" (structural
		// redaction in writeArtifact). base64 of a real value is never "***", so this
		// special-case is collision-free — restore it as the placeholder so the model
		// re-fetches, instead of failing (Buffer.from("***") → empty → deserialize
		// throws → wrongly lands in failed).
		if (encoded === "***") {
			namespace[name] = "***";
			restored.push(name);
			continue;
		}
		try {
			const buffer = Buffer.from(encoded, "base64");
			// D6 per-var cap (256 KiB) — bounds v8 amplification per decoded var.
			if (buffer.length > MAX_RESTORE_VAR_BYTES) {
				failed.push({ name, reason: `size:${buffer.length}>${MAX_RESTORE_VAR_BYTES}` });
				continue;
			}
			// D13 (MINOR-S4): flat redaction can inject "***" INTO a valid base64 payload
			// (bytes matching sk-/eyJ patterns) → decode yields a DIFFERENT buffer →
			// silent corruption. Round-trip check: a clean base64 re-encodes identically.
			if (buffer.toString("base64") !== encoded) {
				failed.push({ name, reason: "base64-corrupt" });
				continue;
			}
			namespace[name] = deserialize(buffer);
			restored.push(name);
		} catch (error) {
			failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	// Bootstrap runs after restore: live handles would overwrite anything
	// revived. The spike installs nothing, but the hook is kept for fidelity.
	installBootstrapBindings();
	return { restored, failed };
}

function listNames(): string[] {
	return Object.keys(namespace).filter((name) => INTERNAL_BINDINGS.get(name) !== namespace[name]);
}

// ── resilience ───────────────────────────────────────────────────────────────
// A throw from a detached task (setTimeout, a floating promise) would otherwise
// kill the process and take the whole namespace with it. Report it as stderr on
// the owning cell and keep the evaluator alive.

function reportStrayError(kind: string, error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	emit("stderr", `[${kind}] ${err.name}: ${err.message}\n`);
}

process.on("uncaughtException", (error) => reportStrayError("uncaught exception", error));
process.on("unhandledRejection", (reason) => reportStrayError("unhandled rejection", reason));

// ── message loop ─────────────────────────────────────────────────────────────

const readline = createInterface({ input: process.stdin });

readline.on("line", (line) => {
	const message = decodeMessage<HostToGuestMessage>(line, NONCE);
	if (!message) return;
	switch (message.type) {
		case "run":
			void runCell(message.cellId, message.code);
			break;
		case "abort":
			abortCell(message.cellId);
			break;
		case "ping":
			send({ type: "pong", id: message.id });
			break;
		case "snapshot": {
			const { vars, failed } = snapshotNamespace();
			send({ type: "snapshot_result", id: message.id, vars, failed });
			break;
		}
		case "restore": {
			const { restored, failed } = restoreNamespace(message.vars);
			send({ type: "restore_result", id: message.id, restored, failed });
			break;
		}
		case "list_names":
			send({ type: "names_result", id: message.id, names: listNames() });
			break;
	}
});

readline.on("close", () => {
	try {
		writeSync(2, "[guest] stdin closed; exiting\n");
		// biome-ignore lint/suspicious/noEmptyBlockStatements: best-effort write on teardown.
	} catch {}
	process.exit(0);
});

send({ type: "ready" });
