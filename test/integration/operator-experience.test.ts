import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJsonlSink } from "../../src/extension/notification-sink.ts";
import { NotificationRouter, type NotificationDescriptor } from "../../src/extension/notification-router.ts";
import { appendMailboxMessage, readDeliveryState } from "../../src/state/mailbox.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import { dispatchDiagnosticExport, dispatchMailboxAck, dispatchMailboxAckAll, dispatchMailboxCompose } from "../../src/ui/run-action-dispatcher.ts";

function createFixture(): { cwd: string; ctx: ExtensionContext; runId: string; manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-operator-int-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = { name: "operator", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "operator", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "operator" });
	return { cwd, ctx: { cwd } as unknown as ExtensionContext, runId: created.manifest.runId, manifest: created.manifest };
}

test("operator mailbox compose and ack roundtrip updates delivery state", async () => {
	const fixture = createFixture();
	try {
		const composed = await dispatchMailboxCompose(fixture.ctx, fixture.runId, { from: "operator", to: "worker", body: "hello", direction: "inbox" });
		const messageId = JSON.parse(composed.message).id as string;
		assert.equal((await dispatchMailboxAck(fixture.ctx, fixture.runId, messageId)).ok, true);
		assert.equal(readDeliveryState(fixture.manifest).messages[messageId], "acknowledged");
	} finally {
		fs.rmSync(fixture.cwd, { recursive: true, force: true });
	}
});

test("operator mailbox ackAll acknowledges multiple unread messages", async () => {
	const fixture = createFixture();
	try {
		const first = appendMailboxMessage(fixture.manifest, { direction: "inbox", from: "a", to: "b", body: "one" });
		const second = appendMailboxMessage(fixture.manifest, { direction: "inbox", from: "a", to: "b", body: "two" });
		assert.equal((await dispatchMailboxAckAll(fixture.ctx, fixture.runId)).ok, true);
		const delivery = readDeliveryState(fixture.manifest).messages;
		assert.equal(delivery[first.id], "acknowledged");
		assert.equal(delivery[second.id], "acknowledged");
	} finally {
		fs.rmSync(fixture.cwd, { recursive: true, force: true });
	}
});

test("operator notification router deduplicates repeated health notifications", () => {
	const delivered: NotificationDescriptor[] = [];
	let now = 0;
	const router = new NotificationRouter({ now: () => now, dedupWindowMs: 30_000 }, (notification) => delivered.push(notification));
	for (let index = 0; index < 5; index += 1) router.enqueue({ id: "health:run", severity: "warning", source: "health", title: "dead" });
	now = 31_000;
	router.enqueue({ id: "health:run", severity: "warning", source: "health", title: "dead again" });
	assert.deepEqual(delivered.map((item) => item.title), ["dead", "dead again"]);
});

test("operator notification router respects cross-day quiet hours", () => {
	const delivered: NotificationDescriptor[] = [];
	const quiet = new NotificationRouter({ quietHours: "22:00-07:00", now: () => Date.parse("2026-01-01T23:30:00") }, (notification) => delivered.push(notification));
	quiet.enqueue({ severity: "warning", source: "health", title: "quiet" });
	const loud = new NotificationRouter({ quietHours: "22:00-07:00", now: () => Date.parse("2026-01-01T12:00:00") }, (notification) => delivered.push(notification));
	loud.enqueue({ severity: "warning", source: "health", title: "loud" });
	assert.deepEqual(delivered.map((item) => item.title), ["loud"]);
});

test("operator notification sink rotates retained JSONL files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-operator-sink-"));
	try {
		const dir = path.join(root, "state", "notifications");
		fs.mkdirSync(dir, { recursive: true });
		const oldFile = path.join(dir, "2026-01-01.jsonl");
		fs.writeFileSync(oldFile, "{}\n", "utf-8");
		fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
		createJsonlSink(root, 1).write({ severity: "warning", source: "test", title: "new", timestamp: Date.parse("2026-01-10T00:00:00.000Z") });
		assert.equal(fs.existsSync(oldFile), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("operator diagnostic export writes redacted health report", async () => {
	const fixture = createFixture();
	try {
		saveRunTasks(fixture.manifest, [{ id: "one", runId: fixture.runId, role: "worker", agent: "worker", title: "one", status: "running", dependsOn: [], cwd: fixture.cwd, error: "apiToken=abc", heartbeat: { workerId: "one", lastSeenAt: fixture.manifest.createdAt, alive: true } }]);
		const exported = await dispatchDiagnosticExport(fixture.ctx, fixture.runId);
		assert.equal(exported.ok, true);
		const text = fs.readFileSync(String(exported.data), "utf-8");
		assert.match(text, /"heartbeat"/);
		assert.doesNotMatch(text, /abc/);
	} finally {
		fs.rmSync(fixture.cwd, { recursive: true, force: true });
	}
});
