/**
 * N1 regression tests (security-audit run-1, w9-n1) — legacy-loader-route MCP
 * allowlist backstop.
 *
 * Lead: on the legacy `DefaultResourceLoader` route (live-session-runtime.ts,
 * `!sharedServicesAvailable`), the ONLY MCP control for a non-permitted role
 * was `stripMcpExtensions` — a NAME-based denylist (`builtin:mcp` exact +
 * `pi-mcp-adapter` substring). A differently-named MCP adapter ('mcp-bridge',
 * arbitrary user path) was KEPT, loaded, and connected its servers for a
 * read-only role. The shared-services fast path already has an allowlist-shaped
 * post-creation assert (collectForeignExtensions + allowedLiveExtensionPaths)
 * that THROWS; the legacy route now runs the same-shaped assert
 * (legacyLoaderMcpAllowlistViolation + McpForeignExtensionError).
 *
 * These tests mirror the lead's PoC at unit level (driving the real
 * runLiveSessionTask down the legacy route would require an SDK that lacks
 * createAgentSessionServices/fromServices — SDK drift — which no local
 * fixture can provide; the decision helper exported from the runtime IS the
 * assert's arming + check, and it goes through the production
 * collectForeignExtensions → foreignMcpExtensionsAgainstAllowlist path).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allowedLiveExtensionPaths,
	collectForeignExtensions,
	legacyLoaderMcpAllowlistViolation,
} from "../../../../src/runtime/live-session/live-session-runtime.ts";
import {
	foreignMcpExtensionsAgainstAllowlist,
	isMcpExtensionPath,
	type LoadedExtensionsShape,
	McpForeignExtensionError,
	mcpPermittedForRole,
	stripMcpExtensions,
} from "../../../../src/runtime/mcp-proxy.ts";

/** The lead's exact PoC fixture (NEEDS-VALIDATION.md N1 sandbox replication). */
const POC_EXTENSIONS: Array<{ path: string }> = [
	{ path: "builtin:mcp" },
	{ path: "/home/u/.pi/agent/extensions/pi-mcp-adapter" },
	{ path: "mcp-bridge" },
	{ path: "/home/u/.pi/agent/extensions/my-mcp-link" },
	{ path: "some-normal-extension" },
];

/** Session-shaped stand-in matching LiveSessionLike's extensionRunner surface. */
function sessionWithExtensions(paths: string[]): { extensionRunner: { getExtensionPaths: () => string[] } } {
	return { extensionRunner: { getExtensionPaths: () => paths } };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) PoC mirror: differently-named adapter in the legacy route for a
//     read-only role → assert FIRES (typed failure, NOT silently kept)
// ─────────────────────────────────────────────────────────────────────────────

test("N1 (a): 'mcp-bridge' + arbitrary adapter path survive the name denylist, then are flagged foreign for a read-only role on the legacy route", () => {
	// Read-only role is NOT MCP-permitted (default-deny for unknown roles too).
	assert.equal(mcpPermittedForRole("explorer"), false);
	assert.equal(mcpPermittedForRole(undefined), false);
	// The legacy route's allowlist for such roles is EMPTY.
	assert.deepEqual(allowedLiveExtensionPaths(false), []);

	// Step 1 — the loader-level name denylist (unchanged): strips only
	// 'builtin:mcp' + the canonical 'pi-mcp-adapter' path.
	const afterStrip = stripMcpExtensions({ extensions: POC_EXTENSIONS });
	const keptAfterStrip = afterStrip.extensions.map((extension) => extension.path);
	assert.deepEqual(keptAfterStrip, ["mcp-bridge", "/home/u/.pi/agent/extensions/my-mcp-link", "some-normal-extension"]);
	assert.deepEqual(
		(afterStrip.warnings ?? []).map((warning) => warning.path),
		["builtin:mcp", "/home/u/.pi/agent/extensions/pi-mcp-adapter"],
	);

	// Step 2 — the N1 backstop: those survivors are FOREIGN for the read-only
	// role on the legacy route, so the post-creation assert fires (the runtime
	// then emits live-session.foreign_extension_blocked + throws).
	const session = sessionWithExtensions(keptAfterStrip);
	const violation = legacyLoaderMcpAllowlistViolation(session, { sharedServices: false, mcpPermitted: false });
	assert.deepEqual(violation, keptAfterStrip);
	assert.ok(violation.includes("mcp-bridge"), "differently-named MCP adapter must be flagged, not silently kept");
	assert.ok(violation.includes("/home/u/.pi/agent/extensions/my-mcp-link"));

	// Step 3 — the typed fail-closed error the assert throws.
	const error = new McpForeignExtensionError({
		foreignExtensions: violation,
		allowedExtensions: allowedLiveExtensionPaths(false),
		role: "explorer",
	});
	assert.equal(error.name, "McpForeignExtensionError");
	assert.ok(error instanceof Error);
	assert.ok(error.message.includes("[mcp-allowlist-fail-closed]"), error.message);
	assert.ok(error.message.includes("mcp-bridge"), error.message);
	assert.ok(error.message.includes('role "explorer"'), error.message);
	assert.deepEqual(error.foreignExtensions, violation);
	assert.deepEqual(error.allowedExtensions, []);
});

test("N1 (a) pure check: foreignMcpExtensionsAgainstAllowlist mirrors the fast path's set-membership semantics", () => {
	// Non-permitted role: empty allowlist → everything loaded is foreign.
	assert.deepEqual(foreignMcpExtensionsAgainstAllowlist(["mcp-bridge", "some-normal-extension"], []), [
		"mcp-bridge",
		"some-normal-extension",
	]);
	// Permitted role: exactly builtin:mcp sanctioned (allowedLiveExtensionPaths(true)).
	assert.deepEqual(foreignMcpExtensionsAgainstAllowlist(["builtin:mcp"], allowedLiveExtensionPaths(true)), []);
	assert.deepEqual(foreignMcpExtensionsAgainstAllowlist(["builtin:mcp", "mcp-bridge"], allowedLiveExtensionPaths(true)), ["mcp-bridge"]);
	// Exact-path membership, no substring/name heuristics.
	assert.deepEqual(foreignMcpExtensionsAgainstAllowlist([], []), []);
	assert.deepEqual(foreignMcpExtensionsAgainstAllowlist(["pi-mcp-adapter"], ["pi-mcp-adapter"]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Permitted role on the legacy route keeps extensions (assert NOT armed)
// ─────────────────────────────────────────────────────────────────────────────

test("N1 (b): permitted role on the legacy route is NOT flagged — the assert fires only for non-mcpPermitted roles", () => {
	assert.equal(mcpPermittedForRole("executor"), true); // write-capable → MCP-permitted
	const loaded = ["builtin:mcp", "/home/u/.pi/agent/extensions/pi-mcp-adapter", "some-user-extension"];
	// Legacy route + permitted role: no strip is armed, extensions are kept, and
	// the N1 assert must NOT fire.
	assert.deepEqual(legacyLoaderMcpAllowlistViolation(sessionWithExtensions(loaded), { sharedServices: false, mcpPermitted: true }), []);
	// The strip itself is not applied for permitted roles (runtime arms
	// extensionsOverride only when !mcpPermitted) — pinned by the denylist
	// helper staying inert when unused; the arming contract is the assert's.
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Existing name denylist unchanged: 'builtin:mcp' + 'pi-mcp-adapter' stripped
// ─────────────────────────────────────────────────────────────────────────────

test("N1 (c): isMcpExtensionPath/stripMcpExtensions behavior unchanged", () => {
	assert.equal(isMcpExtensionPath("builtin:mcp"), true);
	assert.equal(isMcpExtensionPath("/home/u/.pi/agent/extensions/pi-mcp-adapter"), true);
	assert.equal(isMcpExtensionPath("npm:pi-mcp-adapter"), true); // substring keeps npm form
	assert.equal(isMcpExtensionPath("mcp-bridge"), false);
	assert.equal(isMcpExtensionPath("/home/u/.pi/agent/extensions/my-mcp-link"), false);

	const base: LoadedExtensionsShape = { extensions: [{ path: "builtin:mcp" }, { path: "mcp-bridge" }] };
	const stripped = stripMcpExtensions(base);
	assert.deepEqual(stripped.extensions, [{ path: "mcp-bridge" }]);
	assert.deepEqual(stripped.warnings, [
		{ path: "builtin:mcp", warning: "stripped by pi-crew G2 role MCP policy (role is not MCP-permitted)" },
	]);
	// No-op when nothing matches: same reference back.
	const clean: LoadedExtensionsShape = { extensions: [{ path: "x" }] };
	assert.equal(stripMcpExtensions(clean), clean);
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Fast-path behavior unchanged
// ─────────────────────────────────────────────────────────────────────────────

test("N1 (d): fast path keeps its own assert and is not governed by the legacy helper", () => {
	// sharedServices route: the legacy assert is disarmed (fast path owns its
	// own assert with allowedLiveExtensionPaths(mcpPermitted)).
	const loaded = ["mcp-bridge"];
	assert.deepEqual(legacyLoaderMcpAllowlistViolation(sessionWithExtensions(loaded), { sharedServices: true, mcpPermitted: false }), []);
	// Fast-path assert semantics via collectForeignExtensions (now delegating to
	// the single mcp-proxy check): unchanged filtering for both permission modes.
	assert.deepEqual(collectForeignExtensions(sessionWithExtensions(["builtin:mcp"]), allowedLiveExtensionPaths(true)), []);
	assert.deepEqual(collectForeignExtensions(sessionWithExtensions(["builtin:mcp"]), allowedLiveExtensionPaths(false)), ["builtin:mcp"]);
	assert.deepEqual(
		collectForeignExtensions(sessionWithExtensions(["builtin:mcp", "/host/ext/pi-crew/index.ts"]), allowedLiveExtensionPaths(true)),
		["/host/ext/pi-crew/index.ts"],
	);
	// Defensive parity: a session without the runner surface never blocks.
	assert.deepEqual(collectForeignExtensions(undefined, []), []);
	assert.deepEqual(collectForeignExtensions({}, []), []);
	assert.deepEqual(collectForeignExtensions({ extensionRunner: {} }, []), []);
});
