import { DANGEROUS_OBJECT_KEYS } from "./config-validation.ts";
import type { AgentOverrideConfig, PiTeamsConfig } from "./types.ts";

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function mergeConfig(base: PiTeamsConfig, override: PiTeamsConfig): PiTeamsConfig {
	const warnings: string[] = [];
	const merged: PiTeamsConfig = {
		...base,
		...withoutUndefined(override as Record<string, unknown>),
	};
	if (base.autonomous || override.autonomous) {
		merged.autonomous = {
			...(base.autonomous ?? {}),
			...withoutUndefined((override.autonomous ?? {}) as Record<string, unknown>),
		};
	}
	if (base.limits || override.limits) {
		merged.limits = {
			...(base.limits ?? {}),
			...withoutUndefined((override.limits ?? {}) as Record<string, unknown>),
		};
	}
	if (base.runtime || override.runtime) {
		merged.runtime = {
			...(base.runtime ?? {}),
			...withoutUndefined((override.runtime ?? {}) as Record<string, unknown>),
	};
		// F19-1 (Round 19 parity): deep-merge modelFallback like
		// reliability.retryPolicy so a partial override cannot erase base fields
		// (user-wins precedence per key). Assigned only when a side defines it —
		// unlike retryPolicy we avoid a stray `modelFallback: undefined` key so
		// the merged runtime shape stays byte-identical for configs without it.
		if (base.runtime?.modelFallback || override.runtime?.modelFallback) {
			merged.runtime.modelFallback = {
				...(base.runtime?.modelFallback ?? {}),
				...withoutUndefined((override.runtime?.modelFallback ?? {}) as Record<string, unknown>),
			};
		}
	}
	if (base.control || override.control) {
		merged.control = {
			...(base.control ?? {}),
			...withoutUndefined((override.control ?? {}) as Record<string, unknown>),
		};
	}
	if (base.worktree || override.worktree) {
		merged.worktree = {
			...(base.worktree ?? {}),
			...withoutUndefined((override.worktree ?? {}) as Record<string, unknown>),
		};
	}
	if (base.ui || override.ui) {
		merged.ui = {
			...(base.ui ?? {}),
			...withoutUndefined((override.ui ?? {}) as Record<string, unknown>),
		};
	}
	if (base.agents || override.agents) {
		merged.agents = {
			...(base.agents ?? {}),
			...withoutUndefined((override.agents ?? {}) as Record<string, unknown>),
			overrides: {
				...(base.agents?.overrides ?? {}),
				...(withoutUndefined((override.agents?.overrides ?? {}) as Record<string, unknown>) as Record<string, AgentOverrideConfig>),
			},
		};
	}
	if (base.tools || override.tools) {
		merged.tools = {
			...(base.tools ?? {}),
			...withoutUndefined((override.tools ?? {}) as Record<string, unknown>),
		};
	}
	if (base.telemetry || override.telemetry) {
		merged.telemetry = {
			...(base.telemetry ?? {}),
			...withoutUndefined((override.telemetry ?? {}) as Record<string, unknown>),
		};
	}
	if (base.policy || override.policy) {
		merged.policy = {
			...(base.policy ?? {}),
			...withoutUndefined((override.policy ?? {}) as Record<string, unknown>),
		};
	}
	if (base.notifications || override.notifications) {
		merged.notifications = {
			...(base.notifications ?? {}),
			...withoutUndefined((override.notifications ?? {}) as Record<string, unknown>),
		};
	}
	if (base.observability || override.observability) {
		merged.observability = {
			...(base.observability ?? {}),
			...withoutUndefined((override.observability ?? {}) as Record<string, unknown>),
		};
	}
	if (base.reliability || override.reliability) {
		merged.reliability = {
			...(base.reliability ?? {}),
			...withoutUndefined((override.reliability ?? {}) as Record<string, unknown>),
			retryPolicy:
				base.reliability?.retryPolicy || override.reliability?.retryPolicy
					? {
							...(base.reliability?.retryPolicy ?? {}),
							...withoutUndefined((override.reliability?.retryPolicy ?? {}) as Record<string, unknown>),
						}
					: undefined,
		};
	}
	if (base.otlp || override.otlp) {
		merged.otlp = {
			...(base.otlp ?? {}),
			...withoutUndefined((override.otlp ?? {}) as Record<string, unknown>),
			headers: {
				...(base.otlp?.headers ?? {}),
				...(override.otlp?.headers ?? {}),
			},
		};
		if (Object.keys(merged.otlp.headers ?? {}).length === 0) delete merged.otlp.headers;
		// Validate OTLP headers for injection attacks:
		// - Check top-level keys for dangerous prototype pollution patterns
		// - Block ALL control characters except tab (0x09) to prevent header
		//   injection via CR/LF/zero-byte/etc.
		// BUG (Round 28, CRLF injection): the previous range
		//   /[\x00-\x08\x0b\x0c\x0e-\x1f]/ left THREE chars unblocked: tab (0x09,
		//   intentionally allowed), LF (0x0A) AND CR (0x0D). The comment claimed to
		//   "prevent header injection via CR/LF" but CR was never matched, and LF
		//   was explicitly allowed — both are CRLF injection vectors that can split
		//   HTTP headers. Fix: block 0x00-0x08 and 0x0A-0x1F, allowing only tab.
		const invalidHeaders: string[] = [];
		for (const [k, v] of Object.entries(merged.otlp.headers ?? {})) {
			// Check top-level key for dangerous names (only top-level keys are checked)
			const checkKey = (key: string): boolean => {
				const lowerKey = key.toLowerCase();
				if (DANGEROUS_OBJECT_KEYS.has(lowerKey)) return true;
				return false;
			};
			if (checkKey(k)) {
				invalidHeaders.push(k);
				continue;
			}
			// Block any control characters except tab (0x09) in values.
			// Round 28 fix: /[\x00-\x08\x0a-\x1f]/ blocks LF (0x0A) and CR (0x0D) too.
			const valStr = String(v);
			if (/[\x00-\x08\x0a-\x1f]/.test(valStr)) {
				invalidHeaders.push(k);
			}
		}
		if (invalidHeaders.length > 0) {
			delete merged.otlp.headers;
			warnings.push(`OTLP headers blocked due to invalid characters: ${invalidHeaders.join(", ")}`);
		}
	}
	if (merged.agents?.overrides && Object.keys(merged.agents.overrides).length === 0) delete merged.agents.overrides;
	return merged;
}

/** @internal — direct-test seam for Phase 2.2 extraction target (refactor-plan step 1.9c). */
export const __test__mergeConfig = mergeConfig;
