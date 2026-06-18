import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderRunStarted, renderRunCompleted, renderResumeDirective, registerCrewMessageRenderers } from "../../src/extension/message-renderers.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Minimal stub theme — the renderers only call theme.fg(level, text) and theme.bold(text).
const theme = {
	fg: (_level: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
} as unknown as Theme;

const options = { expanded: false };

describe("renderRunStarted", () => {
	it("renders a launch line with team/workflow/goal", () => {
		const result = renderRunStarted(
			{ content: "", details: { runId: "team_123", team: "default", workflow: "fast-fix", goal: "fix bug" } },
			options,
			theme,
		);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /team_123/);
		assert.match(rendered, /default\/fast-fix/);
		assert.match(rendered, /fix bug/);
	});

	it("truncates long goals", () => {
		const longGoal = "x".repeat(100);
		const result = renderRunStarted(
			{ content: "", details: { runId: "r1", team: "t", goal: longGoal } },
			options,
			theme,
		);
		const rendered = result.render(120).join(" ");
		assert.ok(!rendered.includes("x".repeat(100)));
		assert.match(rendered, /…/);
	});

	it("falls back to 'direct' when no team/agent", () => {
		const result = renderRunStarted({ content: "", details: { runId: "r1" } }, options, theme);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /direct/);
	});
});

describe("renderRunCompleted", () => {
	it("uses success styling for completed runs", () => {
		const result = renderRunCompleted(
			{ content: "", details: { runId: "r1", status: "completed", taskCount: 5, goal: "done" } },
			options,
			theme,
		);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /completed/);
		assert.match(rendered, /5 tasks/);
		assert.match(rendered, /done/);
	});

	it("uses error styling for failed runs", () => {
		const result = renderRunCompleted(
			{ content: "", details: { runId: "r1", status: "failed" } },
			options,
			theme,
		);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /failed/);
	});

	it("uses warning styling for cancelled runs", () => {
		const result = renderRunCompleted(
			{ content: "", details: { runId: "r1", status: "cancelled" } },
			options,
			theme,
		);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /cancelled/);
	});

	it("handles missing details gracefully", () => {
		const result = renderRunCompleted({ content: "" }, options, theme);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /finished/);
	});
});

describe("renderResumeDirective", () => {
	it("extracts text from string content", () => {
		const result = renderResumeDirective({ content: "Context compacted, resuming" }, options, theme);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /Context compacted, resuming/);
	});

	it("falls back to default message when content is empty", () => {
		const result = renderResumeDirective({ content: "" }, options, theme);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /resuming in-flight crew work/);
	});

	it("extracts text from array content", () => {
		const result = renderResumeDirective({ content: [{ type: "text", text: "array content" }] }, options, theme);
		const rendered = result.render(120).join(" ");
		assert.match(rendered, /array content/);
	});
});

describe("registerCrewMessageRenderers", () => {
	it("registers all 3 renderers without throwing", () => {
		const registered: string[] = [];
		const fakePi = {
			registerMessageRenderer: (customType: string) => { registered.push(customType); },
		};
		registerCrewMessageRenderers(fakePi as never);
		assert.deepEqual(registered, ["crew:run-started", "crew:run-completed", "crew:resume-directive"]);
	});

	it("works with a real-shaped ExtensionAPI (registerMessageRenderer present)", () => {
		const fakePi = { registerMessageRenderer: () => {} };
		// Should not throw
		registerCrewMessageRenderers(fakePi as never);
	});
});
