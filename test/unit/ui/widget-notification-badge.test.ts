import assert from "node:assert/strict";
import test from "node:test";
import { NOTIFICATION_BADGE_CAP, notificationBadge, widgetHeader } from "../../../src/ui/widget/index.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

test("notificationBadge hides zero and renders alerts label (not a bell)", () => {
	assert.equal(notificationBadge(0), "");
	assert.equal(notificationBadge(undefined), "");
	// Bug 021: no 🔔 bell glyph (was misread as "messages"); explicit "alerts" label
	const badge = notificationBadge(3, { TERM: "xterm-256color" });
	assert.match(badge, /3 alerts/);
	assert.doesNotMatch(badge, /🔔/);
});

test("notificationBadge falls back for dumb terminals (bracketed, still labeled alerts)", () => {
	assert.equal(notificationBadge(2, { TERM: "dumb" }), " [2 alerts]");
});

test("Bug 021: notificationBadge caps the display at 99+ (no alarming 227)", () => {
	const badge = notificationBadge(227, { TERM: "xterm-256color" });
	assert.match(badge, /99\+ alerts/);
	assert.doesNotMatch(badge, /227/); // the raw alarming number is NOT shown
	// exactly-at-cap shows the bare number, not "99+"
	assert.match(notificationBadge(NOTIFICATION_BADGE_CAP, { TERM: "xterm-256color" }), /99 alerts/);
	assert.match(
		notificationBadge(NOTIFICATION_BADGE_CAP + 1, {
			TERM: "xterm-256color",
		}),
		/99\+ alerts/,
	);
});

test("widgetHeader includes the alerts segment (not a bell)", () => {
	const header = widgetHeader([], "⠋", 20, 4);
	assert.match(header, /4 alerts/);
	assert.doesNotMatch(header, /🔔/);
});

/** Minimal run-shaped mock: widgetHeader only reads agent statuses off runs. */
function headerRun(planApproval?: WidgetRun["run"]["planApproval"]): WidgetRun {
	return {
		run: {
			runId: "run_abc123def45678",
			team: "fast-fix",
			workflow: "fast-fix",
			status: "running",
			createdAt: "2026-08-18T00:00:00Z",
			updatedAt: "2026-08-18T00:00:00Z",
			artifacts: [],
			planApproval,
		},
		agents: [],
		snapshot: undefined,
	} as unknown as WidgetRun;
}

test("WP-3: widgetHeader is byte-identical regardless of planApproval state (golden regression)", () => {
	// The plan badge lives on the RUN line (see widget-truncate tests); the
	// header must stay untouched so the alerts badge remains the only header badge.
	const pending = widgetHeader([headerRun({ required: true, status: "pending", requestedAt: "t", updatedAt: "t" })], "⠋", 20, 4);
	const none = widgetHeader([headerRun()], "⠋", 20, 4);
	assert.equal(pending, none);
	assert.doesNotMatch(pending, /plan:/);
	assert.match(pending, /4 alerts/);
});
