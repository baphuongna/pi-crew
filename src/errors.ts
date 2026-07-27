// pi-crew structured error module — taxonomy mapping E001–E006.
/**
 * @fileoverview Error types and structured error handling for pi-crew.
 *
 * This module defines pi-crew's error taxonomy, mapping to semantic categories
 * matching fallow's E001-E004 pattern. It exports three main constructs:
 *
 * - {@link ErrorCode} — a `const` object and string-literal union type alias
 *   enumerating machine-readable error codes (E001–E006). Implemented as a
 *   `const` object rather than a TypeScript `enum` so that Node's
 *   `--experimental-strip-types` can load this module (enum syntax is not
 *   supported in strip-only mode).
 *
 * - {@link CrewError} — a structured `Error` subclass that carries an
 *   {@link ErrorCode}, an optional human-readable `help` hint, and an optional
 *   `context` string. Its `toString()` renders the display format:
 *   `error[E001]: Failed to read manifest.json: not found`.
 *
 * - {@link errors} — a factory object exposing convenience constructors
 *   (e.g. `errors.fileRead`, `errors.taskNotFound`) that build `CrewError`
 *   instances with sensible defaults and pre-attached context.
 */
// Implemented as const object + type alias (not `enum`) so that Node's
// `--experimental-strip-types` can load this module. TypeScript `enum`
// syntax is not supported in strip-only mode.
export const ErrorCode = {
	FileReadError: "E001", // Cannot read a file
	FileWriteError: "E002", // Cannot write a file
	TaskNotFound: "E003", // Referenced task ID does not exist
	InvalidStatusTransition: "E004", // Run/task status cannot legally transition
	ConfigError: "E005", // Malformed config or missing required field
	ResourceNotFound: "E006", // Agent/team/workflow not found in discovery paths
	// E1 (Round 15): runtime failure categories that previously threw raw Error
	// with no code, no help hint, and no context. Surfaces actionable guidance.
	ChildTimeout: "E007", // Child Pi worker became unresponsive and was killed
	ModelExhausted: "E008", // All model candidates in the fallback chain failed
	PreStepFailed: "E009", // A pre-step hook script returned a non-zero exit
	EventLogLockTimeout: "E010", // Could not acquire the event-log file lock
	DepthLimitExceeded: "E011", // Pipeline/chain recursion depth limit hit (circular dep)
	RunStale: "E012", // Run reconciled as stale/zombie (heartbeat expired)
	ModelOutOfScope: "E013", // Caller-supplied model is not in pi's enabledModels allowlist (F7 scope gate)
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const DEFAULT_HELP: Record<ErrorCode, string | undefined> = {
	[ErrorCode.FileReadError]: "Check that the file exists and that the process has read permission.",
	[ErrorCode.FileWriteError]: "Check that the disk is not full and that the process has write permission.",
	[ErrorCode.TaskNotFound]: "The task may have been removed or the run may be in an inconsistent state. Use `team status` to verify.",
	[ErrorCode.InvalidStatusTransition]: "Verify the run status using `team status` before retrying.",
	[ErrorCode.ConfigError]: "Check the configuration file for syntax errors or missing required fields.",
	[ErrorCode.ResourceNotFound]: "Use `team list` to see available agents, teams, and workflows.",
	// E1 (Round 15): help hints for the new runtime categories.
	[ErrorCode.ChildTimeout]:
		"The child Pi worker produced no output for too long and was terminated. Re-run the team; if it recurs, raise the response timeout in config or reduce the task scope.",
	[ErrorCode.ModelExhausted]:
		"Every model in the fallback chain failed. Check your API key/quota and the per-attempt errors, then retry or swap the model in config.",
	[ErrorCode.PreStepFailed]:
		"The pre-step hook script exited non-zero. Inspect its stderr, or mark it optional in the workflow step (preStepOptional).",
	[ErrorCode.EventLogLockTimeout]:
		"Another process holds the event-log lock. Check for orphaned `.mkdirlock` directories or stale pi-crew processes, then retry.",
	[ErrorCode.DepthLimitExceeded]:
		"A pipeline/chain exceeded the recursion depth limit, which usually indicates a circular stage dependency. Review step `dependsOn` chains.",
	[ErrorCode.RunStale]:
		"The worker stopped heartbeating and was treated as a zombie. Re-run the team (resume or fresh); if it recurs, check `runtime.executeWorkers` / system load.",
	[ErrorCode.ModelOutOfScope]:
		"The requested model is not in your pi `enabledModels` allowlist. Either pick a model listed in `enabledModels` (settings.json) or extend the allowlist. The scope gate is opt-in — disable `runtime.reliability.scopeModels` to allow any model.",
};

/**
 * Structured error type for pi-crew.
 * Display format:
 *   error[E001]: Failed to read manifest.json: not found
 *     context: while loading run state
 *     help: Check that the file exists and that the process has read permission.
 */
export class CrewError extends Error {
	readonly code: ErrorCode;
	help?: string;
	private _context?: string;

	constructor(code: ErrorCode, message: string, help?: string) {
		super(message);
		this.name = "CrewError";
		this.code = code;
		this.help = help ?? DEFAULT_HELP[code];
		Object.defineProperty(this, "message", { enumerable: true });
		Object.defineProperty(this, "code", { enumerable: true });
	}

	withContext(context: string): this {
		this._context = context;
		return this;
	}

	withHelp(help: string): this {
		this.help = help;
		return this;
	}

	toString(): string {
		let out = `error[${this.code}]: ${this.message}`;
		if (this._context) out += `\n  context: ${this._context}`;
		if (this.help) out += `\n  help: ${this.help}`;
		return out;
	}
}

export const errors = {
	fileRead(path: string, source: NodeJS.ErrnoException): CrewError {
		return new CrewError(ErrorCode.FileReadError, `Failed to read ${path}: ${source.code?.toLowerCase() ?? "unknown"}`).withContext(
			"file system read operation",
		);
	},

	fileWrite(path: string, source: NodeJS.ErrnoException): CrewError {
		return new CrewError(ErrorCode.FileWriteError, `Failed to write ${path}: ${source.code?.toLowerCase() ?? "unknown"}`).withContext(
			"file system write operation",
		);
	},

	taskNotFound(taskId: string, runId?: string): CrewError {
		const msg = runId ? `Task '${taskId}' not found in run '${runId}'` : `Task '${taskId}' not found`;
		return new CrewError(ErrorCode.TaskNotFound, msg);
	},

	invalidStatusTransition(from: string, to: string): CrewError {
		return new CrewError(ErrorCode.InvalidStatusTransition, `Invalid run status transition: ${from} -> ${to}`);
	},

	config(message: string): CrewError {
		return new CrewError(ErrorCode.ConfigError, message).withContext("configuration loading");
	},

	resourceNotFound(type: string, name: string): CrewError {
		return new CrewError(ErrorCode.ResourceNotFound, `${type} '${name}' not found in any discovery path`);
	},

	// E1 (Round 15): runtime failure constructors. These wrap the raw-throw
	// sites identified in the Round 15 error-experience audit so failures carry
	// a machine-readable code, a help hint, and structured context.
	childTimeout(detail: { timeoutMs?: number; taskId?: string; stderr?: string }): CrewError {
		const tail = detail.stderr ? ` Stderr tail: ${detail.stderr.slice(-400)}` : "";
		const dur = detail.timeoutMs ? ` after ${detail.timeoutMs}ms of no output` : "";
		return new CrewError(ErrorCode.ChildTimeout, `Child Pi worker became unresponsive${dur} and was terminated.${tail}`).withContext(
			`worker execution${detail.taskId ? ` (task ${detail.taskId})` : ""}`,
		);
	},

	modelExhausted(chain: string[], lastFailure?: string): CrewError {
		const tried = chain.join(" → ");
		const last = lastFailure ? ` Last failure: ${lastFailure}` : "";
		return new CrewError(
			ErrorCode.ModelExhausted,
			`All ${chain.length} model candidates exhausted (tried: ${tried}).${last}`,
		).withContext("model fallback chain");
	},

	preStepFailed(script: string, exitCode: number | undefined, stderr?: string): CrewError {
		const tail = stderr ? ` Stderr: ${stderr.slice(-400)}` : "";
		return new CrewError(ErrorCode.PreStepFailed, `preStepScript '${script}' exited ${exitCode ?? "non-zero"}.${tail}`).withContext(
			"pre-step hook execution",
		);
	},

	eventLogLockTimeout(eventsPath: string, timeoutMs: number): CrewError {
		return new CrewError(
			ErrorCode.EventLogLockTimeout,
			`Event log lock timeout for ${eventsPath}: could not acquire lock within ${timeoutMs}ms`,
		).withContext("event-log append");
	},

	depthLimitExceeded(depth: number, kind = "pipeline"): CrewError {
		return new CrewError(
			ErrorCode.DepthLimitExceeded,
			`${kind[0].toUpperCase() + kind.slice(1)} recursion depth limit exceeded (${depth}). Possible circular dependency.`,
		).withContext(`${kind} execution`);
	},

	runStale(reason: string, heartbeatAgeSeconds?: number): CrewError {
		const age = heartbeatAgeSeconds !== undefined ? ` Last heartbeat was ${heartbeatAgeSeconds}s ago.` : "";
		return new CrewError(
			ErrorCode.RunStale,
			`Stale run reconciled (reason=${reason}).${age} The worker stopped heartbeating and was treated as dead/zombie.`,
		).withContext("stale-run reconciliation");
	},

	modelOutOfScope(model: string, patterns: string[]): CrewError {
		return new CrewError(
			ErrorCode.ModelOutOfScope,
			`Requested model "${model}" is not in enabledModels scope (allowlist: [${patterns.join(", ")}])`,
		).withContext("F7 model scope gate — caller override rejected");
	},
} as const;
