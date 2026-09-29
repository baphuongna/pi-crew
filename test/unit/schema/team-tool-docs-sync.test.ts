/**
 * A3 (upgrade plan 2026-09-29): docs truth-sync gate for the `team` tool
 * action surface.
 *
 * History: the schema action arrays grew to 56 actions (10 run + 16 status +
 * 7 control + 17 manage — MANAGE gained `compare` in US-021 — + 6 automate)
 * while the docs kept claiming 53/54/55, CLAUDE.md still carried a legacy
 * "28 total" table, and docs/actions-reference.md omitted `compare`.
 * `allActionLiterals` (src/schema/team-tool-schema.ts) is the single source
 * of truth; this test fails whenever docs drift from it:
 *
 *  - docs/actions-reference.md Quick Reference table (set-compare, both
 *    directions, duplicate detection);
 *  - CLAUDE.md Tool Actions domain table (set-compare + per-domain counts +
 *    counts sum);
 *  - every numeric action-count claim in README.md and CLAUDE.md
 *    ("<N> actions", "<N> schema actions", "(N total)").
 *
 * If this test fails after you changed an `*_ACTIONS` array in the schema:
 * update docs/actions-reference.md, the CLAUDE.md domain table, and the
 * count claims — do NOT relax this test.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { allActionLiterals } from "../../../src/schema/team-tool-schema.ts";

const readRepoFile = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

const schemaActions: readonly string[] = allActionLiterals.map((literal) => literal.const as string);
const schemaSet = new Set(schemaActions);

/** Human-readable drift report between a docs listing and the schema truth. */
const describeDrift = (docName: string, docActions: readonly string[]): string => {
	const missing = schemaActions.filter((action) => !docActions.includes(action));
	const extra = docActions.filter((action) => !schemaSet.has(action));
	const duplicated = docActions.filter((action, index) => docActions.indexOf(action) !== index);
	const parts: string[] = [];
	if (missing.length > 0) parts.push(`in schema but missing from ${docName}: ${missing.join(", ")}`);
	if (extra.length > 0) parts.push(`listed in ${docName} but unknown to the schema: ${extra.join(", ")}`);
	if (duplicated.length > 0) parts.push(`duplicated in ${docName}: ${duplicated.join(", ")}`);
	return parts.join("; ");
};

describe("team-tool docs sync (A3)", () => {
	it("docs/actions-reference.md Quick Reference lists exactly allActionLiterals", () => {
		const md = readRepoFile("docs/actions-reference.md");
		const start = md.indexOf("## Quick Reference");
		assert.notEqual(start, -1, "docs/actions-reference.md lost its '## Quick Reference' section");
		const end = md.indexOf("\n---", start);
		const section = md.slice(start, end === -1 ? undefined : end);
		// Rows look like `| \`recommend\` | ... |` (v0.9.0 additions are bolded:
		// `| **\`goal\`** | ... |`).
		const rows = [...section.matchAll(/^\|\s*(?:\*\*)?`([a-zA-Z_-]+)`(?:\*\*)?\s*\|/gm)].map((match) => match[1]);
		assert.ok(rows.length > 0, "Quick Reference parser produced 0 action rows — table format or parser is broken");
		const drift = describeDrift("docs/actions-reference.md", rows);
		assert.equal(drift, "", `action drift (schema has ${schemaActions.length}): ${drift}`);
	});

	it("CLAUDE.md Tool Actions domain table lists exactly allActionLiterals", () => {
		const md = readRepoFile("CLAUDE.md");
		const start = md.indexOf("### Tool Actions (");
		assert.notEqual(start, -1, "CLAUDE.md lost its '### Tool Actions' section");
		const end = md.indexOf("\n### ", start + 1);
		const section = md.slice(start, end === -1 ? undefined : end);
		// Rows look like `| run | 10 | run, parallel, ... |`.
		const rows = [...section.matchAll(/^\|\s*([a-z]+)\s*\|\s*(\d+)\s*\|\s*([^|]+)\|/gm)].map((match) => ({
			domain: match[1],
			count: Number(match[2]),
			actions: match[3]
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
		}));
		assert.ok(rows.length > 0, "CLAUDE.md domain-table parser produced 0 rows — table format or parser is broken");
		const listed = rows.flatMap((row) => row.actions);
		const drift = describeDrift("CLAUDE.md", listed);
		assert.equal(drift, "", `action drift (schema has ${schemaActions.length}): ${drift}`);
		const total = rows.reduce((acc, row) => acc + row.count, 0);
		assert.equal(total, schemaActions.length, `CLAUDE.md per-domain counts sum to ${total}, schema has ${schemaActions.length}`);
		for (const row of rows) {
			assert.equal(
				row.actions.length,
				row.count,
				`CLAUDE.md domain '${row.domain}' claims ${row.count} but lists ${row.actions.length}`,
			);
		}
	});

	it("numeric action-count claims in README.md and CLAUDE.md equal allActionLiterals.length", () => {
		const expected = schemaActions.length;
		for (const rel of ["README.md", "CLAUDE.md"]) {
			const md = readRepoFile(rel);
			const claims: { text: string; value: number }[] = [];
			for (const match of md.matchAll(/(\d+)\s+(?:schema\s+)?actions?\b/gi)) {
				claims.push({ text: match[0], value: Number(match[1]) });
			}
			for (const match of md.matchAll(/\((\d+)\s+total\)/gi)) {
				claims.push({ text: match[0], value: Number(match[1]) });
			}
			assert.ok(
				claims.length > 0,
				`${rel} no longer states any action count — keep at least one, docs drift would otherwise go undetected`,
			);
			for (const claim of claims) {
				assert.equal(claim.value, expected, `${rel} claims '${claim.text}' but allActionLiterals.length is ${expected}`);
			}
		}
	});
});
