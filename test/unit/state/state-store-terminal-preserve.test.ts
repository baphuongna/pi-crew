import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRunManifest, saveRunManifest, updateRunStatus } from "../../../src/state/stores/state-store.ts";

/**
 * Finding 8 write-layer guard (2026-09-23 live battery, run team_20260923175042):
 * a cross-session cancel wrote `cancelled` to disk (17:51:08), then the owning
 * process's mid-flight savers (task-runner artifact/progress writes carrying the
 * stale in-memory `running` manifest) overwrote it, and finalize completed the
 * run — the cancel was fully erased.
 *
 * Guards, in order:
 * 1. saveRunManifest/saveRunManifestAsync: a write carrying a NON-terminal status
 *    must never leave a TERMINAL disk status (fields still merge; status stays).
 * 2. updateRunStatus: same, plus emits run.terminal_preserved and does NOT emit
 *    run.<status> when preserved; allowTerminalExit bypasses (resume).
 *
 * Fixture isolation (e81d81a3 lesson): project marker `.crew/` inside tmp cwd.
 */

function fixture(prefix: string) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-f8w-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeTeam() {
	return { name: "fast-fix", description: "", roles: [{ name: "executor", agent: "executor" }], source: "test", filePath: "builtin" } as never;
}
function makeWorkflow() {
	return { name: "fast-fix", description: "", source: "test", filePath: "builtin", steps: [] } as never;
}

describe("finding 8 write-layer terminal preserve", () => {
	it("raw saveRunManifest with in-memory 'running' cannot erase disk 'cancelled' — the live race", () => {
		const cwd = fixture("raw");
		try {
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8w raw" });
			updateRunStatus(manifest, "cancelled", "external cancel");
			// mid-flight saver with stale in-memory running manifest + new artifacts
			const stale = { ...manifest, status: "running" as const, artifacts: [{ path: "/tmp/x.txt" }] as typeof manifest.artifacts };
			const saved = saveRunManifest(stale);
			assert.equal(saved.status, "cancelled", "status preserved");
			assert.equal(saved.artifacts.length, 1, "non-status fields still merged");
			const onDisk = JSON.parse(fs.readFileSync(path.join(manifest.stateRoot, "manifest.json"), "utf-8"));
			assert.equal(onDisk.status, "cancelled");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("allowTerminalExit bypasses the guard (resume contract)", () => {
		const cwd = fixture("bypass");
		try {
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8w bypass" });
			updateRunStatus(manifest, "cancelled", "external cancel");
			const stale = { ...manifest, status: "cancelled" as const };
			const saved = saveRunManifest(stale, { allowTerminalExit: true });
			assert.equal(saved.status, "cancelled");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("updateRunStatus preserves disk terminal, emits run.terminal_preserved, NOT run.<status>", () => {
		const cwd = fixture("upd");
		try {
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8w upd" });
			updateRunStatus(manifest, "cancelled", "external cancel");
			const eventsPath = manifest.eventsPath;
			// in-memory view still "running" (merge-style write)
			const stale = { ...manifest, status: "running" as const };
			const result = updateRunStatus(stale, "running", "Merged task updates from parallel batch.");
			assert.equal(result.status, "cancelled", "run stays cancelled");
			const events = fs.readFileSync(eventsPath, "utf-8");
			assert.ok(events.includes("run.terminal_preserved"), "preserve event recorded");
			assert.ok(!events.includes('"run.running"'), "no false run.running event");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("normal transitions are untouched (running→cancelled writes cancelled + event)", () => {
		const cwd = fixture("norm");
		try {
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8w norm" });
			const result = updateRunStatus(manifest, "cancelled", "cancel");
			assert.equal(result.status, "cancelled");
			const events = fs.readFileSync(manifest.eventsPath, "utf-8");
			assert.ok(events.includes('"run.cancelled"'));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resume bypass: updateRunStatus cancelled→running with allowTerminalExit succeeds", () => {
		const cwd = fixture("resume");
		try {
			const { manifest } = createRunManifest({ cwd, team: makeTeam(), workflow: makeWorkflow(), goal: "f8w resume" });
			updateRunStatus(manifest, "cancelled", "external cancel");
			const cancelled = { ...manifest, status: "cancelled" as const };
			const result = updateRunStatus(cancelled, "running", "Executing team workflow.", { allowTerminalExit: true });
			assert.equal(result.status, "running", "resume transition allowed");
			const events = fs.readFileSync(manifest.eventsPath, "utf-8");
			assert.ok(events.includes('"run.running"'));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
