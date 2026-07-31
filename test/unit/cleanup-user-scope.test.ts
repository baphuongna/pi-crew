import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { handleCleanup } from "../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";

/**
 * Issue #35 comment: "pi-crew leaves behind user-level junk". This test pins
 * the new `team action=cleanup scope=user` mode that removes pi-crew's
 * user-scope state (~/.pi/agent/extensions/pi-crew/, pi-crew.json, smoke-test
 * .bak junk) — the part `pi uninstall` leaves behind.
 *
 * Uses PI_TEAMS_HOME to redirect userPiRoot() to a temp dir so we don't touch
 * the real ~/.pi/agent/.
 */

function makeTempHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "crew-user-cleanup-home-"));
	// userPiRoot() = <home>/.pi/agent
	fs.mkdirSync(path.join(home, ".pi", "agent", "extensions", "pi-crew", "state"), { recursive: true });
	fs.mkdirSync(path.join(home, ".pi", "agent", "agents"), {
		recursive: true,
	});
	return home;
}

function makeCtx(cwd: string): TeamContext {
	return {
		cwd,
		config: undefined,
		sessionId: "test-session",
		signal: undefined,
	} as unknown as TeamContext;
}

function params(p: Partial<TeamToolParamsValue>): TeamToolParamsValue {
	return p as TeamToolParamsValue;
}

describe("team action=cleanup scope=user — user-level junk (Issue #35)", () => {
	let prevHome: string | undefined;
	let tempHome: string;
	let tempCwd: string;

	beforeEach(() => {
		prevHome = process.env.PI_TEAMS_HOME;
		tempHome = makeTempHome();
		tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-user-cleanup-cwd-"));
		process.env.PI_TEAMS_HOME = tempHome;
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = prevHome;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempCwd, { recursive: true, force: true });
	});

	it("removes the pi-crew user state dir (~/.pi/agent/extensions/pi-crew/)", async () => {
		const crewStateDir = path.join(tempHome, ".pi", "agent", "extensions", "pi-crew");
		fs.writeFileSync(path.join(crewStateDir, "state", "marker.json"), "{}");
		assert.ok(fs.existsSync(crewStateDir));

		const r = await handleCleanup(params({ scope: "user", confirm: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /pi-crew user state dir/);
		assert.match(text, /removed:/);
		assert.ok(!fs.existsSync(crewStateDir), "user state dir must be removed");
	});

	it("preserves pi-crew.json by default (may hold user-customized settings)", async () => {
		const cfg = path.join(tempHome, ".pi", "agent", "pi-crew.json");
		fs.writeFileSync(cfg, "{}", "utf-8");

		const r = await handleCleanup(params({ scope: "user", confirm: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /pi-crew global config:/);
		assert.match(text, /preserved — use force: true/);
		assert.ok(fs.existsSync(cfg), "config preserved without force");
	});

	it("removes pi-crew.json only with force=true", async () => {
		const cfg = path.join(tempHome, ".pi", "agent", "pi-crew.json");
		fs.writeFileSync(cfg, "{}", "utf-8");

		const r = await handleCleanup(params({ scope: "user", force: true, confirm: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /removed:.*pi-crew\.json/);
		assert.ok(!fs.existsSync(cfg), "config removed with force");
	});

	it("removes only the pi-crew smoke-test .bak-* pattern, NOT real agent files", async () => {
		const agentsDir = path.join(tempHome, ".pi", "agent", "agents");
		// pi-crew smoke-test junk (the pattern we target).
		const bakJunk = path.join(agentsDir, "test-agent.md.bak-20260612091345819-b90d2b13");
		fs.writeFileSync(bakJunk, "junk", "utf-8");
		// A REAL user-authored agent file — must NEVER be touched.
		const realAgent = path.join(agentsDir, "my-custom-agent.md");
		fs.writeFileSync(realAgent, "# my agent", "utf-8");
		// A pi-crew-bundled agent that was copied — we can't tell, so we leave it.
		const copiedAgent = path.join(agentsDir, "explorer.md");
		fs.writeFileSync(copiedAgent, "# explorer", "utf-8");

		const r = await handleCleanup(params({ scope: "user", confirm: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /pi-crew test junk in agents dir:/);
		assert.match(text, /removed: 1 backup file/);
		assert.ok(!fs.existsSync(bakJunk), ".bak junk removed");
		assert.ok(fs.existsSync(realAgent), "real user agent preserved");
		assert.ok(fs.existsSync(copiedAgent), "copied agent preserved (can't tell origin)");
	});

	it("dryRun previews without removing anything", async () => {
		const crewStateDir = path.join(tempHome, ".pi", "agent", "extensions", "pi-crew");
		fs.writeFileSync(path.join(crewStateDir, "state", "marker.json"), "{}");

		const r = await handleCleanup(params({ scope: "user", dryRun: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /would remove/);
		assert.match(text, /dry-run preview/);
		assert.ok(fs.existsSync(crewStateDir), "nothing removed in dry-run");
	});

	it("handles a clean install (no pi-crew state) gracefully", async () => {
		// Remove everything we created in makeTempHome so the user dir is clean.
		fs.rmSync(path.join(tempHome, ".pi", "agent", "extensions", "pi-crew"), { recursive: true, force: true });

		const r = await handleCleanup(params({ scope: "user", confirm: true }), makeCtx(tempCwd));
		const text = textFromToolResult(r);

		assert.match(text, /nothing to do/);
	});
});
