/**
 * Phase 1.5 #2 — git-worktree verification sandbox unit tests.
 * RFC: research-findings/goal-workflow/16-PHASE1.5-WORKTREE-SANDBOX-RFC.md
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	checkWorktreeSandboxAvailable,
	isWorktreeSandboxEnabled,
	prepareVerificationWorktree,
	withVerificationWorktree,
} from "../../src/runtime/verification/verification-worktree.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	return Promise.resolve(fn()).finally(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

/** Create a temp git repo with one commit. Returns path. */
function makeTempGitRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wt-test-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test.test"], {
		cwd: dir,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	// Prevent CRLF conversion on Windows (core.autocrlf=true is the default on
	// GitHub Actions windows-latest runners) so the worktree content matches
	// the LF-only bytes the test writes/expects.
	execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wt-test", version: "1.0.0" }));
	fs.writeFileSync(path.join(dir, "test.js"), "console.log('PASS');\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
	return dir;
}

function rmrf(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

test("isWorktreeSandboxEnabled: defaults to false (opt-in)", async () => {
	await withEnv(
		{
			PI_CREW_VERIFICATION_WORKTREE: undefined,
			PI_TEAMS_VERIFICATION_WORKTREE: undefined,
		},
		async () => {
			assert.equal(isWorktreeSandboxEnabled(), false);
		},
	);
});

test("isWorktreeSandboxEnabled: true when PI_CREW_VERIFICATION_WORKTREE=1", async () => {
	await withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, async () => {
		assert.equal(isWorktreeSandboxEnabled(), true);
	});
});

test("isWorktreeSandboxEnabled: true when PI_TEAMS_VERIFICATION_WORKTREE=true", async () => {
	await withEnv(
		{
			PI_CREW_VERIFICATION_WORKTREE: undefined,
			PI_TEAMS_VERIFICATION_WORKTREE: "true",
		},
		async () => {
			assert.equal(isWorktreeSandboxEnabled(), true);
		},
	);
});

test("checkWorktreeSandboxAvailable: false when opt-in env not set", async () => {
	const repo = makeTempGitRepo();
	try {
		await withEnv({ PI_CREW_VERIFICATION_WORKTREE: undefined }, async () => {
			const result = checkWorktreeSandboxAvailable(repo);
			assert.equal(result.available, false);
			assert.match(result.reason, /not set/i);
		});
	} finally {
		rmrf(repo);
	}
});

test("checkWorktreeSandboxAvailable: false when cwd is not a git repo", async () => {
	const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wt-norepo-"));
	try {
		await withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, async () => {
			const result = checkWorktreeSandboxAvailable(nonRepo);
			assert.equal(result.available, false);
			assert.match(result.reason, /git precondition|not a git repo|fatal/i);
		});
	} finally {
		rmrf(nonRepo);
	}
});

test("checkWorktreeSandboxAvailable: false when git index is dirty", async () => {
	const repo = makeTempGitRepo();
	try {
		// Make the index dirty.
		fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted change");
		await withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, async () => {
			const result = checkWorktreeSandboxAvailable(repo);
			assert.equal(result.available, false);
			assert.match(result.reason, /dirty git index/i);
		});
	} finally {
		rmrf(repo);
	}
});

test("checkWorktreeSandboxAvailable: true + returns commitSha when clean git repo", async () => {
	const repo = makeTempGitRepo();
	try {
		await withEnv({ PI_CREW_VERIFICATION_WORKTREE: "1" }, async () => {
			const result = checkWorktreeSandboxAvailable(repo);
			assert.equal(result.available, true);
			assert.ok((result as { commitSha: string }).commitSha.length >= 7, "commitSha must be a real SHA");
		});
	} finally {
		rmrf(repo);
	}
});

test("prepareVerificationWorktree: creates pristine checkout at commitSha", async () => {
	const repo = makeTempGitRepo();
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf-8",
	}).trim();
	try {
		const wt = prepareVerificationWorktree(repo, sha);
		try {
			assert.ok(fs.existsSync(wt.worktreePath), "worktree path must exist");
			assert.equal(wt.commitSha, sha);
			// The worktree contains the committed files.
			assert.ok(fs.existsSync(path.join(wt.worktreePath, "package.json")));
			assert.ok(fs.existsSync(path.join(wt.worktreePath, "test.js")));
		} finally {
			wt.cleanup();
		}
		// After cleanup, worktree path is gone.
		assert.equal(fs.existsSync(wt.worktreePath), false, "cleanup must remove worktree dir");
	} finally {
		rmrf(repo);
		// Prune any leftover worktree registrations.
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd: repo,
				stdio: "ignore",
			});
		} catch {
			/* gone */
		}
	}
});

test("prepareVerificationWorktree: worktree does NOT see main-workspace edits after creation", async () => {
	// This is the KEY security property: edit main workspace AFTER worktree is
	// created → worktree still has the ORIGINAL content (round-trip tamper blocked).
	const repo = makeTempGitRepo();
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf-8",
	}).trim();
	try {
		const wt = prepareVerificationWorktree(repo, sha);
		try {
			// Worker "tamper": edit test.js in MAIN workspace (not committed).
			fs.writeFileSync(path.join(repo, "test.js"), "console.log('TAMPERED');\n");
			// Worktree still has the original content.
			const wtContent = fs.readFileSync(path.join(wt.worktreePath, "test.js"), "utf-8");
			assert.equal(wtContent, "console.log('PASS');\n", "worktree must contain ORIGINAL content, not worker edits");
		} finally {
			wt.cleanup();
		}
	} finally {
		rmrf(repo);
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd: repo,
				stdio: "ignore",
			});
		} catch {
			/* gone */
		}
	}
});

test("withVerificationWorktree: RAII cleanup on success", async () => {
	const repo = makeTempGitRepo();
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf-8",
	}).trim();
	let capturedPath: string | undefined;
	try {
		await withVerificationWorktree(repo, sha, async (wt) => {
			capturedPath = wt.worktreePath;
			assert.ok(fs.existsSync(capturedPath!));
			return "ok";
		});
		// After withVerificationWorktree returns, worktree is cleaned up.
		assert.ok(capturedPath);
		assert.equal(fs.existsSync(capturedPath!), false, "RAII: worktree removed after fn returns");
	} finally {
		rmrf(repo);
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd: repo,
				stdio: "ignore",
			});
		} catch {
			/* gone */
		}
	}
});

test("withVerificationWorktree: RAII cleanup on EXCEPTION (finally always runs)", async () => {
	const repo = makeTempGitRepo();
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf-8",
	}).trim();
	let capturedPath: string | undefined;
	try {
		await assert.rejects(
			withVerificationWorktree(repo, sha, async (wt) => {
				capturedPath = wt.worktreePath;
				throw new Error("simulated verification crash");
			}),
			/simulated verification crash/,
		);
		// Cleanup ran despite the exception.
		assert.ok(capturedPath);
		assert.equal(fs.existsSync(capturedPath!), false, "RAII: worktree removed even when fn throws");
	} finally {
		rmrf(repo);
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd: repo,
				stdio: "ignore",
			});
		} catch {
			/* gone */
		}
	}
});

test("prepareVerificationWorktree cleanup is idempotent (safe to call twice)", async () => {
	const repo = makeTempGitRepo();
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf-8",
	}).trim();
	try {
		const wt = prepareVerificationWorktree(repo, sha);
		wt.cleanup();
		// Second call must NOT throw.
		assert.doesNotThrow(() => wt.cleanup());
	} finally {
		rmrf(repo);
		try {
			execFileSync("git", ["worktree", "prune"], {
				cwd: repo,
				stdio: "ignore",
			});
		} catch {
			/* gone */
		}
	}
});
