/**
 * Regression test for the Windows `${APPDATA}` bug class (v0.9.0).
 *
 * Root cause: subprocess env allowlists stripped all Windows-essential env
 * vars, so child processes couldn't resolve the npm-global prefix and created
 * a phantom literal `${APPDATA}/npm` directory + leaked `${APPDATA}` into
 * .gitignore. The fix centralizes these vars in WINDOWS_ESSENTIAL_ENV_VARS and
 * requires every allowlist site to use it (no inline hardcoding).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../../../src/utils/env-allowlist.ts";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
const ALLOWED_CANONICAL_FILE = path.join(SRC_DIR, "utils", "env-allowlist.ts");

function listTsFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listTsFiles(full, acc);
		else if (entry.name.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

test("WINDOWS_ESSENTIAL_ENV_VARS contains exactly the 7 Windows essentials", () => {
	assert.deepEqual([...WINDOWS_ESSENTIAL_ENV_VARS], ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "SystemRoot", "ComSpec", "TEMP", "TMP"]);
});

test("no src/ file hardcodes the Windows essentials inline (must spread WINDOWS_ESSENTIAL_ENV_VARS)", () => {
	// Every Windows-essential var, quoted as a string literal, must appear ONLY
	// in the canonical constant file. Any other src/ file containing the quoted
	// literal means an allowlist hardcodes it instead of spreading the constant
	// — a regression of the ${APPDATA} bug.
	const offenders: string[] = [];
	for (const file of listTsFiles(SRC_DIR)) {
		if (file === ALLOWED_CANONICAL_FILE) continue;
		const src = fs.readFileSync(file, "utf-8");
		for (const v of WINDOWS_ESSENTIAL_ENV_VARS) {
			const needle = `"${v}"`;
			if (src.includes(needle)) {
				offenders.push(`${path.relative(SRC_DIR, file)}: hardcoded ${needle}`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"These files hardcode Windows env vars inline — use ...WINDOWS_ESSENTIAL_ENV_VARS instead:\n" + offenders.join("\n"),
	);
});
