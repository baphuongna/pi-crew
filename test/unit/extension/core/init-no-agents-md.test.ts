import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { initializeProject } from "../../../../src/extension/project-init.ts";

/**
 * v0.8.14 regression (Issue #35): pi-crew must NOT modify AGENTS.md on init.
 * AGENTS.md is the USER's project-instructions file — extensions modifying it
 * was out-of-scope and redundant (the `team` tool self-describes via tool
 * registration). This test pins that init never touches AGENTS.md.
 */

describe("init does NOT modify AGENTS.md (v0.8.14, Issue #35)", () => {
	let tempCwd: string;
	let tempHome: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-init-noagents-"));
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "crew-init-noagents-home-"));
		prevHome = process.env.PI_TEAMS_HOME;
		process.env.PI_TEAMS_HOME = tempHome;
		// Minimal git marker so findRepoRoot anchors at tempCwd.
		fs.mkdirSync(path.join(tempCwd, ".git"), { recursive: true });
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = prevHome;
		fs.rmSync(tempCwd, { recursive: true, force: true });
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("does NOT create AGENTS.md when none exists", () => {
		const agentsMd = path.join(tempCwd, "AGENTS.md");
		assert.ok(!fs.existsSync(agentsMd), "precondition: no AGENTS.md");

		initializeProject(tempCwd, {});

		assert.ok(!fs.existsSync(agentsMd), "init must NOT create AGENTS.md");
	});

	it("does NOT modify an existing AGENTS.md (user content preserved, no marker injected)", () => {
		const agentsMd = path.join(tempCwd, "AGENTS.md");
		const userContent = "# My Project\n\nMy own instructions here.\n";
		fs.writeFileSync(agentsMd, userContent, "utf-8");

		initializeProject(tempCwd, {});

		const after = fs.readFileSync(agentsMd, "utf-8");
		assert.equal(after, userContent, "AGENTS.md must be byte-identical (no injection)");
		assert.ok(!after.includes("PI-CREW:GUIDANCE"), "no pi-crew marker injected");
		assert.ok(!after.includes("pi-crew-overview"), "no pi-crew block injected");
		assert.ok(!after.includes("Quick Commands"), "no quick-commands table injected");
	});

	it("does NOT inject even with copyBuiltins=true (AGENTS.md is separate from bundled copies)", () => {
		const agentsMd = path.join(tempCwd, "AGENTS.md");
		initializeProject(tempCwd, { copyBuiltins: true, overwrite: true });

		assert.ok(!fs.existsSync(agentsMd), "init must NOT create AGENTS.md even with copyBuiltins");
	});

	it("init result no longer carries guidance fields (API contract update)", () => {
		const r = initializeProject(tempCwd, {});
		assert.equal("guidanceModified" in r, false, "guidanceModified field removed");
		assert.equal("guidancePath" in r, false, "guidancePath field removed");
	});
});
