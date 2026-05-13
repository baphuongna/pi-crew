/**
 * crew-errors.ts — Typed error sentinels for pi-crew operations.
 *
 * Based on oh-my-pi pattern from compaction/errors.ts.
 * Uses `instanceof` discrimination instead of string matching.
 *
 * NOTE: Constructor parameters are explicit properties (not TypeScript
 * parameter properties) for strip-types compatibility.
 *
 * The `name` property is not set on instances because JavaScript's `name`
 * on functions is special and can't be overridden. Use `instanceof` checks
 * or the `code` property for discrimination.
 */

/** Base class for all pi-crew errors. */
export abstract class CrewError extends Error {
	abstract readonly code: string;

	/** Returns the class name. Use `instanceof` for discrimination. */
toString(): string {
		return `[${this.constructor.name}] ${this.message}`;
	}
}

/** Raised when a crew run is explicitly cancelled by user or API. */
export class CrewCancelledError extends CrewError {
	readonly code = "CREW_CANCELLED";
	constructor(message = "Crew run cancelled") {
		super(message);
	}
}

/** Raised when a crew run exceeds its configured maximum duration. */
export class CrewTimeoutError extends CrewError {
	readonly code = "CREW_TIMEOUT";
	readonly maxDurationMs: number;
	constructor(maxDurationMs: number, message?: string) {
		super(message ?? `Crew run exceeded timeout of ${maxDurationMs}ms`);
		this.maxDurationMs = maxDurationMs;
	}
}

/**
 * Raised when an individual agent in a crew goes deadletter — i.e. it
 * encountered an unrecoverable error that blocks its task from completing.
 * Common causes: crash, OOM, unhandled exception in tool execution.
 */
export class CrewDeadletterError extends CrewError {
	readonly code = "CREW_DEADLETTER";
	readonly agentId: string;
	readonly reason: string;
	constructor(agentId: string, reason: string, message?: string) {
		super(message ?? `Agent ${agentId} deadlettered: ${reason}`);
		this.agentId = agentId;
		this.reason = reason;
	}
}

/** Raised when a crew run is aborted — operator Esc, SIGINT, or similar. */
export class CrewAbortError extends CrewError {
	readonly code = "CREW_ABORT";
	constructor(message = "Crew run aborted") {
		super(message);
	}
}

/** Raised when a manifest or task file is malformed or missing required fields. */
export class CrewManifestError extends CrewError {
	readonly code = "CREW_MANIFEST_ERROR";
	readonly runId?: string;
	readonly taskId?: string;
	constructor(message: string, runId?: string, taskId?: string) {
		super(message);
		this.runId = runId;
		this.taskId = taskId;
	}
}

/** Raised when a lock cannot be acquired or is held by a stale process. */
export class CrewLockError extends CrewError {
	readonly code = "CREW_LOCK_ERROR";
	readonly lockPath?: string;
	constructor(message: string, lockPath?: string) {
		super(message);
		this.lockPath = lockPath;
	}
}

/** Raised when an agent exceeds its turn limit. */
export class CrewTurnLimitError extends CrewError {
	readonly code = "CREW_TURN_LIMIT";
	readonly agentId: string;
	readonly maxTurns: number;
	constructor(agentId: string, maxTurns: number) {
		super(`Agent ${agentId} exceeded turn limit of ${maxTurns}`);
		this.agentId = agentId;
		this.maxTurns = maxTurns;
	}
}

/** Raised when a workflow step gate condition is not met. */
export class CrewGateError extends CrewError {
	readonly code = "CREW_GATE_ERROR";
	readonly gateName: string;
	constructor(gateName: string, message: string) {
		super(message);
		this.gateName = gateName;
	}
}

/** Raised when an agent session fails to initialize (e.g. model not found). */
export class CrewSessionError extends CrewError {
	readonly code = "CREW_SESSION_ERROR";
	readonly agentId?: string;
	constructor(message: string, agentId?: string) {
		super(message);
		this.agentId = agentId;
	}
}

/**
 * Outcome of a crew run attempt.
 * Used by RunTracker and health monitoring for outcome classification.
 */
export type CrewRunOutcome =
	| "ok"       // Completed successfully
	| "cancelled" // Explicitly cancelled by user or API
	| "deadletter" // Agent encountered unrecoverable error
	| "failed"   // Workflow step failed (gate error, etc.)
	| "timeout"  // Exceeded max duration
	| "aborted"; // Operator interrupt (Esc, SIGINT)

/**
 * Classify a thrown error into a CrewRunOutcome.
 * Useful in catch blocks that need to determine run outcome.
 */
export function classifyError(error: unknown): CrewRunOutcome {
	if (error instanceof CrewCancelledError) return "cancelled";
	if (error instanceof CrewTimeoutError) return "timeout";
	if (error instanceof CrewDeadletterError) return "deadletter";
	if (error instanceof CrewAbortError) return "aborted";
	if (error instanceof CrewGateError) return "failed";
	if (error instanceof CrewError) return "failed";
	// Unknown errors → failed
	return "failed";
}

/**
 * Check if an error indicates the run was intentionally interrupted
 * (cancelled, aborted, or timed out) vs a genuine failure.
 */
export function isInterruptError(error: unknown): boolean {
	return error instanceof CrewCancelledError
		|| error instanceof CrewAbortError
		|| error instanceof CrewTimeoutError;
}

/**
 * Check if an error indicates the run failed due to agent malfunction
 * rather than workflow logic or user action.
 */
export function isAgentError(error: unknown): boolean {
	return error instanceof CrewDeadletterError
		|| error instanceof CrewTurnLimitError
		|| error instanceof CrewSessionError;
}