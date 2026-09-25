import assert from "node:assert/strict";
import test from "node:test";
import { purgeQueuedAmbientNotifications } from "../../../../src/extension/registration/subagent-helpers.ts";

/**
 * FINDING 6 regression: clearing a health notification must opportunistically
 * purge still-QUEUED host follow-up copies of the original warning (the host
 * drains the follow-up queue one message per turn boundary — stale copies
 * otherwise replay for hours). Feature-detected: hosts without
 * clearQueuedUserMessagesMatching (e.g. pi 0.87.0) no-op safely.
 */

function fakePi(surface: Record<string, unknown>): never {
	return { sendMessage: () => undefined, ...(surface as object) } as never;
}

test("F6: purges matching queued follow-ups when the host API exists", () => {
	const calls: Array<(text: string) => boolean> = [];
	const pi = fakePi({
		clearQueuedUserMessagesMatching: (predicate: (text: string) => boolean) => {
			calls.push(predicate);
			return { steering: [], followUp: ["Run team_x has 2 dead worker(s)."] };
		},
	});
	const purged = purgeQueuedAmbientNotifications(pi, (text) => text.includes("team_x"));
	assert.equal(purged, true, "reports removal when the queue held a match");
	assert.equal(calls.length, 1, "host API called exactly once");
	assert.ok(calls[0]!("Run team_x has 2 dead worker(s)."), "predicate receives queued text");
	assert.ok(!calls[0]!("Unrelated user message"), "predicate is the caller's matcher");
});

test("F6: prefers session surface when the top-level API is absent", () => {
	const pi = fakePi({
		session: {
			clearQueuedUserMessagesMatching: () => ({ steering: ["s"], followUp: [] }),
		},
	});
	assert.equal(
		purgeQueuedAmbientNotifications(pi, () => true),
		true,
		"steering removals also count",
	);
});

test("F6: no-op (false, no throw) when the host lacks the API — pi 0.87.0", () => {
	const pi = fakePi({});
	assert.equal(
		purgeQueuedAmbientNotifications(pi, () => true),
		false,
	);
});

test("F6: host API throwing is swallowed (returns false)", () => {
	const pi = fakePi({
		clearQueuedUserMessagesMatching: () => {
			throw new Error("boom");
		},
	});
	assert.equal(
		purgeQueuedAmbientNotifications(pi, () => true),
		false,
	);
});

test("F6: zero removals reported as false", () => {
	const pi = fakePi({
		clearQueuedUserMessagesMatching: () => ({ steering: [], followUp: [] }),
	});
	assert.equal(
		purgeQueuedAmbientNotifications(pi, () => false),
		false,
	);
});
