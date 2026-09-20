/**
 * F08 / RR-016 — the config JSON guard must measure TRUE nesting depth, not
 * the number of parsed values.
 *
 * Baseline defect (measured before the fix, `src/config/config.ts`):
 *   const raw = JSON.parse(text, (_key, value) => { if (++depth > MAX_JSON_DEPTH) throw ... })
 * incremented once per VALUE, so the real threshold was the 101st reviver
 * callback. Consequences:
 *   - 47 agent overrides (99 values) loaded; 48 overrides (101 values) threw,
 *     and `readOptionalConfig` discarded the ENTIRE file (`config: {}`) — the
 *     resource limits (`limits.maxConcurrentWorkers`) silently stopped applying;
 *   - a genuinely 96-level-deep document with 99 values was ACCEPTED;
 *   - `updateConfig` threw too, so the user could not repair the file via CLI.
 *
 * These tests pin the fixed contract (AC-1..AC-7 of docs/stories/RR-016.md).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { configPath, invalidateConfigCache, loadConfig, updateConfig } from "../../../src/config/config.ts";

const HOME_KEY = "PI_TEAMS_HOME";
const HOME_CHECK_KEY = "PI_CREW_SKIP_HOME_CHECK";

/** Isolate PI_TEAMS_HOME to a tmp dir (mirrors config-cache.test.ts). */
function isolateHome(): { home: string; configFile: string; restore: () => void } {
	// NOTE: the tmp prefix must not contain the substring "depth" — the
	// warnings are asserted with a /depth/i filter and the message embeds the
	// full path.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-nest-guard-"));
	const prevHome = process.env[HOME_KEY];
	const prevCheck = process.env[HOME_CHECK_KEY];
	process.env[HOME_KEY] = home;
	process.env[HOME_CHECK_KEY] = "1";
	invalidateConfigCache();
	return {
		home,
		configFile: configPath(),
		restore: () => {
			if (prevHome === undefined) delete process.env[HOME_KEY];
			else process.env[HOME_KEY] = prevHome;
			if (prevCheck === undefined) delete process.env[HOME_CHECK_KEY];
			else process.env[HOME_CHECK_KEY] = prevCheck;
			invalidateConfigCache();
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

/** A shallow-but-wide config: `count` agent model overrides + resource limits. */
function wideConfig(count: number): Record<string, unknown> {
	const overrides: Record<string, { model: string }> = {};
	for (let i = 0; i < count; i += 1) overrides[`agent_${i}`] = { model: `provider/model-${i}` };
	return { agents: { overrides }, limits: { maxConcurrentWorkers: 3 } };
}

/**
 * A genuinely deep document: a chain of `chainLength` nested single-key objects
 * under `deep`, plus a top-level marker we can assert on. Depth counted by the
 * guard is `chainLength + 1` (the root object is depth 1).
 */
function deepConfig(chainLength: number, kind: "object" | "array" = "object"): Record<string, unknown> {
	let inner: unknown = "leaf";
	for (let i = 0; i < chainLength; i += 1) inner = kind === "object" ? { a: inner } : [inner];
	return { limits: { maxConcurrentWorkers: 3 }, deep: inner };
}

function writeConfig(configFile: string, value: unknown): void {
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, `${JSON.stringify(value)}\n`, "utf-8");
	invalidateConfigCache();
}

function depthWarnings(warnings: string[] | undefined): string[] {
	return (warnings ?? []).filter((warning) => /depth/i.test(warning));
}

describe("F08 — shallow-wide configs load (AC-1, AC-2)", () => {
	it("loads 47 overrides / 99 values (baseline behavior preserved)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, wideConfig(47));
			const loaded = loadConfig();
			assert.equal(Object.keys(loaded.config.agents?.overrides ?? {}).length, 47);
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, 3);
			assert.deepEqual(depthWarnings(loaded.warnings), []);
		} finally {
			restore();
		}
	});

	it("loads 48 overrides / 101 values instead of discarding the whole file (RED before fix: keptOverrides=0)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, wideConfig(48));
			const loaded = loadConfig();
			assert.equal(Object.keys(loaded.config.agents?.overrides ?? {}).length, 48);
			assert.deepEqual(depthWarnings(loaded.warnings), []);
		} finally {
			restore();
		}
	});

	it("keeps resource limits for a 500-override config (AC-2: limits must not be lost to a value count)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, wideConfig(500));
			const loaded = loadConfig();
			assert.equal(Object.keys(loaded.config.agents?.overrides ?? {}).length, 500);
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, 3, "resource limit must survive a wide config");
			assert.deepEqual(depthWarnings(loaded.warnings), []);
		} finally {
			restore();
		}
	});
});

describe("F08 — true depth boundary is measured on BOTH sides (AC-3, AC-4)", () => {
	it("accepts a document at exactly depth 100 (chain of 99 objects)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(99));
			const loaded = loadConfig();
			assert.deepEqual(depthWarnings(loaded.warnings), [], "depth 100 must be accepted");
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, 3);
		} finally {
			restore();
		}
	});

	it("rejects a document at depth 101 (chain of 100 objects) even though it has only 5 values", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(100));
			const loaded = loadConfig();
			const depthWarn = depthWarnings(loaded.warnings);
			assert.equal(depthWarn.length, 1, `expected a depth warning, got ${JSON.stringify(loaded.warnings)}`);
			assert.match(depthWarn[0]!, /nesting depth 101 exceeds max depth 100/);
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, undefined, "rejected file is discarded as before");
		} finally {
			restore();
		}
	});

	it("rejects a deep ARRAY document too (depth is measured for arrays, not just objects)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(100, "array"));
			const loaded = loadConfig();
			assert.equal(depthWarnings(loaded.warnings).length, 1);
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, undefined);
		} finally {
			restore();
		}
	});

	it("accepts a deep ARRAY document at the boundary (chain of 99 arrays)", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(99, "array"));
			const loaded = loadConfig();
			assert.deepEqual(depthWarnings(loaded.warnings), []);
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, 3);
		} finally {
			restore();
		}
	});

	it("does not stack-overflow on a pathological 100000-level document (guard stays iterative)", () => {
		const { configFile, restore } = isolateHome();
		try {
			let text = '{"limits":{"maxConcurrentWorkers":3},"deep":';
			const levels = 100_000;
			text += "[".repeat(levels) + "]".repeat(levels) + "}";
			fs.mkdirSync(path.dirname(configFile), { recursive: true });
			fs.writeFileSync(configFile, text, "utf-8");
			invalidateConfigCache();
			const loaded = loadConfig();
			assert.equal(depthWarnings(loaded.warnings).length, 1, "must be rejected by the depth guard, not crash");
		} finally {
			restore();
		}
	});
});

describe("F08 — byte-size limit preserved (AC-5)", () => {
	it("still discards a file larger than 10 MB (behaviour unchanged)", () => {
		const { configFile, restore } = isolateHome();
		try {
			// Valid JSON, > 10 MB, depth 2 — only the byte cap can reject it.
			const big = { limits: { maxConcurrentWorkers: 3 }, pad: "x".repeat(10 * 1024 * 1024 + 64) };
			fs.mkdirSync(path.dirname(configFile), { recursive: true });
			fs.writeFileSync(configFile, JSON.stringify(big), "utf-8");
			invalidateConfigCache();
			assert.ok(fs.statSync(configFile).size > 10 * 1024 * 1024);
			const loaded = loadConfig();
			assert.equal(loaded.config.limits?.maxConcurrentWorkers, undefined, "oversized file is ignored");
			assert.deepEqual(depthWarnings(loaded.warnings), [], "the byte cap is not reported as a depth problem");
		} finally {
			restore();
		}
	});
});

describe("F08 — diagnostics name DEPTH (AC-7)", () => {
	it("the rejection message states the measured depth, the limit, and how to fix it", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(150));
			const loaded = loadConfig();
			const depthWarn = depthWarnings(loaded.warnings);
			assert.equal(depthWarn.length, 1);
			assert.match(depthWarn[0]!, /nesting depth 151 exceeds max depth 100/);
			assert.match(depthWarn[0]!, /fix:/, "message must tell the user how to repair the file");
			assert.doesNotMatch(
				depthWarn[0]!,
				/^.*invalid config ignored: config JSON exceeds max depth 100$/,
				"old value-count wording must be gone",
			);
		} finally {
			restore();
		}
	});
});

describe("F08 — updateConfig can rewrite files the loader accepts (AC-6)", () => {
	it("rewrites a 48-override (101-value) config instead of throwing", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, wideConfig(48));
			// Baseline: readConfigRecord threw → updateConfig threw → the CLI could
			// not repair the file.
			const saved = updateConfig({ limits: { maxConcurrentWorkers: 4 } });
			assert.equal(saved.written, true);
			const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
				limits?: { maxConcurrentWorkers?: number };
				agents?: { overrides?: Record<string, unknown> };
			};
			assert.equal(onDisk.limits?.maxConcurrentWorkers, 4);
			assert.equal(Object.keys(onDisk.agents?.overrides ?? {}).length, 48, "overrides must survive the rewrite");
		} finally {
			restore();
		}
	});

	it("still throws for a genuinely over-deep file, with an actionable message", () => {
		const { configFile, restore } = isolateHome();
		try {
			writeConfig(configFile, deepConfig(150));
			assert.throws(
				() => updateConfig({ limits: { maxConcurrentWorkers: 4 } }),
				(error: Error) => {
					assert.match(error.message, /nesting depth 151 exceeds max depth 100/);
					assert.match(error.message, /fix:/);
					return true;
				},
			);
		} finally {
			restore();
		}
	});
});
