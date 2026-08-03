import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HANDOFF_TEMPLATE, parseHandoffFromOutput } from "../../../../src/runtime/task-packet.ts";

const SAMPLE_OUTPUT = `Some preamble text here.

## Handoff

### Summary
- Implemented the auth middleware
- Added rate limiting to all endpoints
- Fixed 3 security issues from audit

### Files Changed
- src/auth/middleware.ts: New auth middleware
- src/api/routes.ts: Added rate limiting
- src/config/security.ts: Updated config

### Tests / Verification
- All 42 unit tests pass
- Manual curl test against localhost:3000

### Follow-ups
- Need to add integration tests for OAuth
- Consider CSP headers for production

Some trailing text here.`;

describe("parseHandoffFromOutput", () => {
	it("parses summary bullets", () => {
		const result = parseHandoffFromOutput(SAMPLE_OUTPUT);
		assert.equal(result.summary.length, 3);
		assert.ok(result.summary[0].includes("auth middleware"));
	});

	it("parses files changed bullets", () => {
		const result = parseHandoffFromOutput(SAMPLE_OUTPUT);
		assert.equal(result.filesChanged.length, 3);
		assert.ok(result.filesChanged[0].includes("middleware.ts"));
	});

	it("parses tests section", () => {
		const result = parseHandoffFromOutput(SAMPLE_OUTPUT);
		assert.equal(result.tests.length, 2);
		assert.ok(result.tests[0].includes("42 unit tests"));
	});

	it("parses follow-ups", () => {
		const result = parseHandoffFromOutput(SAMPLE_OUTPUT);
		assert.equal(result.followups.length, 2);
		assert.ok(result.followups[0].includes("OAuth"));
	});

	it("returns empty arrays for missing handoff section", () => {
		const result = parseHandoffFromOutput("Just some random output without handoff");
		assert.deepEqual(result, {
			summary: [],
			filesChanged: [],
			tests: [],
			followups: [],
		});
	});

	it("returns empty arrays for empty string input", () => {
		const result = parseHandoffFromOutput("");
		assert.deepEqual(result, {
			summary: [],
			filesChanged: [],
			tests: [],
			followups: [],
		});
	});

	it("returns empty arrays for null input", () => {
		const result = parseHandoffFromOutput(null as any);
		assert.deepEqual(result, {
			summary: [],
			filesChanged: [],
			tests: [],
			followups: [],
		});
	});

	it("handles handoff with empty sections", () => {
		const output = `## Handoff\n\n### Summary\n\n### Files Changed\n- file.ts: change\n\n### Tests / Verification\n\n### Follow-ups\n`;
		const result = parseHandoffFromOutput(output);
		assert.equal(result.summary.length, 0);
		assert.equal(result.filesChanged.length, 1);
		assert.equal(result.tests.length, 0);
		assert.equal(result.followups.length, 0);
	});

	it("strips HTML comment placeholders from template", () => {
		// The HANDOFF_TEMPLATE contains <!-- --> comments, should be skipped
		const result = parseHandoffFromOutput(HANDOFF_TEMPLATE);
		// All sections should be empty since template only has comments
		assert.equal(result.summary.length, 0);
		assert.equal(result.filesChanged.length, 0);
	});

	it("handles free-text paragraphs in summary", () => {
		const output = `## Handoff\n\n### Summary\nI implemented the feature end-to-end.\nIt covers all edge cases.\n\n### Files Changed\n- a.ts\n\n### Tests / Verification\n- pass\n\n### Follow-ups\n- none\n`;
		const result = parseHandoffFromOutput(output);
		assert.equal(result.summary.length, 2);
		assert.ok(result.summary[0].includes("end-to-end"));
	});

	it("strips backtick wrapping from items", () => {
		const output = `## Handoff\n\n### Summary\n- \`did the thing\`\n\n### Files Changed\n\n### Tests / Verification\n\n### Follow-ups\n`;
		const result = parseHandoffFromOutput(output);
		assert.equal(result.summary[0], "did the thing");
	});
});
