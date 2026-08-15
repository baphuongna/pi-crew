import { PiTeamsConfigSchema } from "./config-schema.ts";

/**
 * Schema-driven sensitive-config discovery (Phase 5.1, ADR
 * docs/decisions/2026-08-15-schema-driven-sanitize.md).
 *
 * Sensitive fields are marked in `config-schema.ts` via TypeBox Options
 * metadata: `Type.Boolean({ sensitive: true })`. In TypeBox 0.34 the
 * constructor spreads unknown option keys verbatim onto the emitted schema
 * object (`build/cjs/type/create/type.js` CreateType: `options !== undefined
 * ? { ...options, ...schema } : schema`), and `Type.Optional` is a flat
 * spread modifier (`{ ...schema, [OptionalKind]: 'Optional' }`), so the mark
 * lands directly on `properties[key]` and survives Clone/Decode.
 *
 * The walk below collects the dotted paths of every marked property. Marked
 * properties are TERMINAL: Record/Object-valued marked props
 * (`agents.overrides`, `otlp.headers`, `runtime.isolationPolicy`) collapse
 * to a single dotted path instead of being recursed into.
 */

type SchemaLike = {
	sensitive?: unknown;
	properties?: Record<string, SchemaLike>;
	anyOf?: SchemaLike[];
} & Record<string, unknown>;

function isMarkedSensitive(property: SchemaLike): boolean {
	if (property.sensitive === true) return true;
	// Defensive: a mark placed on a Union *member* rather than the outermost
	// property schema (the recommended form) still counts. Not used by the
	// current config schema; guards future editors.
	const members = property.anyOf;
	if (Array.isArray(members) && members.some((member) => member.sensitive === true)) return true;
	return false;
}

function walkProperties(schema: SchemaLike, prefix: string, out: string[]): void {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object") return;
	for (const [key, property] of Object.entries(properties)) {
		if (!property || typeof property !== "object") continue;
		const dotted = prefix === "" ? key : `${prefix}.${key}`;
		if (isMarkedSensitive(property)) {
			out.push(dotted);
			continue;
		}
		// `Type.Optional` needs no unwrapping in 0.34 (flat spread — the mark
		// and `.properties` sit on the property schema itself). Union members
		// are visited defensively for nested Object schemas.
		const branches: SchemaLike[] = Array.isArray(property.anyOf) ? property.anyOf : [property];
		for (const branch of branches) {
			if (branch && typeof branch === "object" && branch.properties) walkProperties(branch, dotted, out);
		}
	}
}

/** Dotted paths of every `sensitive: true`-marked field in the config schema
 * (top-level keys unprefixed, nested keys as `section.key`). Order follows
 * schema property declaration order. */
export function collectSensitiveConfigPaths(schema: SchemaLike = PiTeamsConfigSchema as SchemaLike): string[] {
	const out: string[] = [];
	walkProperties(schema, "", out);
	return out;
}
