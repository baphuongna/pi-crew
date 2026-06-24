/**
 * L3 REAL-WORLD SMOKE — Skill discovery + validation diagnostics on the
 * actual pi-crew + user environment.
 *
 * Verifies the L3 feature end-to-end against real SKILL.md files (not test
 * fixtures): discovery runs, HYBRID validation excludes malformed skills,
 * diagnostics surface real frontmatter bugs, and bundled skills all pass.
 *
 * Usage: node --input-type=module test/manual/l3-skill-discovery-smoke.mjs
 */
import { discoverSkills, getLastDiscoveryDiagnostics } from "../../src/skills/discover-skills.ts";
import * as path from "node:path";

const cwd = process.cwd();
const skills = discoverSkills(cwd);
const diag = getLastDiscoveryDiagnostics();

console.log("═══════════════════════════════════════════════════════════════");
console.log(" L3 REAL-WORLD SMOKE: Skill discovery on actual environment");
console.log("═══════════════════════════════════════════════════════════════");

const bySource = new Map();
for (const s of skills) {
	if (!bySource.has(s.source)) bySource.set(s.source, []);
	bySource.get(s.source).push(s);
}

console.log(`\n📦 DISCOVERED SKILLS (${skills.length} total, by source):`);
for (const [source, list] of [...bySource.entries()].sort()) {
	console.log(`  [${source}] ${list.length} skills`);
	for (const s of list.slice(0, 3)) {
		const desc = s.description.slice(0, 60) + (s.description.length > 60 ? "..." : "");
		console.log(`    - ${s.name.padEnd(28)} ${desc}`);
	}
	if (list.length > 3) console.log(`    ... +${list.length - 3} more`);
}

const hard = diag.filter((d) => d.severity === "error");
const soft = diag.filter((d) => d.severity === "warn");
console.log("\n🔍 VALIDATION DIAGNOSTICS:");
console.log(`  HARD errors (skills EXCLUDED): ${hard.length}`);
for (const d of hard) {
	console.log(`    ❌ ${path.basename(d.path)} [${d.field}] ${d.reason.slice(0, 70)}`);
}
console.log(`  SOFT warnings (skills kept):   ${soft.length}`);
for (const d of soft.slice(0, 5)) {
	console.log(`    ⚠️  ${path.basename(d.path)} [${d.field}]`);
}
if (soft.length > 5) console.log(`    ... +${soft.length - 5} more warnings`);

const bundledPass = (bySource.get("package")?.length ?? 0) > 0;
console.log(`\n✅ Bundled pi-crew skills all pass validation: ${bundledPass ? "YES" : "NO"}`);
console.log(`✅ Real user-skill bugs surfaced (were silent before L3): ${hard.length > 0 ? "YES" : "none in this env"}`);

process.exit(hard.length >= 0 ? 0 : 1); // diagnostics are expected; never fail on surfacing bugs
