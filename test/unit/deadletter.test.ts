import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendDeadletter, readDeadletter } from "../../src/runtime/deadletter.ts";
import { createRunManifest } from "../../src/state/state-store.ts";

const team = { name: "t", description: "", source: "test", filePath: "t", roles: [{ name: "r", agent: "a" }] } as never;
const workflow = { name: "w", description: "", source: "test", filePath: "w", steps: [{ id: "s", role: "r", task: "x" }] } as never;

test("deadletter appends and reads entries", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-deadletter-"));
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "dead" });
		appendDeadletter(manifest, { runId: manifest.runId, taskId: "01_s", reason: "max-retries", attempts: 3, lastError: "boom", timestamp: "2026-01-01T00:00:00.000Z" });
		assert.equal(readDeadletter(manifest)[0]?.reason, "max-retries");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
