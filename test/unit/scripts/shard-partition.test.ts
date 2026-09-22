import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error TS7016 — scripts/test-runner.mjs ships no .d.mts (it is a
// dev-only script excluded from the published tarball; same pattern as
// test-runner-exit.test.ts). The runtime import is what matters: these are
// the REAL partition functions used by the CI shard jobs.
import { parseShardArg, partitionShard, SHARD_DIR_WEIGHTS, shardDirKey } from "../../../scripts/test-runner.mjs";

/**
 * DP-03 (2026-09-22): CI test sharding — deterministic weighted partition.
 *
 * The CI budget (1500s) is about to be breached and --test-concurrency is
 * deliberately clamped at 2 (Windows Defender / macOS tmp contention — see
 * test-runner.mjs), so the lever is splitting the suite across parallel jobs.
 * The partition MUST be deterministic (failures map to one shard) and MUST
 * cover every discovered file exactly once (no silently skipped tests).
 *
 * Mutation: break determinism (e.g. sort by localeCompare) or drop a weight
 * → these tests go RED.
 */

const UNIT_ROOT = path.resolve(import.meta.dirname, "..", "..", "unit");

function discoverUnitFiles(): string[] {
	const out: string[] = [];
	(function walk(dir: string) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".test.ts")) out.push(full);
		}
	})(UNIT_ROOT);
	return out;
}

test("DP-03 AC-1: partition is deterministic across repeated calls AND enumeration orders", () => {
	const files = discoverUnitFiles();
	const first = [0, 1, 2, 3].map((shard) => partitionShard(files, { shard, total: 4 }));
	const second = [0, 1, 2, 3].map((shard) => partitionShard(files, { shard, total: 4 }));
	assert.deepEqual(first, second, "same input + weights must produce byte-identical shards");
	// THE real determinism contract: the same SET must partition identically
	// regardless of enumeration order (readdirSync order varies by filesystem /
	// mount). A locale-sensitive or unstable sort passes the first assertion on
	// ASCII-only locales but breaks here. Reversed + rotated copies must agree.
	const reversed = [...files].reverse();
	const third = [0, 1, 2, 3].map((shard) => partitionShard(reversed, { shard, total: 4 }));
	assert.deepEqual(third, first, "reversed enumeration must produce identical shards");
	// Order within a shard is also stable (sorted).
	for (const shardFiles of first) {
		const sorted = [...shardFiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		assert.deepEqual(shardFiles, sorted);
	}
});

test("DP-03 AC-2: union of shards == full suite, exactly once, no empty shard", () => {
	const files = discoverUnitFiles();
	const shards = [0, 1, 2, 3].map((shard) => partitionShard(files, { shard, total: 4 }));
	const flat = shards.flat();
	assert.equal(new Set(flat).size, files.length, "no duplicates across shards");
	assert.equal(flat.length, files.length, "every discovered file is in exactly one shard");
	for (const [i, shardFiles] of shards.entries()) {
		assert.ok(shardFiles.length > 0, `shard ${i} must not be empty (balance regression)`);
	}
});

test("DP-03 AC-3: committed weights balance the real suite within ±20%", () => {
	const files: string[] = discoverUnitFiles();
	const shards: string[][] = [0, 1, 2, 3].map((shard) => partitionShard(files, { shard, total: 4 }));
	const weightOf = (f: string): number => SHARD_DIR_WEIGHTS[shardDirKey(f)] ?? 0;
	const sums = shards.map((s) => s.reduce((acc: number, f: string) => acc + weightOf(f), 0));
	const target = sums.reduce((a, b) => a + b, 0) / 4;
	for (const [i, sum] of sums.entries()) {
		assert.ok(
			Math.abs(sum - target) <= target * 0.2,
			`shard ${i} weight ${sum} deviates >±20% from target ${target} — rebalance SHARD_DIR_WEIGHTS`,
		);
	}
});

test("DP-03: every discovered top-level dir has a weight (loud failure on new dirs)", () => {
	const files = discoverUnitFiles();
	const dirs = [...new Set(files.map(shardDirKey))];
	const missing = dirs.filter((dir) => SHARD_DIR_WEIGHTS[dir] === undefined);
	assert.deepEqual(missing, [], "a new test/unit/<dir> without a SHARD_DIR_WEIGHTS entry unbalances shards silently");
});

test("DP-03: shardDirKey maps paths correctly (prefix, root bucket, windows separators)", () => {
	assert.equal(shardDirKey("test/unit/runtime/x.test.ts"), "runtime");
	assert.equal(shardDirKey("runtime/x.test.ts"), "runtime");
	assert.equal(shardDirKey("test/unit/adaptive-plan.test.ts"), "(root)", "file directly under test/unit → root bucket");
	assert.equal(shardDirKey("test\\unit\\ui\\pane.test.ts"), "ui", "windows separators normalize");
});

test("DP-03: parseShardArg accepts syntactic --shard=i/n (range validation lives in partitionShard)", () => {
	assert.deepEqual(parseShardArg("--shard=0/4"), { shard: 0, total: 4 });
	assert.deepEqual(parseShardArg("--shard=3/4"), { shard: 3, total: 4 });
	// Syntactically valid but out of range — the PARSER accepts it; the
	// PARTITION throws (see the invalid-spec test below). One validation owner.
	assert.deepEqual(parseShardArg("--shard=4/4"), { shard: 4, total: 4 });
	assert.equal(parseShardArg("--test-timeout=180000"), undefined);
	assert.equal(parseShardArg("shard=1/4"), undefined);
});

test("DP-03: invalid shard specs throw (fail loud, not silently empty)", () => {
	assert.throws(() => partitionShard(["a.test.ts"], { shard: 4, total: 4 }), /invalid shard spec/);
	assert.throws(() => partitionShard(["a.test.ts"], { shard: -1, total: 4 }), /invalid shard spec/);
	assert.throws(() => partitionShard(["a.test.ts"], { shard: 0, total: 0 }), /invalid shard spec/);
	// Unknown directory → loud error naming the missing weight.
	assert.throws(() => partitionShard(["totally-unknown-dir/x.test.ts"], { shard: 0, total: 2 }), /no shard weight/);
});
