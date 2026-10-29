/**
 * w7a-render — untrusted theme-name regression tests
 * (fingerprint: pi-crew:src/ui/theme-discovery:control-char-theme-name-render).
 *
 * ~/.pi/agent/themes is worker-writable (unsandboxed default execution, not
 * sensitive-path protected), so a filename stem there can embed OSC-52 /
 * OSC-8 / CSI sequences. The old discovery took the raw stem as the theme
 * name and every downstream render (formatThemesListing tool-result content,
 * settings-overlay SelectSubmenu values) emitted it verbatim.
 *
 * Fixes under test:
 *  1. discovery REFUSES control-char filename stems entirely;
 *  2. themeLine sanitizes the name before it enters the listing;
 *  3. the JSON `name` display field is sanitized at discovery;
 *  4. settings-overlay maps picker values through sanitizeUntrustedLine
 *     (source pin — the SETTINGS table is module-private).
 *
 * Sandbox: HOME/USERPROFILE point at a mkdtemp dir (same pattern as
 * theme-discovery.test.ts) so the real ~/.pi is never touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverPiThemes, formatThemesListing } from "../../../src/ui/theme-discovery.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const ESC = "\u001b";
const BEL = "\u0007";

const SETTINGS_OVERLAY_SOURCE = path.join(import.meta.dirname ?? __dirname, "../../../src/ui/settings-overlay.ts");

let tmpHome = "";
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

/** A planted filename stem carrying a full OSC-52 clipboard-write payload. */
const EVIL_STEM = `evil${ESC}]52;c;aGkK${BEL}name`;

before(() => {
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-theme-untrusted-"));
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;

	const dir = path.join(tmpHome, ".pi", "agent", "themes");
	fs.mkdirSync(dir, { recursive: true });
	// (1) escape-carrying filename (the PoC plant — byte-for-byte the audit shape)
	fs.writeFileSync(path.join(dir, `${EVIL_STEM}.json`), "{}", "utf8");
	// (2) a legitimate theme, untouched by sanitization
	fs.writeFileSync(path.join(dir, "clean-name.json"), JSON.stringify({ name: "clean display" }), "utf8");
	// (3) legit filename but worker-writable JSON body whose `name` carries a payload
	fs.writeFileSync(path.join(dir, "weird-display.json"), JSON.stringify({ name: `bad${ESC}]52;c;ZmlsZWQ=${BEL}display` }), "utf8");
});

after(async () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	await removeDirWithRetry(tmpHome);
});

describe("w7a: theme discovery refuses escape-carrying filenames", () => {
	it("a planted OSC-52 filename stem never becomes a theme name", () => {
		const themes = discoverPiThemes();
		const names = themes.map((t) => t.name);
		assert.ok(!names.includes(EVIL_STEM), `planted escape filename must be refused, got: ${JSON.stringify(names)}`);
		for (const name of names) {
			assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(name), `theme name must be control-char-free: ${JSON.stringify(name)}`);
		}
	});

	it("legitimate custom themes are still discovered (skip is surgical)", () => {
		const names = discoverPiThemes().map((t) => t.name);
		assert.ok(names.includes("clean-name"), `clean theme must survive: ${JSON.stringify(names)}`);
		assert.ok(names.includes("weird-display"), `clean filename with dirty JSON name must survive: ${JSON.stringify(names)}`);
	});

	it("the JSON `name` display field is sanitized at discovery", () => {
		const weird = discoverPiThemes().find((t) => t.name === "weird-display");
		assert.ok(weird, "weird-display fixture theme must exist");
		assert.ok(weird.displayName !== undefined, "displayName must be read");
		assert.ok(
			!/[\u001b\u009b\u009c\u0007]/.test(weird.displayName!),
			`displayName must be escape-free, got ${JSON.stringify(weird.displayName)}`,
		);
		assert.ok(weird.displayName!.includes("baddisplay"), `sanitized prose must survive: ${JSON.stringify(weird.displayName)}`);
	});
});

describe("w7a: formatThemesListing output is escape-free", () => {
	it("the gallery listing (tool-result content) contains zero ESC/BEL/C1 bytes", () => {
		const listing = formatThemesListing();
		assert.ok(!/[\u001b\u009b\u009c\u0007]/.test(listing), `listing must be escape-free:\n${JSON.stringify(listing)}`);
		assert.ok(listing.includes("clean-name"), `clean theme must be listed:\n${listing}`);
		assert.ok(!listing.includes("evil"), `planted theme must not be listed:\n${listing}`);
	});
});

describe("w7a: settings-overlay picker values are sanitized (source pin)", () => {
	// The SETTINGS table (and the `__piTheme__` values mapping) is
	// module-private, so this guard pins the sanitize mapping in source — the
	// same pattern theme-discovery.test.ts uses for its own regression pin.
	it("__piTheme__ values map through sanitizeUntrustedLine before SelectSubmenu", () => {
		const source = fs.readFileSync(SETTINGS_OVERLAY_SOURCE, "utf8");
		assert.ok(
			source.includes("values: discoverPiThemes().map((t) => sanitizeUntrustedLine(t.name))"),
			"settings-overlay __piTheme__ picker values must pass through sanitizeUntrustedLine (w7a-render)",
		);
		assert.ok(
			source.includes("sanitizeUntrustedLine(getActivePiTheme()"),
			"the active-theme description read from worker-writable settings.json must be sanitized too",
		);
	});
});
