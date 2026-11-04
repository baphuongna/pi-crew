/**
 * R1 (adaptive context diet, 2026-11-04): PI_CREW_KNOWLEDGE_MAX_BYTES knob.
 *
 * HARD RULE under test: env unset ⇒ output BYTE-IDENTICAL to pre-R1
 * behavior — every path keeps its own default cap
 * (MAX_KNOWLEDGE_HEAD_BYTES 2000 no-query, MAX_CONVENTIONS_BYTES 2048 +
 * MAX_SESSION_LOG_BYTES 5000 query path). The existing truncation/
 * section-aware suites pin the unset behavior; the first two tests here pin
 * it EXPLICITLY (full-string equality) so a future regression cannot hide
 * behind marker-substring asserts.
 *
 * Knob semantics (knowledge-injection.ts resolveKnowledgeMaxBytes):
 *   - unset / non-integer / empty / whitespace-only-invalid → per-path defaults;
 *   - N ≥ 1 → EVERY cap becomes N (raise above a default is allowed);
 *   - N ≤ 0 → off-switch: readKnowledge/buildKnowledgeFragment return "".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildKnowledgeFragment, knowledgePath, readKnowledge } from "../../../../src/extension/knowledge-injection.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const ENV = "PI_CREW_KNOWLEDGE_MAX_BYTES";

/** Run fn with the knob set to `value` (undefined = deleted), then restore. */
function withKnob<T>(value: string | undefined, fn: () => T): T {
	const saved = process.env[ENV];
	if (value === undefined) delete process.env[ENV];
	else process.env[ENV] = value;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env[ENV];
		else process.env[ENV] = saved;
	}
}

/** Pre-R1 exact head-truncation format for the no-query path. */
function expectedHeadTruncation(content: string, cap: number, kPath: string): string {
	return `${content.slice(0, cap)}\n\n<!-- knowledge.md truncated at ${cap} bytes (head shown). Full file: ${kPath} — use the \`read\` tool if you need sections beyond the head. -->`;
}

function makeTmpCrewDir(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("R1 HARD RULE: env unset → no-query output is BYTE-IDENTICAL to the pre-R1 head-truncation format", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-unset-");
	try {
		const kPath = knowledgePath(cwd);
		// Sanitization is identity on plain ASCII — the expected string can be
		// constructed directly from the written content (pre-R1 behavior).
		const big = `HEAD_TOKEN_R1\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8");

		const out = withKnob(undefined, () => readKnowledge(cwd));
		assert.equal(out, expectedHeadTruncation(big, 2_000, kPath), "unset knob must reproduce pre-R1 output byte-for-byte");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1 HARD RULE: env unset → query path keeps the 2048-byte conventions cap (pre-R1 default)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-unset-q-");
	try {
		const kPath = knowledgePath(cwd);
		const bigConvention = `## Code Style\n${"c".repeat(4_000)}\n\n## v0.9.10 redaction env hardening\n- redact auth headers\n`;
		fs.writeFileSync(kPath, bigConvention, "utf-8");

		const out = withKnob(undefined, () => readKnowledge(cwd, { goal: "redaction of auth headers", taskText: "audit env scrubbing" }));
		assert.match(out, /conventions section capped at 2048 bytes/, "unset knob must keep the 2048 default conventions cap");
		assert.match(out, /## v0\.9\.10 redaction env hardening/, "matched session-log still injected under defaults");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: N=1000 overrides the no-query head cap (marker + slice reflect 1000)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-1000-");
	try {
		const kPath = knowledgePath(cwd);
		const big = `HEAD_TOKEN_R1\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8");

		const out = withKnob("1000", () => readKnowledge(cwd));
		assert.equal(out, expectedHeadTruncation(big, 1_000, kPath), "N=1000 must reproduce the exact format at cap 1000");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: N above the default RAISES the cap (no truncation for ≤N content)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-raise-");
	try {
		fs.writeFileSync(knowledgePath(cwd), `HEAD\n${"y".repeat(3_000)}`, "utf-8");
		const out = withKnob("4000", () => readKnowledge(cwd));
		assert.equal(out.includes("truncated at"), false, "3000-byte content under a 4000 knob must not truncate");
		assert.equal(out.includes("y".repeat(3_000)), true, "full body survives");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: N ≤ 0 is the off-switch — readKnowledge and buildKnowledgeFragment return empty on BOTH paths", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-off-");
	try {
		const kPath = knowledgePath(cwd);
		fs.writeFileSync(kPath, `## Code Style\n- tabs only\n\n## v0.9.10 redaction env hardening\n- redact auth headers\n`, "utf-8");
		for (const off of ["0", "-1"]) {
			assert.equal(
				withKnob(off, () => readKnowledge(cwd)),
				"",
				`knob=${off} → no-query readKnowledge must be ""`,
			);
			assert.equal(
				withKnob(off, () => readKnowledge(cwd, { goal: "redaction env hardening", taskText: "audit" })),
				"",
				`knob=${off} → query readKnowledge must be ""`,
			);
			assert.equal(
				withKnob(off, () => buildKnowledgeFragment(cwd)),
				"",
				`knob=${off} → fragment must be "" (nothing injected)`,
			);
		}
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: invalid values fall through to the per-path defaults (never throw)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-invalid-");
	try {
		const kPath = knowledgePath(cwd);
		const big = `HEAD_TOKEN_R1\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8");
		for (const invalid of ["12abc", "abc", ""]) {
			const out = withKnob(invalid, () => readKnowledge(cwd));
			assert.equal(out, expectedHeadTruncation(big, 2_000, kPath), `knob=${JSON.stringify(invalid)} must keep the 2000 default`);
		}
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: surrounding whitespace is trimmed before parsing (' 1200 ' → 1200)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-ws-");
	try {
		const kPath = knowledgePath(cwd);
		const big = `HEAD_TOKEN_R1\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8");
		const out = withKnob(" 1200 ", () => readKnowledge(cwd));
		assert.equal(out, expectedHeadTruncation(big, 1_200, kPath), "padded 1200 must act as 1200");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: no-query content cache respects env changes within one process (cap rides the cache key)", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-cache-");
	try {
		const kPath = knowledgePath(cwd);
		const big = `HEAD_TOKEN_R1\n${"x".repeat(20_000)}`;
		fs.writeFileSync(kPath, big, "utf-8"); // file NOT rewritten between reads

		const outDefault = withKnob(undefined, () => readKnowledge(cwd));
		assert.match(outDefault, /truncated at 2000 bytes/);

		const outSmall = withKnob("1000", () => readKnowledge(cwd));
		assert.match(outSmall, /truncated at 1000 bytes/, "env change must bypass the mtime+size content cache");

		const outAgain = withKnob(undefined, () => readKnowledge(cwd));
		assert.match(outAgain, /truncated at 2000 bytes/, "restoring the env must restore the default render");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R1: N overrides BOTH query-path caps — conventions marker AND session-log budget follow N", async () => {
	const cwd = makeTmpCrewDir("pi-crew-knowledge-r1-query-");
	try {
		const kPath = knowledgePath(cwd);
		// Conventions block > 1500; one matching session-log section of ~800 bytes.
		const content = `## Code Style\n${"c".repeat(4_000)}\n\n## v0.9.10 redaction env hardening\n${"r".repeat(790)}\n`;
		fs.writeFileSync(kPath, content, "utf-8");

		const out = withKnob("1500", () => readKnowledge(cwd, { goal: "redaction env hardening", taskText: "audit" }));
		assert.match(out, /conventions section capped at 1500 bytes/, "conventions cap follows the knob");
		// The ~800-byte matched section fits the 1500 session-log budget.
		assert.ok(out.includes("r".repeat(790)), "matched section within the knobbled budget survives");
	} finally {
		await removeDirWithRetry(cwd);
	}
});
