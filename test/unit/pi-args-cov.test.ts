import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyThinkingSuffix,
	currentCrewDepth,
	resolveCrewMaxDepth,
	checkCrewDepth,
	cleanupTempDir,
} from "../../src/runtime/pi-args.ts";

// ── applyThinkingSuffix ──

describe("applyThinkingSuffix", () => {
	it("returns undefined when model is undefined", () => {
		assert.strictEqual(applyThinkingSuffix(undefined, "high"), undefined);
	});

	it("returns undefined when model is undefined and thinking is undefined", () => {
		assert.strictEqual(applyThinkingSuffix(undefined, undefined), undefined);
	});

	it("returns model unchanged when thinking is off", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", "off"), "claude-3.5");
	});

	it("returns model unchanged when thinking is undefined", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", undefined), "claude-3.5");
	});

	it("appends thinking suffix to model", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", "high"), "claude-3.5:high");
	});

	it("does not double-append if model already has valid thinking suffix", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5:medium", "high"), "claude-3.5:medium");
	});

	it("returns model unchanged for invalid thinking value", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", "invalid"), "claude-3.5");
	});

	it("handles minimal thinking level", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", "minimal"), "claude-3.5:minimal");
	});

	it("handles xhigh thinking level", () => {
		assert.strictEqual(applyThinkingSuffix("claude-3.5", "xhigh"), "claude-3.5:xhigh");
	});
});

// ── currentCrewDepth ──

describe("currentCrewDepth", () => {
	it("returns 0 when no env vars set", () => {
		assert.strictEqual(currentCrewDepth({}), 0);
	});

	it("reads PI_CREW_DEPTH", () => {
		assert.strictEqual(currentCrewDepth({ PI_CREW_DEPTH: "3" }), 3);
	});

	it("reads PI_TEAMS_DEPTH as fallback", () => {
		assert.strictEqual(currentCrewDepth({ PI_TEAMS_DEPTH: "2" }), 2);
	});

	it("prefers PI_CREW_DEPTH over PI_TEAMS_DEPTH", () => {
		assert.strictEqual(currentCrewDepth({ PI_CREW_DEPTH: "3", PI_TEAMS_DEPTH: "2" }), 3);
	});

	it("returns 0 for non-numeric values", () => {
		assert.strictEqual(currentCrewDepth({ PI_CREW_DEPTH: "abc" }), 0);
	});

	it("returns 0 for negative values", () => {
		assert.strictEqual(currentCrewDepth({ PI_CREW_DEPTH: "-1" }), 0);
	});

	it("returns 0 for float values", () => {
		assert.strictEqual(currentCrewDepth({ PI_CREW_DEPTH: "1.5" }), 0);
	});
});

// ── resolveCrewMaxDepth ──

describe("resolveCrewMaxDepth", () => {
	it("returns default (2) when no input or env", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, {}), 2);
	});

	it("reads from PI_CREW_MAX_DEPTH env", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "5" }), 5);
	});

	it("reads from PI_TEAMS_MAX_DEPTH as fallback", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_TEAMS_MAX_DEPTH: "3" }), 3);
	});

	it("prefers PI_CREW_MAX_DEPTH over PI_TEAMS_MAX_DEPTH", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "5", PI_TEAMS_MAX_DEPTH: "3" }), 5);
	});

	it("uses input value when env is not set", () => {
		assert.strictEqual(resolveCrewMaxDepth(4, {}), 4);
	});

	it("env overrides input value", () => {
		assert.strictEqual(resolveCrewMaxDepth(4, { PI_CREW_MAX_DEPTH: "7" }), 7);
	});

	it("clamps values > 10 to 10", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "11" }), 10);
	});

	it("rejects values < 1", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "0" }), 2);
	});

	it("rejects non-integer values", () => {
		assert.strictEqual(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "2.5" }), 2);
	});
});

// ── checkCrewDepth ──

describe("checkCrewDepth", () => {
	it("is not blocked at depth 0 with default maxDepth 2", () => {
		const result = checkCrewDepth(undefined, {});
		assert.strictEqual(result.blocked, false);
		assert.strictEqual(result.depth, 0);
		assert.strictEqual(result.maxDepth, 2);
	});

	it("is blocked when depth equals maxDepth", () => {
		const result = checkCrewDepth(3, { PI_CREW_DEPTH: "3" });
		assert.strictEqual(result.blocked, true);
	});

	it("is blocked when depth exceeds maxDepth", () => {
		const result = checkCrewDepth(1, { PI_CREW_DEPTH: "5" });
		assert.strictEqual(result.blocked, true);
	});

	it("is not blocked when depth is below maxDepth", () => {
		const result = checkCrewDepth(5, { PI_CREW_DEPTH: "1" });
		assert.strictEqual(result.blocked, false);
	});
});

// ── cleanupTempDir ──

describe("cleanupTempDir", () => {
	it("does nothing for undefined tempDir", () => {
		// Should not throw
		cleanupTempDir(undefined);
	});

	it("removes the temp directory if it exists", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cleanup-"));
		assert.ok(fs.existsSync(dir));
		cleanupTempDir(dir);
		assert.ok(!fs.existsSync(dir));
	});

	it("does not throw for non-existent directory", () => {
		cleanupTempDir("/tmp/this-dir-does-not-exist-cleanup-test");
	});
});
