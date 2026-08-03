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
import { buildMcpProxyConfig, buildMcpProxyFromSession, discoverMcpToolNames } from "../../../../src/runtime/mcp-proxy.ts";

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

test("buildMcpProxyConfig: shareMcp=false short-circuits to empty proxies regardless of parent tools", () => {
	const cfg = buildMcpProxyConfig({ parentMcpTools: ["mcp__fs__read"], shareMcp: false });
	assert.equal(cfg.enableMcp, true);
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

test("buildMcpProxyFromSession: shareMcp=false ignores discovered parent MCP tools", () => {
	const cfg = buildMcpProxyFromSession(["mcp__github__pr"], { shareMcp: false });
	assert.equal(cfg.enableMcp, true);
	assert.deepEqual(cfg.proxyToolNames, []);
});

test("buildMcpProxyFromSession: session with no MCP tools yields empty config", () => {
	const cfg = buildMcpProxyFromSession(["bash", "edit", "read"]);
	assert.equal(cfg.enableMcp, true);
	assert.deepEqual(cfg.proxyTools, []);
	assert.deepEqual(cfg.proxyToolNames, []);
});
