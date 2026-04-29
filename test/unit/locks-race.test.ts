import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRunManifest } from "../../src/state/state-store.ts";
import { withRunLock } from "../../src/state/locks.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withRunLock holds exclusivity across concurrent async callers", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lock-race-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest } = createRunManifest({
		cwd,
		team: { name: "race-team", description: "race", source: "builtin", filePath: "", roles: [{ name: "explorer", agent: "explorer" }] },
		workflow: { name: "race", description: "", source: "builtin", filePath: "", steps: [] },
		goal: "race",
	});

	const order: string[] = [];
	const run1 = withRunLock(manifest, async () => {
		order.push("run-1-enter");
		await sleep(120);
		order.push("run-1-exit");
	});
	await sleep(10);
	const run2 = withRunLock(manifest, async () => {
		order.push("run-2-enter");
		await sleep(20);
		order.push("run-2-exit");
	});

	await Promise.all([run1, run2]);
	assert.equal(order[0], "run-1-enter");
	assert.deepEqual(order.indexOf("run-2-enter") > order.indexOf("run-1-exit"), true);

	fs.rmSync(cwd, { recursive: true, force: true });
});
