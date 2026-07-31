/**
 * SEC-4 Test: Polynomial O(n²) DoS on agent-file sanitizer.
 *
 * Verifies:
 * 1. `readAgentDir` skips files > 256KB (short-circuit before parse).
 * 2. Timing for a 320KB-file skip is < 100ms.
 * 3. Sanitizer timing on 80K/160K/320KB inputs is ~linear (not quadratic).
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

	it("short-circuits a 320KB file in <100ms", () => {
		invalidateAgentDiscoveryCache();
		const dir = createTrackedTempDir("sec4-time-");
		writeAgent(dir, "tiny.md", "ok");
		writeAgent(dir, "big.md", "y".repeat(320 * 1024));
		try {
			const t0 = performance.now();
			discoverAgents(dir);
			const elapsed = performance.now() - t0;
			assert.ok(elapsed < 100, `discoverAgents with 320KB file took ${elapsed.toFixed(1)}ms (expected <100ms)`);
		} finally {
			invalidateAgentDiscoveryCache();
		}
	});
});

describe("SEC-4: sanitizer regex timing is linear (not quadratic)", () => {
	it("80K → 320KB timing ratio is < 6x (linear, not quadratic)", () => {
		const sizes = [80 * 1024, 160 * 1024, 320 * 1024];
		const timings: number[] = [];
		for (const size of sizes) {
			const input = makePathological(size);
			// Warm-up run (JIT).
			sanitizeAgentSystemPrompt(input, "project");
			// Timed run.
			const t0 = performance.now();
			sanitizeAgentSystemPrompt(input, "project");
			timings.push(performance.now() - t0);
		}
		const [t80, t160, t320] = timings;
		const ratio = t320 / Math.max(t80, 0.01);
		// Linear: 4x size → ~4x time. Quadratic: 4x size → ~16x time.
		// Threshold 6x clearly separates linear from quadratic.
		assert.ok(
			ratio < 6,
			`Sanitizer timing ratio 320K/80K = ${ratio.toFixed(1)}x (expected <6 for linear; ` +
				`timings: 80K=${t80.toFixed(1)}ms 160K=${t160.toFixed(1)}ms 320K=${t320.toFixed(1)}ms)`,
		);
	});

	it("160K → 320KB timing ratio is < 3x (linear)", () => {
		const input160 = makePathological(160 * 1024);
		const input320 = makePathological(320 * 1024);
		sanitizeAgentSystemPrompt(input160, "project"); // warm-up
		sanitizeAgentSystemPrompt(input320, "project");
		const t0 = performance.now();
		sanitizeAgentSystemPrompt(input160, "project");
		const t160 = performance.now() - t0;
		const t1 = performance.now();
		sanitizeAgentSystemPrompt(input320, "project");
		const t320 = performance.now() - t1;
		const ratio = t320 / Math.max(t160, 0.01);
		assert.ok(
			ratio < 3,
			`Sanitizer timing ratio 320K/160K = ${ratio.toFixed(1)}x (expected <3 for linear)`,
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
