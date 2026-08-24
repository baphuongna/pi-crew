/**
 * Task 16 (perf/review-2026-08-24): mailbox reads are stat-gated.
 *
 * Parked workers poll all mailboxes every 500ms; parse results are memoized
 * per file by (mtime, size). These tests prove:
 *  1. an unchanged file is NOT re-parsed on re-read (cache hit),
 *  2. an append changes mtime → the cache self-invalidates,
 *  3. rotation (rename + recreate-empty) invalidates the primary entry while
 *     archived messages stay readable, and immutable archives permanently hit,
 *  4. readers get an array copy — callers may sort/filter it freely.
 *
 * INSTRUMENTATION NOTE: the task brief suggested `t.mock.method(fs,
 * "readFileSync")`, but Node 22's builtin ESM namespace is non-configurable
 * (`Cannot redefine property: readFileSync` — verified on this toolchain) and
 * mocking the CJS `require("node:fs")` exports object does not intercept
 * namespace-import calls. We instrument the equivalent, stronger signals:
 *  - `t.mock.method(JSON, "parse")` — the cache exists to skip parsing, so a
 *    hit performs zero JSON.parse calls;
 *  - message object identity — JSON.parse mints fresh objects, so identical
 *    references across reads prove the parsed array was reused, not re-read.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendMailboxMessage, readAllMailboxMessages } from "../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-stat-gate-run",
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function setupMailboxWorkspace(): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir("mailbox-stat-gate-");
	const stateRoot = path.join(dir, "state", "runs", "mailbox-stat-gate-run");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot) };
}

test("mailbox reads are stat-gated: unchanged file is not re-parsed, append invalidates", (t) => {
	const { dir, manifest } = setupMailboxWorkspace();
	try {
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "first" });
		const first = readAllMailboxMessages(manifest, "inbox");
		assert.equal(first.length, 1);
		assert.equal(first[0].body, "first");

		// Second read of the unchanged file must be a cache hit: no JSON.parse
		// runs and the message objects keep their identity (a re-parse via
		// JSON.parse would mint fresh objects).
		const jsonParse = t.mock.method(JSON, "parse");
		try {
			const parseCallsBefore = jsonParse.mock.callCount();
			const second = readAllMailboxMessages(manifest, "inbox");
			assert.equal(second.length, 1);
			assert.equal(jsonParse.mock.callCount(), parseCallsBefore, "cache hit must not re-parse the mailbox file");
			assert.strictEqual(second[0], first[0], "cache hit returns the memoized message objects (shallow copy)");
		} finally {
			jsonParse.mock.restore();
		}

		// Append changes mtime → the entry self-invalidates → re-parse picks
		// up the new message and re-mints objects for the old one.
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "second" });
		const third = readAllMailboxMessages(manifest, "inbox");
		assert.deepEqual(
			third.map((m) => m.body),
			["first", "second"],
		);
		assert.notStrictEqual(third[0], first[0], "invalidated entry must be re-parsed into fresh objects");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("rotation invalidates the primary entry; archives stay readable and permanently hit", () => {
	const { dir, manifest } = setupMailboxWorkspace();
	try {
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "small" });
		const first = readAllMailboxMessages(manifest, "inbox");
		assert.equal(first.length, 1); // primes the cache on the primary file

		// Cross the 10MB rotation threshold: the append rotates the primary
		// (rename → archive, then recreate-empty) inside the file lock.
		const bigBody = "x".repeat(10 * 1024 * 1024 + 2048);
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: bigBody });
		const mailboxDir = path.join(manifest.stateRoot, "mailbox");
		const inboxPath = path.join(mailboxDir, "inbox.jsonl");
		assert.equal(fs.statSync(inboxPath).size, 0, "primary file is recreated empty by rotation");
		const archives = fs.readdirSync(mailboxDir).filter((f) => /^inbox\.jsonl\..*\.archive\.jsonl$/.test(f));
		assert.equal(archives.length, 1, "one archive holds the rotated messages");

		// The primary's stale cache entry (old mtime) self-invalidates; the
		// archive is a fresh path so it parses once and both messages surface.
		const second = readAllMailboxMessages(manifest, "inbox");
		assert.equal(second.length, 2);
		assert.deepEqual(
			second.map((m) => m.body.length),
			["small".length, bigBody.length],
		);

		// Archives are immutable once written → subsequent reads hit forever.
		const third = readAllMailboxMessages(manifest, "inbox");
		assert.strictEqual(third[0], second[0], "archive cache entry is reused");
		assert.strictEqual(third[1], second[1], "archive cache entry is reused");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("cached reads hand out array copies — callers may sort/filter freely", () => {
	const { dir, manifest } = setupMailboxWorkspace();
	try {
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "worker", body: "only" });
		const first = readAllMailboxMessages(manifest, "inbox");
		first.pop(); // caller-side mutation of the returned array
		const second = readAllMailboxMessages(manifest, "inbox");
		assert.equal(second.length, 1, "mutating the returned array must not corrupt the cache");
		assert.equal(second[0].body, "only");
	} finally {
		removeTrackedTempDir(dir);
	}
});
