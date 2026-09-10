#!/usr/bin/env node
/**
 * CI gate: detect stale dist/index.mjs vs src/.
 *
 * MODES
 *
 * 1. Default — local dev (`npm run check:bundle-staleness`):
 *    mtime heuristic (newest src/ file vs dist/index.mjs mtime), as before.
 *    When mtime flags staleness, a content-hash confirmation arbitrates:
 *    mtimes lie after `git checkout` / `git revert` (touched files get
 *    fresh mtimes), bytes do not. If the working-tree dist content still
 *    matches a fresh build from src/, the gate passes; only genuine
 *    content drift fails.
 *
 * 2. `--committed-hash` — CI / release gate (WI-1.2): verify the COMMITTED
 *    dist/ blobs (read from the git object DB via `git show HEAD:dist/...`,
 *    AS-IS) hash equal to a fresh deterministic build from the checked-out
 *    src/. Catches "src edited + committed but dist not rebuilt +
 *    recommitted" — the stale-bundle incident class (v0.9.17+, see Phase 5
 *    H2 investigation 2026-07-01). MUST run BEFORE any step that rebuilds
 *    dist/ (see "Committed dist hash gate" step in .github/workflows/ci.yml):
 *    a dist check placed AFTER the rebuild step compares fresh-vs-fresh — a
 *    tautology that is always green. That tautology is exactly the hole
 *    this mode closes.
 *
 * DETERMINISM CLAUSES (mandatory — spec R2 P1-SEC-3):
 *
 *   (1) Canonicalize build-meta.json before hashing. The esbuild metafile
 *       can embed absolute paths (build-bundle.mjs passes an absolute
 *       outfile; some esbuild versions absolutize metafile keys), which
 *       differ per checkout location/machine. We replace the absolute repo
 *       root and the outdir prefix (dist/ vs the scratch dir) with stable
 *       tokens before hashing. Applied defensively to ALL hashed files.
 *
 *   (2) Cross-OS determinism. The CI matrix runs ubuntu/windows/macos, so
 *       we do NOT pin the hash to one OS; instead every payload is
 *       line-ending normalized (CRLF→LF) before hashing. esbuild writes LF
 *       on every OS and this repo's dist blobs are stored LF, so this is a
 *       no-op in practice — it exists so a Windows contributor with
 *       core.autocrlf=true cannot commit CRLF dist blobs that then
 *       hash-differ from CI's fresh LF build.
 *
 *   (3) Hash the committed dist AS-IS. The committed side is read straight
 *       from the git object database; dist/ ON DISK is never rebuilt or
 *       touched by this gate. The fresh (expected) side is built into a
 *       scratch dir (.bundle-gate.tmp/ at repo root — gitignored via the
 *       existing `*.tmp` pattern, and at the same depth as dist/ so
 *       esbuild's relative sourcemap "sources" match). No rebuild happens
 *       between reading the committed bytes and hashing them, so the
 *       comparison can never degenerate into fresh-vs-fresh.
 *
 * Skips (exit 0) when dist/index.mjs does not exist or dist/ is not tracked
 * in git — the strip-types fallback path is fine in that case and the
 * build:bundle automation will produce the bundle.
 *
 * Exits:
 *   0 — dist is fresh, content-identical, or absent
 *   1 — dist is stale (run `npm run build:bundle`; for committed drift also
 *       commit the rebuilt dist/ — see docs/publishing.md "dist clean check")
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Root-level scratch dir (depth 1, same as dist/ — see header clause (3) for
// why depth matters). Matched by the repo .gitignore `*.tmp` pattern.
const SCRATCH_DIR = ".bundle-gate.tmp";
const DIST_FILES = ["index.mjs", "index.mjs.map", "build-meta.json"];

const committedHashMode = process.argv.includes("--committed-hash");

// ---------------------------------------------------------------------------
// Clause (1)+(2): canonicalization + line-ending normalization before hashing
// ---------------------------------------------------------------------------

function canonicalize(text, { absRoot, outTokens }) {
	// Clause (2): normalize line endings first — cross-OS (CRLF/LF) hash
	// stability. See header. Git stores this repo's dist as LF and esbuild
	// always writes LF, so this is a belt-and-suspenders no-op.
	let t = text.replace(/\r\n/g, "\n");
	// Clause (1): strip absolute-path leakage. Replace the absolute repo
	// root (posix and windows separator variants) with a stable token so
	// hashes are checkout-location independent.
	if (absRoot) {
		const variants = new Set([absRoot, absRoot.split("/").join("\\")]);
		for (const v of variants) {
			if (v) t = t.split(v).join("<ROOT>");
		}
	}
	// Normalize the outdir prefix (committed side "dist/", fresh side the
	// scratch dir) so metafile outputs keys compare equal.
	for (const tok of outTokens) {
		t = t.split(tok).join("<OUTDIR>");
	}
	return t;
}

function sha256(s) {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}

function hashPayload(buffer, file) {
	const canon = canonicalize(buffer.toString("utf-8"), {
		absRoot: root,
		outTokens: [`dist/`, `${SCRATCH_DIR}/`],
	});
	return { hash: sha256(canon), size: buffer.length, file };
}

// ---------------------------------------------------------------------------
// Sides of the comparison
// ---------------------------------------------------------------------------

// Clause (3): the committed side — read blobs straight from the object DB,
// AS COMMITTED. dist/ on disk is never rebuilt before this read.
function readCommittedDist() {
	const tracked = execFileSync("git", ["ls-files", "--", "dist"], {
		cwd: root,
		encoding: "utf-8",
	})
		.split("\n")
		.filter(Boolean);
	if (tracked.length === 0) return null; // dist not committed → fallback path
	const blobs = {};
	for (const f of DIST_FILES) {
		try {
			blobs[f] = execFileSync("git", ["show", `HEAD:dist/${f}`], {
				cwd: root,
				encoding: "buffer",
				maxBuffer: 128 * 1024 * 1024, // dist/index.mjs.map is ~8 MB
			});
		} catch {
			// File never committed (e.g. older layout) — treat as absent.
			blobs[f] = null;
		}
	}
	return blobs;
}

// Fresh build from CURRENT src into the scratch dir. dist/ is untouched.
// Uses scripts/build-bundle.mjs with PI_CREW_BUNDLE_OUT so the build config
// is THE ONE source of truth (no duplicated esbuild options in this gate).
function freshBuildToScratch() {
	const scratch = path.join(root, SCRATCH_DIR);
	rmSync(scratch, { recursive: true, force: true });
	const res = spawnSync(process.execPath, [path.join("scripts", "build-bundle.mjs")], {
		cwd: root,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, PI_CREW_BUNDLE_OUT: SCRATCH_DIR },
	});
	if (res.status !== 0) {
		throw new Error(`scratch bundle build failed (exit ${res.status}) — see output above`);
	}
	const side = {};
	for (const f of DIST_FILES) {
		const p = path.join(scratch, f);
		side[f] = existsSync(p) ? readFileSync(p) : null;
	}
	rmSync(scratch, { recursive: true, force: true });
	return side;
}

// Compare two sides (buffers or null per file). Returns per-file rows.
function compareSides(sideA, sideB, labelA, labelB) {
	const rows = [];
	for (const f of DIST_FILES) {
		const a = sideA[f];
		const b = sideB[f];
		if (a === null || b === null) {
			rows.push({ file: `dist/${f}`, match: a === null && b === null, aHash: null, bHash: null, aSize: a?.length, bSize: b?.length, missing: true });
			continue;
		}
		const ha = hashPayload(a, f);
		const hb = hashPayload(b, f);
		rows.push({ file: `dist/${f}`, match: ha.hash === hb.hash, aHash: ha.hash, bHash: hb.hash, aSize: a.length, bSize: b.length, missing: false, labelA, labelB });
	}
	return rows;
}

function printRows(rows) {
	for (const r of rows) {
		if (r.missing) {
			console.log(`  ${r.file.padEnd(22)} ${r.aSize === undefined ? "absent" : `${r.aSize} B`} vs ${r.bSize === undefined ? "absent" : `${r.bSize} B`} (missing on one side)`);
		} else {
			console.log(
				`  ${r.file.padEnd(22)} ${r.match ? "MATCH " : "DIFFER"} sha256(${r.labelA})=${r.aHash.slice(0, 16)}… sha256(${r.labelB})=${r.bHash.slice(0, 16)}… (${r.aSize} B vs ${r.bSize} B)`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Mode 2: --committed-hash (CI gate, WI-1.2)
// ---------------------------------------------------------------------------

if (committedHashMode) {
	const committed = readCommittedDist();
	if (committed === null) {
		console.log("[check-bundle-staleness] dist/ is not tracked in git — strip-types fallback applies. OK.");
		process.exit(0);
	}
	// Clause (3): committed bytes captured FIRST (above), only now build the
	// expected side — into scratch, never into dist/.
	let fresh;
	try {
		fresh = freshBuildToScratch();
	} catch (err) {
		console.error(`[check-bundle-staleness] FAIL: could not derive expected bundle from current src: ${err.message}`);
		process.exit(1);
	}
	const rows = compareSides(committed, fresh, "committed", "fresh");
	const ok = rows.every((r) => r.match);
	console.log(
		`[check-bundle-staleness] committed-hash gate: committed dist (as-is, git show HEAD:dist/*) vs fresh build from current src/`,
	);
	printRows(rows);
	if (!ok) {
		console.error(
			"[check-bundle-staleness] FAIL: committed dist/ is STALE — src changed without rebuilding + recommitting dist.\n" +
				"  → run `npm run build:bundle`, then commit the bundle: git add -f dist/ && git commit -- dist\n" +
				"  (This gate runs BEFORE the rebuild step by design — a dist check after rebuilding is tautological.)",
		);
		process.exit(1);
	}
	console.log("[check-bundle-staleness] OK: committed dist matches a fresh build from current src.");
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode 1 (default): local mtime heuristic + content-hash confirmation
// ---------------------------------------------------------------------------

const distPath = path.join(root, "dist/index.mjs");
if (!existsSync(distPath)) {
	console.log("[check-bundle-staleness] dist/index.mjs absent — strip-types fallback will be used. OK.");
	process.exit(0);
}

const distMtimeMs = statSync(distPath).mtimeMs;

// `git ls-files src` lists tracked files; untracked new .ts files are added
// below. Cheap heuristic: stat every file, keep the newest mtime.
let trackedFiles;
try {
	trackedFiles = execFileSync("git", ["ls-files", "src"], { encoding: "utf-8", cwd: root })
		.split("\n")
		.filter(Boolean);
} catch {
	// Not a git repo (e.g. npm pack test) — skip.
	console.log("[check-bundle-staleness] not a git repo; skipping staleness check.");
	process.exit(0);
}

let newestMtimeMs = 0;
let newestFile = "";
for (const f of trackedFiles) {
	try {
		const mt = statSync(path.join(root, f)).mtimeMs;
		if (mt > newestMtimeMs) {
			newestMtimeMs = mt;
			newestFile = f;
		}
	} catch {
		// File listed but missing on disk — ignore.
	}
}

// Add untracked .ts files in src/ (devs editing a new file)
try {
	const untracked = execFileSync("git", ["ls-files", "-o", "--exclude-standard", "src"], { encoding: "utf-8", cwd: root })
		.split("\n")
		.filter(Boolean);
	for (const f of untracked) {
		if (!f.endsWith(".ts")) continue;
		try {
			const mt = statSync(path.join(root, f)).mtimeMs;
			if (mt > newestMtimeMs) {
				newestMtimeMs = mt;
				newestFile = f;
			}
		} catch {
			// ignore
		}
	}
} catch {
	// git may fail; ignore
}

if (newestMtimeMs === 0) {
	console.log("[check-bundle-staleness] no src/*.ts files found; skipping.");
	process.exit(0);
}

if (newestMtimeMs > distMtimeMs) {
	// Mtime says stale — confirm with content before failing. A plain
	// `git checkout -- src/...` (e.g. after reverting a scratch edit) gives
	// every touched file a fresh mtime while the dist content is still
	// current; the content comparison below keeps that common case green.
	console.log(
		`[check-bundle-staleness] mtime heuristic flags staleness (newest src: ${newestFile}). Confirming with content-hash build…`,
	);
	let fresh;
	try {
		fresh = freshBuildToScratch();
	} catch (err) {
		console.error(
			`[check-bundle-staleness] FAIL: dist/index.mjs is stale and the confirmation build failed: ${err.message}\n` +
				`  Newest src file: ${newestFile} (mtime=${newestMtimeMs.toFixed(0)})\n` +
				`  dist/index.mjs mtime: ${distMtimeMs.toFixed(0)}\n` +
				`  → run \`npm run build:bundle\` to refresh.`,
		);
		process.exit(1);
	}
	const working = {};
	for (const f of DIST_FILES) {
		const p = path.join(root, "dist", f);
		working[f] = existsSync(p) ? readFileSync(p) : null;
	}
	const rows = compareSides(working, fresh, "working", "fresh");
	printRows(rows);
	if (rows.every((r) => r.match)) {
		console.log(
			"[check-bundle-staleness] OK: mtime was heuristically stale but dist content is identical to a fresh build from src/ (e.g. src was checked out / reverted after the last build). No rebuild needed.",
		);
		process.exit(0);
	}
	console.error(
		"[check-bundle-staleness] FAIL: dist/index.mjs is stale (content differs from a fresh build).\n" +
			"  → run `npm run build:bundle` to refresh.",
	);
	process.exit(1);
}

const ageSec = (distMtimeMs - newestMtimeMs) / 1000;
console.log(`[check-bundle-staleness] OK: dist/index.mjs is ${ageSec.toFixed(1)}s newer than newest src/ file.`);
