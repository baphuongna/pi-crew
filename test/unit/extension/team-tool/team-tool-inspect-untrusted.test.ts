/**
 * w7a-render — inspect.ts producer-side sanitization regression
 * (defense in depth for pi-crew:src/ui/tool-renderers:worker-output-render-unsanitized).
 *
 * team action=events / action=summary interpolate worker-failure-derived
 * text (event.message / task.error, which embed child-process stderr
 * excerpts) into tool-result content RAW. With this fix both are sanitized
 * at interpolation, so the payload never enters tool-result content at all.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleEvents, handleSummary } from "../../../../src/extension/team-tool/inspect.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const ESC = "\u001b";
/** OSC-52 clipboard write + screen clear, riding a fake child-stderr excerpt. */
const PAYLOAD = `RPC child Pi failed to start. Stderr: ${ESC}]52;c;ZWNobyBwd25lZA==${ESC}\\${ESC}[2Jboom`;

const fixtureTeam: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const fixtureWorkflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

interface RunFixture {
	cwd: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
}

function makeRun(goal: string): RunFixture {
	let cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-inspect-untrusted-"));
	try {
		const real = fs.realpathSync.native(cwd);
		cwd = real.startsWith("\\\\?\\") ? real.slice(4) : real;
	} catch {
		/* keep as-is */
	}
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest, tasks } = createRunManifest({ cwd, team: fixtureTeam, workflow: fixtureWorkflow, goal });
	return { cwd, manifest, tasks };
}

/** Zero ESC / BEL / C1 bytes anywhere in tool-result content. */
function assertContentEscapeFree(text: string, label: string): void {
	assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(text), `${label}: escape byte reached tool-result content:\n${JSON.stringify(text)}`);
	assert.ok(!text.includes("ZWNobyBwd25lZA=="), `${label}: OSC-52 base64 body survived:\n${text}`);
}

describe("w7a: handleEvents sanitizes event.message at interpolation", () => {
	it("an escape-payload event message renders sanitized in the events listing", async () => {
		const fixture = makeRun("events sanitize");
		try {
			const line = JSON.stringify({
				time: "2026-10-29T00:00:00.000Z",
				type: "task.failed",
				runId: fixture.manifest.runId,
				message: PAYLOAD,
				metadata: { seq: 99 },
			});
			fs.appendFileSync(fixture.manifest.eventsPath, `${line}\n`, "utf-8");

			const res = handleEvents({ action: "events", runId: fixture.manifest.runId } as never, { cwd: fixture.cwd } as TeamContext);
			assert.equal(res.isError, false);
			const text = textFromToolResult(res);
			assertContentEscapeFree(text, "handleEvents");
			assert.ok(text.includes("task.failed"), "event row must still be listed");
			assert.ok(text.includes("boom"), "sanitized stderr prose must survive");
		} finally {
			await removeDirWithRetry(fixture.cwd);
		}
	});
});

describe("w7a: handleSummary sanitizes task.error at interpolation", () => {
	it("an escape-payload task error renders sanitized in the task summary line", async () => {
		const fixture = makeRun("summary sanitize");
		try {
			fixture.tasks[0]!.error = PAYLOAD;
			fixture.tasks[0]!.status = "failed";
			saveRunTasks(fixture.manifest, fixture.tasks);

			const res = handleSummary({ action: "summary", runId: fixture.manifest.runId } as never, { cwd: fixture.cwd } as TeamContext);
			assert.equal(res.isError, false);
			const text = textFromToolResult(res);
			assertContentEscapeFree(text, "handleSummary");
			assert.ok(text.includes("RPC child Pi failed to start. Stderr:"), "error prose must be listed");
			assert.ok(text.includes("boom"), "sanitized stderr tail must survive");
		} finally {
			await removeDirWithRetry(fixture.cwd);
		}
	});
});
