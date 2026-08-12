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
import { execFile } from "node:child_process";
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
// pi-rlm mounts rlm/tools/Bun handles here. Pattern 12 (shell guard): the
// guest-local `sh` helper narrows raw child_process — it refuses null/undefined
// arguments (the `rm -rf undefined` class bug) and returns a value, not a
// string, so cell 2 can reuse cell 1's result. Advisory guard only — cells run
// at full worker trust (no VM sandbox), so `sh` is a nudge, not a boundary.

const INTERNAL_BINDINGS = new Map<string, unknown>();

/**
 * Protected Node globals — must never be persistently shadowed by a cell.
 *
 * Because the scope proxy's `get` trap checks the namespace BEFORE globalThis,
 * a cell writing `const process = 'poisoned'` (transformed to a namespace
 * assignment) would otherwise poison EVERY later cell in the same engine
 * (the namespace is a module-level singleton) AND survive snapshot→restore
 * (a serializable shadow revives). Result: silent corruption — e.g.
 * `typeof process.env` becomes 'undefined' with no error.
 *
 * We register the LIVE global for each protected name in INTERNAL_BINDINGS +
 * the namespace, so (a) restore's re-install overwrites any revived shadow,
 * and (b) each cell starts with the real global. Within-cell shadowing still
 * works (the cell's own write wins for that cell only); it just cannot leak
 * to other cells or across restarts. Verified: probe reproduced the bug
 * pre-fix; see test/unit/runtime/scratchpad/guest-global-shadow.test.ts.
 */
const PROTECTED_GLOBALS: ReadonlyArray<string> = [
	"process",
	"Buffer",
	"console",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"setImmediate",
	"clearImmediate",
	"queueMicrotask",
	"structuredClone",
	"AbortController",
	"globalThis",
];

function resetProtectedGlobals(): void {
	const g = globalThis as Record<string, unknown>;
	for (const name of PROTECTED_GLOBALS) {
		const live = g[name];
		if (live === undefined) continue;
		INTERNAL_BINDINGS.set(name, live);
		namespace[name] = live;
	}
}

/** Pattern-12 nullish guard: refuse undefined/null BEFORE spawning. */
function assertShellArgNotNullish(name: string, value: unknown): void {
	if (value === undefined || value === null) {
		throw new Error(
			`sh: argument '${name}' is null/undefined — a missing variable would stringify to the literal 'undefined' in the command. Re-verify variables after a restore before using them in shell commands.`,
		);
	}
}

/**
 * sh(cmd, args[]) — pattern-12 shell interpolation guard.
 * Runs via execFile (shell:false, args as an array — no shell interpolation
 * of the command string), refuses nullish args, and returns a value:
 * `{ exitCode, stdout, stderr }` (pi-rlm "shell as value"). Non-zero exit does
 * NOT throw — it is returned in `exitCode`.
 */
function makeSh(): (cmd: string, args?: unknown[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const execFileAsync = (cmd: string, args: string[]) =>
		new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
			execFile(cmd, args, { shell: false, encoding: "utf8" }, (error, stdout, stderr) => {
				if (error) {
					// error.code is the exit code for a non-zero exit; otherwise a real
					// spawn failure (ENOENT etc.) — surface it as exitCode 127-like.
					const exitCode = typeof error.code === "number" ? error.code : 127;
					resolve({ exitCode, stdout: String(stdout), stderr: String(stderr || error.message) });
					return;
				}
				resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	return async (cmd: string, args?: unknown[]) => {
		assertShellArgNotNullish("cmd", cmd);
		const stringArgs = (args ?? []).map((a, i) => {
			assertShellArgNotNullish(`arg[${i}]`, a);
			return String(a);
		});
		return execFileAsync(cmd, stringArgs);
	};
}

function installBootstrapBindings(): void {
	const sh = makeSh();
	// Register the SAME function reference in INTERNAL_BINDINGS and the
	// namespace so snapshotNamespace()'s identity skip (===) excludes it from
	// serialization, and so cells can call `sh(...)` directly.
	INTERNAL_BINDINGS.set("sh", sh);
	namespace.sh = sh;
	// Overwrite any protected-global shadow (e.g. a revived `process='x'` from
	// restore) with the live global — fixes the global shadow poisoning bug.
	resetProtectedGlobals();
}

installBootstrapBindings();

// ── cell execution ───────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noEmptyBlockStatements: async arrow is only a constructor carrier.
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

const liveCells = new Map<string, CellContext>();

// ── P6: remap transformed error-stack lines back to the cell's source ───────
// V8 reports a thrown line as `N = bodyLine + 2` (1-based) — the AsyncFunction
// wrapper adds 2 prefix lines (the anonymous function line + the `with (...)`
// line) before the cell body. `lineMap` (from transformCell) maps body lines
// that RECEIVED A REPLACEMENT back to the source line the model wrote. Lines
// between replacements (unreplaced spans — e.g. a bare `throw`) are identity:
// sourceLine = entry.sourceLine + (bodyLine - entry.bodyLine), using the
// nearest replacement entry at or before the body line.
//
// SECURITY/robustness (P6 review finding): only lines that look like a real
// V8 frame (`    at ... <anonymous>:N:C)`) are remapped. The `Error: <message>`
// line and any cell text containing `<anonymous>:N:C)` (e.g. an error message
// that echoes code) must be left byte-identical — a crafted message must never
// get its numbers rewritten.
function remapStackLines(stack: string, lineMap: { sourceLine: number; bodyLine: number }[]): string[] {
	const lines = stack.split("\n");
	const sorted = [...lineMap].sort((a, b) => a.bodyLine - b.bodyLine);
	return lines.map((line) => {
		// Real V8 frame only: `    at <anything> <anonymous>:N:C)` — anchored to
		// the leading frame prefix and a parenthesized trailing position. The
		// message line (`Error: ...`) does not start with `    at `, so it is
		// never matched; a crafted message containing `<anonymous>:N:C)` is
		// likewise safe because it lacks the frame prefix.
		const m = line.match(/^\s+at .*<anonymous>:(\d+):(\d+)\)/);
		if (!m) return line;
		const reported = Number(m[1]);
		const bodyLine = reported - 2; // wrapper prefix offset (verified by probe)
		// nearest replacement entry at or before bodyLine (lower bound)
		let lo = 0;
		let hi = sorted.length - 1;
		let entry: { sourceLine: number; bodyLine: number } | undefined;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid].bodyLine <= bodyLine) {
				entry = sorted[mid];
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (!entry) return line; // before any replacement — leave as-is
		const sourceLine = entry.sourceLine + (bodyLine - entry.bodyLine);
		const col = m[2];
		return line.replace(/<anonymous>:\d+:\d+/, `<anonymous>:${sourceLine}:${col}`);
	});
}

async function runCell(cellId: string, code: string): Promise<void> {
	const ctx = makeCellContext(cellId);
	activeCell = ctx;
	liveCells.set(cellId, ctx);
	// Reset protected globals so a prior cell's shadow (e.g. `const process='x'`)
	// cannot poison this cell — shadowing stays local to the cell that did it
	// (the namespace is a module-level singleton shared across cells).
	resetProtectedGlobals();

	let done: GuestToHostMessage;
	// P6: lineMap from transformCell is needed in BOTH try (to build the
	// wrapper) and catch (to remap the error stack), so hoist it here.
	let lineMap: { sourceLine: number; bodyLine: number }[] = [];
	try {
		const { body, lineMap: lm } = transformCell(code, { ctxName: CTX_NAME });
		lineMap = lm;
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
			error: { name: err.name, message: err.message, stack: remapStackLines(err.stack ?? "", lineMap) },
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
	// revived. `sh` is re-installed so a revived stale value cannot shadow the
	// live handle (I6).
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
