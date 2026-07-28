#!/usr/bin/env node
/**
 * CI gate: enforce a max size budget on dist/index.mjs.
 *
 * The bundle is the cold-start entrypoint (preferred over strip-types
 * loading since v0.9.17). A growing bundle directly increases parse
 * time and npm install cost. This guard FAILS the build if the bundle
 * exceeds the budget, surfacing regressions early.
 *
 * Budget: 3.5 MB (see ROADMAP-2026-07-27 Sprint 6 CI-4).
 *
 * Exits:
 *   0 — bundle is within budget (or absent, deferring to build:bundle)
 *   1 — bundle exceeds budget
 */

import { existsSync, statSync } from "node:fs";

const BUDGET_BYTES = 3.5 * 1024 * 1024; // 3.5 MB
const distPath = "dist/index.mjs";

if (!existsSync(distPath)) {
	console.log("[check-bundle-size] dist/index.mjs absent — nothing to check. OK.");
	process.exit(0);
}

const sizeBytes = statSync(distPath).size;

if (sizeBytes > BUDGET_BYTES) {
	console.error(
		`[check-bundle-size] FAIL: dist/index.mjs (${(sizeBytes / 1024 / 1024).toFixed(2)} MB) exceeds budget (${(BUDGET_BYTES / 1024 / 1024).toFixed(1)} MB).`,
	);
	process.exit(1);
}

console.log(
	`[check-bundle-size] OK: dist/index.mjs is ${(sizeBytes / 1024 / 1024).toFixed(2)} MB (budget ${(BUDGET_BYTES / 1024 / 1024).toFixed(1)} MB).`,
);
