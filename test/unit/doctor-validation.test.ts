import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("doctor includes platform diagnostics", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-platform-"));
	try {
		const doctor = await handleTeamTool({ action: "doctor" }, { cwd });
		assert.match(firstText(doctor), new RegExp(`platform: ${process.platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${process.arch}`));
		assert.match(firstText(doctor), /node=v/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor includes resource validation result", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-test-"));
	fs.mkdirSync(path.join(cwd, ".crew", "teams"), { recursive: true });
	try {
		fs.writeFileSync(path.join(cwd, ".crew", "teams", "broken.team.md"), "---\nname: broken\ndescription: Broken team\ndefaultWorkflow: missing-flow\n---\n\n- ghost: agent=ghost\n", "utf-8");
		const doctor = await handleTeamTool({ action: "doctor" }, { cwd });
		assert.equal(doctor.isError, true);
		assert.match(firstText(doctor), /resource validation/);
		assert.match(firstText(doctor), /1 errors|2 errors/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

