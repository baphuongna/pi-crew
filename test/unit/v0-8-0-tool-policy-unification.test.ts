/**
 * v0.8.0 — tool-restriction unification tests.
 *
 * Bug: the child-pi path (`pi-args.ts`) and live-session path
 * (`live-session-runtime.ts`) disagreed on tool restrictions:
 *   - child-pi: `roleConfig.tools ?? agent.tools`, `excludeTools = roleConfig.excludeTools`
 *     (role authoritative; frontmatter `tools:`/`disallowed_tools:` ignored)
 *   - live-session: `agent.tools` / `agent.disallowedTools` only
 *     (frontmatter authoritative; role-config ignored)
 * so the same agent behaved differently depending on the runtime.
 *
 * Fix: a shared `resolveToolPolicy(agent, role)` is now the single source of
 * truth used by BOTH paths. Semantics:
 *   - allowlist precedence is source-aware:
 *     builtin → role authoritative (security); user/project → frontmatter authoritative
 *   - denylist is additive: role excludeTools + agent disallowedTools merged
 *
 * These tests pin the policy resolver so both paths stay in lockstep.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { resolveToolPolicy } from "../../src/agents/agent-config.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "project",
		filePath: "/tmp/test.md",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

describe("resolveToolPolicy — allowlist precedence", () => {
	it("builtin agent: role-config allowlist wins over frontmatter", () => {
		// W7: explorer role-config tools now include `bash` (for research-5
		// decisions stream's `git log --grep`). Frontmatter still omits bash.
		// Builtin must use the role-config allowlist (security: it's the
		// authoritative set).
		const agent = makeAgent({
			source: "builtin",
			name: "explorer",
			tools: ["read", "grep", "find", "ls"],
		});
		const policy = resolveToolPolicy(agent, "explorer");
		assert.deepEqual(policy.tools, ["read", "grep", "find", "ls", "glob", "bash"]);
	});

	it("builtin agent: frontmatter allowlist is the fallback when role has none", () => {
		// executor role has NO tools allowlist (full access). A builtin executor
		// with a frontmatter tools list should fall back to that frontmatter.
		const agent = makeAgent({
			source: "builtin",
			name: "executor",
			tools: ["read", "bash", "edit"],
		});
		const policy = resolveToolPolicy(agent, "executor");
		assert.deepEqual(policy.tools, ["read", "bash", "edit"]);
	});

	it("user/project agent: frontmatter allowlist wins over role-config", () => {
		// A custom auditor agent (user source) with its own tools list. The
		// frontmatter is authoritative (user intent), even if a matching role
		// exists with a different set.
		const agent = makeAgent({
			source: "project",
			name: "auditor",
			tools: ["read", "grep", "find", "bash"],
		});
		const policy = resolveToolPolicy(agent, "auditor");
		assert.deepEqual(policy.tools, ["read", "grep", "find", "bash"]);
	});

	it("user/project agent: role-config is the fallback when frontmatter omits tools", () => {
		// W7: explorer role-config now also includes `bash`. Custom agent
		// spawned under explorer → inherits the role-config allowlist.
		const agent = makeAgent({
			source: "project",
			name: "custom",
			tools: undefined,
		});
		const policy = resolveToolPolicy(agent, "explorer");
		assert.deepEqual(policy.tools, ["read", "grep", "find", "ls", "glob", "bash"]);
	});

	it("no allowlist anywhere → tools undefined (all built-ins allowed)", () => {
		const agent = makeAgent({
			source: "project",
			name: "custom",
			tools: undefined,
		});
		const policy = resolveToolPolicy(agent, "executor"); // executor has no allowlist
		assert.equal(policy.tools, undefined);
	});
});

describe("resolveToolPolicy — denylist is additive (merged)", () => {
	it("merges role excludeTools + agent disallowedTools", () => {
		// W7: bash MOVED to explorer tools allowlist. excludeTools now
		// [edit,write,web]. Agent disallows [foo]. Merged denylist must contain
		// ALL of them.
		const agent = makeAgent({
			source: "builtin",
			name: "explorer",
			disallowedTools: ["foo", "edit"], // "edit" overlaps with role — dedup
		});
		const policy = resolveToolPolicy(agent, "explorer");
		assert.ok(policy.excludeTools, "denylist should be present");
		const set = new Set(policy.excludeTools);
		for (const expected of ["edit", "write", "web", "foo"]) {
			assert.ok(set.has(expected), `denylist should include ${expected}`);
		}
		// dedup: "edit" appears in both but only once
		assert.equal(policy.excludeTools!.filter((t) => t === "edit").length, 1);
	});

	it("agent disallowedTools honored even when role has no excludeTools", () => {
		// executor role has NO excludeTools. A user agent with disallowed_tools
		// must still have them applied (this was the child-pi bug: child-pi
		// ignored agent.disallowedTools entirely).
		const agent = makeAgent({
			source: "project",
			name: "custom",
			disallowedTools: ["web", "bash"],
		});
		const policy = resolveToolPolicy(agent, "executor");
		assert.ok(policy.excludeTools?.includes("web"));
		assert.ok(policy.excludeTools?.includes("bash"));
	});

	it("role excludeTools honored even when agent has no disallowedTools", () => {
		// (this was the live-session bug: live-session ignored role-config)
		const agent = makeAgent({
			source: "project",
			name: "custom",
			disallowedTools: undefined,
		});
		const policy = resolveToolPolicy(agent, "writer"); // writer excludes bash,web,ask_question
		assert.ok(policy.excludeTools?.includes("bash"));
		assert.ok(policy.excludeTools?.includes("web"));
		assert.ok(policy.excludeTools?.includes("ask_question"));
	});

	it("no denylist anywhere → excludeTools undefined", () => {
		const agent = makeAgent({
			source: "project",
			name: "custom",
			disallowedTools: undefined,
		});
		const policy = resolveToolPolicy(agent, "executor"); // executor has no excludeTools
		assert.equal(policy.excludeTools, undefined);
	});
});

describe("resolveToolPolicy — cross-path consistency", () => {
	it("the same (agent, role) yields the same policy regardless of which path asks", () => {
		// This is the core guarantee: child-pi and live-session both call
		// resolveToolPolicy(agent, role) and get the SAME result. We can't call
		// both paths here, but we can assert the resolver is deterministic and
		// role-keyed — the shared helper is what makes them agree.
		const agent = makeAgent({
			source: "project",
			name: "auditor",
			tools: ["read", "grep"],
			disallowedTools: ["web"],
		});
		const a = resolveToolPolicy(agent, "auditor");
		const b = resolveToolPolicy(agent, "auditor");
		assert.deepEqual(a, b);
		assert.deepEqual(a.tools, ["read", "grep"]);
		assert.deepEqual(a.excludeTools, ["web"]);
	});
});
