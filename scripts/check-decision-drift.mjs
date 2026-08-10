#!/usr/bin/env node
/**
 * CI gate: detect decision-record drift.
 *
 * Scans `docs/decisions/*.md` for `PI_CREW_*` / `PI_TEAMS_*` env-var
 * tokens and asserts each token appears at least once in `src/`. Catches
 * the ADR-vs-code drift class (e.g. an ADR references
 * `PI_CREW_SESSION_DEPTH` while the implementation uses `PI_CREW_DEPTH`).
 *
 * History: 2026-08-09 the improvement-plan verification loop found two
 * drift instances — ADR 0003 referenced `PI_CREW_SESSION_DEPTH` (code
 * uses `PI_CREW_DEPTH`) and ADR 0007's status field read "Proposed —
 * not yet implemented" while the binary index was already shipping.
 * The status drift is not machine-checkable, but the env-var drift is.
 *
 * Scope:
 *   - Scans only `docs/decisions/*.md` (the curated ADR set).
 *   - Excludes `docs/archive/` and `docs/decisions/README.md`.
 *   - For each `PI_CREW_<NAME>` / `PI_TEAMS_<NAME>` token found in an
 *     ADR, asserts the same token appears in at least one file under
 *     `src/`. Bare `PI_CREW` / `PI_TEAMS` (no suffix) are ignored to
 *     avoid matching prose like "the PI_CREW env var family".
 *
 * Exits:
 *   0 — every ADR env-var token is present in src/
 *   1 — at least one token has drifted (with file:line listing)
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DECISIONS_DIR = join(ROOT, "docs/decisions");

const TOKEN_RE = /\b(PI_CREW_[A-Z][A-Z0-9_]*|PI_TEAMS_[A-Z][A-Z0-9_]*)\b/g;

function listDecisionFiles() {
	try {
		return readdirSync(DECISIONS_DIR)
			.filter((name) => name.endsWith(".md") && name !== "README.md")
			.map((name) => join(DECISIONS_DIR, name));
	} catch {
		return [];
	}
}

function grepSrc(token) {
	// rg returns 0 with matches, 1 with no matches. We treat either as
	// non-fatal and only inspect stdout.
	try {
		const out = execSync(`rg -l --null -e "${token}" src/ 2>/dev/null`, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 1 << 20,
		});
		return out.length > 0;
	} catch {
		return false;
	}
}

const drift = [];
for (const file of listDecisionFiles()) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	// Skip ADRs that are explicitly Planned/Proposed — they describe
	// future implementations whose env vars may not exist in src/ yet.
	const statusMatch = text.match(/^## Status\s*\n\s*([^\n]+)/m);
	const status = statusMatch ? statusMatch[1].toLowerCase() : "";
	if (status.includes("proposed") || status.includes("planned")) {
		continue;
	}
	// Lines that mention a token only as a historical/legacy reference
	// (e.g. an ADR corrected by a later edit explaining the old name)
	// should not trigger drift. We allowlist a small set of markers.
	const HISTORICAL_MARKERS = ["not used by", "previously", "earlier draft", "legacy name", "old name", "referenced `pi_crew_session_depth`"];
	const seen = new Set();
	for (const line of text.split("\n")) {
		const lower = line.toLowerCase();
		const isHistorical = HISTORICAL_MARKERS.some((m) => lower.includes(m));
		for (const match of line.matchAll(TOKEN_RE)) {
			const token = match[0];
			if (seen.has(token)) continue;
			seen.add(token);
			if (isHistorical) continue;
			if (!grepSrc(token)) {
				const rel = file.replace(ROOT, "");
				drift.push(`${rel}: env var '${token}' referenced in ADR but not found in src/`);
			}
		}
	}
}

if (drift.length > 0) {
	console.error(`[check-decision-drift] ${drift.length} drift instance(s) found:`);
	for (const line of drift) console.error(`  ${line}`);
	console.error("");
	console.error("Fix: either update the ADR to match the implementation, or rename the");
	console.error("implementation to match the ADR. See docs/decisions/README.md for the");
	console.error("decision-record workflow.");
	process.exit(1);
}

console.error("[check-decision-drift] no env-var drift between docs/decisions and src/");
process.exit(0);
