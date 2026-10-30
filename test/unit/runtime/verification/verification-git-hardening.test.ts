/**
 * w9-n4 — MED-1 hardening pins for the verification subsystem's git calls.
 *
 * Lead: NEEDS-VALIDATION N4 (security-audit-skill run-1) — every
 * execFileSync("git", …) under src/runtime/verification/ previously ran RAW
 * (full host-env inheritance, no config neutralizers, no gitdir trust check),
 * while the mandated controls (src/worktree/git-hardening.ts) were applied
 * only by worktree-manager.ts (R-A7 uniformity violation). The sink was
 * live-reproduced in the audit: raw `git status --porcelain` at a hijacked
 * linked-worktree cwd spawned an attacker-controlled core.fsmonitor helper in
 * the calling (orchestrator) process.
 *
 * Pins, in three layers mirroring the fix:
 *   (a) SOURCE: exactly ONE execFileSync("git" site per owned file — the
 *       hardened helper — and that helper composes hardenGitArgs +
 *       buildGitSafeEnv + assertWorktreePointerTrusted; no `{ ...process.env }`
 *       env inheritance remains.
 *   (b) BEHAVIORAL: fixture git repos (scratch tmpdirs only) prove the
 *       attacker-controlled helper is NOT spawned by the hardened paths for
 *       all three config-reachability shapes — repo config (core.fsmonitor),
 *       env-injected config (GIT_CONFIG_COUNT), and the audit's hijacked
 *       linked-worktree pointer shape (strict-path fail-closed) — each with a
 *       RAW control run proving the fixture is live on this platform.
 *   (c) VALUE: the w2 memo tree-OID values are unchanged by the hardening
 *       (full + tracked OID both equal HEAD^{tree} on a clean repo).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorktreeSandboxAvailable, prepareVerificationWorktree } from "../../../../src/runtime/verification/verification-worktree.ts";
import {
	computeTrackedTreeOid,
	computeVerifyGateMemoKey,
	computeWorkspaceTreeOid,
	workingTreeDirty,
} from "../../../../src/runtime/verification/verify-gate-memo.ts";
import { worktreeTrustCheck } from "../../../../src/worktree/git-hardening.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const CHECKS = [{ name: "true", command: "true", critical: true }];

/** POSIX-only: the marker payloads are /bin/sh scripts (repo convention — see
 *  test/unit/worktree/cleanup-git-injection.test.ts; linux + macos CI cover). */
const POSIX_ONLY = process.platform === "win32" ? "marker-hook fixtures are POSIX /bin/sh scripts" : false;

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Scratch root containing the repo + marker script + marker output. */
interface PoCFixture {
	/** The fixture git repo (clean, one commit). */
	repo: string;
	/** Executable marker script git will spawn as core.fsmonitor. */
	script: string;
	/** File the marker script appends to when it runs. */
	marker: string;
}

function markerWritten(f: PoCFixture): boolean {
	return fs.existsSync(f.marker);
}

function clearMarker(f: PoCFixture): void {
	fs.rmSync(f.marker, { force: true });
}

/**
 * The RAW control invocation — the exact audited sink shape
 * (verification-worktree.ts:93 pre-fix): env-inheriting execFileSync.
 */
function rawGitStatus(cwd: string): void {
	execFileSync("git", ["status", "--porcelain"], { cwd, stdio: "ignore" });
}

function makePoCFixture(): PoCFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w9n4-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
	execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	const script = path.join(root, "fsm.sh");
	const marker = path.join(root, "marker.txt");
	// Marker shape mirrors the audit PoC output ('HELPER SPAWNED args:2').
	fs.writeFileSync(script, `#!/bin/sh\necho "HELPER SPAWNED args:$#" >> ${JSON.stringify(marker)}\n`);
	fs.chmodSync(script, 0o755);
	return { repo, script, marker };
}

async function rmrf(p: string): Promise<void> {
	try {
		await removeDirWithRetry(p);
	} catch {
		/* best-effort */
	}
}

/** Marker script inside a hijack scratch root (lazily created, +x). */
function fsmScript(root: string): string {
	const script = path.join(root, "fsm.sh");
	if (!fs.existsSync(script)) {
		fs.writeFileSync(script, `#!/bin/sh\necho "HELPER SPAWNED args:$#" >> ${JSON.stringify(path.join(root, "marker.txt"))}\n`);
		fs.chmodSync(script, 0o755);
	}
	return script;
}

/** Read a repo-owned source file (package-root-relative) for the source pin. */
function readSrc(rel: string): string {
	return fs.readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf-8");
}

test('(a) source pin: one execFileSync("git" site per file — the hardened MED-1 helper', () => {
	const files = ["src/runtime/verification/verification-worktree.ts", "src/runtime/verification/verify-gate-memo.ts"] as const;
	for (const rel of files) {
		const src = readSrc(rel);
		// Pin only CODE — doc comments deliberately name the call/env shapes
		// (e.g. the helper's own explanation of what it replaced), so strip
		// block-comment continuations `*` and `//` line comments first.
		const codeLines = src
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => !l.startsWith("*") && !l.startsWith("//"));
		const code = codeLines.join("\n");
		const rawSites = codeLines.filter((l) => l.includes('execFileSync("git"'));
		assert.equal(rawSites.length, 1, `${rel}: every git call routes through the single hardened helper`);
		// The helper composes all three mandated controls (git-hardening.ts).
		assert.match(code, /assertWorktreePointerTrusted\(cwd\)/, `${rel}: R-A3 pointer trust assert`);
		assert.match(code, /hardenGitArgs\(args\)/, `${rel}: MED-1 argv neutralizers`);
		assert.match(code, /buildGitSafeEnv\(/, `${rel}: sanitized env, not process.env`);
		// No full host-env inheritance remains anywhere in executable code.
		assert.doesNotMatch(code, /\.\.\.process\.env/, `${rel}: no { ...process.env } env spread`);
	}
});

test("(b) repo-config core.fsmonitor: helper spawned by RAW control, NOT by hardened calls", { skip: POSIX_ONLY }, (t) => {
	const f = makePoCFixture();
	try {
		execFileSync("git", ["config", "core.fsmonitor", f.script], { cwd: f.repo });
		// CONTROL (live sink): the raw pre-fix shape spawns the helper here.
		rawGitStatus(f.repo);
		if (!markerWritten(f)) return t.skip("raw git did not spawn core.fsmonitor on this platform");
		clearMarker(f);
		// HARDENED (verification-worktree.ts): availability probe — same verdict
		// as pre-fix (clean repo ⇒ available), zero helper spawns.
		withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, () => {
			const result = checkWorktreeSandboxAvailable(f.repo);
			assert.equal(result.available, true, "hardened probe must keep the clean-repo verdict");
			if (!result.available) return;
			assert.ok(result.commitSha.length >= 7);
		});
		assert.equal(markerWritten(f), false, "helper must NOT spawn from checkWorktreeSandboxAvailable");
		// HARDENED (verify-gate-memo.ts): dirty probe + memo key — no spawn.
		assert.equal(workingTreeDirty(f.repo), false);
		assert.equal(markerWritten(f), false, "helper must NOT spawn from workingTreeDirty");
		assert.ok(computeVerifyGateMemoKey(f.repo, CHECKS), "memo key still computed on the clean repo");
		clearMarker(f);
		// HARDENED: pristine-worktree preparation + cleanup — no spawn.
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.repo, encoding: "utf-8" }).trim();
		const wt = prepareVerificationWorktree(f.repo, sha);
		try {
			assert.equal(fs.readFileSync(path.join(wt.worktreePath, "a.txt"), "utf-8"), "hello\n");
		} finally {
			wt.cleanup();
		}
		assert.equal(fs.existsSync(wt.worktreePath), false, "cleanup still removes the worktree");
		assert.equal(markerWritten(f), false, "helper must NOT spawn from prepareVerificationWorktree");
	} finally {
		rmrf(path.dirname(f.repo));
	}
});

test("(b2) env-injected config (GIT_CONFIG_COUNT): stripped from the hardened git env", { skip: POSIX_ONLY }, (t) => {
	const f = makePoCFixture();
	try {
		withEnv(
			{
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.fsmonitor",
				GIT_CONFIG_VALUE_0: f.script,
			},
			() => {
				// CONTROL: env-inheriting raw git reads GIT_CONFIG_COUNT and spawns.
				rawGitStatus(f.repo);
				if (!markerWritten(f)) return t.skip("raw git did not honor GIT_CONFIG_COUNT on this platform");
				clearMarker(f);
				// HARDENED: buildGitSafeEnv strips GIT_CONFIG_* (and the -c
				// overrides would neutralize the value even if forwarded).
				assert.equal(workingTreeDirty(f.repo), false);
				assert.equal(markerWritten(f), false, "env-injected core.fsmonitor must not reach the hardened git env");
				const oid = computeWorkspaceTreeOid(f.repo);
				assert.ok(oid, "tree OID still computed");
				assert.equal(markerWritten(f), false, "env-injected core.fsmonitor must not reach add -A either");
			},
		);
	} finally {
		rmrf(path.dirname(f.repo));
	}
});

test("(b3) hijacked linked-worktree pointer (audit PoC shape): strict-path fail-closed, no spawn", { skip: POSIX_ONLY }, (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w9n4-hijack-"));
	const main = path.join(root, "main");
	try {
		fs.mkdirSync(main);
		execFileSync("git", ["init", "-q"], { cwd: main });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: main });
		execFileSync("git", ["config", "user.name", "t"], { cwd: main });
		fs.writeFileSync(path.join(main, "a.txt"), "hello\n");
		execFileSync("git", ["add", "."], { cwd: main });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: main });
		// Production shape: task worktree under <repoRoot>/.crew/state/worktrees/
		// (a DESCENDANT of the main repo — the strict R-A3 parent-walk anchors
		// at <main>/.git, not the R-A3b foreign fallback).
		const wt = path.join(main, ".crew", "state", "worktrees", "wt1");
		fs.mkdirSync(path.dirname(wt), { recursive: true });
		execFileSync("git", ["worktree", "add", wt, "-b", "probe"], { cwd: main });
		// Poisoned FULL STANDALONE gitdir copy (config read as repo config —
		// admin-dir-shaped copies with commondir do not fire, per the audit).
		const poison = path.join(root, "poison-gitdir");
		fs.cpSync(path.join(main, ".git"), poison, { recursive: true });
		fs.appendFileSync(path.join(poison, "config"), `[core]\n\tfsmonitor = ${fsmScript(root)}\n`);
		const marker = path.join(root, "marker.txt");
		// HIJACK: rewrite the worker-writable worktree .git pointer.
		fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${poison}\n`);

		// The R-A3 trust check itself fails on the strict path.
		const trust = worktreeTrustCheck(wt);
		assert.equal(trust.kind, "worktree");
		assert.equal(trust.ok, false, "hijacked pointer must fail the gitdir trust check");

		// CONTROL (live audit sink): raw git at the hijacked cwd spawns the
		// attacker-controlled helper in THIS process.
		rawGitStatus(wt);
		if (!fs.existsSync(marker)) return t.skip("raw git did not spawn core.fsmonitor on this platform");
		fs.rmSync(marker, { force: true });

		// HARDENED — verify-gate-memo: every probe converts the corruption into
		// its fail-closed value (dirty=true ⇒ memo key undefined), no spawn.
		assert.equal(workingTreeDirty(wt), true, "corrupted worktree must probe as dirty (fail-closed)");
		assert.equal(fs.existsSync(marker), false, "helper must NOT spawn from workingTreeDirty");
		assert.equal(computeVerifyGateMemoKey(wt, CHECKS), undefined, "memo disabled on a corrupted worktree");
		assert.equal(computeWorkspaceTreeOid(wt), undefined, "tree OID unavailable on a corrupted worktree");
		assert.equal(computeTrackedTreeOid(wt), undefined, "tracked OID unavailable on a corrupted worktree");
		assert.equal(fs.existsSync(marker), false);

		// HARDENED — verification-worktree: availability probe reports the
		// corruption instead of running git inside the hijacked worktree.
		withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, () => {
			const result = checkWorktreeSandboxAvailable(wt);
			assert.equal(result.available, false);
			if (!result.available) assert.match(result.reason, /worktree corrupted/);
		});
		assert.equal(fs.existsSync(marker), false, "helper must NOT spawn from checkWorktreeSandboxAvailable");
	} finally {
		rmrf(root);
	}
});

test("(c) memo tree-OID values unchanged by the hardening (clean repo ⇒ HEAD^{tree})", () => {
	const f = makePoCFixture();
	try {
		const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: f.repo,
			encoding: "utf-8",
		}).trim();
		assert.ok(/^[0-9a-f]{40}$/.test(headTree));
		// Independent ground truth: both hardened OID computations must produce
		// bit-identical values to what the raw sequence produced pre-fix.
		assert.equal(computeWorkspaceTreeOid(f.repo), headTree, "full tree OID unchanged");
		assert.equal(computeTrackedTreeOid(f.repo), headTree, "tracked tree OID unchanged");
		assert.equal(workingTreeDirty(f.repo), false);
		const key = computeVerifyGateMemoKey(f.repo, CHECKS);
		assert.ok(key, "memo key still computable");
		assert.ok(key.includes(headTree), "memo key embeds the unchanged tree OID");
	} finally {
		rmrf(path.dirname(f.repo));
	}
});
