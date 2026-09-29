import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// RR-021 WI-2.3: the check previously only matched `await import(` — bare
// runtime `import()` expressions (e.g. Promise.all([import(...)]), void import())
// escaped it entirely (audit "gate blind spot #2"). We now flag EVERY runtime
// dynamic-import position. Type-position `import("...").SomeType` annotations
// are erased at compile time (zero runtime cost), so they are skipped via a
// positive runtime-pattern list plus declaration/comment skips.
const RUNTIME_IMPORT_PATTERNS = [
	"await import\\(", // explicit await (original rule)
	"=\\s*import\\(", // assignment (space optional — `=import(` escaped the `= import\(` form)
	"void import\\(", // fire-and-forget
	"return import\\(", // return position
	"^\\s*import\\(", // expression/statement start (Promise.all arrays, warmup)
	"\\? import\\(", // ternary branch
	"&& import\\(", // short-circuit branch
	"\\|\\| import\\(", // short-circuit branch
	"[(,{\\[]\\s*import\\(", // call/array/object-argument (RR-021 round-2: `foo(import())`, `Promise.allSettled([import()])`, `[import()]` escaped the line-start rule). KNOWN GAPS (RR-021 round-3, accepted): ternary-else `x ? y : import(...)`, object-property values `{ foo: import(...) }`, case/label positions `case 1: import(...)` RESIDUAL FALSE-SKIP (round-4, accepted): a RUNTIME member-access form `import("./x").then(...)` on a line that also has an earlier `: identifier` colon-shape satisfies both skip conditions and escapes — closing it needs AST parsing or a narrower skip rule. — closing them needs a `:\s*import\(` rule that would false-flag return-type annotations.
	">\\s*import\\(", // arrow body (RR-021 round-2: `arr.map((m) => import(m))` escaped every prior rule)
];
const GREP_ARGS = RUNTIME_IMPORT_PATTERNS.map((p) => `-e "${p}"`).join(" ");

// RR-021 round-2 review: `git grep` exits 1 (and execSync therefore throws)
// when there are ZERO matches — i.e. on a fully-clean src/. Treat status 1 as
// "no matches" instead of crashing the gate on a clean tree (fail-closed only
// for real anomalies: any other non-zero status still propagates).
let out = "";
try {
	out = execSync(`git grep -nE ${GREP_ARGS} -- "src/**/*.ts"`, { encoding: "utf-8" });
} catch (err) {
	if (err?.status !== 1) throw err;
	out = err?.stdout?.toString() ?? "";
}

const bad = [];
const fileCache = new Map();

for (const line of out.split("\n").filter(Boolean)) {
	if (line.includes("// LAZY:")) continue;
	const m = line.match(/^([^:]+):(\d+):/);
	if (!m) continue;
	const [, file, lineNum] = m;
	if (!fileCache.has(file)) fileCache.set(file, readFileSync(file, "utf-8").split(/\r?\n/));
	const lines = fileCache.get(file);
	const idx = Number(lineNum) - 1;
	const prevLine = lines[idx - 1] ?? "";
	// Biome's formatter hoists trailing comments on block-opening lines into
	// the block body (first statement line) — accept a marker there too.
	const nextLine = lines[idx + 1] ?? "";
	if (prevLine.includes("// LAZY:") || nextLine.includes("// LAZY:")) continue;
	// Skip type-only declarations (`type X = import("...").T` is erased).
	const content = lines[Number(lineNum) - 1] ?? "";
	const stripped = content.trimStart();
	if (
		stripped.startsWith("//") ||
		stripped.startsWith("*") ||
		stripped.startsWith("/*") ||
		stripped.startsWith("type ") ||
		stripped.startsWith("interface ") ||
		stripped.startsWith("declare ")
	)
		continue;
	// Skip type-ANNOTATION positions (RR-021 round-2): a generic inside a
	// variable's type annotation — `const X: Record<string, import("./f.ts").T>` —
	// is erased at compile time. The `[(,]\s*import\(` pattern needed for
	// `Promise.allSettled([import()])` also matches the generic's comma, so
	// recognize the annotation shape: colon + identifier + no `=`/`(` until the
	// import, AND require a member-access suffix `import("...").T` (RR-021
	// round-3: type annotations always access a member; runtime arg positions
	// like `Promise.all([cond ? a : b, await import("./x")])` are terminal, so
	// the compound-colon shape no longer false-skips them). A bare ternary
	// `x ? y : import(...)` still does not match (no identifier between `:` and
	// `import(`), so runtime positions stay flagged.
	if (/:\s*\w+[^=(]*import\(/.test(content) && /import\(["'][^"']*["']\)\s*\./.test(content)) continue;
	bad.push(line);
}

if (bad.length > 0) {
	console.error("Dynamic runtime imports without `// LAZY:` marker:\n" + bad.join("\n"));
	process.exit(1);
}

// ── Dist-side assertion (RR-021 WI-2.3b) ────────────────────────────────────
// The heavy deps below are INTENTIONALLY external + lazy (sync createRequire
// shims or await import). A module-scope hoisted `from"pkg"` import in the
// minified bundle means someone reintroduced an eager import — this is the
// C1/H1 regression gate. Dynamic (`import("pkg")`) and require()-shim forms
// are fine and do not match. dist/ is committed, so this runs even pre-build.
// KNOWN GAP (RR-021 review): only the `from"pkg"` specifier form is matched —
// a bare side-effect `import"pkg"` or inline array form would escape. Acceptable
// as a regression gate (esbuild emits `from`-form for named/default imports);
// tighten here if a new hoisting shape appears.
const HEAVY_PKGS = ["esbuild", "acorn", "diff", "jiti", "cli-highlight", "yaml", "ajv"];
const distPath = path.resolve(import.meta.dirname, "../dist/index.mjs");
if (existsSync(distPath)) {
	const dist = readFileSync(distPath, "utf-8");
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

console.log("All dynamic runtime imports have `// LAZY:` marker.");
