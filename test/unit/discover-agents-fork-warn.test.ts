import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __test_resetForkWarnings, allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";

/**
 * M4: warn-only when contextMode=fork is configured but the runtime
 * is the default child-process path. `contextMode: fork` only inherits
 * parent session context in the live-session runtime; the default
 * child-process path spawns a new pi instance with no parent session
 * to inherit, so the agent behaves as 'fresh' regardless.
 *
 * Capture mechanism: replace console.warn with a recorder before the
 * discoverAgents call, restore in afterEach. We capture all calls
 * (multi-arg, formatters, etc.) by joining arguments with a space.
 * node:test also supports t.mock.method but the manual pattern is
 * simpler, fully self-contained, and matches the project's existing
 * background-runner-console-redirect.test.ts style.
 */

type Recorder = (msg: string, ...args: unknown[]) => void;

function installWarnRecorder(): { calls: string[]; restore: () => void } {
	const calls: string[] = [];
	const original = console.warn;
	const recorder: Recorder = (msg, ...args) => {
		calls.push([msg, ...args].map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	};
	console.warn = recorder as typeof console.warn;
	return {
		calls,
		restore: () => {
			console.warn = original;
		},
	};
}

describe("M4: contextMode=fork warn-only on child-process runtime", () => {
	let recorder: { calls: string[]; restore: () => void };
	beforeEach(() => {
		__test_resetForkWarnings();
		recorder = installWarnRecorder();
	});
	afterEach(() => {
		recorder.restore();
		__test_resetForkWarnings();
	});

	it("emits the warning when an agent has contextMode: fork", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m4-fork-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".crew", "agents", "fork-agent.md"),
				"---\nname: fork-agent\ndescription: agent that asks for fork\ncontextMode: fork\n---\nJust a body.\n",
				"utf-8",
			);
			// First call: cache miss, warning fires.
			discoverAgents(cwd);
			assert.ok(
				recorder.calls.some((c) => c.includes("contextMode: 'fork' is only effective in live-session runtime")),
				`expected fork warning in: ${JSON.stringify(recorder.calls)}`,
			);
			assert.ok(
				recorder.calls.some((c) => c.includes("See docs/runtime-flow.md")),
				`expected docs hint in: ${JSON.stringify(recorder.calls)}`,
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("emits the warning on cache miss, not on cache hit (per-process dedup)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m4-fork-dedup-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".crew", "agents", "fork-dedup.md"),
				"---\nname: fork-dedup\ndescription: dedup test\ncontextMode: fork\n---\nBody.\n",
				"utf-8",
			);
			// First call: cache miss → parse fires → warning emitted.
			discoverAgents(cwd);
			const firstCount = recorder.calls.filter((c) => c.includes("contextMode: 'fork'")).length;
			assert.ok(firstCount >= 1, `expected at least 1 warning on cache miss, got ${firstCount}`);
			// Second call: cache hit → no re-parse → no new warning.
			discoverAgents(cwd);
			const secondCount = recorder.calls.filter((c) => c.includes("contextMode: 'fork'")).length;
			assert.equal(secondCount, firstCount, "no NEW warning on cache hit (per-process dedup)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does NOT emit the warning when contextMode is fresh", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m4-fresh-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".crew", "agents", "fresh-agent.md"),
				"---\nname: fresh-agent\ndescription: agent that asks for fresh\ncontextMode: fresh\n---\nBody.\n",
				"utf-8",
			);
			discoverAgents(cwd);
			const forkWarnings = recorder.calls.filter((c) => c.includes("contextMode: 'fork'"));
			assert.equal(forkWarnings.length, 0, `expected NO fork warning, got: ${JSON.stringify(forkWarnings)}`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does NOT emit the warning when contextMode is omitted", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m4-omitted-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".crew", "agents", "default-agent.md"),
				"---\nname: default-agent\ndescription: agent with no contextMode\n---\nBody.\n",
				"utf-8",
			);
			discoverAgents(cwd);
			const forkWarnings = recorder.calls.filter((c) => c.includes("contextMode: 'fork'"));
			assert.equal(forkWarnings.length, 0, `expected NO fork warning, got: ${JSON.stringify(forkWarnings)}`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("returns the agent normally despite the warning (no throw, no schema reject)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m4-return-"));
		try {
			fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".crew", "agents", "still-returns.md"),
				"---\nname: still-returns\ndescription: should still be discoverable\ncontextMode: fork\n---\nBody.\n",
				"utf-8",
			);
			const discovery = discoverAgents(cwd);
			const agents = allAgents(discovery);
			const forkAgent = agents.find((a) => a.name === "still-returns");
			assert.ok(forkAgent, "agent must still be returned (no schema reject, no throw)");
			assert.equal(forkAgent.contextMode, "fork", "contextMode must be preserved on the returned agent");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
