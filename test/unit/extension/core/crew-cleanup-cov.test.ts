/**
 * Complementary tests for src/extension/crew-cleanup.ts
 * Focuses on ChildProcessRegistry edge cases and registerChildProcess/unregisterChildProcess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childProcessRegistry, registerChildProcess, unregisterChildProcess } from "../../../../src/extension/crew-cleanup.ts";

describe("ChildProcessRegistry register overwrites existing pid", () => {
	it("overwrites previous entry when same pid is re-registered", () => {
		childProcessRegistry.clear();
		registerChildProcess(100, "run-A", "agent-A");
		registerChildProcess(100, "run-B", "agent-B");

		const info = childProcessRegistry.getInfo(100);
		assert.ok(info);
		assert.equal(info!.runId, "run-B", "should have latest runId");
		assert.equal(info!.agentId, "agent-B", "should have latest agentId");

		childProcessRegistry.clear();
	});
});

describe("ChildProcessRegistry getInfo returns undefined for unknown pid", () => {
	it("returns undefined for non-existent pid", () => {
		childProcessRegistry.clear();
		const info = childProcessRegistry.getInfo(99999);
		assert.equal(info, undefined);
	});
});

describe("ChildProcessRegistry unregister is idempotent", () => {
	it("does not throw when unregistering non-existent pid", () => {
		childProcessRegistry.clear();
		// Should not throw
		unregisterChildProcess(88888);
		assert.equal(childProcessRegistry.getAllPids().length, 0);
	});
});

describe("ChildProcessRegistry clear on already-empty registry", () => {
	it("does not throw when clearing empty registry", () => {
		childProcessRegistry.clear();
		childProcessRegistry.clear(); // double clear
		assert.equal(childProcessRegistry.getAllPids().length, 0);
	});
});

describe("ChildProcessRegistry getAllPids returns all registered pids", () => {
	it("returns array of all registered process IDs", () => {
		childProcessRegistry.clear();
		registerChildProcess(10, "r1", "a1");
		registerChildProcess(20, "r2", "a2");
		registerChildProcess(30, "r3", "a3");

		const pids = childProcessRegistry.getAllPids();
		assert.equal(pids.length, 3);
		assert.ok(pids.includes(10));
		assert.ok(pids.includes(20));
		assert.ok(pids.includes(30));

		childProcessRegistry.clear();
	});
});

describe("ChildProcessRegistry unregister removes specific pid", () => {
	it("only removes the specified pid, leaving others", () => {
		childProcessRegistry.clear();
		registerChildProcess(100, "r1", "a1");
		registerChildProcess(200, "r2", "a2");

		unregisterChildProcess(100);

		assert.equal(childProcessRegistry.getInfo(100), undefined);
		assert.ok(childProcessRegistry.getInfo(200));

		childProcessRegistry.clear();
	});
});
