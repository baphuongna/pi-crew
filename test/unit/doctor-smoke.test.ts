import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("doctor child smoke is opt-in and reports failure cleanly without throwing", async () => {
	// Place mock pi in node_modules/.bin which is an allowed PI_TEAMS_PI_BIN prefix
	const mockDir = path.join(process.cwd(), "node_modules", ".bin");
	fs.mkdirSync(mockDir, { recursive: true });
	const previousPiBin = process.env.PI_TEAMS_PI_BIN;
	const failingPi = path.join(mockDir, "pi-fail-doctor-smoke.mjs");
	try {
		fs.writeFileSync(failingPi, "console.error('mock pi smoke failure'); process.exit(1);\n", "utf-8");
		process.env.PI_TEAMS_PI_BIN = failingPi;
		const result = await handleTeamTool({ action: "doctor", config: { smokeChildPi: true } }, { cwd: process.cwd() });
		const text = firstText(result);
		assert.match(text, /child Pi smoke/);
		assert.match(text, /mock pi smoke failure|Command failed/);
	} finally {
		if (previousPiBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = previousPiBin;
		fs.rmSync(failingPi, { force: true });
	}
});
