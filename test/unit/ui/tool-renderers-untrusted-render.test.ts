/**
 * w7a-render — tool-renderer worker-output render sanitization regression
 * (fingerprint: pi-crew:src/ui/tool-renderers:worker-output-render-unsanitized).
 *
 * The team/agent tool-renderer module rendered worker-derived text (tool
 * result content, task.error excerpts, streaming fallback, agent output
 * previews) with only newline-flattening + visible-width truncation — but
 * pi-tui zero-widths escape payloads, so an in-window OSC-52 / OSC-8 / CSI
 * payload rode truncateToWidth verbatim into terminal.write.
 *
 * Fix under test: every worker/repo-derived string passes
 * sanitizeUntrustedLine BEFORE theme wrap (R4-B1), at previewLine and at
 * each raw content/error consumption site.
 *
 * asCrewTheme({}) emits no ANSI of its own (locked by
 * tool-renderers-redesign.test.ts literal matches), so these assertions can
 * be STRICT: zero ESC bytes anywhere in rendered card output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { asCrewTheme, type CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { agentToolRenderer, teamToolRenderer } from "../../../src/ui/tool-renderers/index.ts";

const theme: CrewTheme = asCrewTheme({});
const W = 160;

const ESC = "\u001b";
const BEL = "\u0007";

/** OSC-52 clipboard write + OSC-8 hyperlink + OSC-0 title + screen-clear CSI + bare ESC. */
const PAYLOAD = `${ESC}]52;c;ZWNobyBwd25lZA==${ESC}\\${ESC}]8;;file:///etc/evil${BEL}link${ESC}]8;;${BEL}${ESC}]0;pwned-title${BEL}${ESC}[2J${ESC}`;

const raw = (c: unknown, w: number = W): string => {
	const lines = (c as { render?: (width: number) => string[] } | null)?.render?.(w);
	return Array.isArray(lines) ? lines.map((l) => l.replace(/\s+$/, "")).join("\n") : "";
};

function assertRenderEscapeFree(out: string, label: string): void {
	assert.ok(!out.includes(ESC), `${label}: raw ESC byte reached rendered card output:\n${JSON.stringify(out)}`);
	assert.ok(!out.includes("ZWNobyBwd25lZA=="), `${label}: OSC-52 base64 body survived:\n${JSON.stringify(out)}`);
	assert.ok(!out.includes("file:///etc/evil"), `${label}: OSC-8 hyperlink target survived:\n${JSON.stringify(out)}`);
	assert.ok(!out.includes("pwned-title"), `${label}: OSC-0 title payload survived:\n${JSON.stringify(out)}`);
}

test("team expanded non-run card: tool-result content payload renders neutralized", () => {
	const out = raw(
		teamToolRenderer.renderResult(
			{
				details: { action: "summary", status: "ok" },
				content: [{ type: "text", text: `summary line${PAYLOAD}clean tail` }],
			},
			{},
			theme,
			{ expanded: true },
		),
	);
	assertRenderEscapeFree(out, "team expanded");
	assert.ok(out.includes("summary line"), "unsanitized prose must still render");
	assert.ok(out.includes("clean tail"), "text after the stripped payload must survive");
});

test("team renderCall goal preview payload renders neutralized", () => {
	const out = raw(
		teamToolRenderer.renderCall({ action: "run", goal: `implement${PAYLOAD}thing`, team: "impl" }, theme, { expanded: false }),
	);
	assertRenderEscapeFree(out, "team renderCall goal");
	// The payload's OSC-8 anchor text ("link") survives as printable prose between
	// the stripped sequences — only the control bytes must vanish.
	assert.ok(out.includes("implementlinkthing"), "goal prose must survive sanitization");
});

test("team streaming fallback line (elapsed=0 path) payload renders neutralized", () => {
	const out = raw(
		teamToolRenderer.renderResult(
			{ details: {}, content: [{ type: "text", text: `${PAYLOAD}starting` }] },
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assertRenderEscapeFree(out, "team streaming fallback");
	assert.ok(out.includes("starting"), "fallback prose must survive");
});

test("agent closed card: d.error payload renders neutralized", () => {
	const out = raw(
		agentToolRenderer.renderResult(
			{ details: { agentId: "sub_01", agentName: "explorer", status: "failed", error: `RPC child failed: ${PAYLOAD}stderr tail` } },
			{},
			theme,
			{ expanded: false },
		),
	);
	assertRenderEscapeFree(out, "agent closed error");
	assert.ok(out.includes("stderr tail"), "error prose must survive sanitization");
});

test("agent closed card: results[].output preview payload renders neutralized", () => {
	const out = raw(
		agentToolRenderer.renderResult(
			{
				details: {
					status: "completed",
					results: [{ agentId: "sub_01", status: "completed", output: `first line${PAYLOAD}kept` }],
				},
			},
			{},
			theme,
			{ expanded: false },
		),
	);
	assertRenderEscapeFree(out, "agent closed preview");
	assert.ok(out.includes("first line"), "preview prose must survive");
});

test("agent expanded card: results[].output/error rows render neutralized", () => {
	const out = raw(
		agentToolRenderer.renderResult(
			{
				details: {
					status: "failed",
					results: [{ agentId: "sub_01", status: "failed", error: `boom${PAYLOAD}done` }],
				},
			},
			{},
			theme,
			{ expanded: true },
		),
	);
	assertRenderEscapeFree(out, "agent expanded error row");
	assert.ok(out.includes("boom"), "error row prose must survive");
});

test("agent streaming card: progress text payload renders neutralized", () => {
	const out = raw(
		agentToolRenderer.renderResult(
			{
				details: { agentId: "sub_02", agentName: "explorer", status: "running" },
				content: [{ type: "text", text: `agent status=running elapsed=95s${PAYLOAD}` }],
			},
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assertRenderEscapeFree(out, "agent streaming");
	assert.ok(out.includes("explorer"), "agent label must still render");
});
