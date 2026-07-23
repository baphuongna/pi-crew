import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { CrewBroker } from "../../src/runtime/crew-broker.ts";
import { CrewBrokerClient } from "../../src/runtime/crew-broker-client.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

function isSymlinkTestUnsupportedOn(): boolean {
	return process.platform === "win32" || process.platform === "darwin";
}

async function connectClient(args: { runId: string; taskId: string; token: string; socketPath: string }): Promise<CrewBrokerClient> {
	const client = new CrewBrokerClient({
		...args,
		setTimeoutFn: ((cb: () => void, _ms: number) => {
			const timer = setTimeout(cb, 100);
			return new Proxy(timer, {
				get(target, prop) {
					if (prop === "unref" || prop === "ref" || prop === "hasRef") return undefined;
					return Reflect.get(target, prop);
				},
			}) as unknown as NodeJS.Timeout;
		}) as typeof setTimeout,
	});
	const ping = await client.request("ping", null);
	if (!ping.ok) throw new Error(`connect+ping failed: ${JSON.stringify(ping)}`);
	return client;
}

test("steer.push does not follow a symlinked steering directory outside artifactsRoot", async (t) => {
	if (isSymlinkTestUnsupportedOn()) {
		t.skip("authoritative symlink rejection coverage runs on Linux");
		return;
	}

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-symlink-"));
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-steer-outside-"));
	let broker: CrewBroker | undefined;
	let client: CrewBrokerClient | undefined;
	try {
		fs.mkdirSync(path.join(cwd, ".crew"));
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "symlink-safe broker steering",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		if (!runId) throw new Error("scaffold run did not return a runId");
		const loaded = loadRunManifestById(cwd, runId);
		if (!loaded) throw new Error("could not load scaffold manifest");
		const [senderTaskId, targetTaskId] = loaded.tasks.map((task) => task.id);
		if (!senderTaskId || !targetTaskId) throw new Error("expected two scaffold tasks");

		const steeringDir = path.join(loaded.manifest.artifactsRoot, "steering");
		fs.rmSync(steeringDir, { recursive: true, force: true });
		fs.symlinkSync(outsideDir, steeringDir, "dir");

		broker = new CrewBroker({
			sessionId: `symlink-steering-${Date.now()}`,
			socketPath: path.join(os.tmpdir(), `pi-crew-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`),
			enabled: true,
			cwd,
		});
		await broker.start();
		const token = broker.issueRunToken(runId);
		client = await connectClient({ runId, taskId: senderTaskId, token, socketPath: broker.socketPath });
		const steerBody = "must-not-escape-artifacts-root";
		const result = await client.request("steer.push", { taskId: targetTaskId, body: steerBody });
		assert.equal(result.ok, true, `mailbox-backed steer.push should remain best-effort: ${JSON.stringify(result)}`);

		const escapedPath = path.join(outsideDir, `${targetTaskId}.jsonl`);
		assert.equal(fs.existsSync(escapedPath), false, "steering JSONL must not be written through the symlink");
		const outsideContent = fs
			.readdirSync(outsideDir)
			.map((name) => fs.readFileSync(path.join(outsideDir, name), "utf8"))
			.join("\n");
		assert.equal(outsideContent.includes(steerBody), false, "outside directory must not contain the steer body");
	} finally {
		await client?.close();
		await broker?.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	}
});
