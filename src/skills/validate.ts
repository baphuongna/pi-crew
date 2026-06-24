/**
 * SKILL.md frontmatter validation (L3 of deer-flow→pi-crew plan).
 *
 * Parses a SKILL.md's YAML frontmatter and validates it against the
 * `ALLOWED_SKILL_PROPS` whitelist using HYBRID policy:
 *   - HARD errors (missing/malformed `name`/`description`, type mismatches,
 *     read/parse failures): EXCLUDE the skill from `discoverSkills()`.
 *   - SOFT warnings (unknown props, missing `name` derived from directory):
 *     KEEP the skill; surface via `getLastDiscoveryDiagnostics()`.
 *
 * YAML parsing uses the `yaml` package (^2.9.0). It is now a direct dep;
 * before L3 it was only transitively available through
 * `@earendil-works/pi-coding-agent`. Adding it as a direct dep is justified by:
 *   - Replaces a fragile line-prefix parser that broke on multi-line folded
 *     scalars (`description: >`), quoted strings, and nested YAML.
 *   - Standard lib (eemeli/yaml), MIT, actively maintained.
 *   - Already in the lockfile at the same version → zero install cost.
 *   - Frontmatter is small and well-formed; YAML parsing cost is negligible.
 *
 * The validator runs once per skill at discovery. Discovery is already cached
 * (`CACHE_TTL_MS = 30_000` in discover-skills.ts) so the validation cost is
 * bounded regardless of how many skills exist.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "yaml";

/**
 * Properties allowed in SKILL.md frontmatter.
 *
 * Why this list:
 *   - `name`, `description` are the contract used by pi-crew's prompt
 *     rendering (see src/runtime/skill-instructions.ts) and capability
 *     inventory. Both are HARD-required.
 *   - `license`, `allowed-tools`, `compatibility`, `version`, `author` are
 *     common metadata; we surface but don't enforce content beyond type.
 *   - `metadata` is a free-form key/value bag (mirrors deer-flow `validation.py`).
 *
 * Unknown props (e.g. bundled skills' `origin`, `triggers`) are SOFT-warned,
 * not rejected — see HYBRID policy in the module docstring.
 */
export const ALLOWED_SKILL_PROPS = new Set<string>([
	"name",
	"description",
	"license",
	"allowed-tools",
	"metadata",
	"compatibility",
	"version",
	"author",
]);

/** Hyphen-case name regex (Anthropic Agent Skills spec compatible). */
const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const VERSION_REGEX = /^\d+\.\d+(\.\d+)?(-[A-Za-z0-9.-]+)?$/;

/**
 * Structured error so callers (capability inventory, logs) can present
 * actionable diagnostics instead of silently dropping malformed skills.
 */
export interface SkillValidationError {
	/** Absolute path to the skill directory. */
	path: string;
	/** Field name (e.g. "name", "description", "<unknown-prop>") or "frontmatter" for parse errors. */
	field: string;
	/** Human-readable reason. Safe to surface in capability listings. */
	reason: string;
	/** Severity — "error" excludes the skill; "warn" keeps it. */
	severity: "error" | "warn";
}

/**
 * Validated manifest exposes the parsed frontmatter fields in a typed shape.
 * Only present for valid skills; undefined for invalid ones.
 */
export interface ValidatedSkillManifest {
	name: string;
	description: string;
	license?: string;
	allowedTools?: string[];
	metadata?: Record<string, unknown>;
	compatibility?: string;
	version?: string;
	author?: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: SkillValidationError[];
	manifest?: ValidatedSkillManifest;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Returns an empty object when there is no frontmatter block. Parsing errors
 * surface as `{ ok: false }` rather than throwing — discovery must remain
 * exception-safe.
 */
export function parseSkillFrontmatter(
	content: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return { ok: true, data: {} };
	try {
		const parsed = yaml.parse(match[1]);
		if (parsed === null || parsed === undefined) return { ok: true, data: {} };
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, error: "Frontmatter must be a YAML mapping, not a scalar or list." };
		}
		return { ok: true, data: parsed as Record<string, unknown> };
	} catch (e) {
		return { ok: false, error: `YAML parse error: ${(e as Error).message}` };
	}
}

function hard(path: string, field: string, reason: string): SkillValidationError {
	return { path, field, reason, severity: "error" };
}

function warn(path: string, field: string, reason: string): SkillValidationError {
	return { path, field, reason, severity: "warn" };
}

/**
 * Validate a single skill's frontmatter.
 *
 * @param skillDir Absolute path to the skill directory (must contain SKILL.md).
 * @returns ValidationResult — `ok` is true when there are no HARD errors.
 *          `errors[]` always lists ALL violations (HARD + SOFT).
 *
 * Back-compat: when `name` is missing from frontmatter, the validator
 * DERIVES it from the directory name and emits a SOFT warning. Bundled
 * pi-crew skills always set `name` explicitly, so the warning is informational.
 */
export function validateSkillFrontmatter(skillDir: string): ValidationResult {
	const errors: SkillValidationError[] = [];
	const skillMdPath = path.join(skillDir, "SKILL.md");
	const derivedName = path.basename(skillDir);

	let content: string;
	try {
		content = fs.readFileSync(skillMdPath, "utf-8");
	} catch (e) {
		errors.push(hard(skillDir, "SKILL.md", `Cannot read SKILL.md: ${(e as Error).message}`));
		return { ok: false, errors };
	}

	const parsed = parseSkillFrontmatter(content);
	if (!parsed.ok) {
		errors.push(hard(skillDir, "frontmatter", parsed.error));
		return { ok: false, errors };
	}

	const data = parsed.data;

	// No frontmatter at all → back-compat: derive everything from the
	// directory. Pre-L3 skills shipped without frontmatter and we don't want
	// to regress them. Surface a SOFT warning so authors know to add YAML.
	if (Object.keys(data).length === 0) {
		errors.push(warn(skillDir, "frontmatter", "No frontmatter block; deriving name from directory and leaving description empty."));
		return {
			ok: true,
			errors,
			manifest: { name: derivedName, description: "" },
		};
	}

	// ── name: HARD if type/length/regex bad; SOFT if missing (derive from dir)
	const nameRaw = data.name;
	let resolvedName = derivedName;
	if (nameRaw === undefined || nameRaw === null) {
		errors.push(warn(skillDir, "name", `Frontmatter 'name' missing; using directory name "${derivedName}" as fallback. Add explicit 'name' to silence this.`));
	} else if (typeof nameRaw !== "string") {
		errors.push(hard(skillDir, "name", `'name' must be a string, got ${typeof nameRaw}.`));
	} else if (nameRaw.length === 0) {
		errors.push(hard(skillDir, "name", "'name' is empty."));
	} else if (nameRaw.length > NAME_MAX_LEN) {
		errors.push(hard(skillDir, "name", `'name' exceeds ${NAME_MAX_LEN} chars (got ${nameRaw.length}).`));
	} else if (!NAME_REGEX.test(nameRaw)) {
		errors.push(hard(skillDir, "name", `'name' must be hyphen-case lowercase (a-z, 0-9, single hyphens); got "${nameRaw}".`));
	} else {
		resolvedName = nameRaw;
	}

	// ── description: HARD required
	const descRaw = data.description;
	if (descRaw === undefined || descRaw === null) {
		errors.push(hard(skillDir, "description", "Required field 'description' is missing."));
	} else if (typeof descRaw !== "string") {
		errors.push(hard(skillDir, "description", `'description' must be a string, got ${typeof descRaw}.`));
	} else if (descRaw.length > DESCRIPTION_MAX_LEN) {
		errors.push(hard(skillDir, "description", `'description' exceeds ${DESCRIPTION_MAX_LEN} chars (got ${descRaw.length}).`));
	} else if (descRaw.includes("<") || descRaw.includes(">")) {
		errors.push(hard(skillDir, "description", `'description' must not contain '<' or '>' (prompt-safety).`));
	}

	// ── OPTIONAL: license
	if (data.license !== undefined && typeof data.license !== "string") {
		errors.push(hard(skillDir, "license", `'license' must be a string.`));
	}

	// ── OPTIONAL: allowed-tools
	if (data["allowed-tools"] !== undefined) {
		const at = data["allowed-tools"];
		if (!Array.isArray(at) || !at.every((x) => typeof x === "string")) {
			errors.push(hard(skillDir, "allowed-tools", `'allowed-tools' must be an array of strings.`));
		}
	}

	// ── OPTIONAL: metadata
	if (data.metadata !== undefined) {
		const m = data.metadata;
		if (typeof m !== "object" || m === null || Array.isArray(m)) {
			errors.push(hard(skillDir, "metadata", `'metadata' must be an object.`));
		}
	}

	// ── OPTIONAL: compatibility
	if (data.compatibility !== undefined && typeof data.compatibility !== "string") {
		errors.push(hard(skillDir, "compatibility", `'compatibility' must be a string.`));
	}

	// ── OPTIONAL: version
	if (data.version !== undefined) {
		if (typeof data.version !== "string" || !VERSION_REGEX.test(data.version)) {
			errors.push(hard(skillDir, "version", `'version' must be a semver string (e.g. "1.2.3" or "1.2.3-beta.1"); got "${String(data.version)}".`));
		}
	}

	// ── OPTIONAL: author
	if (data.author !== undefined && typeof data.author !== "string") {
		errors.push(hard(skillDir, "author", `'author' must be a string.`));
	}

	// ── UNKNOWN PROPS: SOFT warn (HYBRID policy)
	for (const key of Object.keys(data)) {
		if (!ALLOWED_SKILL_PROPS.has(key)) {
			errors.push(warn(skillDir, `<unknown-prop:${key}>`, `Unknown property '${key}' is not in the whitelist; keeping for forward-compat.`));
		}
	}

	// ── Result: ok iff no HARD errors
	const hasHardError = errors.some((e) => e.severity === "error");
	if (!hasHardError) {
		const manifest: ValidatedSkillManifest = {
			name: resolvedName,
			description: typeof data.description === "string" ? data.description : "",
		};
		if (typeof data.license === "string") manifest.license = data.license;
		if (Array.isArray(data["allowed-tools"])) {
			manifest.allowedTools = (data["allowed-tools"] as unknown[]).filter((x) => typeof x === "string") as string[];
		}
		if (typeof data.metadata === "object" && data.metadata !== null && !Array.isArray(data.metadata)) {
			manifest.metadata = data.metadata as Record<string, unknown>;
		}
		if (typeof data.compatibility === "string") manifest.compatibility = data.compatibility;
		if (typeof data.version === "string") manifest.version = data.version;
		if (typeof data.author === "string") manifest.author = data.author;
		return { ok: true, errors, manifest };
	}

	return { ok: false, errors };
}
