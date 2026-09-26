#!/usr/bin/env node
/**
 * CLI wrapper for the post-suite tmp sweep implemented (and unit-tested) in
 * test-runner.mjs — `node scripts/sweep-test-tmp.mjs [ageMinutes]` (default 30).
 * The implementation lives in the runner so a copied runner stays
 * self-contained (tests copy it into bare fixture dirs).
 */
import { sweepStaleTestTmpdirs } from "./test-runner.mjs";

if (process.argv[1] && process.argv[1].endsWith("sweep-test-tmp.mjs")) {
	const ageMin = Number(process.argv[2] ?? 30);
	const out = sweepStaleTestTmpdirs({ thresholdMs: Date.now() - ageMin * 60 * 1000 });
	console.log(`[tmp-sweep] removed=${out.removed} skipped=${out.skipped} errors=${out.errors}`);
}
