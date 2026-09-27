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
	"= import\\(", // assignment / type-alias-free assignment
	"void import\\(", // fire-and-forget
	"return import\\(", // return position
	"^\\s*import\\(", // expression/statement start (Promise.all arrays, warmup)
	"\\? import\\(", // ternary branch
	"&& import\\(", // short-circuit branch
	"\\|\\| import\\(", // short-circuit branch
];
const GREP_ARGS = RUNTIME_IMPORT_PATTERNS.map((p) => `-e "${p}"`).join(" ");

const out = execSync(
	`git grep -nE ${GREP_ARGS} -- "src/**/*.ts"`,
	{ encoding: "utf-8" },
);

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
		const re = new RegExp(`from["']${pkg}["']`);
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
