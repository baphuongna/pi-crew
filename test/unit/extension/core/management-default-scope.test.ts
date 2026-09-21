import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";

/**
 * Tier 9e real-probe finding (2026-09-21).
 *
 * `create` a project-scoped resource, then `update`/`delete` it WITHOUT an
 * explicit `scope`:
 *
 *   { action:'update', resource:'team', team:'t9e-probe-team', config:{...} }
 *   → "team 't9e-probe-team' not found in mutable user/project scopes."
 *
 * The message claims user+project are searched, but `findResource`'s default
 * pool is `[...discovery.builtin, ...discovery.user]` — `discovery.project` is
 * missing, and every `builtin` entry is then dropped by `sourceMatches`
 * (`item.source !== "builtin"`), so the default pool degenerates to USER ONLY.
 * A project resource is therefore invisible unless the caller guesses
 * `scope:'project'`.
 *
 * The pre-existing test masked it by always passing `scope:'project'`.
 */

function scratch(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mgmt-scope-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

async function createProjectTeam(cwd: string): Promise<string> {
	const created = await handleTeamTool(
		{
			action: "create",
			resource: "team",
			config: {
				name: "Scoped Probe",
				description: "project-scoped team",
				scope: "project",
				roles: [{ name: "executor", agent: "executor" }],
			},
		},
		{ cwd },
	);
	assert.equal(created.isError, false, `create failed: ${JSON.stringify(created)}`);
	return path.join(cwd, ".crew", "teams", "scoped-probe.team.md");
}

test("update finds a PROJECT resource WITHOUT an explicit scope (default pool must include project)", async () => {
	const cwd = scratch();
	try {
		const filePath = await createProjectTeam(cwd);
		const update = await handleTeamTool(
			{
				action: "update",
				resource: "team",
				team: "scoped-probe",
				// NOTE: no `scope` — the caller should not have to guess.
				config: { description: "Updated without scope" },
			},
			{ cwd },
		);
		assert.equal(update.isError, false, `update rejected a project team: ${JSON.stringify(update)}`);
		assert.match(fs.readFileSync(filePath, "utf-8"), /Updated without scope/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("delete finds a PROJECT resource WITHOUT an explicit scope", async () => {
	const cwd = scratch();
	try {
		const filePath = await createProjectTeam(cwd);
		const deleted = await handleTeamTool({ action: "delete", resource: "team", team: "scoped-probe", confirm: true }, { cwd });
		assert.equal(deleted.isError, false, `delete rejected a project team: ${JSON.stringify(deleted)}`);
		assert.equal(fs.existsSync(filePath), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a project AND a user resource with the same name is ambiguous → explicit scope required", async () => {
	const cwd = scratch();
	try {
		await createProjectTeam(cwd);
		const update = await handleTeamTool(
			{ action: "update", resource: "team", team: "scoped-probe", config: { description: "x" } },
			{ cwd },
		);
		// With only a project copy present this must SUCCEED (no false ambiguity).
		assert.equal(update.isError, false, `single project resource must not be ambiguous: ${JSON.stringify(update)}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("a genuinely unknown name still reports not-found", async () => {
	const cwd = scratch();
	try {
		await createProjectTeam(cwd);
		const update = await handleTeamTool(
			{ action: "update", resource: "team", team: "does-not-exist", config: { description: "x" } },
			{ cwd },
		);
		assert.equal(update.isError, true, "an unknown name must still fail");
		assert.match(JSON.stringify(update), /not found/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
