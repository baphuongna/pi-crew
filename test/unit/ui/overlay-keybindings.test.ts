/**
 * M2-1 (P1-9) — centralised `overlay:*` keybindings.
 *
 * The 4 migrated overlays (agent-picker, confirm, mailbox-detail,
 * mailbox-compose) used to hardcode their own `matchesKey` chains: the same
 * "↑/↓/Enter/Esc" concept re-implemented 4 times, none of it remappable. M2-1
 * routes them through `overlayActionForKey()` in `keybinding-map.ts`, which
 * reuses the EXISTING override pipeline (`.crew/config.json` → `keybindings`,
 * `PI_CREW_KEYBINDINGS`, collision → revert, `getKeybindingOverrideWarnings`).
 *
 * This file proves the three M2-1 acceptance criteria:
 *   (a) an override through `.crew/config.json` →
 *       `keybindings["overlay:<name>:<action>"]` demonstrably changes
 *       BEHAVIOUR (the real overlay classes are driven, not just the resolver);
 *   (b) the DEFAULT keys are byte-identical to the pre-M2-1 hardcoded chains
 *       (the parity table below was transcribed from the code BEFORE the
 *       migration) — and the dashboard goldens in
 *       `keybinding-map.parity.test.ts` / `keybinding-map-override.test.ts`
 *       remain untouched;
 *   (c) no overlay hardcodes `matchesKey(data, "q")` (or any other literal key)
 *       any more — asserted against the real source files.
 *
 * Sandbox: any test that writes config points `cwd` at a mkdtemp dir (and
 * restores `process.chdir`) so nothing is written to the repo's `.crew/` or to
 * `~/.pi`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	__test__resetKeybindingCache,
	dashboardActionForKey,
	getKeybindingOverrideWarnings,
	OVERLAY_KEYS,
	overlayActionForKey,
} from "../../../src/ui/keybinding-map.ts";
import { AgentPickerOverlay } from "../../../src/ui/overlays/agent-picker-overlay.ts";
import { ConfirmOverlay } from "../../../src/ui/overlays/confirm-overlay.ts";
import { MailboxComposeOverlay } from "../../../src/ui/overlays/mailbox-compose-overlay.ts";
import { MailboxDetailOverlay } from "../../../src/ui/overlays/mailbox-detail-overlay.ts";

const OVERLAY_FILES = ["agent-picker-overlay.ts", "confirm-overlay.ts", "mailbox-detail-overlay.ts", "mailbox-compose-overlay.ts"] as const;

const OVERLAYS_DIR = new URL("../../../src/ui/overlays/", import.meta.url);

const origEnv = process.env.PI_CREW_KEYBINDINGS;
const origCwd = process.cwd();

beforeEach(() => {
	delete process.env.PI_CREW_KEYBINDINGS;
	__test__resetKeybindingCache();
});

afterEach(() => {
	if (origEnv === undefined) delete process.env.PI_CREW_KEYBINDINGS;
	else process.env.PI_CREW_KEYBINDINGS = origEnv;
	process.chdir(origCwd);
	__test__resetKeybindingCache();
});

/** Run `fn` with `keybindings` written to `<tmp>/.crew/config.json` as cwd. */
function withConfigKeybindings<T>(keybindings: Record<string, unknown>, fn: (cwd: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-overlay-kb-"));
	try {
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".crew", "config.json"), JSON.stringify({ keybindings }), "utf-8");
		process.chdir(dir);
		__test__resetKeybindingCache();
		return fn(dir);
	} finally {
		process.chdir(origCwd);
		__test__resetKeybindingCache();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ─── (b) default-key parity with the pre-M2-1 hardcoded chains ──────────────
//
// Transcribed from the `handleInput` bodies BEFORE the migration, e.g.
//   `matchesKey(data, "escape") || data === "q"` → close
//   `data === "k" || keyOf(data) === "up"`       → up
//   `matchesKey(data, "return")`                 → select / toggleDetail
// The right-hand side is the action `overlayActionForKey()` must return.
//
// NOTE on the two named-key literals: the migrated keyspaces spell the canonical
// KeyIds `"escape"` and `"return"` (the same vocabulary `DASHBOARD_KEYS` uses),
// so `overlayActionForKey(name, "escape")` / `(…, "return")` resolve — a
// superset over the old `matchesKey(data, …)` chains, which only ever matched
// the real byte sequences ("\x1b", "\r") and never the literal name. Real
// terminal input ("\x1b", "\r", "\n", CSI/app-cursor variants) is
// byte-identical; the literal names are synthetic-only.
const OVERLAY_PARITY: Record<string, Record<string, string | undefined>> = {
	"agent-picker": {
		"\x1b": "close",
		q: "close",
		escape: "close",
		k: "up",
		up: "up",
		"\x1b[A": "up",
		j: "down",
		down: "down",
		"\x1b[B": "down",
		"\r": "select",
		"\n": "select",
		return: "select",
		// the literal word "enter" was never matched by the old chain
		// (`matchesKey("enter", "return") === false`)
		enter: undefined,
		// unbound in the old chain
		a: undefined,
		y: undefined,
	},
	confirm: {
		y: "confirm",
		Y: "confirm",
		"\r": "submit",
		return: "submit",
		"\n": "submit",
		n: "cancel",
		N: "cancel",
		"\x1b": "cancel",
		escape: "cancel",
		q: "cancel",
		z: undefined,
	},
	"mailbox-detail": {
		"\x1b": "close",
		q: "close",
		"\t": "toggleSide",
		tab: "toggleSide",
		k: "up",
		up: "up",
		j: "down",
		down: "down",
		"\r": "toggleDetail",
		return: "toggleDetail",
		A: "ack",
		N: "nudge",
		C: "compose",
		X: "ackAll",
		// lowercase 'a'/'n'/'c'/'x' are NOT the mailbox action keys
		// (case-sensitive, exactly like the old `data === "A"` chain)
		a: undefined,
		n: undefined,
		c: undefined,
		x: undefined,
	},
	"mailbox-compose": {
		"\x1b": "cancel",
		escape: "cancel",
		P: "preview",
		"\t": "nextField",
		tab: "nextField",
		" ": "space",
		backspace: "backspace",
		"\x7f": "backspace",
		"\r": "submit",
		return: "submit",
		// free-text passthrough stays unbound at the dispatch layer
		a: undefined,
		z: undefined,
	},
};

describe("M2-1 — overlay:* default keys are byte-identical to the pre-migration chains", () => {
	for (const [overlay, table] of Object.entries(OVERLAY_PARITY)) {
		it(`${overlay}: every key keeps its old action (and nothing new is claimed)`, () => {
			for (const [key, expected] of Object.entries(table)) {
				assert.equal(
					overlayActionForKey(overlay as keyof typeof OVERLAY_KEYS, key),
					expected,
					`overlay=${overlay} key=${JSON.stringify(key)}`,
				);
			}
			assert.equal(getKeybindingOverrideWarnings().length, 0, "no override configured → no warnings");
		});
	}

	it("the keyspace exposes exactly the 4 migrated overlays", () => {
		assert.deepEqual(Object.keys(OVERLAY_KEYS).sort(), ["agent-picker", "confirm", "mailbox-compose", "mailbox-detail"]);
	});

	it("overlay defaults do NOT leak into the dashboard namespace (and vice versa)", () => {
		// 'y' is confirm-overlay territory only.
		assert.equal(dashboardActionForKey("y", undefined), undefined, "confirm key must not be a dashboard action");
		// 'r' is a dashboard action; no overlay claims it.
		for (const overlay of Object.keys(OVERLAY_KEYS) as (keyof typeof OVERLAY_KEYS)[]) {
			assert.equal(overlayActionForKey(overlay, "r"), undefined, `overlay=${overlay} must not claim the dashboard key 'r'`);
		}
		// escape/q are shared on purpose: the two namespaces are never live at
		// the same time (host gives input to exactly one component).
		assert.equal(dashboardActionForKey("q", undefined), "close");
		assert.equal(overlayActionForKey("confirm", "q"), "cancel");
	});
});

// ─── (a) override through .crew/config.json changes behaviour ───────────────

describe('M2-1 — keybindings["overlay:..."] override actually takes effect', () => {
	it("agent-picker: close remapped via .crew/config.json → the OLD key stops closing and the NEW key closes", () => {
		let doneCalls = 0;
		const overlay = new AgentPickerOverlay({ cwd: "/nonexistent-run-dir", runId: "team_x", done: () => (doneCalls += 1) });

		withConfigKeybindings({ "overlay:agent-picker:close": ["x"] }, () => {
			// The resolver reflects the override…
			assert.equal(overlayActionForKey("agent-picker", "x"), "close");
			assert.equal(overlayActionForKey("agent-picker", "q"), undefined, "default 'q' is replaced, not merged");
			// …and so does the real component.
			overlay.handleInput("q");
			assert.equal(doneCalls, 0, "the replaced default key must no longer close the overlay");
			overlay.handleInput("x");
			assert.equal(doneCalls, 1, "the overridden key must close the overlay");
		});
		assert.equal(getKeybindingOverrideWarnings().length, 0, "valid overlay override → no collision warning");
	});

	it("confirm: the confirm key remapped via .crew/config.json changes which key confirms", () => {
		const decisions: boolean[] = [];
		const overlay = new ConfirmOverlay({ title: "Delete run?", defaultAction: "confirm" }, (ok) => decisions.push(ok));

		withConfigKeybindings({ "overlay:confirm:confirm": ["z"] }, () => {
			overlay.handleInput("z");
			overlay.handleInput("y"); // no longer bound → must do nothing
			overlay.handleInput("\r"); // 'submit' still confirms (defaultAction = confirm)
			assert.deepEqual(decisions, [true, true], "z and Enter confirm; the replaced 'y' does nothing");
		});
	});

	it("mailbox-compose: remapping 'nextField' keeps the free-text passthrough working", () => {
		const overlay = new MailboxComposeOverlay({ done: () => undefined });
		withConfigKeybindings({ "overlay:mailbox-compose:nextField": ["w"] }, () => {
			assert.equal(overlayActionForKey("mailbox-compose", "w"), "nextField");
			assert.equal(overlayActionForKey("mailbox-compose", "\t"), undefined, "default Tab is replaced");
			assert.equal(overlayActionForKey("mailbox-compose", "a"), undefined, "plain letters stay unbound (free text)");
			// No throw: 'w' cycles the field, 'a' is appended to the body.
			overlay.handleInput("w");
			overlay.handleInput("a");
			assert.ok(overlay.render(60).length > 0);
		});
	});

	it("mailbox-detail: remapping 'ack' moves the ack key", () => {
		const actions: unknown[] = [];
		const overlay = new MailboxDetailOverlay({ runId: "team_y", cwd: "/nonexistent-run-dir", done: (a) => actions.push(a) });
		withConfigKeybindings({ "overlay:mailbox-detail:ack": ["Z"] }, () => {
			assert.equal(overlayActionForKey("mailbox-detail", "Z"), "ack");
			assert.equal(overlayActionForKey("mailbox-detail", "A"), undefined, "default 'A' is replaced");
			// 'A' no longer acks; 'X' (ack-all) is unrelated and keeps working.
			overlay.handleInput("X");
			assert.deepEqual(actions, [{ type: "ackAll" }], "unrelated keys keep working after the remap");
		});
	});

	it("PI_CREW_KEYBINDINGS drives overlay keys too (same pipeline, env wins over config)", () => {
		withConfigKeybindings({ "overlay:confirm:cancel": ["x"] }, () => {
			process.env.PI_CREW_KEYBINDINGS = JSON.stringify({ "overlay:confirm:cancel": ["w"] });
			__test__resetKeybindingCache();
			assert.equal(overlayActionForKey("confirm", "w"), "cancel", "env override applies");
			assert.equal(overlayActionForKey("confirm", "x"), undefined, "config override superseded by env");
			assert.equal(overlayActionForKey("confirm", "q"), undefined, "default still replaced");
		});
	});

	it("a dashboard override does not disturb overlay keys", () => {
		withConfigKeybindings({ reload: ["z"] }, () => {
			assert.equal(dashboardActionForKey("z", undefined), "reload");
			assert.equal(overlayActionForKey("confirm", "q"), "cancel", "overlay defaults untouched");
			assert.equal(overlayActionForKey("agent-picker", "q"), "close", "overlay defaults untouched");
		});
	});

	it("an overlay override does not disturb dashboard keys", () => {
		// US-020 note: "x" is now the dashboard's own cancel key, so the
		// does-not-inherit example uses "z" (unbound everywhere by default).
		withConfigKeybindings({ "overlay:agent-picker:close": ["z"] }, () => {
			assert.equal(overlayActionForKey("agent-picker", "z"), "close");
			assert.equal(dashboardActionForKey("q", undefined), "close", "dashboard 'q' untouched");
			assert.equal(dashboardActionForKey("z", undefined), undefined, "dashboard does not inherit overlay keys");
		});
	});
});

// ─── collision handling inside one overlay ─────────────────────────────────

describe("M2-1 — an overlay override that collides inside its own overlay is reverted", () => {
	it("reverts and warns when the new key is already used by another action of the same overlay", () => {
		withConfigKeybindings({ "overlay:agent-picker:close": ["j"] }, () => {
			// 'j' is `down` in the same overlay → ambiguous → revert to defaults.
			assert.equal(overlayActionForKey("agent-picker", "j"), "down", "collision loser keeps its default action");
			assert.equal(overlayActionForKey("agent-picker", "q"), "close", "colliding override reverted to default key");
			assert.equal(overlayActionForKey("agent-picker", "x"), undefined, "the rejected key was not applied");
			const warnings = getKeybindingOverrideWarnings();
			assert.ok(
				warnings.some((w) => w.includes("overlay:agent-picker:close")),
				`expected a revert warning naming the overlay binding, got ${JSON.stringify(warnings)}`,
			);
		});
	});

	it("keeps the override when it is unambiguous inside the overlay", () => {
		withConfigKeybindings({ "overlay:mailbox-detail:close": ["z"] }, () => {
			assert.equal(overlayActionForKey("mailbox-detail", "z"), "close");
			assert.equal(getKeybindingOverrideWarnings().length, 0, "no collision → no warning");
		});
	});
});

// ─── (c) source contract: no overlay hardcodes keys any more ───────────────

describe("M2-1 — the 4 migrated overlays dispatch through the central map", () => {
	for (const file of OVERLAY_FILES) {
		it(`${file} uses overlayActionForKey and hardcodes no literal key`, () => {
			const source = fs.readFileSync(new URL(file, OVERLAYS_DIR), "utf-8");
			assert.ok(source.includes("overlayActionForKey("), `${file} must dispatch through overlayActionForKey()`);
			for (const banned of [
				'matchesKey(data, "q")',
				'data === "q"',
				'matchesKey(data, "escape")',
				'data === "escape"',
				'matchesKey(data, "return")',
				'matchesKey(data, "backspace")',
			]) {
				assert.ok(!source.includes(banned), `${file} still hardcodes ${banned}`);
			}
			assert.ok(!/from "\.\.\/key-utils\.ts"/.test(source), `${file} should no longer import the local key helpers`);
		});
	}
});
