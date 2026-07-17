import { PiTeamsConfigSchema } from "../schema/config-schema.ts";
import type { PiTeamsConfig } from "./config.ts";

/**
 * A single drift finding between discovered resources and config expectations.
 */
export interface DriftItem {
	kind: "agent" | "team" | "workflow" | "config-key";
	name: string;
	status: "missing" | "extra" | "mismatched";
	expected?: string;
	actual?: string;
	severity: "error" | "warning";
}

/**
 * Summary counts by drift status.
 */
export interface DriftSummary {
	missing: number;
	extra: number;
	mismatched: number;
}

/**
 * Full drift report produced by `detectDrift`.
 */
export interface DriftReport {
	hasDrift: boolean;
	items: DriftItem[];
	summary: DriftSummary;
}

/**
 * Discovered resources passed into the drift detector.
 */
export interface DiscoveredResources {
	agents: string[];
	teams: string[];
	workflows: string[];
}

/**
 * Config references extracted from team roles and workflow steps.
 * Used to compare against discovered resources.
 */
export interface ConfigReferences {
	agents: Set<string>;
	teams: Set<string>;
	workflows: Set<string>;
}

const MAX_CONFIG_KEY_DEPTH = 3;

type ConfigSchemaNode = Record<string, unknown>;

interface SchemaKeyResolution {
	allowed: boolean;
	childSchema?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAlternatives(schema: unknown): ConfigSchemaNode[] {
	if (!isRecord(schema)) return [];
	const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf.flatMap((entry) => schemaAlternatives(entry)) : [];
	return [schema, ...alternatives];
}

function resolveSchemaKey(schema: unknown, key: string): SchemaKeyResolution {
	let sawObjectSchema = false;
	let allowsAdditionalProperties = false;
	const childSchemas: unknown[] = [];

	for (const candidate of schemaAlternatives(schema)) {
		const properties = isRecord(candidate.properties) ? candidate.properties : undefined;
		const patternProperties = isRecord(candidate.patternProperties) ? candidate.patternProperties : undefined;
		if (candidate.type !== "object" && !properties && !patternProperties) continue;
		sawObjectSchema = true;

		if (properties && Object.hasOwn(properties, key)) {
			childSchemas.push(properties[key]);
			continue;
		}

		let matchedPattern = false;
		if (patternProperties) {
			for (const [pattern, childSchema] of Object.entries(patternProperties)) {
				try {
					if (new RegExp(pattern).test(key)) {
						childSchemas.push(childSchema);
						matchedPattern = true;
						break;
					}
				} catch {
					// Schema patterns are trusted constants; an invalid one simply cannot match.
				}
			}
		}
		if (!matchedPattern && candidate.additionalProperties !== false) {
			allowsAdditionalProperties = true;
		}
	}

	return {
		allowed: !sawObjectSchema || childSchemas.length > 0 || allowsAdditionalProperties,
		childSchema: childSchemas[0],
	};
}

/**
 * Recursively compare object keys with their TypeBox schema nodes. Root is
 * depth 0; nested objects are traversed through depth 3, which covers the
 * deepest current config shapes (`goalWrap.<workflow>.verification` and
 * `agents.overrides.<agent>`) without allowing attacker-controlled recursion.
 */
function findUnknownConfigKeyPaths(value: unknown, schema: unknown, depth = 0, path: readonly string[] = []): string[][] {
	if (!isRecord(value) || depth > MAX_CONFIG_KEY_DEPTH) return [];
	const unknownPaths: string[][] = [];
	for (const [key, childValue] of Object.entries(value)) {
		const childPath = [...path, key];
		const resolution = resolveSchemaKey(schema, key);
		if (!resolution.allowed) {
			unknownPaths.push(childPath);
			continue;
		}
		if (resolution.childSchema !== undefined && depth < MAX_CONFIG_KEY_DEPTH) {
			unknownPaths.push(...findUnknownConfigKeyPaths(childValue, resolution.childSchema, depth + 1, childPath));
		}
	}
	return unknownPaths;
}

function isAgentOverrideKeyPath(path: readonly string[]): boolean {
	return path.length === 4 && path[0] === "agents" && path[1] === "overrides";
}

/**
 * Extract all agent, team, and workflow names referenced in a raw config object.
 *
 * Looks at:
 * - `agents.overrides` keys → referenced agent names
 * - Top-level keys that aren't in the schema are ignored (handled separately as config-key drift)
 */
function extractConfigReferences(config: Record<string, unknown>): ConfigReferences {
	const agents = new Set<string>();
	const teams = new Set<string>();
	const workflows = new Set<string>();

	// agents.overrides keys are explicit agent references
	const agentsObj =
		typeof config.agents === "object" && config.agents !== null && !Array.isArray(config.agents)
			? (config.agents as Record<string, unknown>)
			: undefined;
	if (agentsObj) {
		const overrides =
			typeof agentsObj.overrides === "object" && agentsObj.overrides !== null && !Array.isArray(agentsObj.overrides)
				? (agentsObj.overrides as Record<string, unknown>)
				: undefined;
		if (overrides) {
			for (const name of Object.keys(overrides)) {
				agents.add(name);
			}
		}
	}

	return { agents, teams, workflows };
}

/**
 * Detect config drift between discovered resources and the configuration.
 *
 * Checks:
 * 1. **Missing**: resource referenced in config (e.g. agents.overrides) but not discovered → error
 * 2. **Extra**: discovered resource not referenced anywhere in config → warning
 * 3. **Mismatched**: resource exists in both but with structural differences → warning
 * 4. **Config keys**: config keys not present in the schema, recursively through depth 3 → warning
 *
 * For agents: compares against `agents.overrides` in config. Discovered agents not in overrides
 * are NOT considered extra (they may be built-in). Only agents referenced in overrides but not
 * discovered are considered missing.
 *
 * For teams/workflows: the config currently doesn't have explicit team/workflow references,
 * so missing/extra checks rely solely on what resources reference each other.
 */
export function detectDrift(discovered: DiscoveredResources, config: PiTeamsConfig): DriftReport {
	const items: DriftItem[] = [];

	const configRaw = config as Record<string, unknown>;
	const refs = extractConfigReferences(configRaw);

	// --- Agent drift ---
	const discoveredAgentSet = new Set<string>(discovered.agents);

	// Missing: referenced in agents.overrides but not discovered
	for (const agentName of refs.agents) {
		if (!discoveredAgentSet.has(agentName)) {
			items.push({
				kind: "agent",
				name: agentName,
				status: "missing",
				expected: "agent file discovered",
				actual: "not found",
				severity: "error",
			});
		}
	}

	// Extra: discovered agent referenced in overrides doesn't apply here;
	// discovered agents not in overrides are not "extra" since they can be built-in.
	// We only check if the override references a disabled agent that doesn't exist.

	// --- Team drift ---
	// Teams reference agents via roles; check if any role.agent is not in discovered agents
	// This is already handled by validate-resources, so we keep it lightweight here.
	// We do NOT mark teams as "extra" because teams can exist without explicit config references.

	// --- Workflow drift ---
	// Similar to teams — workflows are discovered but not directly referenced in config.
	// No extra/missing checks for workflows from config alone.

	// --- Config-key drift ---
	for (const keyPath of findUnknownConfigKeyPaths(configRaw, PiTeamsConfigSchema)) {
		// Preserve the existing, more specific agent/mismatched finding for
		// agents.overrides.<agent>.<key> instead of reporting the same key twice.
		if (isAgentOverrideKeyPath(keyPath)) continue;
		items.push({
			kind: "config-key",
			name: keyPath.join("."),
			status: "extra",
			expected: `key not in schema`,
			actual: `present in config`,
			severity: "warning",
		});
	}

	// --- Mismatched config-key check ---
	// Check if agents.overrides references exist but have unexpected structure
	if (config.agents?.overrides) {
		for (const [agentName, override] of Object.entries(config.agents.overrides)) {
			if (override && typeof override === "object") {
				const overrideKeys = Object.keys(override as Record<string, unknown>);
				const knownOverrideKeys = new Set(["disabled", "model", "fallbackModels", "thinking", "tools", "skills"]);
				const unknownKeys = overrideKeys.filter((key) => !knownOverrideKeys.has(key));
				if (unknownKeys.length > 0) {
					items.push({
						kind: "agent",
						name: agentName,
						status: "mismatched",
						expected: `override keys from schema: ${[...knownOverrideKeys].join(", ")}`,
						actual: `unknown keys: ${unknownKeys.join(", ")}`,
						severity: "warning",
					});
				}
			}
		}
	}

	// --- Build summary ---
	const missing = items.filter((item) => item.status === "missing").length;
	const extra = items.filter((item) => item.status === "extra").length;
	const mismatched = items.filter((item) => item.status === "mismatched").length;

	return {
		hasDrift: items.length > 0,
		items,
		summary: { missing, extra, mismatched },
	};
}

/**
 * Format a drift report into a human-readable multi-line string.
 */
export function formatDriftReport(report: DriftReport): string {
	if (!report.hasDrift) {
		return "No drift detected.";
	}
	const lines: string[] = [
		`Drift summary: ${report.summary.missing} missing, ${report.summary.extra} extra, ${report.summary.mismatched} mismatched`,
		"",
	];
	for (const item of report.items) {
		const severityTag = item.severity === "error" ? "ERROR" : "WARN";
		const detail = item.expected && item.actual ? ` (expected: ${item.expected}, actual: ${item.actual})` : "";
		lines.push(`- ${severityTag} [${item.kind}] ${item.name}: ${item.status}${detail}`);
	}
	return lines.join("\n");
}
