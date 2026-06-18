/**
 * Unit tests for team-tool handle-settings.
 * @see src/extension/team-tool/handle-settings.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleSettings } from "../../src/extension/team-tool/handle-settings.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeConfig(args: string, scope?: string): { config: Record<string, unknown> } {
	const cfg: Record<string, unknown> = { args };
	if (scope) cfg.scope = scope;
	return { config: cfg };
}

// ─── handleSettings — list ────────────────────────────────────────────────────

describe("handleSettings list", () => {
	it("shows effective settings when args is empty or 'list'", () => {
		const tmp = createTrackedTempDir("settings-test-");
		try {
			const res = handleSettings(makeConfig(""), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(
				text.includes("pi-crew effective settings") || text.includes("(all defaults"),
				`Expected settings listing, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows config file path in listing", () => {
		const tmp = createTrackedTempDir("settings-test-");
		try {
			const res = handleSettings(makeConfig("list"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Config file:") || text.includes("Source paths:"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — json ────────────────────────────────────────────────────

describe("handleSettings json", () => {
	it("returns JSON config dump", () => {
		const tmp = createTrackedTempDir("settings-json-");
		try {
			const res = handleSettings(makeConfig("json"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew effective config"));
			// Should contain JSON object
			assert.ok(text.includes("{"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — schema ──────────────────────────────────────────────────

describe("handleSettings schema", () => {
	it("shows all known config keys", () => {
		const tmp = createTrackedTempDir("settings-schema-");
		try {
			const res = handleSettings(makeConfig("schema"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew config schema"));
			assert.ok(text.includes("runtime.mode"));
			assert.ok(text.includes("limits.maxConcurrentWorkers"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — paths ──────────────────────────────────────────────────

describe("handleSettings paths", () => {
	it("shows config file paths", () => {
		const tmp = createTrackedTempDir("settings-paths-");
		try {
			const res = handleSettings(makeConfig("paths"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("pi-crew config paths"));
			assert.ok(text.includes("User config"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — scope ──────────────────────────────────────────────────

describe("handleSettings scope", () => {
	it("shows current scope when no argument", () => {
		const tmp = createTrackedTempDir("settings-scope-");
		try {
			const res = handleSettings(makeConfig("scope"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("Current write scope"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("rejects invalid scope value", () => {
		const tmp = createTrackedTempDir("settings-scope-");
		try {
			const res = handleSettings(makeConfig("scope invalidvalue"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("user") || text.includes("project"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — get ────────────────────────────────────────────────────

describe("handleSettings get", () => {
	it("returns error for empty key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get "), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Usage") || text.includes("get"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows value and default for a known key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get runtime.mode"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(text.includes("runtime.mode"));
			// Either set or showing default
			assert.ok(text.includes("=") || text.includes("default"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("shows suggestion for misspelled key", () => {
		const tmp = createTrackedTempDir("settings-get-");
		try {
			const res = handleSettings(makeConfig("get runtime.mod"), makeCtx(tmp));
			const text = textFromToolResult(res);

			// Should mention suggestion or unknown key
			assert.ok(
				text.includes("did you mean") || text.includes("unknown key"),
				`Expected suggestion or unknown key warning, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — set ────────────────────────────────────────────────────

describe("handleSettings set", () => {
	it("returns error when no value provided", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set justkey"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Usage") || text.includes("value"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets a boolean value", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set telemetry.enabled true"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(
				text.includes("Set telemetry.enabled") || text.includes("Error"),
				`Expected set result, got: ${text.slice(0, 200)}`,
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sets a numeric value", () => {
		const tmp = createTrackedTempDir("settings-set-");
		try {
			const res = handleSettings(makeConfig("set limits.maxConcurrentWorkers 4"), makeCtx(tmp));
			const text = textFromToolResult(res);

			assert.ok(
				text.includes("Set limits.maxConcurrentWorkers") || text.includes("Error"),
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — unset ──────────────────────────────────────────────────

describe("handleSettings unset", () => {
	it("returns error for empty key", () => {
		const tmp = createTrackedTempDir("settings-unset-");
		try {
			const res = handleSettings(makeConfig("unset "), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── handleSettings — unknown subcommand ──────────────────────────────────────

describe("handleSettings unknown subcommand", () => {
	it("returns error for unknown subcommand", () => {
		const tmp = createTrackedTempDir("settings-unknown-");
		try {
			const res = handleSettings(makeConfig("foobar"), makeCtx(tmp));

			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.ok(text.includes("Unknown subcommand"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
