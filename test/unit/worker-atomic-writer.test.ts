/**
 * Phase 1.5 worker-thread atomic writer unit tests.
 * RFC: research-findings/goal-workflow/15-PHASE1.5-WORKER-WRITER-RFC.md
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__setKeepWorkerRefForTests,
	appendFileViaWorker,
	atomicWriteFileViaWorker,
	isWorkerAtomicWriterEnabled,
	terminateWorkerAtomicWriter,
} from "../../src/state/event-log/worker-atomic-writer.ts";

// Keep worker ref'd for the WHOLE suite so the test runner doesn't exit before
// promises resolve. Production code keeps worker unref'd.
__setKeepWorkerRefForTests(true);

function tmpFile(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-test-"));
	return { dir, file: path.join(dir, "test.txt") };
}

test("isWorkerAtomicWriterEnabled: defaults to false (opt-in)", () => {
	__setKeepWorkerRefForTests(true);
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	delete process.env.PI_TEAMS_WORKER_ATOMIC_WRITER;
	assert.equal(isWorkerAtomicWriterEnabled(), false);
	if (saved) process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
});

test("isWorkerAtomicWriterEnabled: true when PI_CREW_WORKER_ATOMIC_WRITER=1", () => {
	const saved = process.env.PI_CREW_WORKER_ATOMIC_WRITER;
	process.env.PI_CREW_WORKER_ATOMIC_WRITER = "1";
	assert.equal(isWorkerAtomicWriterEnabled(), true);
	if (saved) process.env.PI_CREW_WORKER_ATOMIC_WRITER = saved;
	else delete process.env.PI_CREW_WORKER_ATOMIC_WRITER;
});

test("atomicWriteFileViaWorker: writes file content", async () => {
	const { dir, file } = tmpFile();
	try {
		await atomicWriteFileViaWorker(file, "hello world\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "hello world\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFileViaWorker: overwrites existing file", async () => {
	const { dir, file } = tmpFile();
	try {
		await atomicWriteFileViaWorker(file, "first\n");
		await atomicWriteFileViaWorker(file, "second\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "second\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFileViaWorker: creates nested dirs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-test-"));
	const nested = path.join(dir, "a", "b", "c", "test.txt");
	try {
		await atomicWriteFileViaWorker(nested, "nested content\n");
		assert.equal(fs.readFileSync(nested, "utf-8"), "nested content\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFileViaWorker: handles parallel writes to DIFFERENT files", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-test-"));
	try {
		const files = Array.from({ length: 10 }, (_, i) => path.join(dir, `f${i}.txt`));
		await Promise.all(files.map((f, i) => atomicWriteFileViaWorker(f, `content-${i}\n`)));
		for (const [i, f] of files.entries()) {
			assert.equal(fs.readFileSync(f, "utf-8"), `content-${i}\n`);
		}
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendFileViaWorker: appends to existing file", async () => {
	const { dir, file } = tmpFile();
	try {
		fs.writeFileSync(file, "first\n", "utf-8");
		await appendFileViaWorker(file, "second\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "first\nsecond\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendFileViaWorker: creates file if missing", async () => {
	const { dir, file } = tmpFile();
	try {
		await appendFileViaWorker(file, "appended\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "appended\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("terminateWorkerAtomicWriter: subsequent write spawns fresh worker", async () => {
	const { dir, file } = tmpFile();
	try {
		await atomicWriteFileViaWorker(file, "before terminate\n");
		terminateWorkerAtomicWriter();
		await atomicWriteFileViaWorker(file, "after terminate\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "after terminate\n");
	} finally {
		terminateWorkerAtomicWriter();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Regression (macOS): symlink that is an ANCESTOR of tmpdir must be accepted.
// On macOS, /var is a symlink → /private/var, and os.tmpdir() returns
// /var/folders/…/T. The worker's isSymlinkSafePath walks up, hits /var,
// resolves it to /private/var, and must accept it (it's an ancestor of the
// resolved tmpdir). The old check rejected it → "Refusing to write: unsafe path"
// (5 macOS CI failures). This test reproduces the structure on any POSIX
// platform by pointing TMPDIR through a symlink and writing via the worker.
test("atomicWriteFileViaWorker: accepts tmpdir reached via symlink ancestor (macOS /var → /private/var regression)", {
	skip: process.platform === "win32" ? "symlinks need admin on Windows CI" : false,
}, async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mac-sym-"));
	const realPrivate = path.join(sandbox, "private");
	const realWork = path.join(realPrivate, "realwork");
	const pubLink = path.join(sandbox, "publink"); // symlink → realPrivate
	fs.mkdirSync(realWork, { recursive: true });
	fs.symlinkSync(realPrivate, pubLink);
	// TMPDIR through the symlink mimics macOS /var/folders/.../T
	const fakeTmp = path.join(pubLink, "realwork");
	const savedTmpdir = process.env.TMPDIR;
	terminateWorkerAtomicWriter(); // fresh worker reads new TMPDIR at spawn
	try {
		process.env.TMPDIR = fakeTmp;
		const file = path.join(fakeTmp, "out.txt");
		await atomicWriteFileViaWorker(file, "hello-mac\n");
		assert.equal(fs.readFileSync(file, "utf-8"), "hello-mac\n", "write through symlink ancestor of tmpdir must succeed");
	} finally {
		if (savedTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpdir;
		terminateWorkerAtomicWriter();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

// Symlink-attack protection: a symlink under tmpdir that escapes to a sibling
// dir must be REJECTED (no write through the attack symlink).
test("atomicWriteFileViaWorker: rejects symlink escaping tmpdir (symlink attack)", {
	skip: process.platform === "win32" ? "symlinks need admin on Windows CI" : false,
}, async () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sym-attack-"));
	const outside = path.join(sandbox, "outside");
	const insideTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inside-"));
	const attackLink = path.join(insideTmp, "evil"); // symlink → outside
	fs.mkdirSync(outside, { recursive: true });
	fs.symlinkSync(outside, attackLink);
	const savedTmpdir = process.env.TMPDIR;
	terminateWorkerAtomicWriter();
	try {
		// Make insideTmp the only safe tmp region; outside is a sibling sandbox.
		process.env.TMPDIR = insideTmp;
		const file = path.join(attackLink, "stolen.txt");
		await assert.rejects(() => atomicWriteFileViaWorker(file, "payload\n"), /Refusing to write: unsafe path/);
		assert.ok(!fs.existsSync(path.join(outside, "stolen.txt")), "must not write through attack symlink");
	} finally {
		if (savedTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpdir;
		terminateWorkerAtomicWriter();
		fs.rmSync(sandbox, { recursive: true, force: true });
		fs.rmSync(insideTmp, { recursive: true, force: true });
	}
});
