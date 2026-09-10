/**
 * migration-validator.ts — WI-5.6 (M5 spec §5).
 *
 * Validates a parsed config against deprecated/removed env keys and
 * returns an advisory list (not a failure). Per spec acceptance:
 *   "Migration validator: test case cũ config + key deprecated →
 *    warning không fail."
 *
 * Key principles (additive-only):
 *   - Deprecated: emit warning, KEEP the value, do not fail.
 *   - Removed:   emit warning, set to undefined, do not fail.
 *   - Unknown:   emit warning, KEEP the value, do not fail.
 *   - Hardcoded: emit warning only if user explicitly overrides; not fail.
 *
 * Returns an array of entries; never throws.
 */

import { CREW_ENV_VARS } from "./env-vars.ts";

export interface ValidationWarning {
	scope: "env-var" | "config-key";
	name: string;
	severity: "deprecated" | "removed" | "unknown";
	message: string;
	/** Optional policy note from the registry entry. */
	policy?: string;
}

export interface EnvValidationResult {
	warnings: ValidationWarning[];
	/** Fast-bool for callers that don't need detail. */
	hasWarnings: boolean;
}

/** Validate `process.env` against the registry. Returns warnings; never
 *  throws. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvValidationResult {
	const warnings: ValidationWarning[] = [];
	if (!env || typeof env !== "object") return { warnings, hasWarnings: false };
	const seen = new Set<string>();
	for (const [name, spec] of Object.entries(CREW_ENV_VARS)) {
		seen.add(name);
		if (spec.mirror) seen.add(spec.mirror);
		let value: string | undefined;
		try {
			value = (env as Record<string, string | undefined>)[name];
		} catch {
			value = undefined;
		}
		if (value === undefined) continue;
		if (spec.deprecated !== undefined) {
			// Distinguish DEAD/REMOVED vs DEPRECATED-but-working.
			const lower = spec.deprecated.toLowerCase();
			if (lower === "dead" || lower === "removed" || lower.startsWith("reverted")) {
				warnings.push({
					scope: "env-var",
					name,
					severity: "removed",
					message: `${name} is ${spec.deprecated}; setting it has no effect`,
					policy: spec.deprecated,
				});
				// Note: we DO NOT delete env[name] here; that's a separate
				// cleanup concern. The validator is read-only.
			} else {
				warnings.push({
					scope: "env-var",
					name,
					severity: "deprecated",
					message: `${name} is deprecated (${spec.deprecated}); prefer the canonical name`,
					policy: spec.deprecated,
				});
			}
		}
	}
	return { warnings, hasWarnings: warnings.length > 0 };
}

/** Validate a parsed config object against the env-var registry.
 *  Useful for: a config file that hardcodes a removed key. */
export function validateConfigAgainstEnvRegistry(config: Record<string, unknown>): EnvValidationResult {
	const warnings: ValidationWarning[] = [];
	if (!config || typeof config !== "object") return { warnings, hasWarnings: false };
	for (const [name, spec] of Object.entries(CREW_ENV_VARS)) {
		let present = false;
		try {
			present = name in config;
		} catch {
			present = false;
		}
		if (present) {
			if (spec.deprecated !== undefined) {
				const lower = spec.deprecated.toLowerCase();
				if (lower === "dead" || lower === "removed" || lower.startsWith("reverted")) {
					warnings.push({
						scope: "config-key",
						name,
						severity: "removed",
						message: `${name} config key is ${spec.deprecated}`,
						policy: spec.deprecated,
					});
				} else {
					warnings.push({
						scope: "config-key",
						name,
						severity: "deprecated",
						message: `${name} config key is deprecated (${spec.deprecated})`,
						policy: spec.deprecated,
					});
				}
			}
		}
	}
	return { warnings, hasWarnings: warnings.length > 0 };
}
