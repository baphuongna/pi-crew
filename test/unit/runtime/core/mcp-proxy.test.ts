/**
 * Unit tests for src/runtime/mcp-proxy.ts (ZERO-COVERAGE module).
 *
 * Public API under test:
 *   - buildMcpProxyConfig({ parentMcpTools?, shareMcp? }): McpProxyConfig
 *   - discoverMcpToolNames(activeToolNames: string[]): string[]
 *   - buildMcpProxyFromSession(activeToolNames, options?): McpProxyConfig
 *
 * createMcpProxyTools is intentionally a stub (always returns []) in the
 * current implementation, which the config tests assert: when parent MCP tools
 * exist, the proxy falls back to letting the child self-discover MCP
 * (enableMcp: true) while still recording the discovered tool names.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildMcpProxyConfig,
	buildMcpProxyFromSession,
	discoverMcpToolNames,
	isMcpExtensionPath,
	mcpPermittedForRole,
	stripMcpExtensions,
} from "../../../../src/runtime/mcp-proxy.ts";

test("discoverMcpToolNames: detects mcp__ and mcp- prefixed names plus __-delimited names", () => {
	const names = discoverMcpToolNames([
		"mcp__filesystem__read_file",
		"mcp-github-issues",
		"submit_result",
		"bash",
		"edit",
		"github__create_issue", // contains __ and is not submit_result
		"submit_result__x", // excluded: starts with submit_result even though it has __
	]);

	assert.deepEqual(names.sort(), ["github__create_issue", "mcp-github-issues", "mcp__filesystem__read_file"]);
});

test("discoverMcpToolNames: returns empty array for ordinary built-in tools", () => {
	const names = discoverMcpToolNames(["bash", "edit", "read", "write", "grep", "find", "ls"]);
	assert.deepEqual(names, []);
});

test("discoverMcpToolNames: empty input yields empty output", () => {
	assert.deepEqual(discoverMcpToolNames([]), []);
});

test("buildMcpProxyConfig: no parent tools → enableMcp true with empty proxies", () => {
	const cfg = buildMcpProxyConfig({ parentMcpTools: [] });
	assert.equal(cfg.enableMcp, true, "child self-discovers MCP when parent has none");
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, []);
});

test("buildMcpProxyConfig: parent tools present → records names but defers discovery to child", () => {
	// Because createMcpProxyTools is a stub (returns []), the module keeps
	// enableMcp: true so the child does not lose MCP access, while still
	// surfacing the discovered parent tool names for metadata/tracking.
	const cfg = buildMcpProxyConfig({ parentMcpTools: ["mcp__fs__read", "mcp__fs__write"] });
	assert.equal(cfg.enableMcp, true, "falls back to child self-discovery when proxies unavailable");
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, ["mcp__fs__read", "mcp__fs__write"]);
});

test("buildMcpProxyConfig: shareMcp=false short-circuits to a fully-disabled MCP config", () => {
	// G2 (SDD-2 W-B): shareMcp=false is the least-privilege contract — the
	// role is NOT permitted to use MCP, so the child session must not
	// discover the parent's MCP servers AT ALL (enableMcp:false), no matter
	// what tools the parent has. The pre-flip behavior (enableMcp:true) was
	// the flag inversion that let even read-only roles self-discover every
	// parent MCP server with credentials.
	const cfg = buildMcpProxyConfig({ parentMcpTools: ["mcp__fs__read"], shareMcp: false });
	assert.equal(cfg.enableMcp, false, "sharing disabled → MCP discovery must be off");
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, [], "sharing disabled → no proxy tool names recorded");
});

test("buildMcpProxyConfig: defaults — undefined parentMcpTools treated as none", () => {
	const cfg = buildMcpProxyConfig({});
	assert.equal(cfg.enableMcp, true);
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, []);
});

test("buildMcpProxyFromSession: integrates discovery + config from a live session's tool list", () => {
	const cfg = buildMcpProxyFromSession(["bash", "mcp__github__pr", "edit", "mcp__slack__post"]);
	// Discovery filters to MCP names; config then records them.
	assert.equal(cfg.enableMcp, true);
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames.sort(), ["mcp__github__pr", "mcp__slack__post"]);
});

test("buildMcpProxyFromSession: shareMcp=false disables MCP entirely (ignores discovered parent MCP tools)", () => {
	const cfg = buildMcpProxyFromSession(["mcp__github__pr"], { shareMcp: false });
	assert.equal(cfg.enableMcp, false, "G2 least-privilege: role not permitted → no MCP discovery");
	assert.deepEqual(cfg.proxyToolNames, []);
});

test("buildMcpProxyFromSession: session with no MCP tools yields empty config", () => {
	const cfg = buildMcpProxyFromSession(["bash", "edit", "read"]);
	assert.equal(cfg.enableMcp, true);
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, []);
});

test("mcpPermittedForRole: write-capable roles are MCP-permitted, read-only/unknown/undefined are denied", () => {
	// Write-capable roles (WRITE_ROLES) keep parent MCP sharing.
	assert.equal(mcpPermittedForRole("executor"), true);
	assert.equal(mcpPermittedForRole("verifier"), true);
	assert.equal(mcpPermittedForRole("agent"), true);
	// Read-only roles (READ_ONLY_ROLES) are denied.
	assert.equal(mcpPermittedForRole("explorer"), false);
	assert.equal(mcpPermittedForRole("reviewer"), false);
	assert.equal(mcpPermittedForRole("security-reviewer"), false);
	assert.equal(mcpPermittedForRole("analyst"), false);
	assert.equal(mcpPermittedForRole("critic"), false);
	assert.equal(mcpPermittedForRole("planner"), false);
	// FIND-12 default-deny: unknown and undefined roles resolve read-only.
	assert.equal(mcpPermittedForRole("typo-explorer"), false);
	assert.equal(mcpPermittedForRole(undefined), false);
});

test("isMcpExtensionPath: matches builtin:mcp and the pi-mcp-adapter replacer only", () => {
	assert.equal(isMcpExtensionPath("builtin:mcp"), true);
	assert.equal(isMcpExtensionPath("/home/u/.pi/agent/npm/node_modules/pi-mcp-adapter/index.js"), true);
	assert.equal(isMcpExtensionPath("npm:pi-mcp-adapter"), true);
	assert.equal(isMcpExtensionPath("builtin:read"), false);
	assert.equal(isMcpExtensionPath("/home/u/source/my_pi/pi-crew/src/prompt/prompt-runtime.ts"), false);
	assert.equal(isMcpExtensionPath(""), false);
});

test("stripMcpExtensions: drops MCP extensions, keeps the rest, records warnings (G2 enforcement)", () => {
	const base = {
		extensions: [
			{ path: "builtin:mcp", tools: new Map() },
			{ path: "/home/u/.pi/agent/npm/node_modules/pi-mcp-adapter/index.js", tools: new Map() },
			{ path: "builtin:read", tools: new Map() },
			{ path: "/repo/ext/user-tool.ts", tools: new Map() },
		],
		errors: [],
		runtime: {},
	};
	const out = stripMcpExtensions(base);
	assert.deepEqual(
		out.extensions.map((e) => e.path),
		["builtin:read", "/repo/ext/user-tool.ts"],
		"non-MCP extensions survive the strip untouched",
	);
	assert.equal(out.errors, base.errors, "errors passthrough");
	assert.equal(out.runtime, base.runtime, "runtime passthrough");
	assert.deepEqual(
		(out.warnings ?? []).map((w) => w.path),
		["builtin:mcp", "/home/u/.pi/agent/npm/node_modules/pi-mcp-adapter/index.js"],
		"each stripped extension is recorded as a warning",
	);
	// No MCP extensions present → object returned unchanged (no fake warnings).
	const clean = { extensions: [{ path: "builtin:read" }], errors: [] };
	assert.equal(stripMcpExtensions(clean), clean, "no-op when nothing matches");
});
