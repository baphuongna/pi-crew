#!/usr/bin/env node
// Δ2 (2026-10-11) — AST-based declared-deps + lazy-import gate with per-entry budgets.
//
// This gate replaces the RR-021 regex scanner with a true AST walk, ported from
// upstream pi monorepo patterns (`scripts/check-runtime-deps.mjs` for the
// declared-deps walk, `scripts/check-entry-graphs.mjs` for the {maxFiles,
// forbid[]} budgets). It runs FOUR checks:
//
//  1. DECLARED DEPS — every value import in `src/**/*.ts` + root entry files
//     (`index.ts`, `index.bundle.ts`) must resolve to a package declared in
//     `dependencies` / `peerDependencies` / `optionalDependencies` (or be a
//     Node builtin / relative path). Covers ImportDeclaration, re-exports
//     (`export … from`, `export * from`), runtime `import("…")`, and
//     `require(…)` / `require.resolve(…)` call sites — all found via AST, so
//     there are no regex-shaped blind spots.
//
//  2. LAZY MARKERS — every RUNTIME `import()` call in `src/**/*.ts` must carry
//     a `// LAZY: <reason>` marker on its line or the adjacent line (Biome
//     hoists trailing comments on block-opening lines onto the first statement
//     line, so ±1 is accepted — carried over from the RR-021 regex gate).
//     Because type annotations are ERASED before parsing, type-position
//     `import("…").T` usage can no longer be mistaken for runtime imports, and
//     the RR-021 round-3/round-4 residual false-skips (object-property values,
//     ternary-else, case-label positions, member-access-after-colon) are all
//     closed: the AST sees every import() call site.
//
//  3. ENTRY BUDGETS — the value-import graph reachable from each bundle entry
//     (`index.bundle.ts`, per scripts/build-bundle.mjs entryPoints) is capped
//     at {maxFiles, forbid[]}. Entries are cost contracts (upstream
//     check-entry-graphs): one stray barrel export silently drags the whole
//     tree into the shipped bundle; this fails at commit time instead.
//
//  4. DIST ASSERTION (unchanged, RR-021 WI-2.3b) — dist/index.mjs must not
//     contain module-scope hoisted `from"pkg"` imports of the heavy externals.
//
// HOW TS IS PARSED: acorn parses ECMAScript only, so each .ts file is first
// type-stripped by esbuild's `transformSync` (loader "ts", treeShaking OFF,
// tsconfigRaw `importsNotUsedAsValues: "preserve"` — see parseFile() for why
// both flags matter) and then parsed by acorn. Both are existing direct
// dependencies; nothing new was added. Original line numbers are recovered
// from esbuild's sourcemap via a minimal VLQ decoder, so violations point at
// the SOURCE file, not the intermediate JS.
//
// KNOWN GAPS (honest, residual):
//  - `import()` with a NON-STATIC argument (template with expressions, `${}`
//    interpolation, identifiers) cannot be resolved for the declared-deps or
//    budget checks — the call site IS still LAZY-marker-checked (argument
//    shape is irrelevant there). pi-crew has no such call sites today.
//  - Value imports that Node's strip-types fallback would load but the bundler
//    erases (an `import { X }` used ONLY in type positions) are preserved via
//    `importsNotUsedAsValues: "preserve"`, which matches strip-types runtime
//    behavior (amaro keeps such imports) — but a bare `import "pkg"` that is
//    dead code in BOTH paths is still counted. Deliberate: dead imports are
//    their own bug.
//  - The dist assertion still only matches the minified `from"pkg"` specifier
//    form (esbuild's emit shape for named/default imports); a side-effect-only
//    `import"pkg"` in dist would escape. Acceptable regression gate, unchanged
//    from RR-021.
//  - `require()` / `require.resolve()` are detected syntactically on the type-
//    stripped output, where esbuild renames local `require` bindings to
//    `require2`, …; the gate matches that rename scheme. A hand-written
//    function literally named `require2` called with a static string argument
//    would be miscounted — none exists in-tree.
//  - Only `src/**` + the two root entry files are dep-checked; `scripts/` and
//    `test/` are dev-only surfaces (not shipped) and stay out of scope, like
//    upstream's src-only rule.
//  - Budget graph resolution follows relative `.ts` imports only; the repo
//    has no self-referential package imports, so none are mapped. Unlike
//    upstream (whose regex only sees `… from "…"` shapes), this walk ALSO
//    follows relative dynamic import("./…") edges — with a single-file esbuild
//    bundle they ship in dist/index.mjs too, so they belong in the budget.
//  - Undeclared-dep exceptions live in OPTIONAL_RUNTIME_REQUIRES with a
//    required written justification; keep that list SHORT.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import * as acorn from "acorn";

// Test seam: point the gate at a fixture tree (`--root <dir>`) instead of the
// repo root. Everything below resolves package.json / src / entries relative
// to this root, so the fixture test can drive both the pass and fail paths.
const rootArgIdx = process.argv.indexOf("--root");
const ROOT =
	rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
		? resolve(process.argv[rootArgIdx + 1])
		: resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MANIFEST = existsSync(resolve(ROOT, "package.json"))
	? JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
	: { name: "fixture", dependencies: {} };
const DECLARED = new Set([
	MANIFEST.name,
	...Object.keys(MANIFEST.dependencies ?? {}),
	...Object.keys(MANIFEST.optionalDependencies ?? {}),
	...Object.keys(MANIFEST.peerDependencies ?? {}),
]);

// ── Per-entry budgets (upstream check-entry-graphs style) ───────────────────
// Keys are the bundle entries from scripts/build-bundle.mjs entryPoints.
// maxFiles is a ratchet on the current reachable-file count; forbid[] lists
// path fragments that must NEVER enter the shipped entry graph (test/, dev
// scripts/, docs/ are not shipped; dist/ would mean the bundle recursively
// re-importing its own output — the exact recursion build-bundle.mjs avoids
// by using index.bundle.ts instead of index.ts).
const BUDGETS = {
	"index.bundle.ts": {
		// U11 (2026-10-11): 521 → 523 — task-runner/hybrid-tier.ts (policy-gated
		// lazy import) + live-session/embedded-tier.ts (static import from
		// live-session-runtime.ts) both ship in the single-file bundle.
		// PI-DURABLE (2026-10-13): 523 → 525 — state/event-log/poison-marker.ts
		// (static import from cursor.ts; sidecar torn/poison integrity) and
		// state/coordination/process-lock.ts (static import from locks.ts; U21
		// kernel socket run-lock supplement) are core sync read/lock paths —
		// not deferrable — and ship in the single-file bundle. Baseline verified
		// at main d29df7dd = 523/523.
		// FOLLOW-UP (2026-10-14): 525 → 526 — runtime/live-session/usage-bridge.ts
		// (m5 extraction from live-session-runtime.ts; pure usage shape/parser
		// helpers on the hot session path — not deferrable). Baseline verified at
		// main f10da4cc = 525/525.
		// DR-03 (2026-10-16): 526 → 527 — broker/protocol/msg-send-targets.ts (pure
		// D9/§15.2 recipient matrix extracted from crew-broker.ts for the wc-gate;
		// statically imported — msg.send is a request-scoped path, not cold-start).
		// Waves 2-4 (2026-10-17): 527 → 528 — broker/protocol/connection-state.ts
		// enters the VALUE graph (outbound-queue trio + caps moved from
		// crew-broker.ts for the wc-gate; it was previously type-only). The two
		// wc-gate extractions (this + root-gate/settings-enum merges in the other
		// direction) keep crew-broker.ts ≤ 2000 with pure moves, no new modules.
		// Fix-wave 6 / M1-4 (2026-10-19): 528 → 529 — runtime/sanitize/worker-text.ts
		// (generic fenceWorkerText helper for R38-C1/EP1; statically imported by
		// api/read.ts — hot read path, must stay in the value graph).
		// Fix-wave 6 / M3-17+M3-20 (2026-10-19): 529 → 532 — utils/timer-limits.ts
		// (R37-F1 2^31-1 timeout clamp; statically imported by
		// extension/team-tool/run-deadline.ts and runtime/run-tracker.ts — both on
		// the run/wait hot path, not deferrable) + the M3-5 delegate family's two
		// new modules (runtime/broker/delegate/delegate-abort.ts,
		// delegate-finalize.ts) which are statically reached from crew-broker.ts.
		// v0.11.31 (2026-10-20): 532 → 533 — runtime/child-pi/inference-broker.ts
		// (loopback inference broker; statically imported by child-pi-spawn.ts,
		// which needs its SYNC snapshot/require/register calls on the spawn path —
		// not deferrable; the async listen start lives in child-pi.ts run()).
		// Count measured with the R18-1 depth-1 + R18-3 `.js`-suffix fixes in place,
		// so the graph is now complete (those two fixes add no file by themselves:
		// no `.js`-suffixed relative import exists in the tree today). RE-MEASURE at
		// wave land — this number is a moving target while parallel tasks land src
		// modules (the wave's rebuild step is the natural point to reconcile it).
		// v0.11.36: 533 → 534 — runtime/child-pi/sandbox.ts (bwrap argv builder,
		// fail-closed config + binary probe; statically imported from child-pi.ts
		// — the spawn path is sync and cannot lazy-import the wrapper).
		// v0.11.38 W10-8: 534 → 535 — runtime/role-permission.ts (read-only lane
		// classification for the same-tree guard; tiny pure module, static is right).
		// fix-wave 11a: 535 → 536 — runtime/process/reap-group.ts (guarded
		// process-group reaper; statically imported by child-pi-kill.ts and
		// orphan-reaper.ts, both on the KILL path where a dynamic import could
		// not be awaited before the pid disappears — static is the only correct
		// shape here).
		// fix-wave 11b: 536 → 537 — runtime/process/run-descendant-sweep.ts
		// (run-scoped descendant reaper; statically imported by stale-reconciler.ts
		// and team-tool/doctor.ts). Static, not lazy: the reconciler is SYNC by
		// contract and must hand the SIGTERM out before it returns, so an await
		// point (dynamic import) at the call site is exactly the shape that loses
		// the pid to a subsequent PID reuse.
		// v0.11.45 MED-1 (2026-10-27): 537 → 539 — worktree/git-hardening.ts
		// (sync git env/argv hardening helpers buildGitSafeEnv/hardenGitArgs/
		// worktreeTrustCheck; statically imported by cleanup.ts,
		// worktree-manager.ts, branch-freshness.ts, task-runner/post-execution.ts
		// and goal-workflow/goal-achievement.ts — every one is a SYNC call on the
		// git-invocation path, so a dynamic import at the call site is not a
		// legal shape) + broker/socket-stop.ts (ownership-gated socket teardown;
		// statically imported by crew-broker.ts which is already in the graph).
		// No lazy route exists: this walk follows dynamic import() edges too,
		// because the single-file esbuild bundle ships everything it reaches.
		// wc-gate ITEM C (2026-10-27): 539 → 540 — broker/crew-broker-delegate-request.ts
		// (delegate.request handler body moved OUT of crew-broker.ts for the wc-gate
		// LIMIT; statically imported by crew-broker.ts which is already in the graph,
		// same shape as socket-stop.ts above — pure file-count growth from the split,
		// zero new reachability).
		// wc-gate live-session split (2026-10-27): 540 → 541 —
		// live-session/live-session-prompt-models.ts (model/prompt cluster moved OUT
		// of live-session-runtime.ts for the wc-gate LIMIT; statically imported by
		// live-session-runtime.ts which is already in the graph — same shape, pure
		// file-count growth from the split, zero new reachability).
		// SEC-2026-11 w7a (2026-10-29): 541 → 542 — utils/safe-terminal-text.ts (shared
		// stripTerminalSequences sanitizer for the w7a render sinks: inline-panel
		// transcript, theme gallery, tool-renderers). Statically imported by
		// inline-panel/agent-transcript.ts which is already in the graph — hot render
		// path, not deferrable; pure file-count growth, zero new reachability).
		maxFiles: 542,
		forbid: ["test/", "scripts/", "docs/", "dist/"],
	},
};

// Deliberate, REVIEWABLE exceptions to the declared-deps rule. Each entry
// must carry its justification here. (Δ2 resolution 2026-10-11: the original
// exception `hosted-git-info` was DROPPED — its require() in src/utils/git.ts
// never resolved in ANY environment (undeclared, and unreachable even
// transitively from src/ in the repo checkout), so the branch was dead code
// and has been deleted outright instead of declared. The allowlist is back
// to strict/empty; add an entry ONLY together with a written justification.)
const OPTIONAL_RUNTIME_REQUIRES = new Set();

const failures = [];

// ── Parsing: esbuild type-strip → acorn AST → sourcemap line recovery ───────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const parseCache = new Map(); // absPath -> { ast, code, segs, srcLines } | { error }
// esbuild's ESM output RENAMES a user binding named `require` to `require2`,
// `require3`, … (it reserves `require` for CJS interop). Syntactic require()
// detection therefore matches that rename scheme too — the in-tree shim
// (src/runtime/deterministic-ast.ts) is exactly this shape.
const REQUIRE_NAME = /^require\d*$/;

function decodeMappings(mappings) {
	// Standard base64 VLQ: per-generated-line arrays of
	// { genCol, origLine } segments with cumulative deltas.
	const perLine = [];
	let srcIdx = 0;
	let origLine = 0;
	let origCol = 0;
	for (const line of mappings.split(";")) {
		let genCol = 0;
		const segs = [];
		for (const seg of line.split(",")) {
			if (!seg) continue;
			const fields = [];
			let shift = 0;
			let value = 0;
			for (const ch of seg) {
				const digit = B64.indexOf(ch);
				if (digit < 0) throw new Error(`bad VLQ char ${JSON.stringify(ch)}`);
				value += (digit & 31) << shift;
				shift += 5;
				if ((digit & 32) === 0) {
					const negative = value & 1;
					value >>= 1;
					fields.push(negative ? -value : value);
					value = 0;
					shift = 0;
				}
			}
			genCol += fields[0] ?? 0;
			if (fields.length >= 4) {
				srcIdx += fields[1];
				origLine += fields[2];
				origCol += fields[3];
				segs.push({ genCol, origLine });
			}
		}
		perLine.push(segs);
	}
	return perLine;
}

function lineOfOffset(code, offset) {
	let line = 1;
	for (let i = 0; i < offset && i < code.length; i++) {
		if (code.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

function origLineOf(segs, genLine, genCol) {
	const row = segs[genLine - 1] ?? [];
	let best;
	for (const seg of row) {
		if (seg.genCol <= genCol) best = seg;
		else break;
	}
	return best?.origLine;
}

/**
 * Type-strip with esbuild then parse with acorn.
 *
 * treeShaking: false — the transform API otherwise DROPS unused top-level
 * statements, including `const m = await import("…")` whose binding is never
 * read. That is a real runtime import() and must be seen by checks 1–2.
 *
 * importsNotUsedAsValues: "preserve" — esbuild's TS default ELIDES
 * `import { X } from "…"` when X is only referenced in type positions (tsc
 * emit semantics). But pi-crew's strip-types FALLBACK path (index.ts when
 * dist/ is absent) runs on Node's amaro, which keeps such imports — the
 * specifier still loads at runtime there. "preserve" keeps the statement so
 * the declared-deps check sees it, matching both runtime paths.
 */
function parseFile(absPath) {
	if (parseCache.has(absPath)) return parseCache.get(absPath);
	let entry;
	try {
		const source = readFileSync(absPath, "utf8");
		const t = transformSync(source, {
			loader: "ts",
			format: "esm",
			target: "node22",
			sourcemap: "external",
			treeShaking: false,
			tsconfigRaw: { compilerOptions: { importsNotUsedAsValues: "preserve" } },
		});
		const map = typeof t.map === "string" ? JSON.parse(t.map) : t.map;
		const ast = acorn.parse(t.code, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
		});
		entry = { ast, code: t.code, segs: decodeMappings(map.mappings ?? ""), srcLines: source.split(/\r?\n/) };
	} catch (err) {
		entry = { error: err };
	}
	parseCache.set(absPath, entry);
	return entry;
}

function isNode(value) {
	return Boolean(value) && typeof value === "object" && typeof value.type === "string";
}

function staticStringOf(node) {
	if (!isNode(node)) return undefined;
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral") {
		const expressions = Array.isArray(node.expressions) ? node.expressions : [];
		if (expressions.length > 0) return undefined;
		const quasis = Array.isArray(node.quasis) ? node.quasis : [];
		return quasis
			.map((q) => {
				const cooked = q?.value?.cooked;
				return typeof cooked === "string" ? cooked : q?.value?.raw ?? "";
			})
			.join("");
	}
	return undefined;
}

/**
 * Walk the AST, collecting every import site.
 *   statics: ImportDeclaration / export-from (specifier required to be present)
 *   dynamics: EVERY runtime import() call site (for the LAZY check — argument
 *             shape is irrelevant)
 *   requires: require("…") / require.resolve("…") calls with a static argument
 */
function collectImportSites(parsed) {
	const statics = [];
	const dynamics = [];
	const requires = [];
	(function walk(node) {
		if (!isNode(node)) return;
		if (node.type === "ImportDeclaration" && isNode(node.source)) {
			statics.push({ spec: node.source.value, start: node.start });
		} else if (
			(node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
			isNode(node.source)
		) {
			statics.push({ spec: node.source.value, start: node.start });
		} else if (node.type === "ImportExpression" || (node.type === "CallExpression" && isNode(node.callee) && node.callee.type === "Import")) {
			// acorn >= 8.9 emits `ImportExpression` for dynamic import(); older
			// shapes (and `import(x)` inside call chains on some versions) use a
			// CallExpression whose callee is an `Import` node. Accept both.
			const arg = isNode(node.source)
				? node.source
				: Array.isArray(node.arguments)
						? node.arguments[0]
						: undefined;
			dynamics.push({ spec: staticStringOf(arg), start: node.start });
		} else if (node.type === "CallExpression") {
			const callee = node.callee;
			const firstArg = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
			if (isNode(callee) && callee.type === "Identifier" && REQUIRE_NAME.test(callee.name)) {
				const spec = staticStringOf(firstArg);
				if (spec !== undefined) requires.push({ spec, start: node.start });
			} else if (
				isNode(callee) &&
				callee.type === "MemberExpression" &&
				callee.computed === false &&
				isNode(callee.object) &&
				callee.object.type === "Identifier" &&
				REQUIRE_NAME.test(callee.object.name) &&
				isNode(callee.property) &&
				callee.property.type === "Identifier" &&
				callee.property.name === "resolve"
			) {
				const spec = staticStringOf(firstArg);
				if (spec !== undefined) requires.push({ spec, start: node.start });
			}
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
			} else {
				walk(value);
			}
		}
	})(parsed.ast);
	return { statics, dynamics, requires };
}

function origLineOfSite(parsed, site) {
	const offset = site.start;
	const lineStart = offset > 0 ? parsed.code.lastIndexOf("\n", offset - 1) + 1 : 0;
	const genLine = lineOfOffset(parsed.code, offset);
	const mapped = origLineOf(parsed.segs, genLine, offset - lineStart);
	if (mapped !== undefined) return mapped + 1; // sourcemap lines are 0-based
	// Fallback (no mapping segment): locate the specifier text in the source.
	if (typeof site.spec === "string") {
		const idx = parsed.srcLines.findIndex((l) => l.includes(site.spec));
		if (idx !== -1) return idx + 1;
	}
	return genLine;
}

// ── File sets ────────────────────────────────────────────────────────────────

function gitTrackedFiles() {
	let out = "";
	try {
		// R18-1 (deep-review round 18): `git ls-files -- "src/**/*.ts"` needs a
		// DIRECTORY level between the globstars, so depth-1 files (src/errors.ts,
		// src/i18n.ts) were never listed — they silently escaped the declared-deps
		// and LAZY-marker checks (real tree: 545 of 547 files seen; the fs-walk
		// fallback below cannot fire because the tracked list is non-empty). List
		// the whole `src` tree and filter by extension instead (same shape as
		// check-bundle-staleness.mjs). The fallback still covers fixture trees.
		out = execSync("git ls-files -- src", {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		out = ""; // non-git fixture trees fall through to the fs walk below
	}
	const files = out.split("\n").filter((f) => f.endsWith(".ts"));
	if (files.length > 0) return files.map((f) => resolve(ROOT, f));
	// Fixture mode (no git / no tracked src): walk the fs for src/**/*.ts.
	const srcDir = resolve(ROOT, "src");
	const acc = [];
	(function walkDir(dir) {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const p = resolve(dir, name.name);
			if (name.isDirectory()) walkDir(p);
			else if (name.name.endsWith(".ts")) acc.push(p);
		}
	})(srcDir);
	return acc;
}

const srcFiles = gitTrackedFiles();
const rootEntries = ["index.ts", "index.bundle.ts"]
	.map((f) => resolve(ROOT, f))
	.filter((f) => existsSync(f));
const depCheckFiles = [...srcFiles, ...rootEntries];

// ── Check 1: declared deps ───────────────────────────────────────────────────

function packageNameOf(spec) {
	if (!spec) return undefined;
	if (spec.startsWith(".") || spec.startsWith("/")) return undefined; // relative/absolute
	if (spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("#")) return undefined;
	if (isBuiltin(spec)) return undefined;
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

for (const file of depCheckFiles) {
	const parsed = parseFile(file);
	if (parsed.error) {
		failures.push(`${relative(ROOT, file)}: parse failed — ${parsed.error.message}`);
		continue;
	}
	const { statics, dynamics, requires } = collectImportSites(parsed);
	const sites = [
		...statics,
		...dynamics.filter((d) => typeof d.spec === "string"),
		...requires,
	];
	for (const site of sites) {
		const pkg = packageNameOf(site.spec);
		if (pkg === undefined) continue;
		if (DECLARED.has(pkg)) continue;
		if (OPTIONAL_RUNTIME_REQUIRES.has(pkg)) continue;
		const line = origLineOfSite(parsed, site);
		failures.push(
			`${relative(ROOT, file)}:${line}: ${site.spec} is not declared in ${MANIFEST.name}'s dependencies/peerDependencies`,
		);
	}
}

// ── Check 2: LAZY markers on runtime import() ────────────────────────────────

for (const file of srcFiles) {
	const parsed = parseFile(file);
	if (parsed.error) continue; // already reported above
	const { dynamics } = collectImportSites(parsed);
	for (const site of dynamics) {
		const line = origLineOfSite(parsed, site); // 1-based
		const near = [
			parsed.srcLines[line - 2] ?? "",
			parsed.srcLines[line - 1] ?? "",
			parsed.srcLines[line] ?? "",
		];
		if (near.some((l) => l.includes("// LAZY:"))) continue;
		failures.push(
			`${relative(ROOT, file)}:${line}: runtime import(${site.spec ?? "…"}) without \`// LAZY:\` marker (checked line and ±1)`,
		);
	}
}

// ── Check 3: per-entry budgets ───────────────────────────────────────────────

function resolveRelative(spec, fromFile) {
	const base = resolve(dirname(fromFile), spec);
	const candidates = [base];
	// R18-3 (deep-review round 18): TS ESM style `import ... from "./x.js"`
	// resolves to `./x.ts` on disk and esbuild INLINES it (probe: graph 1/528 vs
	// control 5/528, code present in the bundle). Without the suffix mapping the
	// edge was dropped → budget undercount AND a route around `forbid`.
	if (spec.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
	if (spec.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`);
	if (spec.endsWith(".jsx")) candidates.push(`${base.slice(0, -4)}.tsx`);
	candidates.push(`${base}.ts`, `${base}/index.ts`);
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

for (const [entry, budget] of Object.entries(BUDGETS)) {
	const entryPath = resolve(ROOT, entry);
	if (!existsSync(entryPath)) {
		console.log(`entry ${entry}: not found — skipping budget check (fixture mode)`);
		continue;
	}
	const seen = new Set();
	const queue = [entryPath];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		if (file.endsWith(".json")) continue;
		const parsed = parseFile(file);
		if (parsed.error) continue;
		const { statics, dynamics } = collectImportSites(parsed);
		for (const site of [...statics, ...dynamics]) {
			if (typeof site.spec !== "string" || !site.spec.startsWith(".")) continue;
			const target = resolveRelative(site.spec, file);
			if (target) queue.push(target);
		}
	}
	const graph = [...seen].map((f) => relative(ROOT, f)).sort();
	if (graph.length > budget.maxFiles) {
		failures.push(
			`entry ${entry} reaches ${graph.length} files, budget ${budget.maxFiles}\n` +
				graph.map((f) => `    ${f}`).join("\n"),
		);
	}
	for (const pattern of budget.forbid ?? []) {
		// R18-3 windows fix (wave-6 CI): graph paths come from path.relative() —
		// backslashes on Windows — while forbid patterns are written with forward
		// slashes ("test/"). Normalize before the substring match or the gate
		// silently passes every forbidden edge on Windows.
		const hit = graph.filter((f) => f.replaceAll("\\", "/").includes(pattern));
		if (hit.length > 0) {
			failures.push(`entry ${entry} must not reach ${pattern}:\n` + hit.map((f) => `    ${f}`).join("\n"));
		}
	}
	console.log(`entry ${entry}: ${graph.length}/${budget.maxFiles} files in value-import graph.`);
}

if (failures.length > 0) {
	console.error(`Declared-deps/lazy-import gate: ${failures.length} violation(s):\n  ` + failures.join("\n  "));
	process.exit(1);
}

// ── Check 4: dist-side assertion (RR-021 WI-2.3b, unchanged semantics) ───────
// The heavy deps below are INTENTIONALLY external + lazy (sync createRequire
// shims or await import). A module-scope hoisted `from"pkg"` import in the
// minified bundle means someone reintroduced an eager import — this is the
// C1/H1 regression gate. Dynamic (`import("pkg")`) and require()-shim forms
// are fine and do not match. dist/ is committed, so this runs even pre-build.
// KNOWN GAP (unchanged from RR-021): only the `from"pkg"` specifier form is
// matched — a bare side-effect `import"pkg"` would escape. Acceptable: esbuild
// emits the `from` form for named/default imports; tighten if a new hoisting
// shape appears.
const HEAVY_PKGS = ["esbuild", "acorn", "diff", "jiti", "cli-highlight", "yaml", "ajv"];
const distPath = resolve(ROOT, "dist/index.mjs");
if (existsSync(distPath)) {
	const dist = readFileSync(distPath, "utf8");
	const hoisted = [];
	for (const pkg of HEAVY_PKGS) {
		const re = new RegExp(`from\\s*["']${pkg}["']`);
		if (re.test(dist)) hoisted.push(pkg);
	}
	if (hoisted.length > 0) {
		console.error(
			`dist/index.mjs contains module-scope hoisted import(s) of heavy external package(s): ${hoisted.join(", ")}. ` +
				"These must stay lazy (sync createRequire shim or await import) — see RR-021 WI-2.1/WI-2.2 and the invariants.",
		);
		process.exit(1);
	}
	console.log("dist/index.mjs: no hoisted imports of heavy externals (esbuild/acorn/diff/jiti/cli-highlight/yaml/ajv).");
} else {
	console.log("dist/index.mjs not found — skipping dist-side hoisted-import assertion.");
}

console.log("Declared-deps gate: all runtime imports declared; all dynamic imports LAZY-marked; entry graphs within budget.");
