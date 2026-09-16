/**
 * M1-10 (audit P1-12) — brief mode scope must match reality.
 *
 * `briefToolResult` is only called with hard-coded names "team" and "agent", so
 * the 7 native-tool branches (read/bash/edit/write/find/grep/ls) are dead. The
 * `/crew-brief` command description (and its on/off notifications) used to read
 * like a global output toggle ("Toggle brief tool output mode"), which made
 * users expect native tool output to change. It must state the real scope.
 *
 * The 7 dead branches were deleted in milestone M3-3 (user-confirmed). A
 * source guard keeps them from silently re-appearing and keeps the
 * `makeBriefEntry` persistence seam exported.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerManageCommands } from "../../../src/extension/registration/commands/manage.ts";
import type { RegisterTeamCommandsDeps } from "../../../src/extension/registration/commands/shared.ts";
import { setBrief } from "../../../src/ui/tool-renderers/brief-mode.ts";

interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

/** Capture commands via a minimal mock pi (deps are only read inside handlers). */
function captureCommands(): Map<string, CapturedCommand> {
	const captured = new Map<string, CapturedCommand>();
	const mockPi = {
		registerCommand(name: string, definition: CapturedCommand): void {
			captured.set(name, definition);
		},
		appendEntry(): void {
			/* brief-state persistence — not under test here */
		},
	} as unknown as ExtensionAPI;
	registerManageCommands(mockPi, {} as unknown as RegisterTeamCommandsDeps);
	return captured;
}

/** Run one /crew-brief invocation, collecting ui.notify messages. */
async function runBriefCommand(args: string): Promise<string[]> {
	const command = captureCommands().get("crew-brief");
	assert.ok(command, "/crew-brief must be registered");
	const notices: string[] = [];
	const ctx = {
		ui: {
			notify(message: string): void {
				notices.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
	await command.handler(args, ctx);
	return notices;
}

test("M1-10: /crew-brief description states the real scope (team/agent only)", () => {
	const command = captureCommands().get("crew-brief");
	assert.ok(command, "/crew-brief must be registered");
	const description = command.description ?? "";
	assert.match(description, /team/, "description must name the team tool");
	assert.match(description, /agent/, "description must name the agent tool");
	assert.match(description, /unaffected|native/i, "description must say native tools are unaffected");
	// The old over-promising wording must be gone.
	assert.doesNotMatch(description, /Toggle brief tool output mode/, "stale over-promising description");
});

test("M1-10: /crew-brief on|off notifications state the real scope", async () => {
	try {
		const on = await runBriefCommand("on");
		const off = await runBriefCommand("off");
		for (const notice of [...on, ...off]) {
			assert.match(notice, /team\/agent/, `notification must scope the claim: ${notice}`);
		}
	} finally {
		// Never leak global brief state into other test files.
		setBrief(false);
	}
});

test("M3-3: the 7 dead native-tool brief branches are gone; makeBriefEntry stays", () => {
	const source = fs.readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../src/ui/tool-renderers/brief-mode.ts"),
		"utf8",
	);
	for (const name of ["briefRead", "briefBash", "briefEdit", "briefWrite", "briefFind", "briefGrep", "briefLs"]) {
		assert.equal(source.indexOf(`function ${name}(`), -1, `${name} was deleted in M3-3 and must not come back`);
	}
	assert.ok(!/@unreachable/.test(source), "no @unreachable annotations should remain after M3-3");
	assert.match(source, /export function makeBriefEntry/, "makeBriefEntry export must be kept (session-entry persistence seam)");
});
