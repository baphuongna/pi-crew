/**
 * EXT-10 regression guard: src/subagents/ files must not be pure-indirection
 * re-export shims (`export * from "..."` with no other code and no comment).
 *
 * Pure indirection adds a hop without abstraction value. If a file genuinely
 * needs to re-export (renaming, deprecation alias, barrel with multiple
 * sources), it must carry a comment explaining WHY.
 *
 * If the directory has been removed entirely (all indirection inlined), this
 * test passes vacuously.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SUBAGENTS_DIR = join(import.meta.dirname, "..", "..", "src", "subagents");

/** Matches a file whose entire content is a single `export * from "..."`. */
const PURE_REEXPORT = /^export\s+\*\s+from\s+["'][^"']+["'];?\s*$/;

/** Recursively collect .ts file names (relative to SUBAGENTS_DIR). */
function listTsFiles(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...listTsFiles(full, join(prefix, entry)));
		} else if (entry.endsWith(".ts")) {
			out.push(join(prefix, entry));
		}
	}
	return out;
}

describe("EXT-10 subagents-no-indirection", () => {
	const files = existsSync(SUBAGENTS_DIR) && statSync(SUBAGENTS_DIR).isDirectory() ? listTsFiles(SUBAGENTS_DIR) : [];

	for (const file of files) {
		it(`${file} is not a pure-indirection re-export shim`, () => {
			const content = readFileSync(join(SUBAGENTS_DIR, file), "utf8");
			const trimmed = content.replace(/^#!.*$/m, "").trim();
			assert.ok(
				!PURE_REEXPORT.test(trimmed),
				`${file} is a pure-indirection re-export shim. Inline it (update callers to import the real module directly) or add a comment explaining the value it adds.`,
			);
		});
	}

	it("no pure-indirection shims remain (regression guard)", () => {
		const shims = files.filter((file) => {
			const content = readFileSync(join(SUBAGENTS_DIR, file), "utf8");
			const trimmed = content.replace(/^#!.*$/m, "").trim();
			return PURE_REEXPORT.test(trimmed);
		});
		assert.deepEqual(shims, [], `Pure-indirection shims found: ${shims.join(", ")}`);
	});
});
