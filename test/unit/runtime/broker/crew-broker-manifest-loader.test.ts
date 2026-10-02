/**
 * crew-broker-manifest-loader.test.ts — Table-driven unit tests for the
 * hello-time manifest loader (src/runtime/broker/protocol/manifest-loader.ts).
 *
 * Invariants (from the M4/WI-4.1 extraction): the loader NEVER throws to the
 * hello handler — absent cwd, unknown run, corrupted/tampered/missing state
 * all collapse to `undefined`; only a fully valid on-disk run yields
 * {manifest, tasks}. Uses a real scaffold run (validateRunManifestPaths
 * requires the canonical <crewRoot>/artifacts/<runId> layout — hand-rolled
 * fixtures trip the .git-marker/path-containment gotchas, knowledge WP-2/R2).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { loadRunForHello } from "../../../../src/runtime/broker/protocol/manifest-loader.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { teardownCwd } from "../../../fixtures/teardown-cwd.ts";

async function scaffoldRun(prefix: string): Promise<{ cwd: string; runId: string; stateRoot: string }> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "manifest-loader" },
		{ cwd },
	);
	const runId = run.details.runId as string;
	const stateRoot = loadRunManifestById(cwd, runId)!.manifest.stateRoot;
	return { cwd, runId, stateRoot };
}

test("loadRunForHello: absent cwd is undefined for any runId (no cwd → no run)", () => {
	assert.equal(loadRunForHello(undefined, "run-1"), undefined);
	assert.equal(loadRunForHello(undefined, ""), undefined);
});

test("loadRunForHello: unknown runId yields undefined, never a throw", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ml-unknown-"));
	try {
		assert.equal(loadRunForHello(dir, "no-such-run"), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRunForHello: a valid scaffold run loads {manifest, tasks}", async () => {
	const fx = await scaffoldRun("pi-crew-ml-valid-");
	try {
		const loaded = loadRunForHello(fx.cwd, fx.runId);
		assert.ok(loaded, "valid run must load");
		assert.equal(loaded.manifest.runId, fx.runId);
		assert.ok(Array.isArray(loaded.tasks));
		assert.equal(loaded.manifest.stateRoot, fx.stateRoot);
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("loadRunForHello: corrupted manifest.json collapses to undefined (adversarial)", async () => {
	const fx = await scaffoldRun("pi-crew-ml-corrupt-");
	try {
		const manifestPath = path.join(fx.stateRoot, "manifest.json");
		fs.writeFileSync(manifestPath, "{ not json !!");
		assert.equal(loadRunForHello(fx.cwd, fx.runId), undefined, "garbage manifest must not throw nor load");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("loadRunForHello: tampered manifest identity is rejected (runId mismatch)", async () => {
	const fx = await scaffoldRun("pi-crew-ml-tamper-");
	try {
		const manifestPath = path.join(fx.stateRoot, "manifest.json");
		const tampered = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		tampered.runId = "somebody-elses-run";
		fs.writeFileSync(manifestPath, JSON.stringify(tampered));
		assert.equal(loadRunForHello(fx.cwd, fx.runId), undefined, "validateRunManifestPaths must reject the rewritten identity");
	} finally {
		teardownCwd(fx.cwd);
	}
});

test("loadRunForHello: deleted manifest.json collapses to undefined", async () => {
	const fx = await scaffoldRun("pi-crew-ml-missing-");
	try {
		fs.rmSync(path.join(fx.stateRoot, "manifest.json"), { force: true });
		assert.equal(loadRunForHello(fx.cwd, fx.runId), undefined);
	} finally {
		teardownCwd(fx.cwd);
	}
});
