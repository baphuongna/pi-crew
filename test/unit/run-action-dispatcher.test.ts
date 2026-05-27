import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendMailboxMessage } from "../../src/state/mailbox.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";
import { dispatchDiagnosticExport, dispatchKillStaleWorkers, dispatchMailboxAck, dispatchMailboxAckAll, dispatchMailboxCompose } from "../../src/ui/run-action-dispatcher.ts";

function createRun(): { cwd: string; ctx: ExtensionContext; runId: string; manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dispatcher-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = { name: "dispatch", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "dispatch" });
	return { cwd, ctx: { cwd } as unknown as ExtensionContext, runId: created.manifest.runId, manifest: created.manifest };
}

test("mailbox dispatchers compose ack and ack all", async () => {
	const run = createRun();
	try {
		const composed = await dispatchMailboxCompose(run.ctx, run.runId, { from: "operator", to: "one", body: "hello", direction: "inbox" });
		assert.equal(composed.ok, true);
		const messageId = JSON.parse(composed.message).id as string;
		assert.equal((await dispatchMailboxAck(run.ctx, run.runId, messageId)).ok, true);
		appendMailboxMessage(run.manifest, { direction: "inbox", from: "a", to: "b", body: "one" });
		appendMailboxMessage(run.manifest, { direction: "inbox", from: "a", to: "b", body: "two" });
		const ackAll = await dispatchMailboxAckAll(run.ctx, run.runId);
		assert.equal(ackAll.ok, true);
		assert.match(ackAll.message, /Acknowledged/);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("health dispatchers mark only stale heartbeats dead and export diagnostics", async () => {
	const run = createRun();
	try {
		const staleAt = new Date(Date.now() - 90_000).toISOString();
		const freshAt = new Date().toISOString();
		saveRunTasks(run.manifest, [
			{ id: "stale", runId: run.runId, role: "worker", agent: "worker", title: "stale", status: "running", dependsOn: [], cwd: run.cwd, heartbeat: { workerId: "stale", lastSeenAt: staleAt, alive: true } },
			{ id: "fresh", runId: run.runId, role: "worker", agent: "worker", title: "fresh", status: "running", dependsOn: [], cwd: run.cwd, heartbeat: { workerId: "fresh", lastSeenAt: freshAt, alive: true } },
		]);
		const killed = await dispatchKillStaleWorkers(run.ctx, run.runId);
		assert.equal(killed.ok, true);
		assert.deepEqual(killed.data, { count: 1 });
		const reloaded = loadRunManifestById(run.cwd, run.runId);
		assert.equal(reloaded?.tasks.find((task) => task.id === "stale")?.heartbeat?.alive, false);
		assert.equal(reloaded?.tasks.find((task) => task.id === "fresh")?.heartbeat?.alive, true);
		const diagnostic = await dispatchDiagnosticExport(run.ctx, run.runId);
		assert.equal(diagnostic.ok, true);
		assert.equal(fs.existsSync(String(diagnostic.data)), true);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("dispatchDiagnosticExport reports missing run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dispatcher-missing-"));
	try {
		const result = await dispatchDiagnosticExport({ cwd } as unknown as ExtensionContext, "missing");
		assert.equal(result.ok, false);
		assert.match(result.message, /not found/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
