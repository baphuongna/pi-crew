import type { OperationTerminalEvidence } from "../../state/types.ts";

export type CancellationReasonCode =
	| "caller_cancelled"
	| "leader_interrupted"
	| "provider_timeout"
	| "worker_timeout"
	| "tool_timeout"
	| "shutdown"
	| "unknown";

export interface CancellationReason {
	code: CancellationReasonCode;
	message: string;
	cause?: unknown;
}

export function buildSyntheticTerminalEvidence(
	operation: "worker" | "tool" | "model",
	reason: CancellationReason,
	startedAt?: string,
): OperationTerminalEvidence {
	return {
		operation,
		status: "cancelled",
		startedAt,
		finishedAt: new Date().toISOString(),
		reason,
	};
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
	"caller_cancelled",
	"leader_interrupted",
	"provider_timeout",
	"worker_timeout",
	"tool_timeout",
	"shutdown",
	"unknown",
]);

export class CrewCancellationError extends Error {
	readonly reason: CancellationReason;

	constructor(reason: CancellationReason) {
		super(reason.message);
		this.name = "CrewCancellationError";
		this.reason = reason;
	}
}

function reasonFromString(value: string): CancellationReason {
	const trimmed = value.trim();
	if (KNOWN_CODES.has(trimmed))
		return {
			code: trimmed as CancellationReasonCode,
			message: `Cancelled: ${trimmed}`,
		};
	return {
		code: "caller_cancelled",
		message: trimmed || "Cancelled by caller.",
	};
}

export function cancellationReasonFromUnknown(value: unknown): CancellationReason {
	if (value instanceof CrewCancellationError) return value.reason;
	if (value instanceof Error)
		return {
			code: "caller_cancelled",
			message: value.message || "Cancelled by caller.",
			cause: value,
		};
	if (typeof value === "string") return reasonFromString(value);
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as {
			code?: unknown;
			reason?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		const rawCode = typeof record.code === "string" ? record.code : typeof record.reason === "string" ? record.reason : undefined;
		const code = rawCode && KNOWN_CODES.has(rawCode) ? (rawCode as CancellationReasonCode) : "caller_cancelled";
		const message = typeof record.message === "string" && record.message.trim() ? record.message.trim() : `Cancelled: ${code}`;
		return { code, message, cause: record.cause ?? value };
	}
	return { code: "caller_cancelled", message: "Cancelled by caller." };
}

export function cancellationReasonFromSignal(signal: AbortSignal | undefined): CancellationReason {
	return cancellationReasonFromUnknown(signal?.reason);
}

export function cancellationErrorFromSignal(signal: AbortSignal | undefined): CrewCancellationError {
	return new CrewCancellationError(cancellationReasonFromSignal(signal));
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw cancellationErrorFromSignal(signal);
}
