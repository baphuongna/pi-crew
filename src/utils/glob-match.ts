/**
 * Glob matcher with ReDoS protection.
 *
 * Extracted from `src/extension/team-tool/api.ts` so the security-critical
 * ReDoS guard (pattern length cap + path-safe wildcards) is testable in
 * isolation without importing the heavy `team-tool/api` transitive graph
 * (which pulls in `pi-coding-agent` peer deps unavailable in unit tests).
 *
 * Semantics (intentional, path-safe):
 *   - `*` matches a run of non-separator chars (does NOT cross `/`)
 *   - `?` matches a single non-separator char
 *   - all other regex metacharacters are escaped (literal match)
 *   - patterns longer than 200 chars are rejected outright (ReDoS backstop)
 *
 * @see test/unit/glob-match-redos.test.ts — the regression suite for the
 * catastrophic-backtracking fix (MEDIUM #4).
 */

// Prevent ReDoS: reject excessively long patterns.
const MAX_GLOB_PATTERN_LEN = 200;

export function globMatch(value: string, pattern: string): boolean {
	if (pattern.length > MAX_GLOB_PATTERN_LEN) return false;
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars
		.replace(/\*/g, "[^/]*") // * matches non-slash characters only
		.replace(/\?/g, "[^/]"); // ? matches single non-slash
	return new RegExp(`^${regex}$`).test(value);
}
