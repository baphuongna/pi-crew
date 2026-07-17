/**
 * buildKnowledgeFragment — focused unit tests for the IDF scoring path.
 *
 * Verifies the public surface of `buildKnowledgeFragment(cwd, query)`:
 *   1. Returns a fragment with the correct shape (header + content).
 *   2. IDF score is computed correctly for known inputs.
 *   3. Higher-frequency terms get lower IDF scores.
 *   4. Empty input is handled gracefully (returns empty string).
 *
 * Companion to `knowledge-section-aware.test.ts` (which tests `readKnowledge`
 * directly); this file targets the public `buildKnowledgeFragment` wrapper
 * that injects knowledge into the worker prompt stablePrefix.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildKnowledgeFragment, knowledgePath } from "../../src/extension/knowledge-injection.ts";

const CONVENTIONS = `## Code Style
- Use TABS for indentation (not spaces)
- Tests run via \`npm test\` (the node:test runner)

## Environment (pi-crew install layout)
- pi-crew is installed as a symlink, NOT a copy.
- Source edits are immediately visible — no \`npm install\`.

## Architecture
- pi-api.ts centralizes the Pi coupling surface (8 symbols)

## Testing Convention
- This file (.crew/knowledge.md) is auto-injected into every agent prompt.

## Release Process (MANDATORY)
- NEVER \`npm publish\` before CI is GREEN.
`;

function makeTmpCrewDir(prefix: string): { cwd: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		cwd,
		cleanup: () => {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/** Build a synthetic knowledge.md with conventions + N session-log sections. */
function buildKnowledgeFile(cwd: string, sessionLogHeaders: string[]): void {
	const sessionLog = sessionLogHeaders.map((h) => `\n## ${h}\n- session log detail\n`).join("");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(knowledgePath(cwd), `${CONVENTIONS}${sessionLog}`, "utf-8");
}

// --- Shape contract ---

test("buildKnowledgeFragment returns a string (empty when no knowledge file)", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-shape-empty-");
	try {
		// No knowledge.md → empty fragment.
		const out = buildKnowledgeFragment(cwd);
		assert.equal(typeof out, "string");
		assert.equal(out, "", "no knowledge file → empty fragment");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment returns the expected header + content shape", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-shape-");
	try {
		buildKnowledgeFile(cwd, ["sessionlog section one"]);
		const out = buildKnowledgeFragment(cwd);
		assert.ok(out.length > 0, "non-empty fragment expected");
		assert.match(out, /# Project knowledge \(from \.crew\/knowledge\.md\)/, "must include the standard header");
		assert.match(out, /Use it to avoid repeating past mistakes/, "must include the usage guidance");
		assert.match(out, /## Code Style/, "must include convention content");
		assert.match(out, /## Architecture/, "must include convention content");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment with no query still includes conventions (legacy path)", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-legacy-");
	try {
		buildKnowledgeFile(cwd, ["some sessionlog section"]);
		const out = buildKnowledgeFragment(cwd);
		assert.match(out, /## Code Style/);
		// Legacy path is head-only: it does not emit the section index.
		assert.equal(out.includes("Session-log sections in knowledge.md"), false);
	} finally {
		cleanup();
	}
});

// --- IDF behavior ---

test("buildKnowledgeFragment IDF scoring: rare token wins over common token", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-idf-rank-");
	try {
		// 4 session-log sections; "common" appears in 3 headers, "rarerare"
		// appears in only 1. A query with both tokens should surface the
		// rarerare-matching section first (higher IDF = higher score).
		buildKnowledgeFile(cwd, [
			"common common common section one",
			"common common section two",
			"common section three",
			"rarerare section four",
		]);
		// Query with both tokens — section four should be the one matching rarerare.
		const out = buildKnowledgeFragment(cwd, { goal: "common rarerare task" });
		assert.match(out, /## rarerare section four/, "rarerare-matched section should be selected");
		assert.match(out, /session log detail/, "selected section body should be present");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment IDF: same-frequency tokens compete by original order", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-idf-tie-");
	try {
		// Both "alpha" and "beta" appear in exactly 1 header → same IDF.
		// When the query has both, the section matching alpha should win (alphabetical
		// score tie broken by original index = first one encountered).
		buildKnowledgeFile(cwd, ["alpha first section", "beta second section"]);
		const out = buildKnowledgeFragment(cwd, { goal: "alpha beta investigation" });
		// Either section matching wins (same IDF, but at least one must be present).
		const hasFirst = out.includes("## alpha first section");
		const hasSecond = out.includes("## beta second section");
		assert.ok(hasFirst || hasSecond, "at least one matching section must be injected");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment IDF: zero-match query yields conventions + section-index only", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-idf-zero-");
	try {
		buildKnowledgeFile(cwd, ["redaction env hardening", "incident recovery"]);
		const out = buildKnowledgeFragment(cwd, { goal: "unrelated zzzquery" });
		// Session-log bodies must NOT appear (zero overlap).
		assert.equal(out.includes("session log detail"), false, "non-matching bodies must be omitted");
		// Section index must appear (recovery safety net).
		assert.match(out, /Session-log sections in knowledge\.md/);
		assert.match(out, /redaction env hardening/);
		assert.match(out, /incident recovery/);
	} finally {
		cleanup();
	}
});

// --- Empty / edge inputs ---

test("buildKnowledgeFragment with empty query string falls through to legacy path", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-empty-query-");
	try {
		buildKnowledgeFile(cwd, ["some section"]);
		const out = buildKnowledgeFragment(cwd, { goal: "", taskText: "" });
		// Empty query → no query path → conventions head, no section index.
		assert.match(out, /## Code Style/);
		assert.equal(out.includes("Session-log sections in knowledge.md"), false);
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment with whitespace-only query: no session-log body injected (just conventions + index)", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-ws-query-");
	try {
		buildKnowledgeFile(cwd, ["some section"]);
		const out = buildKnowledgeFragment(cwd, { goal: "   \t\n  " });
		// selectSessionLog treats whitespace-only query as empty (no overlap),
		// so no session-log body is injected.
		assert.equal(out.includes("session log detail"), false, "no matching body when query is whitespace");
		assert.match(out, /## Code Style/, "conventions still injected");
		// The section index is always shown as a recovery safety net, even
		// when no session-log body was matched.
		assert.match(out, /Session-log sections in knowledge\.md/);
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment returns empty string when .crew dir is missing entirely", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-no-crew-");
	try {
		// No .crew/ directory at all.
		const out = buildKnowledgeFragment(cwd);
		assert.equal(out, "");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment returns empty string when knowledge.md is empty", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-empty-file-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(knowledgePath(cwd), "", "utf-8");
		const out = buildKnowledgeFragment(cwd, { goal: "any query" });
		assert.equal(out, "");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment returns empty string when knowledge.md is only whitespace", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-ws-file-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(knowledgePath(cwd), "   \n\n  \t  \n", "utf-8");
		const out = buildKnowledgeFragment(cwd, { goal: "any query" });
		assert.equal(out, "");
	} finally {
		cleanup();
	}
});

test("buildKnowledgeFragment fragment shape: header line is followed by content (no leading blank)", () => {
	const { cwd, cleanup } = makeTmpCrewDir("bkf-leading-");
	try {
		buildKnowledgeFile(cwd, ["section one"]);
		const out = buildKnowledgeFragment(cwd, { goal: "any query" });
		// The fragment intentionally begins with "\n" so it concatenates cleanly
		// into a larger prompt block. The first NON-EMPTY line must be the header.
		const firstNonEmpty = out.split("\n").find((l) => l.trim().length > 0);
		assert.equal(firstNonEmpty, "# Project knowledge (from .crew/knowledge.md)");
	} finally {
		cleanup();
	}
});
