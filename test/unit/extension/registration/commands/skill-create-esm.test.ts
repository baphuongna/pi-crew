/**
 * skill-create-esm.test.ts — W6/W10 (docs/fixes/slash-commands-fix-spec.md).
 *
 * Covers the /skill-create command's guard paths and the ESM-safe skills-dir
 * resolution that replaced `require.resolve(..., { paths: [__dirname] })`
 * (neither `require` nor `__dirname` exists under strip-types loading or
 * inside the esbuild ESM bundle):
 *   - unknown template id → usage error LISTING the available template ids,
 *     returning before any handleTeamTool interaction;
 *   - missing template id → same usage shape;
 *   - resolveUserSkillsDir() resolves to an existing skills directory inside
 *     the pi-crew package root (works from source layout; the same walk
 *     applies from the dist/ bundle layout).
 *
 * Mock pattern follows commands-handler.test.ts: fake pi capturing the
 * registerCommand surface + fake ctx recording ui.notify, with the
 * `__test__setHandleTeamTool` seam proving the guard never reaches the tool.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { resolveUserSkillsDir } from "../../../../../src/extension/registration/commands/manage.ts";
import { __test__setHandleTeamTool, registerTeamCommands } from "../../../../../src/extension/registration/commands.ts";
import { listTemplates } from "../../../../../src/skills/skill-templates.ts";

type Handler = (args: string, ctx: never) => Promise<void>;

function captureSkillCreateHandler(): Handler {
	const commands = new Map<string, Handler>();
	registerTeamCommands(
		{
			registerCommand: (name: string, def: { handler: Handler }) => {
				commands.set(name, def.handler);
			},
		} as never,
		{
			startForegroundRun: () => undefined,
			abortForegroundRun: () => false,
			openLiveSidebar: () => undefined,
			getManifestCache: () => ({ list: () => [] }),
		},
	);
	const handler = commands.get("skill-create");
	assert.ok(handler, "skill-create command was not registered");
	return handler;
}

function fakeCtx(): { ctx: never; notifications: Array<{ text: string; level: string }> } {
	const notifications: Array<{ text: string; level: string }> = [];
	const ctx = {
		cwd: "/tmp/pi-crew-test",
		hasUI: false,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
		},
	};
	return { ctx: ctx as never, notifications };
}

afterEach(() => {
	__test__setHandleTeamTool(undefined);
});

test("unknown template id → usage error listing template ids; handleTeamTool never called", async () => {
	const handler = captureSkillCreateHandler();
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "should-not-happen" }] };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	await handler("definitely-not-a-template", ctx);

	assert.equal(seen.length, 0, "guard must return before any handleTeamTool interaction");
	assert.equal(notifications.length, 1);
	const text = notifications[0] as { text: string; level: string };
	assert.match(text.text, /^Unknown template 'definitely-not-a-template'\./);
	assert.ok(text.text.includes("Usage: /skill-create <template-id>"), "usage line present");
	assert.ok(text.text.includes("Available templates:"), "available template ids are listed");
	for (const template of listTemplates()) {
		assert.ok(text.text.includes(template.id), `usage lists template id '${template.id}'`);
	}
});

test("missing template id → usage error listing template ids; handleTeamTool never called", async () => {
	const handler = captureSkillCreateHandler();
	const seen: Array<Record<string, unknown>> = [];
	__test__setHandleTeamTool((async (params: unknown) => {
		seen.push(params as Record<string, unknown>);
		return { content: [{ type: "text", text: "should-not-happen" }] };
	}) as never);

	const { ctx, notifications } = fakeCtx();
	await handler("   ", ctx);

	assert.equal(seen.length, 0, "guard must return before any handleTeamTool interaction");
	assert.equal(notifications.length, 1);
	const text = (notifications[0] as { text: string }).text;
	assert.match(text, /^Usage: \/skill-create <template-id>/);
	assert.ok(text.includes("Available templates:"), "available template ids are listed");
	for (const template of listTemplates()) {
		assert.ok(text.includes(template.id), `usage lists template id '${template.id}'`);
	}
});

test("resolveUserSkillsDir returns an existing skills dir inside the pi-crew package root", () => {
	const dir = resolveUserSkillsDir();
	assert.equal(path.basename(dir), "skills");
	assert.ok(fs.existsSync(dir), `resolved skills dir must exist: ${dir}`);
	assert.ok(fs.existsSync(path.join(dir, "..", "package.json")), `parent of skills dir must be the package root (package.json): ${dir}`);
});
