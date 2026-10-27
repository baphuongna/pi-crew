/**
 * MED-1 (git config/hook injection hardening) — shared helpers.
 *
 * Threat model: a worker with WRITE access to a worktree controls every file
 * INSIDE the worktree, including the `.git` pointer file of a linked worktree.
 * Unhardened git invocations with `cwd=<worktree>` therefore let that worker
 * execute code in the ORCHESTRATOR process context through:
 *
 *  - `core.fsmonitor`  (config)            — spawned on status/add/commit/diff
 *  - `core.hooksPath`  (config)            — pre/post-commit, prepare-commit-msg…
 *  - `diff.external` / `diff.<drv>.textconv` (config) — spawned by `git diff`
 *  - `filter.<x>.clean/smudge` (config, driven by in-tree `.gitattributes`) —
 *    spawned by add/status/diff/checkout
 *
 * The config values above can only come from a config file the worker does NOT
 * control (main-repo `.git/config`, global/system config) OR from a hijacked
 * gitdir: pointing the worktree `.git` file at an attacker-built directory that
 * contains a poisoned `config`. The helpers here cover both layers:
 *
 *  1. `hardenGitArgs()` — `-c` overrides that neutralize fsmonitor/hooksPath/
 *     attributesFile plus `--no-textconv --no-ext-diff` (diff) and `--no-verify`
 *     (commit). Empirically verified (git 2.43): `-c core.hooksPath=` (empty)
 *     disables ALL hook execution (including default hooks) without breaking
 *     `git commit`; `--no-verify` alone does NOT cover prepare-commit-msg /
 *     post-commit, which is why the hooksPath override is required.
 *  2. `verifyWorktreeGitdirPointer()` — fail-closed gitdir-hijack guard: before
 *     ANY git runs with `cwd=<worktree>`, the worktree `.git` pointer must
 *     resolve to the git-REGISTERED admin dir (source of truth:
 *     `<commonGitDir>/worktrees/<name>/gitdir`, written by git itself and stored in
 *     the trusted main repo). NOTE: admin dir names are NOT derivable from the
 *     worktree basename — git uniquifies collisions (`task9` → `task91`).
 *  3. `verifyForeignWorktreeLinkage()` (R-A3b) — fallback for linked worktrees
 *     with NO trusted `.git` anchor above them (foreign sibling shape: main repo
 *     and worktree live as peers, e.g. test fixtures under os.tmpdir()). Verifies
 *     the two-way pointer/backlink pair; see the SECURITY NOTE on the helper.
 *
 * KNOWN RESIDUAL (documented): a `filter.<x>.clean` DEFINITION in a genuinely
 * trusted config cannot be neutralized (`git add` has no --no-filters and
 * legit filters must keep working), but the worker-reachable path to a poisoned
 * filter definition is exactly the gitdir hijack this module blocks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { logInternalError } from "../utils/internal-error.ts";

/**
 * `-c` overrides prepended to every hardened git invocation.
 * - core.fsmonitor=false — never spawn an fsmonitor helper
 * - core.hooksPath=      — empty value disables ALL hooks (verified: default
 *                          hooks are skipped too, commit still succeeds)
 * - core.attributesFile= — ignore the config-pointed extra attributes file
 *                          (in-tree .gitattributes still applies; attributes
 *                          alone cannot execute anything without a config-side
 *                          filter/diff definition)
 */
export const GIT_HARDEN_CONFIG_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "core.attributesFile="];

/** Global git options that consume the NEXT argv token as their value
 * (R-A8: `-C <dir>` / `--git-dir <dir>` etc. — the value was previously
 * mistaken for the subcommand, so `diff`/`commit` hardening flags were
 * silently dropped for any argv carrying one of these). */
const GLOBAL_OPTIONS_WITH_SEPARATE_VALUE = new Set([
	"-c",
	"-C",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

/** First positional (subcommand) of a git argv, skipping global options. */
function firstSubcommand(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
			i++; // this option consumes the NEXT token as its value
			continue;
		}
		if (arg.startsWith("-")) continue; // --work-tree=…, --git-dir=… (inline value forms)
		return arg;
	}
	return undefined;
}

/**
 * Build the hardened argv for a git command (MED-1).
 * - always: GIT_HARDEN_CONFIG_ARGS prefix
 * - `diff`  → append --no-textconv --no-ext-diff (kills textconv + diff.external)
 * - `commit`→ append --no-verify (skips pre-commit/commit-msg; hooksPath= above
 *             additionally covers prepare-commit-msg/post-commit)
 */
export function hardenGitArgs(args: string[]): string[] {
	const hardened = [...GIT_HARDEN_CONFIG_ARGS, ...args];
	const sub = firstSubcommand(args);
	if (sub === "diff") {
		hardened.push("--no-textconv", "--no-ext-diff");
	} else if (sub === "commit") {
		hardened.push("--no-verify");
	}
	return hardened;
}

/** realpath with graceful fallback (native first for Windows long-name form). */
function realPathBestEffort(p: string): string {
	try {
		const r = fs.realpathSync.native(p);
		return r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	}
}

/** Path equality that is case-insensitive + separator-normalized on Windows. */
function sameGitPath(a: string, b: string): boolean {
	const norm = (p: string): string => {
		const n = p.replace(/\\/g, "/");
		return process.platform === "win32" ? n.toLowerCase() : n;
	};
	return norm(a) === norm(b);
}

/**
 * Resolve the TRUSTED git (common) dir for a repository path by walking up the
 * directory tree from `startPath` — the same discovery git performs, but using
 * only trusted directories (a worktree `.git` pointer is never consulted from
 * an untrusted directory because `startPath` is either the trusted main-repo
 * cwd/repoRoot (strict path) or a shape-validated `<main>` root derived from
 * the pointer target in the foreign-worktree fallback — never the worktree
 * itself).
 *
 * Handles: `.git` directory (normal repo), `.git` file (linked worktree or
 * submodule → parse `gitdir:`), and follows `commondir` so a repo root that is
 * itself a linked worktree still yields the shared common dir where `config`
 * and the `worktrees/` registry live.
 *
 * Returns undefined when no `.git` is found on the walk-up.
 */
export function resolveTrustedGitDir(startPath: string): string | undefined {
	let current = path.resolve(startPath);
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const dotGit = path.join(current, ".git");
		let gitDir: string | undefined;
		try {
			const st = fs.lstatSync(dotGit);
			if (st.isDirectory()) {
				gitDir = dotGit;
			} else if (st.isFile()) {
				const match = fs.readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m);
				if (match) {
					const target = match[1]!.trim();
					gitDir = path.isAbsolute(target) ? target : path.resolve(current, target);
				}
			}
			// symlinks and anything else are not trusted anchors
		} catch {
			/* no .git at this level — keep walking up */
		}
		if (gitDir !== undefined && fs.existsSync(gitDir)) {
			// Linked-worktree git dirs keep config + worktrees registry in the
			// COMMON dir (git's commondir file, usually a relative "../..").
			const commonFile = path.join(gitDir, "commondir");
			try {
				if (fs.statSync(commonFile).isFile()) {
					const raw = fs.readFileSync(commonFile, "utf-8").trim();
					const abs = path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
					if (fs.existsSync(abs)) return realPathBestEffort(abs);
				}
			} catch {
				/* fall through to gitDir itself */
			}
			return realPathBestEffort(gitDir);
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Shared sanitized env for EVERY git invocation (MED-1 / R-A4 / R-A6).
 *
 * Replaces the three drifting per-module copies (cleanup.ts GIT_SAFE_ENV,
 * worktree-manager.ts gitEnv(), branch-freshness.ts GIT_SAFE_ENV):
 *  - allowList-based `sanitizeEnvSecrets` — the child git process (and any
 *    config-reachable helper it spawns) never sees API keys/tokens;
 *  - `GIT_CONFIG_NOSYSTEM=1` — the system-wide gitconfig is never read, which
 *    ALSO makes a forwarded `GIT_CONFIG_SYSTEM` env var a no-op on git>=2.32
 *    (R-A4a: `GIT_CONFIG_SYSTEM` is therefore REMOVED from the allowlist —
 *    forwarding it would re-open exactly the surface NOSYSTEM closes);
 *  - `GIT_CONFIG_GLOBAL` is KEPT (R-A4b): `git commit` needs user.name/email
 *    from the user's global config — removing it breaks commits for users
 *    without repo-local identity. KNOWN RESIDUAL (accepted, documented): a
 *    `filter.<x>.clean/smudge` or `diff.external` DEFINITION living in a
 *    genuinely trusted global config is executable and cannot be neutralized
 *    without breaking legitimate filters — the worker-reachable path to a
 *    POISONED definition (gitdir hijack) is what the pointer guards block.
 */
export function buildGitSafeEnv(locale: "C" | "en_US.UTF-8" = "C"): Record<string, string> {
	const allowList = [
		"PATH",
		"HOME",
		"USER",
		...WINDOWS_ESSENTIAL_ENV_VARS,
		"SHELL",
		"TERM",
		"LANG",
		"LC_ALL",
		"LC_COLLATE",
		"LC_CTYPE",
		"LC_MESSAGES",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"NVM_BIN",
		"NVM_DIR",
		"NODE_PATH",
		"GIT_CONFIG_GLOBAL",
		"GIT_EXEC_PATH",
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	];
	// R-A4 win32 fix (CI run 40467894728): process.env enumeration is
	// CASE-PRESERVING on Windows (GitHub runners carry `Path`, `SystemRoot`,
	// `ComSpec`), while the allowlist above is exact-match — so PATH silently
	// vanished from git's env on win32. Re-key each enumerated entry to the
	// allowlist's canonical casing before filtering (keys not in the allowlist
	// are dropped by the filter either way). Neutral everywhere else: POSIX
	// names of interest are already uppercase, and win32 env lookup is
	// case-insensitive, so the child git process is unaffected by re-casing.
	const canonicalCase = new Map<string, string>();
	for (const entry of allowList) canonicalCase.set(entry.toUpperCase(), entry);
	const normalizedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		normalizedEnv[canonicalCase.get(key.toUpperCase()) ?? key] = value;
	}
	return {
		...sanitizeEnvSecrets(normalizedEnv, { allowList }),
		LANG: locale,
		LC_ALL: locale,
		// MED-1: never read the system-wide gitconfig for worktree operations —
		// shrinks the config surface a poisoned environment could reach. Set
		// UNCONDITIONALLY on every platform (git for Windows honours it too).
		GIT_CONFIG_NOSYSTEM: "1",
	};
}

/** Result of the R-A3 per-command trust check (see {@link worktreeTrustCheck}). */
export type WorktreeTrust =
	/** Nearest `.git` anchor walking up from cwd is a DIRECTORY (a main-repo
	 *  context) — trusted, nothing to re-verify. */
	| { kind: "repo" }
	/** No `.git` anchor found walking up from cwd — git itself will fail; the
	 *  caller's existing error handling applies. */
	| { kind: "no-git" }
	/** cwd sits inside a linked worktree (nearest anchor is a `.git` POINTER
	 *  FILE). `ok` is the gitdir-pointer verification result for that worktree. */
	| { kind: "worktree"; ok: boolean; reason: string };

/**
 * R-A3 (TOCTOU re-verify): cheap, self-anchored trust check for ANY git
 * invocation about to run with `cwd`. Walk up from `cwd` to the NEAREST `.git`:
 *
 *  - DIRECTORY → main-repo context (`cwd === repoRoot` and friends) → trusted,
 *    no pointer to verify — exactly the "cwd==repoRoot thì bỏ qua" rule;
 *  - FILE → cwd sits inside a linked worktree rooted at that level; its
 *    `.git` pointer is worker-writable, so it is re-verified against the
 *    git-registered admin dir. The TRUSTED common git dir is resolved by
 *    walking up from the worktree's PARENT — pi-crew worktrees live under
 *    `<repoRoot>/.crew/state/worktrees/…`, so the walk anchors at the
 *    orchestrator-owned main repo (never at the worktree's own pointer).
 *    If the walk finds NO anchor (foreign sibling shape — the worktree and
 *    its main repo are peers outside any orchestrator-owned tree, e.g. test
 *    fixtures under os.tmpdir()), the R-A3b mutual-linkage fallback decides
 *    instead of failing closed unconditionally (see
 *    {@link verifyForeignWorktreeLinkage}).
 *
 * Cost: a few lstats + the registry scan in verifyWorktreeGitdirPointer —
 * deliberately paid before EVERY worktree-cwd git command so a live worker
 * cannot flip the pointer after an entry-level check passed.
 */
export function worktreeTrustCheck(cwd: string): WorktreeTrust {
	let current = path.resolve(cwd);
	let worktreeRoot: string | undefined;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const st = fs.lstatSync(path.join(current, ".git"));
			// A plain pointer FILE (or anything that is not a directory, e.g. a
			// symlink — which the pointer verification rejects fail-closed).
			worktreeRoot = st.isDirectory() ? undefined : current;
			break;
		} catch {
			/* no .git at this level — keep walking up */
		}
		const parent = path.dirname(current);
		if (parent === current) return { kind: "no-git" };
		current = parent;
	}
	if (worktreeRoot === undefined) return { kind: "repo" };
	const trustedGitDir = resolveTrustedGitDir(path.dirname(worktreeRoot));
	if (trustedGitDir) {
		const check = verifyWorktreeGitdirPointer(worktreeRoot, trustedGitDir);
		return { kind: "worktree", ok: check.ok, reason: check.reason };
	}
	// R-A3b foreign-worktree fallback: no trusted anchor above the worktree
	// (strict-walk territory ends here). Decide via the weaker mutual-linkage
	// verification instead of failing closed unconditionally — fixes the
	// 0.11.45 regression where snapshotDirtyWorktree threw "cannot resolve a
	// trusted git dir above …" for sibling-shaped worktree fixtures.
	const fallback = verifyForeignWorktreeLinkage(worktreeRoot);
	if (fallback.ok) {
		logInternalError(
			"worktree.trust.foreignFallback",
			new Error("foreign linked worktree accepted via mutual-linkage fallback (no trusted anchor above)"),
			`worktreePath=${worktreeRoot}`,
		);
	}
	return { kind: "worktree", ok: fallback.ok, reason: fallback.reason };
}

/**
 * R-A3b foreign-worktree fallback: mutual-linkage verification for linked
 * worktrees whose parent-walk finds NO trusted `.git` anchor (the worktree and
 * its main repo are SIBLINGS — the shape of test fixtures like
 * `test/integration/worktree-snapshot-*`, or apps embedding these helpers
 * against a repo outside the orchestrator's tree).
 *
 * Checks, in order (fail closed on any mismatch):
 *  1. the worktree `.git` pointer file parses to `gitdir: <target>`;
 *  2. SHAPE: `<target>` must be `<main>/.git/worktrees/<id>` — the layout git
 *     itself writes for a registered linked worktree (anything else is not a
 *     shape git produces and is rejected without further reads);
 *  3. the two-way link, delegated to {@link verifyWorktreeGitdirPointer} with
 *     the pointer-derived candidate root: the admin backlink
 *     `<main>/.git/worktrees/<id>/gitdir` must point back at this worktree's
 *     `.git` AND the pointer must resolve to exactly that registered admin dir
 *     (realpath-normalized on both ends, identical to the strict path).
 *
 * SECURITY NOTE — this branch is strictly WEAKER than the strict parent-walk:
 * an attacker controlling both endpoints in its own tree can fabricate a
 * coherent pointer/backlink pair (the two-way link alone cannot distinguish
 * that from a genuine git registration). It is accepted because non-owned
 * paths do not occur in pi-crew's production runtime — pi-crew only runs git
 * inside OWNED roots (`<repoRoot>/.crew/state/worktrees/…`, which always take
 * the strict branch) and the main repo itself. The fallback exists to keep
 * snapshot/cleanup capability for legitimately-shaped foreign worktrees
 * (tests, embedded hosts) WITHOUT reopening the owned-root gitdir-hijack
 * vector (MED-1).
 */
function verifyForeignWorktreeLinkage(worktreePath: string): WorktreeGitdirCheck {
	const dotGit = path.join(worktreePath, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dotGit);
	} catch {
		return { ok: false, reason: `.git pointer missing at ${dotGit}` };
	}
	if (stat.isSymbolicLink()) {
		return { ok: false, reason: `.git at ${worktreePath} is a symlink (expected a plain pointer file)` };
	}
	if (!stat.isFile()) {
		return { ok: false, reason: `.git at ${worktreePath} is a directory (expected a linked-worktree pointer file)` };
	}
	let match: RegExpMatchArray | null = null;
	try {
		match = fs.readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m);
	} catch {
		/* unreadable pointer → fail below */
	}
	if (!match) {
		return { ok: false, reason: `.git pointer at ${dotGit} has no gitdir entry` };
	}
	const target = match[1]!.trim();
	const absTarget = path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
	// Shape gate: pointer target must name a git-style admin dir
	// `<main>/.git/worktrees/<id>` (relative targets resolved against the
	// worktree, same as verifyWorktreeGitdirPointer).
	const worktreesSegment = path.dirname(absTarget); // <main>/.git/worktrees
	const dotGitSegment = path.dirname(worktreesSegment); // <main>/.git
	const candidateMain = path.dirname(dotGitSegment); // <main>
	if (path.basename(worktreesSegment) !== "worktrees" || path.basename(dotGitSegment) !== ".git") {
		return { ok: false, reason: `.git pointer target ${absTarget} is not a <main>/.git/worktrees/<id> admin dir` };
	}
	// The candidate root's `.git` anchor must actually exist at that level —
	// deliberately NOT a walk-up: an unrelated repo above the named root must
	// never become the trust anchor of a pointer-chosen path.
	try {
		fs.statSync(path.join(candidateMain, ".git"));
	} catch {
		return { ok: false, reason: `pointer target root ${candidateMain} has no .git anchor` };
	}
	const candidateCommon = resolveTrustedGitDir(candidateMain);
	if (!candidateCommon) {
		return { ok: false, reason: `pointer target root ${candidateMain} has no resolvable common git dir` };
	}
	return verifyWorktreeGitdirPointer(worktreePath, candidateCommon);
}

/**
 * Throwing form of {@link worktreeTrustCheck} (R-A3). Call at the top of every
 * git helper: throws `worktree corrupted: …` when cwd sits inside a linked
 * worktree whose `.git` pointer no longer matches the trusted registry, so the
 * chain aborts before ANY further git runs inside that worktree. Trusted
 * contexts (main repo / non-git cwd) are no-ops.
 */
export function assertWorktreePointerTrusted(cwd: string): void {
	const trust = worktreeTrustCheck(cwd);
	if (trust.kind === "worktree" && !trust.ok) {
		throw new Error(`worktree corrupted: refusing to run git in ${cwd} — gitdir pointer check failed (${trust.reason})`);
	}
}

export interface WorktreeGitdirCheck {
	ok: boolean;
	reason: string;
}

/**
 * Gitdir-hijack guard (MED-1). Verify — WITHOUT running git inside the
 * worktree — that:
 *
 *  1. `worktreePath` is a REGISTERED worktree of `commonGitDir`: some
 *     `<commonGitDir>/worktrees/<admin>/gitdir` file (written by git, stored in
 *     the trusted main repo) points back at `worktreePath`; and
 *  2. the worktree `.git` POINTER FILE (worker-writable) resolves to exactly
 *     that registered admin dir.
 *
 * Fail closed: ANY mismatch (pointer rewritten, `.git` is a symlink/directory,
 * worktree not registered, registry unreadable) → ok:false. Callers must then
 * refuse to run git with cwd inside the worktree; removal may only happen via
 * `git worktree remove --force` from the trusted main-repo cwd.
 */
export function verifyWorktreeGitdirPointer(worktreePath: string, commonGitDir: string): WorktreeGitdirCheck {
	const worktreesRoot = path.join(commonGitDir, "worktrees");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
	} catch {
		return { ok: false, reason: `worktree registry unreadable at ${worktreesRoot}` };
	}
	const realWorktree = realPathBestEffort(worktreePath);
	let expectedAdmin: string | undefined;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let registered: string;
		try {
			registered = fs.readFileSync(path.join(worktreesRoot, entry.name, "gitdir"), "utf-8").trim();
		} catch {
			continue; // pruned/incomplete admin entry — not our worktree
		}
		// The registry file contains "<worktree>/.git"; compare worktree roots.
		let registeredRoot = registered;
		if (path.basename(registered) === ".git") registeredRoot = path.dirname(registered);
		if (sameGitPath(realPathBestEffort(registeredRoot), realWorktree)) {
			expectedAdmin = path.join(worktreesRoot, entry.name);
			break;
		}
	}
	if (expectedAdmin === undefined) {
		return { ok: false, reason: `${worktreePath} is not a registered worktree of this repository` };
	}
	const dotGit = path.join(worktreePath, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dotGit);
	} catch {
		return { ok: false, reason: `.git pointer missing at ${dotGit}` };
	}
	if (stat.isSymbolicLink()) {
		return { ok: false, reason: `.git at ${worktreePath} is a symlink (expected a plain pointer file)` };
	}
	if (!stat.isFile()) {
		return { ok: false, reason: `.git at ${worktreePath} is a directory (expected a linked-worktree pointer file)` };
	}
	let match: RegExpMatchArray | null = null;
	try {
		match = fs.readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m);
	} catch {
		/* unreadable pointer → fail below */
	}
	if (!match) {
		return { ok: false, reason: `.git pointer at ${dotGit} has no gitdir entry` };
	}
	const target = match[1]!.trim();
	const absTarget = path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
	if (!sameGitPath(realPathBestEffort(absTarget), realPathBestEffort(expectedAdmin))) {
		return {
			ok: false,
			reason: `.git pointer target ${absTarget} does not match the registered gitdir ${expectedAdmin} (possible gitdir hijack)`,
		};
	}
	return { ok: true, reason: "" };
}
