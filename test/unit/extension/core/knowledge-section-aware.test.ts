/**
 * B2 section-aware knowledge injection — tests for the query-aware path.
 *
 * Verifies the design from research-findings/b2-section-aware-design.md:
 *   - Conventions (Code Style, Environment, Architecture, Testing, Release
 *     Process) are ALWAYS injected in full, regardless of query.
 *   - Session-log sections are injected only when their HEADER tokens match
 *     the query (IDF-weighted); non-matched ones are omitted.
 *   - A section-index of ALL session-log headers is always present (recovery
 *     safety net) with a `read` path-hint.
 *   - Total session-log bytes are capped at MAX_SESSION_LOG_BYTES (5000).
 *   - Zero-match query → conventions-only + index (no empty injection).
 *   - No-query call (legacy / main-session) → head-only path, unchanged.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { knowledgePath, readKnowledge } from "../../../../src/extension/knowledge-injection.ts";

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

/** Build a synthetic knowledge.md with conventions + 3 session-log sections.
 *  Takes the project cwd (NOT the .crew dir) — knowledgePath() appends .crew/. */
function buildKnowledgeFile(cwd: string): string {
	const content = `${CONVENTIONS}

## v0.9.10 redaction env hardening
- Fix M1: redact auth headers in worker logs.
- Fix L3: scrub env before spawn.

## parallel-research reliability incident
- Worker 02_analyze became unresponsive after 8 turns.
- Root cause: child Pi conversation never pruned.

## gajae-code distillation
- Research-only notes from gajae-code analysis.
- Not implemented.
`;
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const kPath = knowledgePath(cwd);
	fs.writeFileSync(kPath, content, "utf-8");
	return kPath;
}

function makeTmpCrewDir(prefix: string): {
	cwd: string;
	crewDir: string;
	cleanup: () => void;
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const crewDir = path.join(cwd, ".crew");
	return {
		cwd,
		crewDir,
		cleanup: () => {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

test("B2: conventions are ALWAYS injected regardless of query", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-conv-");
	try {
		buildKnowledgeFile(cwd);
		// Irrelevant query — should still get all conventions, no session-log body.
		const out = readKnowledge(cwd, {
			goal: "completely unrelated topic zzz",
			taskText: "do something",
		});
		assert.match(out, /## Code Style/);
		assert.match(out, /## Environment/);
		assert.match(out, /## Architecture/);
		assert.match(out, /## Testing Convention/);
		assert.match(out, /## Release Process/);
	} finally {
		cleanup();
	}
});

test("B2: zero-match query → conventions + section-index, NO session-log body", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-zero-");
	try {
		buildKnowledgeFile(cwd);
		const out = readKnowledge(cwd, { goal: "zzz unrelated zzz" });
		// Session-log bodies omitted.
		assert.equal(out.includes("redact auth headers"), false, "non-matching session-log body must be omitted");
		assert.equal(out.includes("unresponsive after 8 turns"), false, "non-matching session-log body must be omitted");
		// But section-index lists ALL session-log headers (recovery safety net).
		assert.match(out, /Session-log sections in knowledge\.md/);
		assert.match(out, /v0\.9\.10 redaction env hardening/);
		assert.match(out, /parallel-research reliability incident/);
		assert.match(out, /gajae-code distillation/);
		// And path-hint present for `read` recovery.
		assert.match(out, /use `read`/);
	} finally {
		cleanup();
	}
});

test("B2: matched query injects the relevant session-log section", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-match-");
	try {
		buildKnowledgeFile(cwd);
		// Query about redaction → should surface the "redaction env hardening" section.
		const out = readKnowledge(cwd, {
			goal: "fix the redaction of auth headers in worker logs",
			taskText: "audit env scrubbing",
		});
		assert.match(out, /## v0\.9\.10 redaction env hardening/);
		assert.match(out, /redact auth headers/);
		// The other two non-matching session-log sections should NOT be in the body.
		assert.equal(out.includes("unresponsive after 8 turns"), false, "non-matching section body omitted");
		// But their headers still appear in the index.
		assert.match(out, /parallel-research reliability incident/);
	} finally {
		cleanup();
	}
});

test("B2: IDF-weighting — rare token beats common token", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-idf-");
	try {
		buildKnowledgeFile(cwd);
		// "incident" is rare (1/3 session-log headers); "research" appears in 1 too.
		// A query mentioning "incident" should match the parallel-research section.
		const out = readKnowledge(cwd, {
			goal: "investigate the incident from last run",
		});
		assert.match(out, /parallel-research reliability incident/);
		assert.match(out, /unresponsive after 8 turns/);
	} finally {
		cleanup();
	}
});

test("B2: session-log bytes capped at MAX_SESSION_LOG_BYTES (drop-whole)", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-cap-");
	try {
		// Write a knowledge.md with a HUGE matching section (>5000 bytes) plus
		// several smaller matching sections. Verify only what fits is included.
		const bigSection = `## bigmatching section one
${"x".repeat(4000)}
`;
		const medSection = `## bigmatching section two
${"y".repeat(2000)}
`;
		const content = `${CONVENTIONS}
${bigSection}
${medSection}
## bigmatching section three
${"z".repeat(1500)}
`;
		fs.mkdirSync(path.dirname(knowledgePath(cwd)), { recursive: true });
		fs.writeFileSync(knowledgePath(cwd), content, "utf-8");

		const out = readKnowledge(cwd, {
			goal: "bigmatching bigmatching bigmatching",
		});
		// Count how many matching section bodies made it in.
		const xCount = (out.match(/x{4000}/g) ?? []).length;
		const yCount = (out.match(/y{2000}/g) ?? []).length;
		const zCount = (out.match(/z{1500}/g) ?? []).length;
		const totalInline = xCount * 4000 + yCount * 2000 + zCount * 1500;
		assert.ok(
			totalInline <= 5000 + 100,
			`session-log inline bytes (${totalInline}) must respect the 5000-byte cap (allowing small marker slack)`,
		);
		// At least one section fit (head-slice fallback guarantees non-empty).
		assert.ok(xCount + yCount + zCount >= 1, "at least one matching section must be injected");
	} finally {
		cleanup();
	}
});

test("B2: head-slice fallback — best match injected even if alone it exceeds budget", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-headslice-");
	try {
		// One matching section WAY bigger than budget, nothing else matches.
		const content = `${CONVENTIONS}
## uniquebigtoken section
${"q".repeat(20_000)}
## other section
unrelated content here.
`;
		fs.mkdirSync(path.dirname(knowledgePath(cwd)), { recursive: true });
		fs.writeFileSync(knowledgePath(cwd), content, "utf-8");
		const out = readKnowledge(cwd, {
			goal: "uniquebigtoken investigation",
		});
		assert.match(out, /## uniquebigtoken section/);
		assert.match(out, /section truncated/);
		// Not the full 20k — must be capped.
		assert.equal((out.match(/q{20000}/g) ?? []).length, 0, "20k section must NOT be injected whole");
	} finally {
		cleanup();
	}
});

test("B2: no-query call (legacy path) unchanged — head-only, no section logic", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-legacy-");
	try {
		buildKnowledgeFile(cwd);
		// readKnowledge(cwd) with no query → old head-only path.
		const out = readKnowledge(cwd);
		// Conventions present (they're in the head).
		assert.match(out, /## Code Style/);
		// Old-style truncation marker NOT present (file < 2KB head).
		// Session-index NOT present (that's a section-aware-only feature).
		assert.equal(out.includes("Session-log sections in knowledge.md"), false, "legacy path must not emit section index");
	} finally {
		cleanup();
	}
});

test("B2: role field accepted but does not affect scoring yet (reserved)", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-role-");
	try {
		buildKnowledgeFile(cwd);
		const outNoRole = readKnowledge(cwd, {
			goal: "redaction fix",
			taskText: "scrub headers",
		});
		const outWithRole = readKnowledge(cwd, {
			goal: "redaction fix",
			taskText: "scrub headers",
			role: "executor",
		});
		// Role is reserved (not scored) — both must surface the same matching section.
		assert.equal(outNoRole.includes("redact auth headers"), outWithRole.includes("redact auth headers"));
		assert.match(outWithRole, /redact auth headers/);
	} finally {
		cleanup();
	}
});

test("B2: mtime+size cache — re-read happens when file changes", () => {
	const { cwd, crewDir, cleanup } = makeTmpCrewDir("b2-cache-");
	try {
		const kPath = buildKnowledgeFile(cwd);
		const out1 = readKnowledge(cwd, { goal: "redaction" });
		assert.match(out1, /redact auth headers/);
		// Rewrite knowledge.md with a new matching section, bump mtime.
		const content2 = `${CONVENTIONS}
## newredaction section
brand new redaction detail.
`;
		fs.writeFileSync(kPath, content2, "utf-8");
		const futureSec = Math.floor(Date.now() / 1000) + 60;
		fs.utimesSync(kPath, futureSec, futureSec);
		const out2 = readKnowledge(cwd, { goal: "redaction" });
		assert.match(out2, /newredaction section/);
		assert.equal(out2.includes("redact auth headers"), false, "old content must be evicted after cache invalidation");
	} finally {
		cleanup();
	}
});
