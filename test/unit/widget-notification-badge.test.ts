import test from "node:test";
import assert from "node:assert/strict";
import { notificationBadge, widgetHeader } from "../../src/ui/crew-widget.ts";

test("notificationBadge hides zero and renders emoji by default", () => {
	assert.equal(notificationBadge(0), "");
	assert.equal(notificationBadge(undefined), "");
	assert.match(notificationBadge(3, { TERM: "xterm-256color" }), /3/);
});

test("notificationBadge falls back for dumb terminals", () => {
	assert.equal(notificationBadge(2, { TERM: "dumb" }), " [!2]");
});

test("widgetHeader includes notification count", () => {
	const header = widgetHeader([], "⠋", 20, 4);
	assert.match(header, /4/);
});
