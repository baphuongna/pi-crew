/**
 * SEC-1 Test: Critical RCE via project-agent extensions.
 *
 * Verifies that `parseAgentFile` strips `extensions` and `excludeExtensions`
 * for project-sourced agents, and that `buildPiWorkerArgs` provides
 * defense-in-depth by never emitting `--extension <attacker-path>` for
 * project agents.
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

	it("buildPiWorkerArgs does NOT emit --extension <attacker-path> for project agents", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("project", ["./.crew/pwn.ts", "./evil.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assertArgvNotContains(args, "pwn.ts");
			assertArgvNotContains(args, "evil.ts");
			// The trusted prompt-runtime extension should still be present.
			assert.ok(
				args.some((a) => a.includes("prompt-runtime")),
				"prompt-runtime extension must be present",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs does NOT emit --extension <attacker-path> for project-pi agents", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("project-pi", ["./.pi/pwn.ts", "./evil.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assertArgvNotContains(args, "pwn.ts");
			assertArgvNotContains(args, "evil.ts");
			// The trusted prompt-runtime extension should still be present.
			assert.ok(
				args.some((a) => a.includes("prompt-runtime")),
				"prompt-runtime extension must be present",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits extensions for user agents (not stripped)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("user", ["./user-ext.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(
				args.some((a) => a.includes("user-ext.ts")),
				"user agent extensions must be preserved",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs emits extensions for builtin agents (not stripped)", () => {
		delete process.env[ENV_KEY];
		try {
			const agent = makeAgent("builtin", ["./builtin-ext.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test task", agent, env: {} });
			assert.ok(
				args.some((a) => a.includes("builtin-ext.ts")),
				"builtin agent extensions must be preserved",
			);
		} finally {
			restoreEnv(envSnap);
		}
	});

	it("buildPiWorkerArgs trusts project extensions when env gate is set", () => {
		delete process.env[ENV_KEY];
		const agent = makeAgent("project", ["./.crew/pwn.ts"]);
		const { args } = buildPiWorkerArgs({
			task: "test task",
			agent,
			env: { PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS: "1" },
		});
		assert.ok(
			args.some((a) => a.includes("pwn.ts")),
			"trusted mode should allow project extension in args",
		);
	});

	it("buildPiWorkerArgs checks agent.source via input.env when process.env differs", () => {
		// Process env says trusted, but the per-call env says NOT trusted.
		process.env[ENV_KEY] = "1";
		try {
			const agent = makeAgent("project", ["./.crew/pwn.ts"]);
			const { args } = buildPiWorkerArgs({ task: "test", agent, env: {} });
			// Per-call env {} has no PI_CREW_TRUST_PROJECT_AGENT_EXTENSIONS → must strip.
			assertArgvNotContains(args, "pwn.ts");
		} finally {
			restoreEnv(envSnap);
		}
	});
});
