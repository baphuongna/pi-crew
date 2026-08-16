#!/usr/bin/env node
/**
 * CI lint: detect drift between emitted event `type:` literals and the
 * `TEAM_EVENT_TYPES` registry in `src/state/contracts.ts`.
 *
 * Background (improvement-plan-2026-08-10 G11): `TeamEvent.type` is typed
 * `string`, not the exported `TeamEventType` union. As of 2026-08-10 there
 * are ~132 unique `type:` strings emitted via `appendEvent*` across `src/`
 * that are NOT in the 65-entry registry. A typo in any of them silently
 * breaks dedupe filters, SIEM export, and `event-to-metric` mapping.
 *
 * Phase 1 (this script): REPORT-ONLY. Prints a drift table and exits 0 so
 * the existing backlog can be triaged without breaking CI. New additions
 * are visible in the report.
 *
 * Phase 2 (future): once the backlog is migrated, run with `--enforce` to
 * fail CI on any unregistered type. After that, tighten `TeamEvent.type`
 * to `TeamEventType` so the compiler catches drift at the call site.
 *
 * Usage:
 *   node scripts/check-event-types-registry.mjs            # report (exit 0)
 *   node scripts/check-event-types-registry.mjs --enforce  # fail on drift
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const enforce = process.argv.includes("--enforce");

// 1. Parse TEAM_EVENT_TYPES from src/state/contracts.ts (single source of truth).
const contractsPath = path.join(root, "src", "state", "contracts.ts");
const contractsSrc = readFileSync(contractsPath, "utf-8");
const contractsBlock = contractsSrc.match(/export const TEAM_EVENT_TYPES\s*=\s*\[([\s\S]*?)\] as const/);
if (!contractsBlock) {
	console.error("check-event-types-registry: could not find TEAM_EVENT_TYPES in src/state/contracts.ts");
	process.exit(2);
}
const registered = new Set(
	(contractsBlock[1].match(/"([a-z][a-z0-9_.]+)"/g) || []).map((s) => s.replace(/"/g, "")),
);

// 2. Scan src/ for appendEvent* call sites and extract `type:` string literals.
//    Most emit sites span multiple lines:
//        appendEvent(eventsPath, {
//            type: "agent.nudged",
//            ...
//        });
//    so a line-based grep cannot see the `type:` literal. We walk the source
//    in JS, find each `appendEvent<A>*(` token, then scan forward up to a
//    bounded window (15 lines / 800 chars) for a `type:\s*"..."` literal.
//    Only catches LITERAL string types — dynamic types from variables are
//    out of scope; the eventual type-tightening (Phase 2) catches those at
//    compile time.
const APPEND_RE = /\bappendEvent[A-Za-z]*\s*\(/g;
const TYPE_RE = /type:\s*"([a-z][a-z0-9_.]+)"/g;
const WINDOW_LINES = 15;

function listTsFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listTsFiles(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const emitted = new Map(); // type → [{ file, line }]
const tsFiles = listTsFiles(path.join(root, "src"));
for (const file of tsFiles) {
	const src = readFileSync(file, "utf-8");
	const lines = src.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!APPEND_RE.test(lines[i])) continue;
		APPEND_RE.lastIndex = 0;
		const slice = lines.slice(i, i + WINDOW_LINES).join("\n");
		const rel = path.relative(root, file);
		for (const m of slice.matchAll(TYPE_RE)) {
			const t = m[1];
			// `type:` may belong to a nested object (e.g. a tool def inside
			// the data payload). Heuristic: only keep dotted names that look
			// like events (one or more dots, lowercase, no slashes).
			if (!t.includes(".")) continue;
			if (!emitted.has(t)) emitted.set(t, []);
			emitted.get(t).push(`${rel}:${i + 1}`);
		}
	}
}

// 3. Compute drift.
const unregistered = [...emitted.keys()].filter((t) => !registered.has(t)).sort();
const unused = [...registered].filter((t) => !emitted.has(t)).sort();

// 4. Report.
console.log(`event-types-registry: ${registered.size} registered, ${emitted.size} emitted (literal types only).`);
if (unregistered.length > 0) {
	console.log(`\nDRIFT — ${unregistered.length} emitted types NOT in TEAM_EVENT_TYPES (silent to consumers):`);
	for (const t of unregistered.slice(0, 50)) {
		const sites = emitted.get(t);
		console.log(`  ${t}  (${sites.length} site${sites.length === 1 ? "" : "s"}, e.g. ${sites[0]})`);
	}
	if (unregistered.length > 50) console.log(`  ... and ${unregistered.length - 50} more.`);
}
if (unused.length > 0) {
	console.log(`\nSTALE — ${unused.length} registered types have no literal emit site (may be dynamic, dead, or legacy):`);
	for (const t of unused.slice(0, 20)) console.log(`  ${t}`);
	if (unused.length > 20) console.log(`  ... and ${unused.length - 20} more.`);
}

if (enforce && unregistered.length > 0) {
	console.error(`\ncheck-event-types-registry: --enforce failed (${unregistered.length} unregistered types).`);
	console.error("  Add them to TEAM_EVENT_TYPES in src/state/contracts.ts, or fix the typo.");
	process.exit(1);
}

console.log(`\ncheck-event-types-registry: ${enforce ? "ENFORCE mode — clean." : "REPORT mode (run with --enforce to fail CI)."} Exit 0.`);
