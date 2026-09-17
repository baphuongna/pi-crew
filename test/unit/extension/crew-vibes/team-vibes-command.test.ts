/**
 * team-vibes-command.test.ts — W10 (docs/fixes/slash-commands-fix-spec.md).
 *
 * Drives the /team-vibes command handler (src/extension/crew-vibes/index.ts
 * registerCommand) with a fake pi + ctx:
 *   - no-arg → status output;
 *   - `on` / `off` → toggle + persist (config is isolated in a temp
 *     PI_CREW_HOME so the real user config is never touched);
 *   - `speed on` / `capacity on` → usage error mentioning ONLY on|off —
 *     pins the docs fix that dropped speed/capacity (never implemented);
 *   - no exceptions escape (every invocation runs under doesNotReject).
 *
 * The seeded config disables capacity.providerUsage so toggling never starts
 * the provider timer / network fetch; hasUI=false keeps every status UI call
 * a no-op.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { configPath, loadConfig } from "../../../../src/extension/crew-vibes/config.ts";
import { registerCrewVibes } from "../../../../src/extension/crew-vibes/index.ts";

type Handler = (args: string, ctx: never) => Promise<void>;

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

/** Register crew-vibes against a fake pi and return the team-vibes handler. */
function captureTeamVibesHandler(): Handler {
	const handlers = new Map<string, Handler>();
	registerCrewVibes({
		registerCommand: (name: string, def: { handler: Handler }) => {
			handlers.set(name, def.handler);
		},
		on: () => undefined,
	} as never);
	const handler = handlers.get("team-vibes");
	assert.ok(handler, "team-vibes command was not registered");
	return handler;
}

function readPersistedEnabled(): boolean {
	return loadConfig().enabled;
}

const previousHome = process.env.PI_CREW_HOME;
let tempHome = "";

before(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-vibes-test-"));
	process.env.PI_CREW_HOME = tempHome;
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify({ enabled: false, capacity: { enabled: true, providerUsage: false } }));
});

after(() => {
	if (previousHome === undefined) delete process.env.PI_CREW_HOME;
	else process.env.PI_CREW_HOME = previousHome;
	if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
});

test("no-arg → status output, no exceptions", async () => {
	const handler = captureTeamVibesHandler();
	const { ctx, notifications } = fakeCtx();
	await assert.doesNotReject(handler("", ctx));
	assert.equal(notifications.length, 1);
	const note = notifications[0] as { text: string; level: string };
	assert.match(note.text, /^crew-vibes: (on|off) · quota /);
	assert.equal(note.level, "info");
});

test("`on`/`off` toggle crew-vibes and persist the change", async () => {
	const handler = captureTeamVibesHandler();

	const onCtx = fakeCtx();
	await assert.doesNotReject(handler("on", onCtx.ctx));
	assert.deepEqual(onCtx.notifications, [{ text: "crew-vibes enabled", level: "info" }]);
	assert.equal(readPersistedEnabled(), true, "enabled=true persisted to the isolated config");

	const offCtx = fakeCtx();
	await assert.doesNotReject(handler("off", offCtx.ctx));
	assert.deepEqual(offCtx.notifications, [{ text: "crew-vibes disabled", level: "info" }]);
	assert.equal(readPersistedEnabled(), false, "enabled=false persisted to the isolated config");
});

test("`speed on` and `capacity on` → usage error mentioning only on|off", async () => {
	const handler = captureTeamVibesHandler();

	for (const badSubcommand of ["speed on", "capacity on", "bogus"]) {
		const { ctx, notifications } = fakeCtx();
		await assert.doesNotReject(handler(badSubcommand, ctx));
		assert.equal(notifications.length, 1, `one notification for '${badSubcommand}'`);
		const note = notifications[0] as { text: string; level: string };
		assert.equal(note.text, "Usage: /team-vibes [on|off]", `usage text for '${badSubcommand}'`);
		assert.equal(note.level, "error", `error level for '${badSubcommand}'`);
		assert.ok(!note.text.includes("speed"), "speed must not appear (never implemented)");
		assert.ok(!note.text.includes("capacity"), "capacity must not appear (never implemented)");
	}
});
