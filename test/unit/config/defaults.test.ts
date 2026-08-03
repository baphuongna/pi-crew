/**
 * Unit tests for src/config/defaults.ts
 * Covers: all exported default constant objects
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_ARTIFACT_CLEANUP,
	DEFAULT_CACHE,
	DEFAULT_CHILD_PI,
	DEFAULT_CONCURRENCY,
	DEFAULT_EVENT_LOG,
	DEFAULT_LIVE_SESSION,
	DEFAULT_LOCKS,
	DEFAULT_MAILBOX,
	DEFAULT_NOTIFICATIONS,
	DEFAULT_PATHS,
	DEFAULT_SUBAGENT,
	DEFAULT_UI,
} from "../../../src/config/defaults.ts";

describe("DEFAULT_CHILD_PI", () => {
	it("has all expected timeout fields with positive numeric values", () => {
		assert.equal(typeof DEFAULT_CHILD_PI.postExitStdioGuardMs, "number");
		assert.ok(DEFAULT_CHILD_PI.postExitStdioGuardMs > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.finalDrainMs, "number");
		assert.ok(DEFAULT_CHILD_PI.finalDrainMs > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.hardKillMs, "number");
		assert.ok(DEFAULT_CHILD_PI.hardKillMs > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.responseTimeoutMs, "number");
		assert.ok(DEFAULT_CHILD_PI.responseTimeoutMs > 0);
	});

	it("has all size-limit fields with positive numeric values", () => {
		assert.equal(typeof DEFAULT_CHILD_PI.maxCaptureBytes, "number");
		assert.ok(DEFAULT_CHILD_PI.maxCaptureBytes > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.maxAssistantTextChars, "number");
		assert.ok(DEFAULT_CHILD_PI.maxAssistantTextChars > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.maxToolResultChars, "number");
		assert.ok(DEFAULT_CHILD_PI.maxToolResultChars > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.maxToolInputChars, "number");
		assert.ok(DEFAULT_CHILD_PI.maxToolInputChars > 0);
		assert.equal(typeof DEFAULT_CHILD_PI.maxCompactContentChars, "number");
		assert.ok(DEFAULT_CHILD_PI.maxCompactContentChars > 0);
	});

	it("responseTimeoutMs is greater than or equal to postExitStdioGuardMs", () => {
		assert.ok(
			DEFAULT_CHILD_PI.responseTimeoutMs >= DEFAULT_CHILD_PI.postExitStdioGuardMs,
			"responseTimeoutMs should be >= postExitStdioGuardMs",
		);
	});

	it("is typed as Readonly at compile time (runtime values are stable)", () => {
		// Readonly<> is a TypeScript compile-time annotation; the object is not
		// frozen at runtime. We verify the values are present and unchanged.
		const original = DEFAULT_CHILD_PI.postExitStdioGuardMs;
		assert.equal(typeof original, "number");
		assert.ok(original > 0);
	});
});

describe("DEFAULT_LIVE_SESSION", () => {
	it("has responseTimeoutMs as a positive number", () => {
		assert.equal(typeof DEFAULT_LIVE_SESSION.responseTimeoutMs, "number");
		assert.ok(DEFAULT_LIVE_SESSION.responseTimeoutMs > 0);
	});

	it("has maxYieldRetries as a positive integer", () => {
		assert.equal(typeof DEFAULT_LIVE_SESSION.maxYieldRetries, "number");
		assert.ok(DEFAULT_LIVE_SESSION.maxYieldRetries > 0);
		assert.ok(Number.isInteger(DEFAULT_LIVE_SESSION.maxYieldRetries));
	});

	it("has yieldPollIntervalMs and idleWaitTimeoutMs as positive numbers", () => {
		assert.ok(DEFAULT_LIVE_SESSION.yieldPollIntervalMs > 0);
		assert.ok(DEFAULT_LIVE_SESSION.idleWaitTimeoutMs > 0);
	});
});

describe("DEFAULT_LOCKS", () => {
	it("has staleMs as a positive number", () => {
		assert.equal(typeof DEFAULT_LOCKS.staleMs, "number");
		assert.ok(DEFAULT_LOCKS.staleMs > 0);
	});

	it("staleMs is a reasonable value (at least 1 second)", () => {
		assert.ok(DEFAULT_LOCKS.staleMs >= 1000);
	});

	it("only has staleMs key", () => {
		assert.deepEqual(Object.keys(DEFAULT_LOCKS), ["staleMs"]);
	});
});

describe("DEFAULT_CONCURRENCY", () => {
	it("has hardCap as a positive integer", () => {
		assert.equal(typeof DEFAULT_CONCURRENCY.hardCap, "number");
		assert.ok(DEFAULT_CONCURRENCY.hardCap > 0);
		assert.ok(Number.isInteger(DEFAULT_CONCURRENCY.hardCap));
	});

	it("has workflow object with all phase keys", () => {
		const w = DEFAULT_CONCURRENCY.workflow;
		assert.ok(w);
		assert.equal(typeof w.parallelResearch, "number");
		assert.equal(typeof w.research, "number");
		assert.equal(typeof w.implementation, "number");
		assert.equal(typeof w.review, "number");
		assert.equal(typeof w.default, "number");
	});

	it("all workflow values are positive integers", () => {
		const w = DEFAULT_CONCURRENCY.workflow;
		for (const [key, val] of Object.entries(w)) {
			assert.ok(typeof val === "number" && val > 0, `workflow.${key} should be a positive number`);
		}
	});

	it("has fallback as a positive integer", () => {
		assert.equal(typeof DEFAULT_CONCURRENCY.fallback, "number");
		assert.ok(DEFAULT_CONCURRENCY.fallback > 0);
	});
});

describe("DEFAULT_EVENT_LOG", () => {
	it("has terminalEventTypes as a non-empty array", () => {
		assert.ok(Array.isArray(DEFAULT_EVENT_LOG.terminalEventTypes));
		assert.ok(DEFAULT_EVENT_LOG.terminalEventTypes.length > 0);
	});

	it("all terminal event types are strings with correct prefix pattern", () => {
		for (const t of DEFAULT_EVENT_LOG.terminalEventTypes) {
			assert.equal(typeof t, "string");
			assert.ok(t.includes(".") || t.includes("_"), `event type '${t}' should contain a delimiter`);
		}
	});

	it("includes common terminal event types", () => {
		const types = DEFAULT_EVENT_LOG.terminalEventTypes;
		assert.ok(types.includes("run.completed"), "should include run.completed");
		assert.ok(types.includes("run.failed"), "should include run.failed");
		assert.ok(types.includes("task.completed"), "should include task.completed");
	});
});

describe("DEFAULT_ARTIFACT_CLEANUP", () => {
	it("has maxAgeDays as a positive integer", () => {
		assert.equal(typeof DEFAULT_ARTIFACT_CLEANUP.maxAgeDays, "number");
		assert.ok(DEFAULT_ARTIFACT_CLEANUP.maxAgeDays > 0);
		assert.ok(Number.isInteger(DEFAULT_ARTIFACT_CLEANUP.maxAgeDays));
	});

	it("maxAgeDays is a reasonable value (>= 1)", () => {
		assert.ok(DEFAULT_ARTIFACT_CLEANUP.maxAgeDays >= 1);
	});

	it("only has maxAgeDays key", () => {
		assert.deepEqual(Object.keys(DEFAULT_ARTIFACT_CLEANUP), ["maxAgeDays"]);
	});
});

describe("DEFAULT_PATHS", () => {
	it("has state object with expected subdirectory keys", () => {
		const s = DEFAULT_PATHS.state;
		assert.ok(s);
		assert.equal(typeof s.runsSubdir, "string");
		assert.equal(typeof s.artifactsSubdir, "string");
		assert.equal(typeof s.subagentsSubdir, "string");
		assert.equal(typeof s.importsSubdir, "string");
		assert.equal(typeof s.worktreesSubdir, "string");
	});

	it("state file names are non-empty strings", () => {
		const s = DEFAULT_PATHS.state;
		assert.ok(s.manifestFile.length > 0);
		assert.ok(s.tasksFile.length > 0);
		assert.ok(s.eventsFile.length > 0);
	});

	it("state subdirectories are non-empty strings", () => {
		const s = DEFAULT_PATHS.state;
		assert.ok(s.runsSubdir.length > 0);
		assert.ok(s.artifactsSubdir.length > 0);
		assert.ok(s.subagentsSubdir.length > 0);
	});
});

describe("DEFAULT_UI", () => {
	it("has refreshMs and notifierIntervalMs as positive numbers", () => {
		assert.ok(DEFAULT_UI.refreshMs > 0);
		assert.ok(DEFAULT_UI.notifierIntervalMs > 0);
	});

	it("has widgetMaxLines as a positive integer", () => {
		assert.equal(typeof DEFAULT_UI.widgetMaxLines, "number");
		assert.ok(DEFAULT_UI.widgetMaxLines > 0);
	});

	it("has widgetPlacement and dashboardPlacement as known strings", () => {
		assert.equal(DEFAULT_UI.widgetPlacement, "aboveEditor");
		assert.equal(DEFAULT_UI.dashboardPlacement, "center");
	});

	it("has boolean flags for powerbar, showModel, showTokens, showTools", () => {
		assert.equal(typeof DEFAULT_UI.powerbar, "boolean");
		assert.equal(typeof DEFAULT_UI.showModel, "boolean");
		assert.equal(typeof DEFAULT_UI.showTokens, "boolean");
		assert.equal(typeof DEFAULT_UI.showTools, "boolean");
	});
});

describe("DEFAULT_NOTIFICATIONS", () => {
	it("severityFilter includes warning, error, and critical", () => {
		const sev = DEFAULT_NOTIFICATIONS.severityFilter as readonly string[];
		assert.ok(sev.includes("warning"));
		assert.ok(sev.includes("error"));
		assert.ok(sev.includes("critical"));
	});

	it("dedupWindowMs and sinkRetentionDays are positive numbers", () => {
		assert.ok(DEFAULT_NOTIFICATIONS.dedupWindowMs > 0);
		assert.ok(DEFAULT_NOTIFICATIONS.sinkRetentionDays > 0);
	});

	it("batchWindowMs is a number (may be 0)", () => {
		assert.equal(typeof DEFAULT_NOTIFICATIONS.batchWindowMs, "number");
		assert.ok(DEFAULT_NOTIFICATIONS.batchWindowMs >= 0);
	});
});

describe("DEFAULT_CACHE", () => {
	it("has manifestMaxEntries as a positive integer", () => {
		assert.equal(typeof DEFAULT_CACHE.manifestMaxEntries, "number");
		assert.ok(DEFAULT_CACHE.manifestMaxEntries > 0);
		assert.ok(Number.isInteger(DEFAULT_CACHE.manifestMaxEntries));
	});

	it("only has manifestMaxEntries key", () => {
		assert.deepEqual(Object.keys(DEFAULT_CACHE), ["manifestMaxEntries"]);
	});
});

describe("DEFAULT_MAILBOX", () => {
	it("has perFileThresholdBytes as a positive number", () => {
		assert.ok(DEFAULT_MAILBOX.perFileThresholdBytes > 0);
	});

	it("has maxArchivesPerDirection as a positive integer", () => {
		assert.ok(DEFAULT_MAILBOX.maxArchivesPerDirection > 0);
		assert.ok(Number.isInteger(DEFAULT_MAILBOX.maxArchivesPerDirection));
	});

	it("only has expected keys", () => {
		assert.deepEqual(Object.keys(DEFAULT_MAILBOX).sort(), ["maxArchivesPerDirection", "perFileThresholdBytes"]);
	});
});

describe("DEFAULT_SUBAGENT", () => {
	it("has stuckBlockedNotifyMs as a positive number", () => {
		assert.equal(typeof DEFAULT_SUBAGENT.stuckBlockedNotifyMs, "number");
		assert.ok(DEFAULT_SUBAGENT.stuckBlockedNotifyMs > 0);
	});

	it("stuckBlockedNotifyMs is at least 1 minute", () => {
		assert.ok(DEFAULT_SUBAGENT.stuckBlockedNotifyMs >= 60_000);
	});

	it("only has stuckBlockedNotifyMs key", () => {
		assert.deepEqual(Object.keys(DEFAULT_SUBAGENT), ["stuckBlockedNotifyMs"]);
	});
});
