import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startChildBrokerClient } from "../runtime/crew-broker-child.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";

export const PI_TEAMS_INHERIT_PROJECT_CONTEXT_ENV = "PI_TEAMS_INHERIT_PROJECT_CONTEXT";
export const PI_TEAMS_INHERIT_SKILLS_ENV = "PI_TEAMS_INHERIT_SKILLS";
export const PI_CREW_INHERIT_PROJECT_CONTEXT_ENV = "PI_CREW_INHERIT_PROJECT_CONTEXT";
export const PI_CREW_INHERIT_SKILLS_ENV = "PI_CREW_INHERIT_SKILLS";
const PI_CREW_MAX_OUTPUT_ENV = "PI_CREW_MAX_OUTPUT";
const PI_CREW_STEERING_FILE_ENV = "PI_CREW_STEERING_FILE";

const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

// ── FIX-02: Steering content sanitization limits ──────────────────────────
// Bounded to keep a malformed/malicious steer entry from blowing up the
// worker's prompt budget or smuggling control sequences into the agent.
const MAX_STEER_MESSAGE_LENGTH = 4096;
const MAX_STEER_MESSAGE_NEWLINES = 50;
// C0 control characters minus the printable whitespace (\t \n \r). These
// are the bytes most useful for ANSI escapes, terminal-control tricks, and
// NUL-injection attacks when steer content reaches the worker's UI.
const STEER_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export interface SteerSanitizeResult {
	valid: boolean;
	reason?: string;
	message?: string;
}

export interface SteerEntry {
	type?: string;
	message?: string;
}

/**
 * Validate a single steering-file entry before forwarding it to
 * `pi.sendMessage`. FIX-02: reject oversized payloads, excessive newlines,
 * or control characters that could be used to confuse the worker UI.
 */
export function sanitizeSteerMessage(entry: SteerEntry): SteerSanitizeResult {
	const message = entry.message;
	if (typeof message !== "string" || message.length === 0) {
		return { valid: false, reason: "missing-or-empty-message" };
	}
	if (message.length > MAX_STEER_MESSAGE_LENGTH) {
		return { valid: false, reason: `message-too-long:${message.length}` };
	}
	const newlineCount = (message.match(/\n/g) ?? []).length;
	if (newlineCount > MAX_STEER_MESSAGE_NEWLINES) {
		return { valid: false, reason: `too-many-newlines:${newlineCount}` };
	}
	if (STEER_CONTROL_CHAR_PATTERN.test(message)) {
		return { valid: false, reason: "contains-control-characters" };
	}
	return { valid: true, message };
}

// ── FIX-03: Steering file path containment validation ─────────────────────
// The steering file path is inherited from the parent via env, so we
// defensively re-validate it before the first read to catch symlink
// redirection or paths that escape the session's artifacts root.
export interface SteeringFileValidation {
	valid: boolean;
	reason?: string;
	resolvedPath?: string;
}

/**
 * Validate `PI_CREW_STEERING_FILE` before first read. FIX-03:
 *   1. `lstatSync` rejects a symlink at the steering file itself.
 *   2. `resolveRealContainedPath` walks the ancestor chain with O_NOFOLLOW
 *      to reject any symlinked parent (e.g. a redirected `artifactsRoot`)
 *      and to verify the resolved path stays inside the derived artifacts
 *      root (`<artifactsRoot>/steering/<taskId>.jsonl` → `<artifactsRoot>`).
 *
 * Returns `{ valid: false }` with a reason on any violation. Callers must
 * log + skip steering on failure rather than abort the worker.
 */
export function validateSteeringFile(steeringFile: string): SteeringFileValidation {
	try {
		const lst = fs.lstatSync(steeringFile);
		if (lst.isSymbolicLink()) {
			return { valid: false, reason: "steering-file-is-symlink" };
		}
	} catch (error) {
		const errCode = (error as NodeJS.ErrnoException).code;
		if (errCode && errCode !== "ENOENT") {
			return { valid: false, reason: `lstat-failed:${errCode}` };
		}
	}
	// Layout invariant from task-runner.ts: `steeringFile` is built as
	// `<artifactsRoot>/steering/<taskId>.jsonl`. We don't trust the caller
	// to pass `artifactsRoot`, so derive it as 2 levels up. `resolveRealContainedPath`
	// then enforces both containment AND ancestor-symlink safety in one shot.
	const artifactsRoot = path.resolve(steeringFile, "..", "..");
	try {
		const resolved = resolveRealContainedPath(artifactsRoot, steeringFile);
		return { valid: true, resolvedPath: resolved };
	} catch (error) {
		return {
			valid: false,
			reason: `path-validation-failed:${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no") return false;
	// Ambiguous value — treat as undefined so callers apply their default.
	return undefined;
}

function readBooleanEnvAny(...names: string[]): boolean | undefined {
	for (const name of names) {
		const value = readBooleanEnv(name);
		if (value !== undefined) return value;
	}
	return undefined;
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) endIndex = index;
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function rewriteTeamWorkerPrompt(prompt: string, options: { inheritProjectContext: boolean; inheritSkills: boolean }): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) rewritten = stripProjectContext(rewritten);
	if (!options.inheritSkills) rewritten = stripInheritedSkills(rewritten);
	return rewritten;
}

export default function registerPiTeamsPromptRuntime(pi: ExtensionAPI): void {
	// ── Feature 1: maxTokens cap ──────────────────────────────────────────
	// Cap output tokens per API call for background workers. Reads
	// PI_CREW_MAX_OUTPUT_TOKENS env (set by pi-args.ts from agent.maxTokens).
	const maxTokensEnv = process.env[PI_CREW_MAX_OUTPUT_ENV];
	const maxTokensCap = maxTokensEnv ? Number.parseInt(maxTokensEnv, 10) : undefined;
	if (maxTokensCap && maxTokensCap > 0) {
		pi.on("before_provider_request", (event) => {
			const payload = event.payload as Record<string, unknown> | undefined;
			if (!payload || typeof payload !== "object") return;
			// Cap both OpenAI-style max_tokens and Anthropic-style max_tokens
			if (typeof payload.max_tokens === "number" && payload.max_tokens > maxTokensCap) {
				payload.max_tokens = maxTokensCap;
			}
			// Also cap newer field names used by some providers
			if (typeof payload.max_completion_tokens === "number" && payload.max_completion_tokens > maxTokensCap) {
				payload.max_completion_tokens = maxTokensCap;
			}
			if (typeof payload.max_output_tokens === "number" && payload.max_output_tokens > maxTokensCap) {
				payload.max_output_tokens = maxTokensCap;
			}
			const generationConfig = payload.generationConfig as Record<string, unknown> | undefined;
			if (
				generationConfig &&
				typeof generationConfig.max_output_tokens === "number" &&
				generationConfig.max_output_tokens > maxTokensCap
			) {
				generationConfig.max_output_tokens = maxTokensCap;
			}
		});
	}

	// ── Feature 2: real-time steering ──────────────────────────────────────
	// Poll the steering JSONL file for new steer messages. The parent (team
	// tool) writes steers here in real-time; this reader injects them into
	// the active session via pi.sendMessage with deliverAs:"steer".
	const steeringFile = process.env[PI_CREW_STEERING_FILE_ENV];
	if (steeringFile) {
		// FIX-03: validate the steering file path once before first read.
		const validation = validateSteeringFile(steeringFile);
		if (!validation.valid) {
			logInternalError(
				"prompt-runtime.steering-file-rejected",
				new Error(validation.reason ?? "steering-file-validation-failed"),
				`path=${steeringFile}`,
				"warn",
			);
		} else {
			const safeSteeringFile = validation.resolvedPath ?? steeringFile;
			let lastOffset = 0;
			const pollSteering = (): void => {
				try {
					const stat = fs.statSync(safeSteeringFile, { throwIfNoEntry: false });
					if (!stat || stat.size <= lastOffset) return;
					const fd = fs.openSync(safeSteeringFile, "r");
					try {
						const buf = Buffer.alloc(stat.size - lastOffset);
						fs.readSync(fd, buf, 0, buf.length, lastOffset);
						lastOffset = stat.size;
						const lines = buf.toString("utf8").split("\n").filter(Boolean);
						for (const line of lines) {
							try {
								const entry = JSON.parse(line) as SteerEntry;
								if (entry.type !== "steer") continue;
								// FIX-02: sanitize each steer entry before forwarding
								// to pi.sendMessage. Reject oversized payloads,
								// excessive newlines, and control characters.
								const sanitized = sanitizeSteerMessage(entry);
								if (!sanitized.valid || sanitized.message === undefined) {
									logInternalError(
										"prompt-runtime.steer-rejected",
										new Error(sanitized.reason ?? "steer-sanitization-failed"),
										`line-preview=${line.slice(0, 64)}`,
										"warn",
									);
									continue;
								}
								pi.sendMessage(
									{ customType: "crew-steer", content: sanitized.message, display: false },
									{ deliverAs: "steer" },
								);
							} catch {
								// Malformed line — skip
							}
						}
					} finally {
						try {
							fs.closeSync(fd);
						} catch {
							/* already closed */
						}
					}
				} catch {
					// File doesn't exist yet or read error — will retry next tick
				}
			};
			const timer = setInterval(pollSteering, 500);
			timer.unref?.();
		}
	}

	// ── Feature 2b: broker push steering (opt-in, layered on the file poll) ──
	// When the parent injected broker credentials, connect a broker client and
	// deliver pushed steers with the SAME sanitize + pi.sendMessage path as the
	// file poll above. The file poll remains the durable fallback; a broker
	// connect failure is invisible to the worker.
	const brokerHandle = startChildBrokerClient({
		onSteer: (rawMessage) => {
			const sanitized = sanitizeSteerMessage({ type: "steer", message: rawMessage });
			if (!sanitized.valid || sanitized.message === undefined) {
				logInternalError(
					"prompt-runtime.broker-steer-rejected",
					new Error(sanitized.reason ?? "steer-sanitization-failed"),
					undefined,
					"warn",
				);
				return;
			}
			pi.sendMessage({ customType: "crew-steer", content: sanitized.message, display: false }, { deliverAs: "steer" });
		},
	});
	// Close the broker connection on session shutdown to avoid leaking the
	// persistent socket / reconnect timer. Fire-and-forget: the socket is
	// already .unref()'d so it never blocks event-loop exit; errors are
	// swallowed because teardown failures during shutdown are harmless.
	pi.on("session_shutdown", () => {
		void brokerHandle.close().catch(() => {});
	});

	// ── Prompt rewriting (existing) ────────────────────────────────────────
	pi.on("before_agent_start", (event) => {
		const inheritProjectContext = readBooleanEnvAny(PI_CREW_INHERIT_PROJECT_CONTEXT_ENV, PI_TEAMS_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnvAny(PI_CREW_INHERIT_SKILLS_ENV, PI_TEAMS_INHERIT_SKILLS_ENV);
		if (inheritProjectContext === undefined && inheritSkills === undefined) return;
		const rewritten = rewriteTeamWorkerPrompt(event.systemPrompt, {
			inheritProjectContext: inheritProjectContext ?? true,
			inheritSkills: inheritSkills ?? true,
		});
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
