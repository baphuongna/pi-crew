import { collectSensitiveConfigPaths } from "../schema/sensitive-config-paths.ts";
import type { ConfigValidationResult, PiTeamsConfig } from "./types.ts";

/**
 * Phase 5.1 (ADR docs/decisions/2026-08-15-schema-driven-sanitize.md): the
 * drop-list is derived from `sensitive: true` marks in the config schema
 * (see src/schema/sensitive-config-paths.ts) instead of being hardcoded.
 *
 * Legacy shape preserved verbatim from the pre-Phase-5.1 implementation:
 * - warning format: `${projectPath}: project-level sensitive config '<dotted>' is ignored; set it in user config to trust it explicitly`
 * - warning order: top-level keys first (executeWorkers, asyncByDefault,
 *   requireCleanWorktreeLeader), then sections runtime → autonomous →
 *   worktree → otlp → agents → tools; newly-marked sections (policy) follow
 *   in schema order. Within a section, keys follow schema property order.
 * - empty-object collapse: a section whose defined keys were all dropped
 *   becomes `undefined`.
 * - worktree/otlp redact via `{ ...section, key: undefined }` (the dropped
 *   key remains as an own `undefined` key) while other sections `delete` it —
 *   pinned by config-sanitize-merge.test.ts.
 * - runtime.requirePlanApproval is NOT schema-marked: it keeps the legacy
 *   conditional drop (only when `=== false`) as an explicit hardcoded
 *   special-case below (ADR "requirePlanApproval exception").
 */

function projectOverrideWarning(projectPath: string, dottedPath: string): string {
	return `${projectPath}: project-level sensitive config '${dottedPath}' is ignored; set it in user config to trust it explicitly`;
}

/** Legacy top-level warning order (kept byte-identical to the pre-5.1 code). */
const TOP_LEVEL_LEGACY_ORDER = ["executeWorkers", "asyncByDefault", "requireCleanWorktreeLeader"] as const;

/** Legacy section processing order; unlisted sections (e.g. policy) follow in schema order. */
const SECTION_LEGACY_ORDER = ["runtime", "autonomous", "worktree", "otlp", "agents", "tools"] as const;

/** Sections where the pre-5.1 code always replaced `sanitized.<section>` with a
 * shallow copy, even when nothing was dropped (runtime/autonomous). */
const LEGACY_ALWAYS_COPY_SECTIONS = new Set<string>(["runtime", "autonomous"]);

/** Sections redacting via assignment (`key: undefined`, own key remains) instead
 * of `delete` — legacy quirk pinned by config-sanitize-merge.test.ts. */
const ASSIGN_REDACT_SECTIONS = new Set<string>(["worktree", "otlp"]);

function groupPathsBySection(dottedPaths: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const dotted of dottedPaths) {
		const separator = dotted.indexOf(".");
		const section = separator === -1 ? "" : dotted.slice(0, separator);
		const key = separator === -1 ? dotted : dotted.slice(separator + 1);
		const bucket = groups.get(section);
		if (bucket) bucket.push(key);
		else groups.set(section, [key]);
	}
	return groups;
}

function sectionProcessingOrder(sections: string[]): string[] {
	return [...sections].sort((a, b) => {
		const rankA = (SECTION_LEGACY_ORDER as readonly string[]).indexOf(a);
		const rankB = (SECTION_LEGACY_ORDER as readonly string[]).indexOf(b);
		// Unlisted sections (new sensitive marks) sort after legacy ones,
		// preserving their schema-walk order (stable sort).
		if (rankA === -1 && rankB === -1) return 0;
		if (rankA === -1) return 1;
		if (rankB === -1) return -1;
		return rankA - rankB;
	});
}

export function sanitizeProjectConfig(projectPath: string, userConfig: PiTeamsConfig, config: PiTeamsConfig): ConfigValidationResult {
	const sanitized: PiTeamsConfig = { ...config };
	const warnings: string[] = [];
	const groups = groupPathsBySection(collectSensitiveConfigPaths());

	const dropTopLevel = (key: string): void => {
		if ((config as Record<string, unknown>)[key] === undefined) return;
		delete (sanitized as Record<string, unknown>)[key];
		warnings.push(projectOverrideWarning(projectPath, key));
	};
	const topLevelKeys = groups.get("") ?? [];
	for (const key of [...topLevelKeys].sort((a, b) => {
		const rankA = (TOP_LEVEL_LEGACY_ORDER as readonly string[]).indexOf(a);
		const rankB = (TOP_LEVEL_LEGACY_ORDER as readonly string[]).indexOf(b);
		if (rankA === -1 && rankB === -1) return 0;
		if (rankA === -1) return 1;
		if (rankB === -1) return -1;
		return rankA - rankB;
	})) {
		dropTopLevel(key);
	}

	const sanitizedRecord = sanitized as Record<string, unknown>;
	const configRecord = config as Record<string, unknown>;
	for (const section of sectionProcessingOrder([...groups.keys()].filter((s) => s !== ""))) {
		const sectionValue = configRecord[section];
		if (sectionValue === undefined || typeof sectionValue !== "object") continue;
		const sectionConfig = { ...(sectionValue as Record<string, unknown>) };
		let changed = false;
		for (const key of groups.get(section) ?? []) {
			if (sectionConfig[key] === undefined) continue;
			if (ASSIGN_REDACT_SECTIONS.has(section)) sectionConfig[key] = undefined;
			else delete sectionConfig[key];
			warnings.push(projectOverrideWarning(projectPath, `${section}.${key}`));
			changed = true;
		}
		// Known exception (ADR): requirePlanApproval is only dropped when the
		// project explicitly disables plan approval (`=== false`).
		if (section === "runtime" && sectionConfig.requirePlanApproval === false) {
			delete sectionConfig.requirePlanApproval;
			warnings.push(projectOverrideWarning(projectPath, "runtime.requirePlanApproval"));
			changed = true;
		}
		if (!changed && !LEGACY_ALWAYS_COPY_SECTIONS.has(section)) continue;
		sanitizedRecord[section] = Object.values(sectionConfig).some((entry) => entry !== undefined) ? sectionConfig : undefined;
	}
	return { config: sanitized, warnings };
}

/** @internal — direct-test seam for Phase 2.2 extraction target (refactor-plan step 1.9c). */
export const __test__sanitizeProjectConfig = sanitizeProjectConfig;
