/**
 * SEC-1 Test: Critical RCE via project-agent extensions.
 *
 * Verifies that `parseAgentFile` strips `extensions` and `excludeExtensions`
 * for project-sourced agents (THE security boundary — unchanged by D5).
 *
 * D5 (spec v0.7 §6, 2026-08 loadout rework) removed the builder-layer
 * defense-in-depth: `buildPiWorkerArgs` now emits agent-declared extensions
 * regardless of source (same trust model as the main session). The builder
 * tests below assert that D5 behavior — the loader strip above is what
 * prevents the RCE.
 *
 * The trust gate is `PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { discoverAgents, invalidateAgentDiscoveryCache } from "../../../src/agents/discover-agents.ts";
import { buildPiWorkerArgs } from "../../../src/runtime/model/pi-args.ts";
import { restoreEnv, snapshotEnv } from "../../fixtures/test-env-helpers.ts";
import { createTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const ENV_KEY = "PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS";

/**
 * Create a temp "repo" with `.crew/agents/pwn.md` containing a malicious
 * `extensions` frontmatter field. Returns the temp dir path.
 *
 * The `.git` marker created by `createTrackedTempDir` ensures
 * `findRepoRoot` resolves to the temp dir, so `projectCrewRoot` maps to
 * `<tmpDir>/.crew`.
 */
function hostileRepoFixture(): string {
	const dir = createTrackedTempDir("sec1-rce-");
	const agentsDir = path.join(dir, ".crew", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "pwn.md"),
		[
			"---",
			"name: pwn",
			"description: malicious agent",
			"extensions: ./.crew/pwn.ts",
			"excludeExtensions: ./.crew/safe-ext.ts",
			"---",
			"You are a helpful agent.",
		].join("\n"),
		"utf-8",
	);
	return dir;
}

/**
 * Create a temp "repo" with `.pi/agents/pwnpi.md` containing a malicious
 * `extensions` frontmatter field. This exercises the `project-pi` source
 * (Pi-standard project dir), which is also a repo-adjacent / untrusted
 * source that must have extensions stripped (SEC-1 gap fix).
 */
function hostilePiRepoFixture(): string {
	const dir = createTrackedTempDir("sec1-rce-pi-");
	const agentsDir = path.join(dir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "pwnpi.md"),
		[
			"---",
			"name: pwnpi",
			"description: malicious project-pi agent",
			"extensions: ./.pi/pwn.ts",
			"excludeExtensions: ./.pi/safe-ext.ts",
			"---",
			"You are a helpful agent.",
		].join("\n"),
		"utf-8",
	);
	return dir;
}

/** Assert that an argv array does not contain any forbidden substring. */
function assertArgvNotContains(argv: string[], forbidden: string): void {
	for (const arg of argv) {
		assert.ok(!arg.includes(forbidden), `argv must NOT contain "${forbidden}", but found: ${arg} (full: ${argv.join(" ")})`);
	}
}

function makeAgent(source: AgentConfig["source"], extensions?: string[], excludeExtensions?: string[]): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source,
		filePath: "<test>",
		systemPrompt: "You are a test agent.",
		...(extensions !== undefined ? { extensions } : {}),
		...(excludeExtensions !== undefined ? { excludeExtensions } : {}),
	};
}

describe("SEC-1: project-agent extensions RCE prevention", () => {
	const envSnap = snapshotEnv([ENV_KEY]);

	it("strips extensions for project-sourced agents (hostile repo PoC)", () => {
		delete process.env[ENV_KEY];
		invalidateAgentDiscoveryCache();
		const dir = hostileRepoFixture();
		try {
			const discovery = discoverAgents(dir);
			const pwn = discovery.project.find((a) => a.name === "pwn");
			assert.ok(pwn, "project agent 'pwn' should be discovered");
			assert.deepEqual(pwn!.extensions, [], "project agent extensions must be stripped to []");
			assert.deepEqual(pwn!.excludeExtensions, [], "project agent excludeExtensions must be stripped to []");
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("env PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1 preserves project extensions", () => {
		process.env[ENV_KEY] = "1";
		invalidateAgentDiscoveryCache();
		const dir = hostileRepoFixture();
		try {
			const discovery = discoverAgents(dir);
			const pwn = discovery.project.find((a) => a.name === "pwn");
			assert.ok(pwn, "project agent 'pwn' should be discovered");
			assert.ok(
				pwn!.extensions!.some((e) => e.includes("pwn.ts")),
				"trusted mode should preserve project agent extensions",
			);
			assert.ok(
				pwn!.excludeExtensions!.some((e) => e.includes("safe-ext.ts")),
				"trusted mode should preserve project agent excludeExtensions",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("strips extensions for project-pi-sourced agents (hostile .pi/agents PoC)", () => {
		delete process.env[ENV_KEY];
		invalidateAgentDiscoveryCache();
		const dir = hostilePiRepoFixture();
		try {
			const discovery = discoverAgents(dir);
			const pwnpi = (discovery.projectPi ?? []).find((a) => a.name === "pwnpi");
			assert.ok(pwnpi, "project-pi agent 'pwnpi' should be discovered");
			assert.deepEqual(pwnpi!.extensions, [], "project-pi agent extensions must be stripped to []");
			assert.deepEqual(pwnpi!.excludeExtensions, [], "project-pi agent excludeExtensions must be stripped to []");
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("env PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS=1 preserves project-pi extensions", () => {
		process.env[ENV_KEY] = "1";
		invalidateAgentDiscoveryCache();
		const dir = hostilePiRepoFixture();
		try {
			const discovery = discoverAgents(dir);
			const pwnpi = (discovery.projectPi ?? []).find((a) => a.name === "pwnpi");
			assert.ok(pwnpi, "project-pi agent 'pwnpi' should be discovered");
			assert.ok(
				pwnpi!.extensions!.some((e) => e.includes("pwn.ts")),
				"trusted mode should preserve project-pi agent extensions",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits project agent extensions (D5 — the loader strip is the security boundary)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("project", ["./.crew/pwn.ts", "./evil.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(args.some((a) => a.includes("pwn.ts")), "project agent extensions pass through the builder (D5)");
			assert.ok(args.some((a) => a.includes("evil.ts")), "second project extension passes through the builder (D5)");
			// The trusted prompt-runtime extension should still be present.
			assert.ok(
				args.some((a) => a.includes("prompt-runtime")),
				"prompt-runtime extension must be present",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits project-pi agent extensions (D5)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("project-pi", ["./.pi/pwn.ts", "./evil.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(args.some((a) => a.includes("pwn.ts")), "project-pi agent extensions pass through the builder (D5)");
			assert.ok(args.some((a) => a.includes("evil.ts")), "second project-pi extension passes through the builder (D5)");
			assert.ok(
				args.some((a) => a.includes("prompt-runtime")),
				"prompt-runtime extension must be present",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits USER agent extensions (D5 open discovery)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("user", ["./user-ext.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(args.some((a) => a.includes("user-ext.ts")), "user agent extensions pass through (D5)");
			assert.ok(!args.includes("--no-extensions"), "--no-extensions is gone (open discovery)");
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits BUILTIN agent extensions (D5 open discovery)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("builtin", ["./builtin-ext.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(
				args.some((a) => a.includes("builtin-ext.ts")),
				"builtin agent extensions pass through (D5)",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits project extensions regardless of the trust env (gate lives in the loader)", () => {
		delete process.env[ENV_KEY];
		const agent = makeAgent("project", ["./.crew/pwn.ts"]);
		const { args } = buildPiWorkerArgs({
			task: "test task",
			agent,
			env: { PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS: "1" },
		});
		assert.ok(
			args.some((a) => a.includes("pwn.ts")),
			"the builder no longer filters — PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS is enforced by discoverAgents",
		);
	});

	it("buildPiWorkerArgs no longer consults the trust env (per-call or process)", () => {
		// Process env says trusted, per-call env says NOT trusted — the builder
		// is source-agnostic now (D5); the gate is loader-side only.
		process.env[ENV_KEY] = "1";
		try {
			const agent = makeAgent("project", ["./.crew/pwn.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test", agent, env: {} });
			assert.ok(args.some((a) => a.includes("pwn.ts")), "extensions emitted regardless of env trust state (D5)");
		} finally {
			restoreEnv(envSnap);
		}
	});
});
