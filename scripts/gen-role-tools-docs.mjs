#!/usr/bin/env node
// Quick Win 17 (Pattern 17 — schema-driven docs): render the role→tools table
// from the single source of truth `ROLE_TOOL_CONFIGS` (+ READ_ONLY/WRITE roles).
// Run: `node scripts/gen-role-tools-docs.mjs`.
// Output (docs/role-tools.md) is deliberately NOT pinned by the sync-test —
// re-run this script after editing role-tools.ts. The sync-test pins
// agents/*.md frontmatter, not this generated doc.

import { ROLE_TOOL_CONFIGS, getRestrictedRoles } from "../src/config/role-tools.ts";
import { permissionForRole } from "../src/runtime/role-permission.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const header = `# Role → Tools reference (generated)

> **Auto-generated** from \`src/config/role-tools.ts\` (\`ROLE_TOOL_CONFIGS\`) and
> \`src/runtime/role-permission.ts\`. Do not edit by hand — run
> \`node --experimental-strip-types scripts/gen-role-tools-docs.mjs\`.
> The enforced source of truth is the code; this doc is a rendered view. The
> \`agents/*.md\` frontmatter is kept in sync by \`test/unit/role-tools-docs-sync.test.ts\`.

| Role | Permission | Tools (allowlist) | Excluded | Scratchpad |
|---|---|---|---|---|
`;

function cell(v) {
	if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
	if (v === true) return "✅";
	if (v === false || v === undefined || v === null || v === "") return "—";
	return String(v);
}

const lines = [header];
for (const role of Object.keys(ROLE_TOOL_CONFIGS)) {
	const cfg = ROLE_TOOL_CONFIGS[role];
	const perm = permissionForRole(role);
	lines.push(
		`| \`${role}\` | ${perm} | ${cell(cfg.tools)} | ${cell(cfg.excludeTools)} | ${cfg.scratchpad ? "✅" : "—"} |\n`,
	);
}

const out = lines.join("");
const outPath = path.resolve(path.dirname(new URL("", import.meta.url).pathname), "..", "docs", "role-tools.md");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${Object.keys(ROLE_TOOL_CONFIGS).length} roles)`);
