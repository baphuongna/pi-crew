/**
 * scratchpad-lifecycle.ts — tool `execute` + EngineManager lifecycle (Phase 1 T6).
 *
 * Owns:
 *   - the conditional `execute` tool registration (D3 + SEC-2);
 *   - the execute handler (spec §4: dormant check → F12 shutdown branch →
 *     ping-before-execute → per-cell timeout → error-as-data);
 *   - the snapshot debounce + temp→writeArtifact flush (spec §5/§6: F4/S-1
 *     crash-safety, N2-4 chmod/unlink, F11/N2-1 fail-closed env validation);
 *   - the `session_shutdown` quit-gated flush+kill hook (spec §5: F3/F22/F13).
 *
 * Kept OUT of prompt-runtime.ts so that file stays focused on prompt shaping.
 *
 * F2: EngineManager is imported DIRECTLY from ../runtime/scratchpad/engine.ts,
 * NOT through the barrel index.ts — the barrel re-exports transform.ts which
 * pulls esbuild into every worker extension process at load time.
 *
 * Testability: the module functions take explicit deps (`engine`,
 * `writeArtifact`, `env`, `logInternalError`) with process-defaults, so unit
 * tests can mock the engine and the artifact writer without spawning guests.
 *
 * THREAT MODEL (accepted, spec §9/§14.9): execute cells run at FULL WORKER
 * TRUST — the guest inherits the worker env (provider keys + broker token)
 * and has network access, same boundary as the built-in bash tool. On quit we
 * SIGKILL the guest PID only; a cell that spawned `detached:true` descendants
 * can leave orphans holding that env. Accepted for Phase 1 (documented, not a
 * containment guarantee); Phase 2: kill process group / orphan sweep.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../extension/pi-api.ts";
import { EngineManager, type ExecuteResult } from "../runtime/scratchpad/engine.ts";
import { type ArtifactWriteOptions, writeArtifact } from "../state/stores/artifact-store.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";

export const PI_CREW_SCRATCHPAD_ENV = "PI_CREW_SCRATCHPAD";
export const PI_CREW_TASK_ID_ENV = "PI_CREW_TASK_ID";
export const PI_CREW_ATTEMPT_ENV = "PI_CREW_ATTEMPT";
export const PI_CREW_ARTIFACTS_ROOT_ENV = "PI_CREW_ARTIFACTS_ROOT";
export const PI_CREW_SCRATCHPAD_SNAPSHOT_ENV = "PI_CREW_SCRATCHPAD_SNAPSHOT";
export const PI_CREW_KIND_ENV = "PI_CREW_KIND";

/** Per-cell wall-clock bound (D9/Q2): the ONLY default anti-hang limit. */
export const EXECUTE_CELL_TIMEOUT_MS = 120_000;
/** Debounce window for the post-cell snapshot (D5/F8). */
export const SNAPSHOT_DEBOUNCE_MS = 1500;
/** SEC-10: cap a single cell so a giant payload cannot OOM the esbuild
 *  transform or the guest. */
export const EXECUTE_CODE_MAX_LENGTH = 262_144;
/** §4 step 5: stack traces are capped before they reach the model. */
export const MAX_ERROR_STACK_LINES = 20;

const ExecuteParams = Type.Object({
	code: Type.String({ minLength: 1, maxLength: EXECUTE_CODE_MAX_LENGTH }),
});
type ExecuteParams = Static<typeof ExecuteParams>;

export interface ExecuteDetails {
	status: "ok" | "error" | "aborted";
	durationMs: number;
	error?: { name: string; message: string; stack: string[] };
}

/**
 * F9: doctrine is carried by the ToolDefinition `promptGuidelines` field (the
 * ONLY channel — pi consumes it from ACTIVE tools; see system-prompt.js +
 * agent-session.js). It is NEVER appended manually in before_agent_start,
 * which would produce duplicate doctrine.
 */
export const SCRATCHPAD_DOCTRINE: string[] = [
	"State compounds: variables persist across execute calls in the task's persistent namespace. Don't re-derive what a previous cell already computed.",
	"Write small cells and run many: the cell's result is the value of its final (trailing) expression.",
	"The runtime is Node.js — use child_process for shell commands; there is no Bun.",
	"Writes are surgical; reads are full: read all the data you need, write the minimum.",
	"Non-serializable variables (functions/classes) are reported in the snapshot's failed list — do not rely on them across calls.",
	"If you see <rlm_engine_reset> or a snapshot-restore notice, re-verify variables before use.",
	"Tool calls inside execute are await expressions — await the result before the next cell.",
];

// ── singleton engine + debounce timer (per worker process) ─────────────────
// The EngineManager INSTANCE is created eagerly at registration (cheap — no
// guest process), but the GUEST spawns lazily on the first execute (lazy start
// lives inside engine.execute → start(), F21).
let engineSingleton: EngineManager | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function getScratchpadEngine(): EngineManager {
	engineSingleton ??= new EngineManager();
	return engineSingleton;
}

/**
 * D5/F8: debounced snapshot scheduling. One timer alive at a time (clear
 * before re-set). The timer is unref'd so an idle worker never blocks
 * event-loop exit; `flushScratchpadSnapshot` swallows+logs its own errors.
 * `delayMs` is injectable for tests only; production uses SNAPSHOT_DEBOUNCE_MS.
 */
export function scheduleScratchpadSnapshot(deps: ScratchpadSnapshotDeps, delayMs: number = SNAPSHOT_DEBOUNCE_MS): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = undefined;
		void flushScratchpadSnapshot(deps);
	}, delayMs);
	debounceTimer.unref?.();
}

/** Cancel any pending debounce snapshot (R-3/SEC-RACE-1: quit-flush must not
 *  race the debounce timer over the same temp path). */
export function cancelScratchpadSnapshot(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = undefined;
}

// ── env validation (F11/SEC-7 — fail-closed) ────────────────────────────────

export interface SnapshotEnvValidation {
	valid: boolean;
	reason?: string;
	taskId?: string;
	/** Fail-open per F4/R-8: PI_CREW_ATTEMPT is always set by the parent, but
	 *  missing here degrades to "0" rather than skipping the snapshot. */
	attempt: string;
	artifactsRoot?: string;
	snapshotPath?: string;
}

/**
 * Worker-side validation of the scratchpad snapshot env, mirroring
 * `validateSteeringFile`'s fail-closed posture (prompt-runtime.ts).
 *
 * - `PI_CREW_TASK_ID` required (relativePath provenance, C3).
 * - `PI_CREW_ATTEMPT` fail-open → "0" (R-8).
 * - `PI_CREW_ARTIFACTS_ROOT` non-empty AND a real non-symlink directory
 *   (resolveRealContainedPath O_NOFOLLOW). We do NOT derive it from the
 *   snapshot path (N2-1 — the snapshot lives in the parent's tempDir, NOT
 *   under artifactsRoot after F4/S-1).
 * - `PI_CREW_SCRATCHPAD_SNAPSHOT` non-empty and resolvable with no symlinked
 *   ancestors (validated against its own dirname, since its base is the
 *   parent's tempDir which the worker does not know by name).
 *
 * Any violation → `{ valid: false, reason }`; callers skip the snapshot write
 * and logInternalError("scratchpad.env-validation", ...) — never derive, never
 * write to a guessed location.
 */
export function validateSnapshotEnv(env: NodeJS.ProcessEnv = process.env): SnapshotEnvValidation {
	const taskId = env[PI_CREW_TASK_ID_ENV];
	const artifactsRoot = env[PI_CREW_ARTIFACTS_ROOT_ENV];
	const snapshotPath = env[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV];
	const attempt = env[PI_CREW_ATTEMPT_ENV] ?? "0";

	if (!taskId) return { valid: false, reason: `missing ${PI_CREW_TASK_ID_ENV}`, attempt };
	if (!artifactsRoot) return { valid: false, reason: `missing ${PI_CREW_ARTIFACTS_ROOT_ENV}`, attempt };
	if (!snapshotPath) return { valid: false, reason: `missing ${PI_CREW_SCRATCHPAD_SNAPSHOT_ENV}`, attempt };

	try {
		// artifactsRoot must exist (or be creatable) and be a real dir, not a symlink.
		resolveRealContainedPath(artifactsRoot, ".");
		// snapshot path: validate containment + O_NOFOLLOW ancestors against its
		// own dirname (tempDir). Target file may not exist yet — that's fine.
		resolveRealContainedPath(path.dirname(snapshotPath), path.basename(snapshotPath));
	} catch (error) {
		return {
			valid: false,
			reason: `env-path-invalid:${error instanceof Error ? error.message : String(error)}`,
			attempt,
		};
	}
	return { valid: true, taskId, attempt, artifactsRoot, snapshotPath };
}

// ── snapshot flush ──────────────────────────────────────────────────────────

export interface ScratchpadSnapshotDeps {
	engine: EngineManager;
	/** Injected for tests; production defaults to the real artifact-store writer.
	 *  Return type is loose (unknown) — the flush ignores the descriptor. */
	writeArtifact?: ScratchpadWriteArtifact;
	env?: NodeJS.ProcessEnv;
	logInternalError?: typeof logInternalError;
}

/** DI-friendly signature for the artifact writer (see ScratchpadSnapshotDeps). */
export type ScratchpadWriteArtifact = (artifactsRoot: string, options: ArtifactWriteOptions) => unknown;

/**
 * Read the RAW snapshot temp file, redact it through `writeArtifact`, then
 * clean the temp (N2-4). Best-effort: every failure is logged via
 * logInternalError("scratchpad.snapshot", ...) and never throws (F8/F13).
 *
 * Crash-safety (F4/S-1): the raw (unredacted, base64 v8.serialize) file is
 * written by engine.snapshotState ONLY under the parent tempDir; the only
 * writer to artifactsRoot is writeArtifact (structural + flat redaction,
 * atomic write). A crash at any point between snapshotState and writeArtifact
 * leaves raw bytes in TEMP, never in artifacts.
 */
export async function flushScratchpadSnapshot(deps: ScratchpadSnapshotDeps): Promise<void> {
	const env = deps.env ?? process.env;
	const writeArtifactFn = deps.writeArtifact ?? writeArtifact;
	const log = deps.logInternalError ?? logInternalError;

	const validation = validateSnapshotEnv(env);
	if (!validation.valid) {
		log("scratchpad.env-validation", new Error(validation.reason ?? "snapshot-env-invalid"), undefined, "warn");
		return;
	}
	// validation.valid ⇒ all four fields are defined (narrowed explicitly below
	// because TS cannot narrow across separate interface properties).
	const { attempt } = validation;
	const taskId = validation.taskId!;
	const artifactsRoot = validation.artifactsRoot!;
	const snapshotPath = validation.snapshotPath!;

	try {
		const snap = await deps.engine.snapshotState(snapshotPath);
		if (!snap) {
			// F8: snapshotState returns null when the engine is not running. An
			// error-null (engine running but the request failed, engine.ts:534)
			// is indistinguishable here — surface it instead of swallowing (F13).
			if (deps.engine.isRunning) {
				log("scratchpad.snapshot", new Error("snapshotState returned null while engine is running"));
			}
			return;
		}
		const tempPath = snap.path;
		try {
			// N2-4: engine wrote RAW with default mode (0666 & ~umask); narrow to
			// owner-only before the content leaves the temp dir. The parent's
			// mkdtemp dir is 0700, so this is belt-and-braces.
			await fs.promises.chmod(tempPath, 0o600);
			const content = await fs.promises.readFile(tempPath, "utf8");
			await writeArtifactFn(artifactsRoot, {
				kind: "result",
				relativePath: `scratchpad/${taskId}.attempt-${attempt}.snapshot.json`,
				content,
				producer: taskId,
			});
		} finally {
			// R-4/N2-4: unlink the raw temp even if writeArtifact (or chmod/read)
			// threw — best-effort, parent cleanupTempDir is the backstop.
			await fs.promises.unlink(tempPath).catch((error) => log("scratchpad.temp-unlink", error));
		}
	} catch (error) {
		// F8: best-effort — a snapshot failure must not kill the worker.
		log("scratchpad.snapshot", error);
	}
}

// ── execute tool ────────────────────────────────────────────────────────────

function renderExecuteResult(result: ExecuteResult): string {
	const lines: string[] = [];
	lines.push(`status: ${result.status}`);
	lines.push(`durationMs: ${result.durationMs}`);
	if (result.stdout) lines.push(`stdout:\n${result.stdout}`);
	if (result.stderr) lines.push(`stderr:\n${result.stderr}`);
	if (result.result !== undefined) lines.push(`result:\n${result.result}`);
	if (result.error) {
		lines.push(`error: ${result.error.name}: ${result.error.message}`);
		const stack = result.error.stack.slice(0, MAX_ERROR_STACK_LINES).join("\n");
		if (stack) lines.push(`stack (first ${MAX_ERROR_STACK_LINES} lines):\n${stack}`);
	}
	return lines.join("\n\n");
}

export type ExecuteToolDefinition = ToolDefinition<typeof ExecuteParams, ExecuteDetails>;

/**
 * Build the `execute` tool definition. `engine` is injected so tests can mock
 * it; production passes the singleton via registerScratchpadLifecycle.
 *
 * Handler flow (spec §4, order is load-bearing):
 *   1. dormant check (layer 2): env !== "1" → throw "scratchpad is dormant".
 *   2. F12: engine.state === "shutdown" → system error (NOT "wedged").
 *   3. ping-before-execute (S-2/N2-2): ping only when isRunning — a first cell
 *      on an idle engine must not false-positive "wedged".
 *   4. per-cell timeout (D9/F7): ternary guard — params.signal may be
 *      undefined and AbortSignal.any([undefined, ...]) throws.
 *   5. execute with onStream forwarded to stdout (V4-2: keeps the parent's
 *      heartbeat alive during long cells).
 *   6. error-as-data (§4.5 + R-5): "error" AND "aborted" are returned as
 *      content, never thrown; only system failures (engine dead/wedge) throw.
 *   7. on a successful cell, schedule the debounced snapshot.
 */
export function createExecuteTool(engine: EngineManager, deps: Partial<ScratchpadSnapshotDeps> = {}): ExecuteToolDefinition {
	return defineTool({
		name: "execute",
		label: "Execute JavaScript",
		description:
			"Chạy JavaScript trong namespace bền vững của task. State (biến gán ở cell trước) tồn tại qua các lần gọi. Kết quả cell = giá trị biểu thức cuối.",
		parameters: ExecuteParams,
		renderShell: "default",
		promptSnippet: "execute(code) — chạy JS trong namespace bền vững của task",
		promptGuidelines: SCRATCHPAD_DOCTRINE,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const env = deps.env ?? process.env;
			// 1. Dormant check (lớp 2 — defense in depth behind the registration gate).
			if (env[PI_CREW_SCRATCHPAD_ENV] !== "1") {
				throw new Error("scratchpad is dormant");
			}
			// 2. F12: terminal shutdown state — a distinct system error, not "wedged".
			if (engine.state === "shutdown") {
				throw new Error("scratchpad engine đã chết (shutdown)");
			}
			// 3. Ping-before-execute (S-2/N2-2): skip on idle so the first cell of a
			//    session never false-positives (listNamespaceNames → null when idle).
			if (engine.isRunning) {
				const ok = await engine.listNamespaceNames();
				if (ok === null) {
					throw new Error(
						"scratchpad engine wedged — previous cell blocked the event loop; restart task or avoid sync infinite loops",
					);
				}
			}
			// 4. Per-cell timeout (D9/F7 ternary guard).
			const cellSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(EXECUTE_CELL_TIMEOUT_MS)])
				: AbortSignal.timeout(EXECUTE_CELL_TIMEOUT_MS);
			// 5. Execute (lazy-start lives inside engine.execute).
			let result: ExecuteResult;
			try {
				result = await engine.execute(params.code, {
					signal: cellSignal,
					onStream: (chunk) => {
						// V4-2: forward guest output to worker stdout so the parent's
						// heartbeat (persistHeartbeat on stdout/JSON events) fires
						// during long-running cells.
						process.stdout.write(chunk);
					},
				});
			} catch (error) {
				// System error — the model cannot fix a dead/wedged engine.
				throw new Error(`scratchpad engine failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			// 6. Error-as-data (R-5): "error" and "aborted" both come back as content.
			const details: ExecuteDetails = {
				status: result.status,
				durationMs: result.durationMs,
				...(result.error
					? {
							error: {
								name: result.error.name,
								message: result.error.message,
								stack: result.error.stack.slice(0, MAX_ERROR_STACK_LINES),
							},
						}
					: {}),
			};
			// 7. Debounced snapshot after a healthy cell (D5/F8).
			if (result.status === "ok") {
				scheduleScratchpadSnapshot({ ...deps, engine });
			}
			return {
				content: [{ type: "text", text: renderExecuteResult(result) }],
				details,
			};
		},
	});
}

// ── shutdown flush (F3/F22/F13) ─────────────────────────────────────────────

/**
 * Quit-path flush: snapshot → writeArtifact → kill, done manually (NOT
 * engine.dispose) so writeArtifact stays the single artifacts writer (D5).
 * Guarded by `engine.isRunning` (F22): an idle engine has no guest to flush
 * and snapshotState would return null (avoiding a chmod on a missing file).
 */
export async function performShutdownFlush(engine: EngineManager, deps: Partial<ScratchpadSnapshotDeps> = {}): Promise<void> {
	if (!engine.isRunning) return;
	cancelScratchpadSnapshot();
	await flushScratchpadSnapshot({ ...deps, engine });
	await engine.kill();
}

// ── extension hook ──────────────────────────────────────────────────────────

export interface ScratchpadLifecycleOptions extends Omit<ScratchpadSnapshotDeps, "engine"> {
	/** Override the lazy singleton (tests). */
	engine?: EngineManager;
}

/**
 * Wire the scratchpad lifecycle into an extension API:
 *   - D3 + SEC-2: register the `execute` tool ONLY when
 *     PI_CREW_SCRATCHPAD === "1" && PI_CREW_KIND === "subagent" (workers always
 *     carry PI_CREW_KIND=subagent; a main session never does, so a leaked env
 *     cannot activate the tool in the user session);
 *   - session_shutdown (F3): flush+kill ONLY on reason === "quit";
 *     reload/new/resume/fork are no-ops (state:"shutdown" is terminal — an
 *     early kill would break every future execute).
 */
export function registerScratchpadLifecycle(pi: ExtensionAPI, options: ScratchpadLifecycleOptions = {}): void {
	const engine = options.engine ?? getScratchpadEngine();
	const deps: ScratchpadSnapshotDeps = { ...options, engine };

	if (shouldRegisterScratchpadTool(options.env ?? process.env)) {
		pi.registerTool(createExecuteTool(engine, deps));
	}

	pi.on("session_shutdown", (event) => {
		if (event.reason !== "quit") return;
		if (!engine.isRunning) return;
		cancelScratchpadSnapshot(); // R-3/SEC-RACE-1: no debounce/quit race over the temp path
		return performShutdownFlush(engine, deps).catch((error) => {
			// F13: teardown must not throw, but must not swallow silently.
			logInternalError("scratchpad.shutdown-flush", error);
		});
	});
}

/**
 * D3 + SEC-2 registration gate (pure, testable): env "1" AND subagent kind.
 * The handler's own dormant check (layer 2) is env-only — the worker env is
 * the single source of truth per F15.
 */
export function shouldRegisterScratchpadTool(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PI_CREW_SCRATCHPAD_ENV] === "1" && env[PI_CREW_KIND_ENV] === "subagent";
}
