#!/usr/bin/env node
/**
 * prepack hook — strip strip-types `.js` companion cruft from `src/` before
 * packing/publishing.
 *
 * WHY: Pi's strip-types loader (and node:test runs) emit a `.js` companion
 * next to every `.ts` it transpiles, as a cache. These are gitignored
 * (the `src slash star-star slash star.js` rule in .gitignore) and never
 * committed, but they accumulate in dev checkouts. `npm pack` would
 * otherwise ship ~290 stale `.js` files (~4MB of cruft) that don't exist in
 * a fresh checkout.
 *
 * This hook runs before every `npm pack` / `npm publish` and deletes them so
 * the published tarball is always clean (only the `.ts` sources ship). They
 * regenerate harmlessly on the next strip-types load. Deleting is safe: pi-crew
 * loads via the bundle (`dist/index.mjs`) or by explicit `.ts` path — never the
 * strip-types `.js` companions.
 *
 * Robust: any error is logged + swallowed (never blocks a pack/publish).
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SRC = join(root, "src");
// Only `.js` and `.js.map` are strip-types companions. `.d.ts` files are NEVER
// emitted by strip-types — they are hand-written source type shims (e.g.
// src/types/diff.d.ts) and must be preserved.
const STRIP_EXT = [".js", ".js.map"];

function walk(dir) {
	let out = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			out = out.concat(walk(full));
		} else if (e.isFile() && STRIP_EXT.some((x) => e.name.endsWith(x))) {
			out.push(full);
		}
	}
	return out;
}

try {
	const files = walk(SRC);
	for (const f of files) rmSync(f, { force: true });
	if (files.length > 0) {
		console.log(
			`[prepack] removed ${files.length} strip-types companion file(s) from src/`,
		);
	}
} catch (e) {
	console.warn(`[prepack] non-fatal: ${e?.message ?? e}`);
}
