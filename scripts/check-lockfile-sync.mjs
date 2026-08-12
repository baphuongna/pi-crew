#!/usr/bin/env node
/**
 * CI / pre-commit gate: package.json deps in sync with package-lock.json.
 *
 * Prevents the "bump a devDependency in package.json but forget to regenerate
 * the lockfile" class of CI failure. `npm ci` (used by CI) requires the two to
 * agree exactly — a stale lock makes the whole pipeline fail at the install
 * step with a verbose dump. This check parses both files and reports the exact
 * offending deps with a one-line fix, in <50ms, with no install/network.
 *
 * Verified range forms: `*`, exact `M.m.p`, `^M.m.p`, `~M.m.p`, comparators
 * (`>=` `<=` `>` `<` `=`), space-AND (`>=1.0.0 <2.0.0`), and `||` unions.
 * Prerelease/build metadata is ignored (pi-crew deps have none). An unknown
 * range form fails SAFE (reported as an offender) rather than silently passing.
 *
 * Run:  `node scripts/check-lockfile-sync.mjs`
 * Exit: 0 = in sync · 1 = stale (lists offenders + the fix command)
 *
 * Wired into `npm run ci` and the CI workflow (before `npm ci`), plus the
 * `.githooks/pre-commit` hook (activate once: `git config core.hooksPath .githooks`).
 */
import { readFileSync } from "node:fs";

const pkgPath = new URL("../package.json", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let lock;
try {
	lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch {
	console.error("[check-lockfile-sync] package-lock.json missing or unparseable — run `npm install`.");
	process.exit(1);
}

// ── minimal semver (only what package.json ranges need) ──────────────────────
function parse(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
function cmp(a, b) {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	return 0;
}
function satisfiesToken(token, v) {
	const p = parse(v);
	if (!p) return false;
	if (token === "*" || token === "" || token === "x" || token === "latest") return true;
	let m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(token);
	if (m) {
		const lo = { major: +m[1], minor: +m[2], patch: +m[3] };
		const below =
			m[1] === "0"
				? m[2] === "0"
					? { major: 0, minor: 0, patch: +m[3] + 1 }
					: { major: 0, minor: +m[2] + 1, patch: 0 }
				: { major: +m[1] + 1, minor: 0, patch: 0 };
		return cmp(p, lo) >= 0 && cmp(p, below) < 0;
	}
	m = /^~(\d+)\.(\d+)\.(\d+)/.exec(token);
	if (m) {
		const lo = { major: +m[1], minor: +m[2], patch: +m[3] };
		const below = { major: +m[1], minor: +m[2] + 1, patch: 0 };
		return cmp(p, lo) >= 0 && cmp(p, below) < 0;
	}
	m = /^(>=|<=|>|<|=)(\d+)\.(\d+)\.(\d+)/.exec(token);
	if (m) {
		const op = m[1];
		const t = { major: +m[2], minor: +m[3], patch: +m[4] };
		const c = cmp(p, t);
		return op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
	}
	m = /^(\d+)\.(\d+)\.(\d+)/.exec(token); // exact
	if (m) return cmp(p, { major: +m[1], minor: +m[2], patch: +m[3] }) === 0;
	return false; // unknown token — fail safe (caller reports it)
}
// `||` splits unions; within a union, whitespace tokens are AND-ed.
function satisfies(range, v) {
	return range
		.split("||")
		.some((union) => union.split(/\s+/).filter(Boolean).every((token) => satisfiesToken(token, v)));
}

// ── collect ranges from package.json ─────────────────────────────────────────
// A package can appear in multiple sections (e.g. a peerDep `*` AND a devDep
// `^0.84.0`) — the lock must satisfy EVERY section's range, so collect them as
// distinct tuples rather than deduping by name (a `*` peerDep must not mask a
// `^0.84.0` devDep check — that was the bug that let the original CI failure
// slip through this gate's first draft).
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const ranges = [];
for (const s of sections) for (const [name, r] of Object.entries(pkg[s] ?? {})) ranges.push({ section: s, name, range: r });

// ── resolved versions from package-lock.json (v3: packages["node_modules/<n>"]) ──
const pkgs = lock.packages ?? {};
const offenders = [];
for (const { name, range, section } of ranges) {
	if (range === "*") continue; // `*` (typical peerDep) is always satisfiable
	const node = pkgs[`node_modules/${name}`];
	if (!node) {
		offenders.push(`${name} [${section}]: package.json "${range}" but missing from lock (no node_modules/${name})`);
		continue;
	}
	if (!satisfies(range, node.version)) {
		offenders.push(`${name} [${section}]: package.json "${range}" not satisfied by lock resolved "${node.version}"`);
	}
}

if (offenders.length) {
	console.error("[check-lockfile-sync] package-lock.json is out of sync with package.json:");
	for (const o of offenders) console.error(`  - ${o}`);
	console.error("\nFix: run `npm install` and commit the updated package-lock.json.");
	process.exit(1);
}
console.log(`[check-lockfile-sync] OK: package-lock.json satisfies all ${ranges.length} package.json ranges.`);
