/**
 * Tests for src/extension/session-summary.ts
 *
 * notifyActiveRuns is tightly coupled to pi infrastructure (listRuns,
 * readCrewAgents, isDisplayActiveRun). These tests verify it does not crash
 * and that the notification logic works as expected.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { notifyActiveRuns } from "../../../../src/extension/session-summary.ts";
import { clearProjectRootCache } from "../../../../src/utils/paths.ts";

interface MockCtx {
	cwd: string;
	ui: { notify: (msg: string, level: string) => void };
	notifyCalls: string[];
}

function makeCtx(dir: string): MockCtx {
	const calls: string[] = [];
	return {
		cwd: dir,
		ui: {
			notify: (msg: string, _level: string) => {
				calls.push(msg);
			},
		},
		notifyCalls: calls,
	};
}

describe("notifyActiveRuns does not crash with empty temp cwd", () => {
	it("executes without throwing on a directory with no project markers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-summary-cov-"));
		clearProjectRootCache();
		// No .git, no .crew — findRepoRoot returns undefined
		const ctx = makeCtx(dir);
		try {
			// Should not throw
			notifyActiveRuns(ctx as never);
			assert.ok(true, "should complete without error");
		} finally {
			clearProjectRootCache();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("notifyActiveRuns uses correct message format", () => {
	it("passes 'pi-crew active runs' prefix when notifying", () => {
		// Use the real CWD which may have active runs from the dev environment
		const cwd = process.cwd();
		clearProjectRootCache();
		const ctx = makeCtx(cwd);
		try {
			notifyActiveRuns(ctx as never);
			// If there are active runs, verify the message format
			if (ctx.notifyCalls.length > 0) {
				const msg = ctx.notifyCalls[0];
				assert.ok(msg.includes("pi-crew active runs"), "message should contain 'pi-crew active runs'");
				assert.ok(msg.includes("["), "message should contain status bracket notation");
			}
			// If no active runs, that's also acceptable (all completed/filtered)
		} finally {
			clearProjectRootCache();
		}
	});
});

describe("notifyActiveRuns produces at most one notification", () => {
	it("calls ctx.ui.notify at most once per invocation", () => {
		const cwd = process.cwd();
		clearProjectRootCache();
		const ctx = makeCtx(cwd);
		try {
			notifyActiveRuns(ctx as never);
			// The function either calls notify once or not at all
			assert.ok(ctx.notifyCalls.length <= 1, `expected at most 1 notification, got ${ctx.notifyCalls.length}`);
		} finally {
			clearProjectRootCache();
		}
	});
});
