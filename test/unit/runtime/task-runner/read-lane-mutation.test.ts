/**
 * read-lane-mutation.test.ts — W10-8 (v0.11.38) pin.
 *
 * pi-subagents lesson #4 (staged-files guard): a READ-ONLY lane that dirtied
 * its worktree violates the lane contract. pi-crew surfaces it as a note
 * (unexpectedMutation on the task) — evidence in the diff artifact, leader
 * decides; never a hard fail.
 *
 * Pins (real throwaway git repos):
 *   (1) clean tree → undefined;
 *   (2) modified tracked file → note with filesChanged=1;
 *   (3) UNTRACKED file also counts (git diff alone would miss it);
 *   (4) non-git dir → undefined (fail-open, no throw);
 *   (5) permissionForRole gating: read_only roles get the probe, mutating
 *       roles don't (checked via the role classifier directly).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { permissionForRole } from "../../../../src/runtime/role-permission.ts";
import { detectReadLaneMutation, warnReadLaneMutation } from "../../../../src/runtime/task-runner/post-execution.ts";

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w108-"));
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

// R-A2 (MED-1 follow-up): fsmonitor-poisoned gitdir-hijack fixture. The
// poison payloads record both EXECUTION (M_HIJACK_FSMON) and the ENV the
// payload saw (envdump) — the probe must spawn NEITHER.
function makeHijackedWorktreeFixture(): { wt: string; markerDir: string } {
	const dir = makeRepo();
	const wt = path.join(dir, "wt-ra2");
	execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: dir });
	fs.appendFileSync(path.join(wt, "a.txt"), "worker edit\n", "utf-8");
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "w108-ra2-poison-"));
	const fakeGit = path.join(markerDir, "fakegit");
	fs.cpSync(path.join(dir, ".git"), fakeGit, { recursive: true, force: true });
	const poisonSh = path.join(markerDir, "fsmon.sh");
	fs.writeFileSync(poisonSh, `#!/bin/sh\ntouch ${markerDir}/M_HIJACK_FSMON\nenv > ${markerDir}/envdump\n`, "utf-8");
	fs.chmodSync(poisonSh, 0o755);
	fs.appendFileSync(path.join(fakeGit, "config"), `\n[core]\n\tfsmonitor = ${poisonSh}\n`, "utf-8");
	const admin = fs.readdirSync(path.join(fakeGit, "worktrees"), { withFileTypes: true }).find((e) => e.isDirectory())?.name;
	if (!admin) throw new Error("fixture: fake git dir has no worktree admin entry");
	fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(fakeGit, "worktrees", admin)}\n`, "utf-8");
	return { wt, markerDir };
}

describe("W10-8 read-lane mutation guard", () => {
	it("(1) clean tree → undefined", async () => {
		const repo = makeRepo();
		assert.equal(await detectReadLaneMutation(repo), undefined);
	});

	it("(2) modified tracked file → note", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		const note = await detectReadLaneMutation(repo);
		assert.ok(note);
		assert.equal(note.filesChanged, 1);
		assert.equal(note.sample.length, 1);
		assert.match(note.sample[0], /a\.txt/);
	});

	it("(3) UNTRACKED file counts too", async () => {
		const repo = makeRepo();
		fs.writeFileSync(path.join(repo, "new.ts"), "export {};\n");
		const note = await detectReadLaneMutation(repo);
		assert.ok(note);
		assert.equal(note.filesChanged, 1);
	});

	it("(4) non-git dir → undefined (fail-open)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
		assert.equal(await detectReadLaneMutation(dir), undefined);
	});

	it("(5) probe is read_only-gated: explorer read-only, executor not", () => {
		assert.equal(permissionForRole("explorer"), "read_only");
		assert.notEqual(permissionForRole("executor"), "read_only");
	});

	it("(6) stamping the note emits exactly one stderr warn line (visibility pin)", () => {
		const original = console.warn;
		const lines: string[] = [];
		console.warn = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			warnReadLaneMutation("task-9", { filesChanged: 3 });
		} finally {
			console.warn = original;
		}
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "[pi-crew:read-lane] unexpected mutation in READ-ONLY lane: task-9 files=3");
	});

	// --- R-A2 (MED-1 follow-up): the probe itself must be hardened. ---

	it("(7) gitdir-hijacked worktree → guard-fail reported AS a mutation, no spawn, no env leak", {
		skip: process.platform === "win32" ? "POSIX /bin/sh poison fixture" : false,
	}, async () => {
		const { wt, markerDir } = makeHijackedWorktreeFixture();
		try {
			const note = await detectReadLaneMutation(wt);
			// Guard fail = corruption signal → reported as a READ-lane mutation note.
			assert.ok(note, "guard failure must surface as a mutation note");
			assert.equal(note.filesChanged, 0, "no files were probed — git never ran");
			assert.match(note.sample[0] ?? "", /worktree corrupted|gitdir pointer check failed/);
			// NO payload execution and NO env leak: the poisoned fsmonitor never
			// spawned, so neither its marker nor its env dump exists.
			assert.ok(!fs.existsSync(path.join(markerDir, "M_HIJACK_FSMON")), "poisoned fsmonitor must not spawn");
			assert.ok(!fs.existsSync(path.join(markerDir, "envdump")), "probe env must not reach worker-planted payloads");
		} finally {
			fs.rmSync(path.dirname(wt), { recursive: true, force: true });
			fs.rmSync(markerDir, { recursive: true, force: true });
		}
	});

	it("(8) hijack fixture is a LIVE attack (raw probe would execute the poison)", {
		skip: process.platform === "win32" ? "POSIX /bin/sh poison fixture" : false,
	}, async () => {
		const { wt, markerDir } = makeHijackedWorktreeFixture();
		try {
			// Attack probe: a RAW `git status` (the pre-fix probe shape, full env)
			// executes the poisoned fsmonitor — proving the fixture is live.
			execFileSync("git", ["status", "--porcelain"], { cwd: wt, stdio: ["ignore", "ignore", "ignore"] });
			assert.ok(fs.existsSync(path.join(markerDir, "M_HIJACK_FSMON")), "raw probe must execute the poison (fixture liveness)");
			assert.ok(fs.existsSync(path.join(markerDir, "envdump")), "raw probe leaks the env to the payload");
		} finally {
			fs.rmSync(path.dirname(wt), { recursive: true, force: true });
			fs.rmSync(markerDir, { recursive: true, force: true });
		}
	});

	it("(9) hardened probe on a benign worktree still detects a real mutation", {
		skip: process.platform === "win32" ? "needs a linked worktree" : false,
	}, async () => {
		const repo = makeRepo();
		const wt = path.join(repo, "wt-benign");
		execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd: repo });
		fs.appendFileSync(path.join(wt, "a.txt"), "harmless read-lane violation\n", "utf-8");
		const note = await detectReadLaneMutation(wt);
		assert.ok(note);
		assert.equal(note.filesChanged, 1);
		assert.match(note.sample[0] ?? "", /a\.txt/);
	});
});
