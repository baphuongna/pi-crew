/**
 * w7a-render — stripTerminalSequences unit tests (src/utils/safe-terminal-text.ts).
 *
 * The helper is the shared neutralizer for the three w7a render sinks:
 * theme names (theme-discovery/settings-overlay), the inline agent
 * transcript (agent-transcript), and tool-renderer payload text. The
 * invariant under test: output contains ZERO ESC/C1-introducer control
 * bytes — OSC/APC/DCS/SOS payloads are removed wholesale, CSI (incl. the
 * C1 form) is removed, truncated sequences leave no introducer behind —
 * while printable structure (newlines, tabs) passes through unchanged.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTerminalEscapeBytes, stripTerminalSequences } from "../../../src/utils/safe-terminal-text.ts";

const ESC = "\u001b";
const BEL = "\u0007";

/** No ESC / C1 introducer / C1 terminator / BEL byte anywhere. */
function assertEscapeFree(value: string, label: string): void {
	assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(value), `${label}: escape byte survived in ${JSON.stringify(value)}`);
}

test("OSC 52 clipboard grab (BEL-terminated) is stripped wholesale", () => {
	const out = stripTerminalSequences(`before${ESC}]52;c;aGkK${BEL}after`);
	assert.equal(out, "beforeafter");
	assertEscapeFree(out, "osc52-bel");
});

test("OSC 52 clipboard grab (ST-terminated) is stripped wholesale", () => {
	const out = stripTerminalSequences(`x${ESC}]52;c;ZWNobyBwd25lZA==${ESC}\\y`);
	assert.equal(out, "xy");
	assertEscapeFree(out, "osc52-st");
});

test("OSC 8 hyperlink pair is stripped, anchor text kept", () => {
	const out = stripTerminalSequences(`${ESC}]8;;file:///etc/passwd${BEL}click${ESC}]8;;${BEL}`);
	assert.equal(out, "click");
	assertEscapeFree(out, "osc8");
});

test("OSC 0 title set is stripped", () => {
	const out = stripTerminalSequences(`${ESC}]0;evil-title${BEL}ok`);
	assert.equal(out, "ok");
	assertEscapeFree(out, "osc0");
});

test("non-SGR CSI is stripped (screen clear, cursor home, DA1 query)", () => {
	for (const seq of ["[2J", "[H", "[6n", "[?25l"]) {
		const out = stripTerminalSequences(`a${ESC}${seq}b`);
		assert.equal(out, "ab", `CSI ${seq} must be stripped`);
		assertEscapeFree(out, `csi-${seq}`);
	}
});

test("C1 CSI (\\u009B) form is stripped", () => {
	const out = stripTerminalSequences("a\u009b2Jb");
	assert.equal(out, "ab");
	assertEscapeFree(out, "c1-csi");
});

test("truncated sequences leave no ESC/C1 byte behind", () => {
	for (const tail of ["", "]", "[", "]52;c;abc", "[38;5", "Ppayload"]) {
		const out = stripTerminalSequences(`keep${ESC}${tail}`);
		assertEscapeFree(out, `truncated-${JSON.stringify(tail)}`);
		assert.ok(out.startsWith("keep"), `printable prefix must survive for tail ${JSON.stringify(tail)}`);
	}
	assertEscapeFree(stripTerminalSequences("x\u009c"), "c1-st-residual");
});

test("printable structure passes through unchanged (newlines/tabs preserved)", () => {
	const text = "line1\nline2\tindented — ✅ ok";
	assert.equal(stripTerminalSequences(text), text);
});

test("clean text hits the fast path and is returned as-is", () => {
	assert.equal(stripTerminalSequences("crew-gruvbox-dark"), "crew-gruvbox-dark");
	assert.equal(stripTerminalSequences(""), "");
	assert.equal(hasTerminalEscapeBytes("plain"), false);
	assert.equal(hasTerminalEscapeBytes(`${ESC}[31m`), true);
	assert.equal(hasTerminalEscapeBytes("a\u009bb"), true);
});

test("composite worker transcript payload (OSC52 + DA1 + OSC0) reduces to plain prose", () => {
	const payload = `${ESC}]52;c;cGx1Z2dlZA==${BEL}${ESC}[6n${ESC}]0;evil-title${BEL}I read the file.`;
	const out = stripTerminalSequences(payload);
	assert.equal(out, "I read the file.");
	assertEscapeFree(out, "composite");
	assert.ok(!out.includes("cGx1Z2dlZA=="), "OSC-52 base64 body must not survive");
});
