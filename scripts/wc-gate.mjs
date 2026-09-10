#!/usr/bin/env node
/**
 * wc-gate.mjs — Enforce the M4 done-gate: no module under src/runtime/ may
 * exceed 2000 lines (spec §5 M4 acceptance).
 *
 * Exits 0 on green, 1 on violation. Run via `npm run check:wc-gate`
 * (also part of `ci` / `ci:fast` and the per-PR ci.yml workflow).
 *
 * REVIEW FIX (2026-09-10, shard-B F2): single-pass scan — the previous
 * version walked + read every file twice (violations pass, then top-5
 * pass); `stat` import was unused; readFile is imported once at top.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../src/runtime/", import.meta.url).pathname;
const LIMIT = 2000;

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			yield* walk(p);
		} else if (e.isFile() && e.name.endsWith(".ts")) {
			yield p;
		}
	}
}

/** Naive line counter — wc -l parity for ASCII source. */
async function lineCount(p) {
	const src = await readFile(p, "utf8");
	if (src.length === 0) return 0;
	// Subtract 1 if file ends with newline (wc -l behaviour)
	let n = 1;
	for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
	return src.endsWith("\n") ? n - 1 : n;
}

// Single pass: collect every (path, count) once; violations and top-5 both
// derive from it.
const all = [];
const violations = [];
for await (const p of walk(ROOT)) {
	const n = await lineCount(p);
	all.push({ p, n });
	if (n > LIMIT) violations.push(`${n}\t${p}`);
}

if (violations.length > 0) {
	console.error(`wc-gate FAIL — ${violations.length} module(s) over ${LIMIT} lines:`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(`M4 done-gate §5: no module under src/runtime/ may exceed ${LIMIT} lines.`);
	process.exit(1);
}

all.sort((a, b) => b.n - a.n);
console.log(`wc-gate OK — ${all.length} files, max ${all[0].n} lines (limit ${LIMIT}).`);
console.log("Top 5 largest:");
for (const x of all.slice(0, 5)) console.log(`  ${x.n}\t${x.p}`);
