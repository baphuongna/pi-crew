// @ts-nocheck — runtime-only test loading the untyped shipped bundle (dist/index.mjs).
// This test guards the bundle build itself; it intentionally bypasses typechecking.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * Regression for Tests/Build #1: the suite never loaded the SHIPPED bundle
 * (dist/index.mjs). CI can be 100% green while the esbuild bundle is broken
 * (CJS-shim, external resolution, tree-shaking) — a classic "tested the wrong
 * thing" anti-pattern. This test dynamically imports the bundle, asserts the
 * expected exports are present, and invokes the default export with a minimal
 * fake Pi API to surface bundle-load / export-shape regressions.
 *
 * Requires `npm run build:bundle` to have produced dist/index.mjs (the `ci`
 * script runs build:bundle before test:bundle).
 */
const BUNDLE = path.resolve(process.cwd(), "dist/index.mjs");

test("shipped bundle dist/index.mjs exists, loads, and exports registerPiTeams/waitForRun", async () => {
	assert.ok(fs.existsSync(BUNDLE), `${BUNDLE} not built — run \`npm run build:bundle\` first (added to ci before this test)`);

	const mod = (await import("../../dist/index.mjs")) as Record<string, unknown>;
	assert.equal(typeof mod.registerPiTeams, "function", "bundle must export registerPiTeams");
	assert.equal(typeof mod.waitForRun, "function", "bundle must export waitForRun");
	assert.equal(typeof mod.default, "function", "bundle must export a default function (the Pi extension entry)");
});

test("default export is callable with a minimal fake Pi API", async () => {
	if (!fs.existsSync(BUNDLE)) {
		assert.fail(`${BUNDLE} not built — run \`npm run build:bundle\` first`);
	}
	const mod = (await import("../../dist/index.mjs")) as { default: (pi: unknown) => unknown };
	const handlers: { event: string; fn: (...args: unknown[]) => void }[] = [];
	const fakePi = {
		on: (event: string, fn: (...args: unknown[]) => void) => {
			handlers.push({ event, fn });
		},
		registerTool: () => {},
		registerCommand: () => {},
		events: {
			on: () => {},
			emit: () => {},
		},
		getSessionName: () => undefined,
		setSessionName: () => {},
		appendEntry: () => {},
	};
	assert.doesNotThrow(() => mod.default(fakePi));
});
