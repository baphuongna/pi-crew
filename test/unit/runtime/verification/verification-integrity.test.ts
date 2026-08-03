/**
 * P1a helper — verification-integrity unit tests (RFC §P1a).
 *
 * snapshotManifests hashes the fixed manifest-file set (only present files);
 * compareSnapshot reports drifted/added/removed files.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compareSnapshot, MANIFEST_FILES, snapshotManifests } from "../../../../src/runtime/verification/verification-integrity.ts";

let tmpDir = "";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-vint-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("snapshotManifests", () => {
	it("hashes only manifest files that exist", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
		fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
		const snap = snapshotManifests(tmpDir);
		assert.deepEqual(Object.keys(snap).sort(), ["package.json", "tsconfig.json"]);
		assert.ok(/^[0-9a-f]{64}$/.test(snap["package.json"]), "sha256 hex digest");
		assert.ok(/^[0-9a-f]{64}$/.test(snap["tsconfig.json"]));
	});

	it("returns {} for an empty directory (missing files skipped gracefully)", () => {
		const snap = snapshotManifests(tmpDir);
		assert.deepEqual(snap, {});
	});

	it("skips directories that share a manifest name without throwing", () => {
		// A directory named package.json is not a regular file -> skipped.
		fs.mkdirSync(path.join(tmpDir, "package.json"));
		const snap = snapshotManifests(tmpDir);
		assert.deepEqual(snap, {});
	});

	it("produces stable hashes for identical content", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), '{ "name": "stable" }');
		const a = snapshotManifests(tmpDir);
		const b = snapshotManifests(tmpDir);
		assert.deepEqual(a, b);
	});

	it("covers every file in the fixed MANIFEST_FILES set when all present", () => {
		for (const rel of MANIFEST_FILES) {
			fs.writeFileSync(path.join(tmpDir, rel), `# ${rel} placeholder`);
		}
		const snap = snapshotManifests(tmpDir);
		assert.deepEqual(Object.keys(snap).sort(), [...MANIFEST_FILES].sort());
	});
});

describe("snapshotManifests — change detection", () => {
	it("detects a package.json content change", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		const before = snapshotManifests(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "1.1.0" }));
		const after = snapshotManifests(tmpDir);
		assert.notEqual(before["package.json"], after["package.json"]);
	});

	it("hashes are byte-sensitive (whitespace change => different hash)", () => {
		fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), '{"a":1}');
		const before = snapshotManifests(tmpDir);
		fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), '{ "a": 1 }');
		const after = snapshotManifests(tmpDir);
		assert.notEqual(before["tsconfig.json"], after["tsconfig.json"]);
	});
});

describe("compareSnapshot", () => {
	it("returns [] for identical snapshots", () => {
		const snap = { "package.json": "aaa", "tsconfig.json": "bbb" };
		assert.deepEqual(compareSnapshot(snap, { ...snap }), []);
	});

	it("returns the drifted file when a hash differs", () => {
		const a = { "package.json": "aaa", "tsconfig.json": "bbb" };
		const b = { "package.json": "aaa", "tsconfig.json": "CHANGED" };
		assert.deepEqual(compareSnapshot(a, b), ["tsconfig.json"]);
	});

	it("reports a removed file as drift", () => {
		const a = { "package.json": "aaa", "go.mod": "ccc" };
		const b = { "package.json": "aaa" };
		// go.mod present in a, missing in b => drift
		assert.deepEqual(compareSnapshot(a, b), ["go.mod"]);
	});

	it("reports an added file as drift", () => {
		const a = { "package.json": "aaa" };
		const b = { "package.json": "aaa", "Cargo.toml": "ddd" };
		assert.deepEqual(compareSnapshot(a, b), ["Cargo.toml"]);
	});

	it("reports multiple drifts in sorted order", () => {
		const a = {
			"package.json": "aaa",
			"tsconfig.json": "bbb",
			"go.mod": "ccc",
		};
		const b = {
			"package.json": "CHANGED",
			"tsconfig.json": "bbb",
			"Cargo.toml": "new",
		};
		// package.json changed; go.mod removed; Cargo.toml added
		assert.deepEqual(compareSnapshot(a, b), ["Cargo.toml", "go.mod", "package.json"]);
	});

	it("returns [] for two empty snapshots", () => {
		assert.deepEqual(compareSnapshot({}, {}), []);
	});
});

describe("compareSnapshot — end-to-end via snapshotManifests", () => {
	it("flags a package.json edit observed through real snapshots", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
		fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
		const before = snapshotManifests(tmpDir);

		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "2.0.0" }));
		const after = snapshotManifests(tmpDir);

		assert.deepEqual(compareSnapshot(before, after), ["package.json"]);
	});

	it("no drift when nothing changed", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
		const before = snapshotManifests(tmpDir);
		const after = snapshotManifests(tmpDir);
		assert.deepEqual(compareSnapshot(before, after), []);
	});
});
