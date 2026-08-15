#!/usr/bin/env node
/**
 * CI gate: forbid raw `process.env` reads of the crew env-var families
 * (`PI_CREW_*` / `PI_TEAMS_*`) outside the central registry.
 *
 * Phase 3.2 (maintainability refactor, refactor-plan row 3.2) introduces
 * `src/config/env-vars.ts` as the SINGLE home for reading crew env vars.
 * Every read must go through the registry getter (e.g.
 * `getCrewEnv("PI_CREW_MAX_OUTPUT")`), so defaults, parsing, deprecated
 * aliases and `PI_TEAMS_*` mirrors live in exactly one place. This gate
 * fails any raw read that bypasses it.
 *
 * What is scanned:
 *   - Raw dot access:         `process.env.PI_CREW_X` / `process.env.PI_TEAMS_X`
 *   - Raw bracket access:     `process.env["PI_CREW_X"]` / `process.env['PI_TEAMS_X']`
 *                             / `process.env[\`PI_CREW_X\`]` (plain template, no `${}`)
 *   - Const-indirect bracket: `process.env[SOME_CONST]` where `SOME_CONST` is
 *     declared in the same file with a `PI_CREW_*` / `PI_TEAMS_*` string value
 *     (e.g. `const SECRET_ENV_VAR = "PI_CREW_RPC_SECRET"` → rpc-hmac.ts; also
 *     `KEYBINDINGS_ENV`, `PEER_DEP_DIR_ENV`, `PI_CREW_MAX_OUTPUT_ENV`).
 *   - Dynamic `process.env[name]` reads (function-parameter keys, e.g.
 *     prompt-runtime.ts `readBooleanEnv(name)` and env-filter.ts namespace
 *     iteration) carry no literal token — NOT statically resolvable, out of
 *     scope by construction; the codemod converts their literal call sites.
 *
 * What is EXEMPT:
 *   - `src/config/env-vars.ts` itself (the registry) — same rule per scan
 *     root (`<root>/config/env-vars.ts`).
 *   - Whole-line comments (`//`, `*`, `/*`, `<!--`) — documentation prose that
 *     mentions the raw access is not a read (e.g. parent-guard.ts JSDoc and
 *     env-vars.ts's own design notes).
 *
 * What is NOT flagged (writes are fine — the registry is read-side):
 *   - Assignments:       `process.env.PI_CREW_BACKGROUND_MODE = "1"`
 *                        (src/runtime/background-runner.ts:713, :833)
 *   - Secret set/clear:  `process.env[SECRET_ENV_VAR] = secret` and
 *                        `delete process.env[SECRET_ENV_VAR]`
 *                        (src/extension/rpc-hmac.ts:31, :36)
 *   - Compound writes:   `+=`, `||=`, `??=`, `++`, `--`, etc.
 *   - `===` / `==` comparisons ARE reads and ARE flagged.
 *   Detection is structural (what follows the access / `delete` prefix), so
 *   no per-site allowlist needs maintaining.
 *
 * Scope policy (test files):
 *   - Default scope is `src/` ONLY. Test files intentionally use raw
 *     `process.env` for fixtures (~1143 raw matches across 96 test files per
 *     the Phase 3.2 recon): they SET env vars before imports and are not part
 *     of the runtime read path. The registry codemod targets src/ reads;
 *     converting test fixtures is out of scope for this phase, and this gate
 *     does not edit files.
 *   - Pass `--include-tests` to also scan `test/` (expected to fail until
 *     tests are migrated; kept as an opt-in for the verifier / future work).
 *
 * Usage:
 *   node scripts/check-env-vars.mjs                 # scan src/
 *   node scripts/check-env-vars.mjs --include-tests # scan src/ + test/
 *   node scripts/check-env-vars.mjs <dir> [<dir>…]  # scan given dirs (self-test fixture)
 *
 * Exits:
 *   0 — no raw crew-family reads found outside the registry
 *   1 — at least one raw read found (file:line:col listing)
 *   2 — a scan directory does not exist
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const FAMILY_RE = /^(PI_CREW_[A-Z0-9_]+|PI_TEAMS_[A-Z0-9_]+)$/;
const DOT_RE = /process\.env\??\.(PI_CREW_[A-Z0-9_]+|PI_TEAMS_[A-Z0-9_]+)/g;
const LITERAL_RE = /process\.env\s*\[\s*(["'`])(PI_CREW_[A-Z0-9_]+|PI_TEAMS_[A-Z0-9_]+)\1\s*\]/g;
const CONST_BRACKET_RE = /process\.env\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
const CONST_DECL_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])(PI_CREW_[A-Z0-9_]+|PI_TEAMS_[A-Z0-9_]+)\2/g;

/** Locate the end (0-based) of the `process.env…` access starting at `start`. */
function accessEnd(line, start) {
	const rest = line.slice(start);
	const m = rest.match(/^process\.env\??(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]?[A-Za-z_$][\w$]*["'`]?\s*\])/);
	if (!m) return start + "process.env".length;
	if (m[1] !== undefined) {
		return start + rest.indexOf(m[1]) + m[1].length;
	}
	const close = rest.indexOf("]");
	return start + close + 1;
}

/** True when the remainder of the line (after the access) is a WRITE. */
function isWriteTail(rest) {
	const trimmed = rest.replace(/^\s+/, "");
	if (trimmed.startsWith("delete")) return true;
	if (/^(?:\+\+|--)/.test(trimmed)) return true;
	if (/^[+\-*/%&|^]?=/.test(trimmed)) return !trimmed.startsWith("==");
	if (/^(?:&&=|\|\|=|\?\?=)/.test(trimmed)) return true;
	return false;
}

/** True when the access at `matchIndex` sits inside a `delete` statement. */
function isInsideDelete(line, matchIndex) {
	const before = line.slice(0, matchIndex);
	const statementStart = before.lastIndexOf(";") + 1;
	return /delete\s*$/.test(before.slice(statementStart).trim());
}

/** True when the whole line is a comment (no code on it). */
function isWholeLineComment(line) {
	const t = line.trimStart();
	return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--");
}

/** Collect `NAME -> "PI_CREW_…"` const bindings declared in this file. */
function collectEnvConsts(source) {
	const map = new Map();
	for (const m of source.matchAll(CONST_DECL_RE)) map.set(m[1], m[3]);
	return map;
}

/** Recursively list *.ts-ish files under a directory. */
function listFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) listFiles(full, out);
		else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
	}
	return out;
}

const args = process.argv.slice(2);
const includeTests = args.includes("--include-tests");
const scanDirs = args.filter((a) => a !== "--include-tests");

let roots;
if (scanDirs.length > 0) {
	roots = scanDirs.map((d) => resolve(d));
} else {
	roots = [join(ROOT, "src")];
	if (includeTests) roots.push(join(ROOT, "test"));
}

const violations = [];
const scannedFiles = [];

for (const root of roots) {
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
		console.error(`[check-env-vars] scan dir not found: ${root}`);
		process.exit(2);
	}
	const exempt = join(root, "config", "env-vars.ts");
	for (const file of listFiles(root)) {
		if (file === exempt) continue;
		scannedFiles.push(file);
		const source = readFileSync(file, "utf8");
		const envConsts = collectEnvConsts(source);
		const lines = source.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isWholeLineComment(line)) continue;
			const findings = []; // { col (1-based), name }
			for (const m of line.matchAll(DOT_RE)) findings.push({ col: m.index + 1, name: m[1] });
			for (const m of line.matchAll(LITERAL_RE)) findings.push({ col: m.index + 1, name: m[2] });
			for (const m of line.matchAll(CONST_BRACKET_RE)) {
				const resolved = envConsts.get(m[1]);
				if (resolved && FAMILY_RE.test(resolved)) findings.push({ col: m.index + 1, name: resolved });
			}
			for (const f of findings) {
				const start = f.col - 1;
				if (isInsideDelete(line, start)) continue;
				if (isWriteTail(line.slice(accessEnd(line, start)))) continue;
				const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : file;
				violations.push(
					`${rel}:${i + 1}:${f.col}: raw read of '${f.name}' via process.env — use getCrewEnv("${f.name}") from src/config/env-vars.ts`,
				);
			}
		}
	}
}

if (violations.length > 0) {
	console.error(
		`[check-env-vars] ${violations.length} raw crew-family env read(s) outside src/config/env-vars.ts:`,
	);
	for (const v of violations) console.error(`  ${v}`);
	console.error("");
	console.error('Fix: route every crew env read through the registry — `getCrewEnv("PI_CREW_X")`');
	console.error("from src/config/env-vars.ts (Phase 3.2 of docs/refactor-plan.md).");
	console.error("Raw WRITES (assignments / delete / secret set-clear) are allowed and not flagged.");
	process.exit(1);
}

const rootsLabel = roots.map((r) => (r.startsWith(ROOT) ? r.slice(ROOT.length) : r)).join(", ");
console.error(
	`[check-env-vars] OK: no raw crew-family env reads outside the registry (${scannedFiles.length} file(s) scanned: ${rootsLabel})`,
);
process.exit(0);
