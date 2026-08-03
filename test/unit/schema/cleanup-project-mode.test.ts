import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { injectGuidance, MARKER_END, MARKER_START, standardGuidanceBlocks } from "../../../src/config/markers.ts";
import type { TeamContext } from "../../../src/extension/team-tool/context.ts";
import { handleCleanup } from "../../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../src/schema/team-tool-schema.ts";

/**
 * Issue #35: pi-crew's `team action=init` injects a guidance block into
 * AGENTS.md, but `pi uninstall` has no extension hook to reverse it.
 * `team action=cleanup` (without runId) is the documented reverse operation.
 * These tests pin both the reversibility (user content preserved) and the
 * safety guards (force-gated .crew/ removal, never arbitrary dirs).
 */

interface Fixture {
	cwd: string;
	agentsMd: string;
	crewDir: string;
}

function makeFixture(withGuidance: boolean): Fixture {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-cleanup-"));
	const agentsMd = path.join(cwd, "AGENTS.md");
	const crewDir = path.join(cwd, ".crew");
	// Minimal git marker so findRepoRoot anchors at cwd.
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	if (withGuidance) {
		injectGuidance(agentsMd, standardGuidanceBlocks("0.0.0-test"));
	} else {
		fs.writeFileSync(agentsMd, "# My Project\n\nUser content here.\n", "utf-8");
	}
	return { cwd, agentsMd, crewDir };
}

function ctx(cwd: string): TeamContext {
	return {
		cwd,
		config: undefined,
		sessionId: "test-session",
		signal: undefined,
	} as unknown as TeamContext;
}

function params(p: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return p as TeamToolParamsValue;
}

function readAgents(p: string): string {
	return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

describe("team action=cleanup — project-level uninstall cleanup (Issue #35)", () => {
	let fixtures: Fixture[] = [];

	beforeEach(() => {
		fixtures = [];
	});
	afterEach(() => {
		for (const f of fixtures) {
			fs.rmSync(f.cwd, { recursive: true, force: true });
		}
	});

	it("removes the pi-crew guidance block from AGENTS.md (no runId = project mode)", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		// Sanity: the marker section is present before cleanup.
		assert.ok(readAgents(f.agentsMd).includes(MARKER_START));

		const r = await handleCleanup(params({ confirm: true }), ctx(f.cwd));
		const after = readAgents(f.agentsMd);

		assert.match(textFromToolResult(r), /AGENTS\.md guidance block/);
		assert.match(textFromToolResult(r), /removed:/);
		assert.ok(!after.includes(MARKER_START), "MARKER_START must be gone");
		assert.ok(!after.includes(MARKER_END), "MARKER_END must be gone");
	});

	it("preserves user content in AGENTS.md (only the marker section is removed)", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		// Inject user content BEFORE the marker by rewriting the file.
		const userLine = "## My Unique Heading That Must Survive";
		const original = readAgents(f.agentsMd);
		fs.writeFileSync(f.agentsMd, `${userLine}\n\n${original}`, "utf-8");

		await handleCleanup(params({ confirm: true }), ctx(f.cwd));
		const after = readAgents(f.agentsMd);

		assert.ok(after.includes(userLine), "user content must survive cleanup");
		assert.ok(!after.includes(MARKER_START), "pi-crew marker must be gone");
	});

	it("is a no-op when no marker section is present (idempotent)", async () => {
		const f = makeFixture(false);
		fixtures.push(f);
		const before = readAgents(f.agentsMd);

		const r = await handleCleanup(params({ confirm: true }), ctx(f.cwd));
		const after = readAgents(f.agentsMd);

		assert.match(textFromToolResult(r), /no pi-crew marker section found/);
		assert.equal(after, before, "file unchanged");
	});

	it("does NOT remove .crew/ by default (preserves run history)", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		fs.mkdirSync(path.join(f.crewDir, "state"), { recursive: true });
		fs.writeFileSync(path.join(f.crewDir, "state", "marker"), "x", "utf-8");

		const r = await handleCleanup(params({ confirm: true }), ctx(f.cwd));

		assert.match(textFromToolResult(r), /\.crew\/ state directory:/);
		assert.match(textFromToolResult(r), /preserved — use force: true to remove/);
		assert.ok(fs.existsSync(f.crewDir), ".crew/ must still exist");
	});

	it("removes .crew/ only with force: true", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		fs.mkdirSync(path.join(f.crewDir, "state"), { recursive: true });

		const r = await handleCleanup(params({ force: true, confirm: true }), ctx(f.cwd));

		assert.match(textFromToolResult(r), /removed:/);
		assert.match(textFromToolResult(r), /\.crew/);
		assert.ok(!fs.existsSync(f.crewDir), ".crew/ must be removed");
	});

	it("dryRun previews without writing (AGENTS.md + .crew/ untouched)", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		fs.mkdirSync(path.join(f.crewDir, "state"), { recursive: true });
		const agentsBefore = readAgents(f.agentsMd);

		const r = await handleCleanup(params({ force: true, dryRun: true }), ctx(f.cwd));

		assert.match(textFromToolResult(r), /dry-run preview — no files were changed/);
		assert.match(textFromToolResult(r), /would remove/);
		assert.equal(readAgents(f.agentsMd), agentsBefore, "AGENTS.md untouched in dry-run");
		assert.ok(fs.existsSync(f.crewDir), ".crew/ untouched in dry-run");
	});

	it("reminds the user to run 'pi uninstall npm:pi-crew' afterwards", async () => {
		const f = makeFixture(true);
		fixtures.push(f);
		const r = await handleCleanup(params({ confirm: true }), ctx(f.cwd));
		assert.match(textFromToolResult(r), /pi uninstall npm:pi-crew/);
	});

	it("routes scope=user to the user-cleanup handler (no longer rejected)", async () => {
		// v0.8.13 (Issue #35 follow-up): scope=user now routes to handleUserCleanup
		// instead of being rejected. The user handler removes pi-crew user-scope
		// state (~/.pi/agent/extensions/pi-crew/). Verify routing by checking the
		// output mentions 'User-scope cleanup'.
		const prevHome = process.env.PI_TEAMS_HOME;
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "crew-route-home-"));
		process.env.PI_TEAMS_HOME = tempHome;
		try {
			const f = makeFixture(true);
			fixtures.push(f);
			const r = await handleCleanup(params({ scope: "user", confirm: true }), ctx(f.cwd));
			assert.equal(r.isError, false);
			assert.match(textFromToolResult(r), /User-scope cleanup/);
		} finally {
			if (prevHome === undefined) delete process.env.PI_TEAMS_HOME;
			else process.env.PI_TEAMS_HOME = prevHome;
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("with runId still routes to per-run worktree cleanup (existing behavior preserved)", async () => {
		const f = makeFixture(false);
		fixtures.push(f);
		// No run exists → per-run path returns "not found" (not project-mode output).
		const r = await handleCleanup(params({ runId: "nonexistent_run", confirm: true }), ctx(f.cwd));
		assert.equal(r.isError, true);
		assert.match(textFromToolResult(r), /not found/);
		assert.ok(!readAgents(f.agentsMd).includes("Project cleanup"), "must not run project-mode on runId path");
	});
});
