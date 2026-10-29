/**
 * L2-3 (upgrade research round 3 §3.5, Wave A item 3): pi 1.1.0 added
 * `+name`/`-name` modifier entries to `--tools` (coding-agent
 * settings-manager.js getToolListError — modifiers may not be mixed with
 * plain names and take exact names, not patterns; 1.0.4 has NO modifier
 * support at all).
 *
 * DECISION (Wave A, 2026-10-11): host-version detection IS reliable
 * (probePiVersion, U9 — threaded into buildPiWorkerArgs as input.piVersion),
 * but defaulting declared `tools:` frontmatter to ADDITIVE `+name` semantics
 * would change the worker privilege surface (legacy = REPLACEMENT allowlist,
 * least privilege, pinned by pi-args-loadout tests + battery 2026-09-10) on
 * every 1.1.0+ host — so the modifier syntax ships OPT-IN via
 * PI_CREW_TOOLS_MODIFIERS=1, default OFF, and ONLY when the probed
 * piVersion >= PI_TOOLS_MODIFIER_FLOOR ("1.1.0"). Below the floor / unknown
 * version → legacy replacement syntax (pi's strict parser must never see a
 * modifier entry on a pre-1.1.0 host).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		// S-7 (w4b): write-tier role name (WRITE_ROLES "agent") — this file pins
		// the L2-3 modifier-syntax emission for a NON-floor role; the read_only
		// execution-tool floor has its own suite.
		name: "agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

function toolsFlagValue(args: string[]): string | undefined {
	const idx = args.indexOf("--tools");
	return idx >= 0 ? args[idx + 1] : undefined;
}

test("default OFF: declared tools keep the legacy replacement-allowlist syntax on every host version", () => {
	for (const piVersion of ["1.1.0", "2.0.0", "1.0.4", undefined]) {
		const { args } = buildPiWorkerArgs({
			task: "Task: x",
			agent: agent({ tools: "read,grep" as unknown as AgentConfig["tools"] }),
			env: {},
			piVersion,
		});
		const value = toolsFlagValue(args);
		assert.ok(value, `--tools must be present (piVersion=${String(piVersion)})`);
		const list = value!.split(",");
		assert.deepEqual(
			[...list].sort(),
			["ask", "delegate", "grep", "message", "read"],
			`legacy allowlist + CONTROL_TOOLS merge (piVersion=${String(piVersion)})`,
		);
	}
});

test("opt-in on a 1.1.0+ host: declared tools emit `+name` modifier syntax WITHOUT the CONTROL_TOOLS merge", () => {
	const { args } = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ tools: "read,grep" as unknown as AgentConfig["tools"] }),
		env: { PI_CREW_TOOLS_MODIFIERS: "1" },
		piVersion: "1.1.0",
	});
	assert.equal(toolsFlagValue(args), "+read,+grep", "additive modifier mode: default surface PLUS declarations, no control-tool merge");
});

test("opt-in BELOW the floor falls back to legacy syntax (strict-parser safety)", () => {
	for (const piVersion of ["1.0.4", "1.0.0", undefined, "garbage"]) {
		const { args } = buildPiWorkerArgs({
			task: "Task: x",
			agent: agent({ tools: "read,grep" as unknown as AgentConfig["tools"] }),
			env: { PI_CREW_TOOLS_MODIFIERS: "1" },
			piVersion,
		});
		const value = toolsFlagValue(args);
		assert.ok(value && !value.includes("+"), `pre-1.1.0/unknown host must never see modifier syntax (piVersion=${String(piVersion)})`);
		assert.deepEqual([...value!.split(",")].sort(), ["ask", "delegate", "grep", "message", "read"]);
	}
});

test("opt-in never weakens disableTools (--no-tools) or the disallowedTools denylist", () => {
	const disabled = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ disableTools: true, tools: "read" as unknown as AgentConfig["tools"] }),
		env: { PI_CREW_TOOLS_MODIFIERS: "1" },
		piVersion: "1.1.0",
	});
	assert.ok(disabled.args.includes("--no-tools"), "capability-locked agents keep --no-tools");
	assert.equal(toolsFlagValue(disabled.args), undefined, "no --tools flag alongside --no-tools");

	const denied = buildPiWorkerArgs({
		task: "Task: x",
		agent: agent({ tools: "read" as unknown as AgentConfig["tools"], disallowedTools: ["bash"] }),
		env: { PI_CREW_TOOLS_MODIFIERS: "1" },
		piVersion: "1.1.0",
	});
	assert.equal(toolsFlagValue(denied.args), "+read");
	const xIdx = denied.args.indexOf("--exclude-tools");
	assert.ok(xIdx >= 0, "disallowedTools denylist still rides --exclude-tools");
	assert.equal(denied.args[xIdx + 1], "bash");
});
