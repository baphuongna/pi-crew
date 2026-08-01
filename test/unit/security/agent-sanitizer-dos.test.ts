/**
 * SEC-4 Test: Polynomial O(n²) DoS on agent-file sanitizer.
 *
 * Verifies:
 * 1. `readAgentDir` skips files > 256KB (short-circuit before parse).
 * 2. The 320KB-file skip is fast (loose timing sanity; structural proof is #1).
 * 3. The HTML-comment sanitizer uses a BOUNDED quantifier {0,8192} — asserted
 *    STRUCTURALLY at the 8192-char boundary (not via wall-clock ratios, which
 *    were flaky on slow CI per QA-12).
 * 4. Sanitizer still strips valid `<script>` tags and code-fence directives.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverAgents, invalidateAgentDiscoveryCache, sanitizeAgentSystemPrompt } from "../../../src/agents/discover-agents.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const CAP = 256 * 1024; // 256KB

/** Write a valid agent markdown file with the given body content. */
function writeAgent(dir: string, name: string, body: string): void {
	const agentsDir = path.join(dir, ".crew", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, name),
		`---\nname: ${name.replace(/\.md$/, "")}\ndescription: test agent\n---\n${body}`,
		"utf-8",
	);
}

/**
 * Build a pathological input that stresses the HTML-comment regex:
 * many unclosed `<!--` markers followed by filler text. With an unbounded
 * `[\s\S]*?` quantifier this is O(n²) (each marker scans to EOF); with the
 * bounded `{0,8192}?` quantifier each marker scans at most 8192 chars → O(n).
 */
function makePathological(totalBytes: number): string {
	const markerLen = 4; // "<!--"
	const markerCount = Math.floor(totalBytes / 20);
	const fillerLen = totalBytes - markerLen * markerCount;
	return "<!--".repeat(markerCount) + "a".repeat(Math.max(0, fillerLen));
}

describe("SEC-4: readAgentDir file-size cap", () => {
	it("skips agent files exceeding 256KB", () => {
		invalidateAgentDiscoveryCache();
		const dir = createTrackedTempDir("sec4-cap-");
		// Small valid agent — should be discovered.
		writeAgent(dir, "small.md", "You are small.");
		// Oversized agent — should be skipped.
		writeAgent(dir, "huge.md", "x".repeat(CAP + 1024));
		try {
			const discovery = discoverAgents(dir);
			const names = discovery.project.map((a) => a.name);
			assert.ok(names.includes("small"), "small agent should be discovered");
			assert.ok(!names.includes("huge"), "oversized agent should be skipped");
		} finally {
			invalidateAgentDiscoveryCache();
		}
	});

	it("reads agent files just under the 256KB cap", () => {
		invalidateAgentDiscoveryCache();
		const dir = createTrackedTempDir("sec4-under-");
		// Just under cap — should be discovered.
		writeAgent(dir, "borderline.md", "x".repeat(CAP - 500));
		try {
			const discovery = discoverAgents(dir);
			const names = discovery.project.map((a) => a.name);
			assert.ok(names.includes("borderline"), "agent just under cap should be discovered");
		} finally {
			invalidateAgentDiscoveryCache();
		}
	});

	it("short-circuits a 320KB file without parsing it (loose timing sanity)", () => {
		// The size-cap stat check short-circuits BEFORE readFileSync + parse +
		// sanitize. The structural proof that the skip happens is "skips agent
		// files exceeding 256KB" above (the oversized file is absent from the
		// discovery result). This is a LOOSE wall-clock sanity that the
		// short-circuit is fast — generous tolerance (was <100ms) to avoid CI
		// flakiness (QA-12: tight timing assertions flake on slow/loaded CI).
		invalidateAgentDiscoveryCache();
		const dir = createTrackedTempDir("sec4-time-");
		writeAgent(dir, "tiny.md", "ok");
		writeAgent(dir, "big.md", "y".repeat(320 * 1024));
		try {
			const t0 = performance.now();
			discoverAgents(dir);
			const elapsed = performance.now() - t0;
			assert.ok(elapsed < 3000, `discoverAgents with 320KB file took ${elapsed.toFixed(1)}ms (expected <3000ms)`);
		} finally {
			invalidateAgentDiscoveryCache();
		}
	});
});

describe("SEC-4: sanitizer uses bounded quantifier (structural DoS mitigation, not timing)", () => {
	// The DoS mitigation is the BOUNDED quantifier {0,8192} on the HTML-comment
	// regex (`/[\s\S]{0,8192}?/`). An UNBOUNDED `*?` quantifier backtracks
	// polynomially (O(n²)) on pathological inputs (many unclosed `<!--`). We
	// assert the bound STRUCTURALLY — by behaviour at the boundary — rather
	// than via wall-clock ratios, which were flaky on slow CI (QA-12).

	it("strips an HTML comment within the 8192-char bound", () => {
		// Body of 8000 chars ≤ 8192 → the bounded quantifier can reach the `-->`
		// terminator → comment is stripped.
		const inner = "x".repeat(8000);
		const content = `<!--${inner}-->after`;
		const out = sanitizeAgentSystemPrompt(content, "project");
		assert.doesNotMatch(out, /<!--/, "comment within the 8192-char bound should be stripped");
		assert.match(out, /after/);
	});

	it("leaves an HTML comment exceeding the 8192-char bound intact (proves quantifier is bounded)", () => {
		// Body of 9000 chars > 8192 → the bounded quantifier CANNOT reach the
		// `-->` terminator → the comment is left intact. An UNBOUNDED quantifier
		// (`[\s\S]*?`) would STILL strip it, so this assertion structurally proves
		// the DoS-mitigation bound is in place — independent of wall-clock timing.
		const inner = "x".repeat(9000);
		const content = `<!--${inner}-->after`;
		const out = sanitizeAgentSystemPrompt(content, "project");
		assert.match(out, /<!--/, "comment exceeding the bound must NOT be stripped (proves bounded quantifier)");
		assert.match(out, /after/);
	});

	it("completes on a pathological input without catastrophic backtracking (loose sanity)", () => {
		// Many unclosed `<!--` markers stress the bounded quantifier. With the
		// {0,8192} bound each marker scans ≤8192 chars (linear). An unbounded
		// quantifier would scan to EOF per marker (O(n²)) and hang. Asserting the
		// call returns a string structurally proves the mitigation; the loose
		// timing (<5000ms) is a sanity backstop with generous CI tolerance.
		const input = makePathological(256 * 1024);
		sanitizeAgentSystemPrompt(input, "project"); // warm-up (JIT)
		const t0 = performance.now();
		const out = sanitizeAgentSystemPrompt(input, "project");
		const elapsed = performance.now() - t0;
		assert.equal(typeof out, "string", "sanitizer must return a string (not hang)");
		assert.ok(
			elapsed < 5000,
			`sanitizer on 256KB pathological input took ${elapsed.toFixed(1)}ms (expected <5000ms with bounded quantifier)`,
		);
	});
});

describe("SEC-4: sanitizer still strips valid patterns (correctness)", () => {
	it("strips <script> tags", () => {
		const content = "before <script>alert(1)</script> after";
		const out = sanitizeAgentSystemPrompt(content, "project");
		assert.doesNotMatch(out, /<script/i);
		assert.match(out, /before/);
		assert.match(out, /after/);
	});

	it("strips valid HTML comments", () => {
		const content = "before <!-- hidden comment --> after";
		const out = sanitizeAgentSystemPrompt(content, "builtin");
		assert.doesNotMatch(out, /<!--/);
		assert.doesNotMatch(out, /hidden comment/);
		assert.match(out, /before/);
		assert.match(out, /after/);
	});

	it("strips code-fence directive blocks", () => {
		const content = "```system\nhidden prompt\n```\nvisible";
		const out = sanitizeAgentSystemPrompt(content, "user");
		assert.doesNotMatch(out, /hidden prompt/);
		assert.match(out, /visible/);
	});

	it("strips code-fence instruction blocks", () => {
		const content = "```instruction\nsecret directive\n```\nkeep";
		const out = sanitizeAgentSystemPrompt(content, "user");
		assert.doesNotMatch(out, /secret directive/);
		assert.match(out, /keep/);
	});

	it("handles long valid HTML comment within the bound", () => {
		const inner = "x".repeat(1000);
		const content = `<!-- ${inner} -->after`;
		const out = sanitizeAgentSystemPrompt(content, "builtin");
		assert.doesNotMatch(out, /<!--/);
		assert.match(out, /after/);
	});
});
