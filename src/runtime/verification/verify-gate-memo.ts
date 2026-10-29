/**
 * verify-gate-memo.ts — W10-2 (v0.11.38): memoized green verify-gate by
 * workspace tree-hash (pi-subagents lesson #3, tool-reference.md:432-496).
 *
 * WHY: sibling lanes / re-verifies on an UNCHANGED workspace re-run the full
 * check set (typecheck + test:critical — minutes each) for a deterministic
 * same-tree result. pisub memoizes gate acceptance by workspace tree-hash:
 * tree unchanged ⇒ same verdict, no re-run.
 *
 * SAFETY MODEL (rewritten by the W2 fix wave, 2026-10-29 — findings
 * verify-gate-memo.index-tree-key-mismatch + nonmanifest-ground-truth-self-grading):
 *  - The ORIGINAL key embedded `git write-tree` over the git INDEX. pi-crew
 *    workflows never stage worker edits (edit/write tools) or seed overlays
 *    (fs.cpSync), and worktree-mode task worktrees are created from HEAD with
 *    fresh HEAD-matching indexes — so that key stayed constant across
 *    materially different working trees and across every fresh worktree of the
 *    same HEAD, and a memo HIT could certify a tree the checks would FAIL.
 *  - The key now embeds (a) the RESOLVED workspace path — a PASS recorded for
 *    one workspace is never served to another (no cross-worktree replay), and
 *    (b) the FULL WORKING TREE OID, computed through a TEMPORARY index
 *    (GIT_INDEX_FILE: read-tree --empty → add -A → write-tree): staged AND
 *    unstaged modifications plus untracked non-ignored files all move the key,
 *    while the caller's index is never touched. A memo HIT therefore proves
 *    the workspace content the checks would evaluate is bit-identical to the
 *    content that produced the recorded PASS.
 *  - FAIL CLOSED ON A DIRTY TREE: `workingTreeDirty` (any tracked change or
 *    untracked file ⇒ true; probe failure ⇒ true) disables the memo entirely
 *    (undefined key ⇒ no hit AND no record). Dirt is pi-crew's normal state
 *    while work is in flight — exactly when self-grading risk is highest — so
 *    only a fully clean tree may ever memoize, and the drift binding in
 *    verify-gate.ts (dispatch treeOid) independently fails those gates closed.
 *  - ONLY verdict PASS outcomes are recorded (ran>0). FAILED / INCONCLUSIVE
 *    (incl. every integrity-drift and determinism downgrade) never memoize.
 *  - The lookup ITSELF re-computes the key — a hit can never serve a changed
 *    tree; a miss is an ordinary full gate run (fail-open only in the sense
 *    that MORE work happens, never less).
 *  - Not a git repo / git unavailable / tree-hash failure ⇒ key undefined ⇒
 *    memo silently disabled for that cwd (ordinary gate runs).
 *  - Typed-JSON gates (structured output, W10-9) must NEVER memoize — a JSON
 *    schema consumer reads fresh structuredOutput per run. The memo records
 *    only exit-code checks; a future structured gate kind must bypass this
 *    module entirely.
 *  - KNOWN TRADEOFF (accepted by design, mirrors pisub): tests that are
 *    time-dependent or environment-sensitive can pass once and be skipped on
 *    an unchanged CLEAN tree. The kill-switch PI_CREW_VERIFY_GATE_MEMO=0
 *    restores pre-W10-2 behavior bit-for-bit (default ON).
 *
 * Scope: host-process in-memory Map. Parallel sibling lanes within one host
 * process share it; cross-process persistence is deliberately out of scope.
 */
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getCrewEnvBool } from "../../config/env-vars.ts";
import type { VerifyGateCheck, VerifyGateOutcome } from "./verify-gate.ts";

/** W10-2 kill-switch: PI_CREW_VERIFY_GATE_MEMO beats default ON. */
export function resolveVerifyGateMemoEnabled(explicit?: boolean): boolean {
	const env = getCrewEnvBool("PI_CREW_VERIFY_GATE_MEMO");
	if (env !== undefined) return env;
	return explicit ?? true;
}

/** Tree-hash git budget: temp-index add -A walks the whole (non-ignored) tree,
 *  so this is more generous than the status probes. */
const TREE_HASH_TIMEOUT_MS = 30_000;
/** `git status --porcelain` probe budget (cheap; a hang must disable, not block). */
const STATUS_TIMEOUT_MS = 10_000;

function isValidTreeOid(oid: string): boolean {
	return /^[0-9a-f]{40}$/.test(oid) || /^[0-9a-f]{64}$/.test(oid);
}

/**
 * FULL working-tree OID of `cwd`: staged + unstaged modifications plus
 * untracked non-ignored files (gitignore respected), computed through a
 * TEMPORARY index (GIT_INDEX_FILE) so the caller's index is never touched.
 * W2 fix (index-tree-key-mismatch): the previous implementation used
 * `git write-tree` over the INDEX, which is blind to unstaged edits — the
 * normal state of pi-crew worker work — so the memo key was constant across
 * materially different trees. Undefined when git/repo unavailable or the
 * hash fails (memo silently disabled for that cwd — ordinary gate runs).
 */
export function computeWorkspaceTreeOid(cwd: string): string | undefined {
	const tmpIndex = path.join(os.tmpdir(), `pi-crew-vgtree-${process.pid}-${crypto.randomUUID()}`);
	try {
		const opts: ExecFileSyncOptionsWithStringEncoding = {
			cwd,
			env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: TREE_HASH_TIMEOUT_MS,
		};
		execFileSync("git", ["read-tree", "--empty"], opts);
		// Stages tracked modifications + untracked files (gitignores respected)
		// into the PRIVATE temp index — the caller's index is never written.
		execFileSync("git", ["add", "-A"], opts);
		const oid = execFileSync("git", ["write-tree"], opts).trim();
		return isValidTreeOid(oid) ? oid : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			fs.rmSync(tmpIndex, { force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

/**
 * TRACKED working-tree OID of `cwd`: the working-tree content of every file
 * known to HEAD (staged + unstaged modifications and deletions), EXCLUDING
 * untracked files. Computed through a temp index seeded from HEAD
 * (read-tree HEAD → add -u → write-tree). This is the dispatch-time
 * ground-truth binding for the verify gate (W2, nonmanifest-ground-truth-
 * self-grading): untracked files legitimately differ between the leader
 * workspace and a fresh task worktree (assertCleanLeader permits them, seeds
 * are selective), so the binding must key on what git tracks — while still
 * moving on ANY tracked edit (the self-grading PoC's tracked-unstaged
 * harness stubs). Undefined when unavailable (binding skipped — manifest
 * bookends still apply).
 */
export function computeTrackedTreeOid(cwd: string): string | undefined {
	const tmpIndex = path.join(os.tmpdir(), `pi-crew-vgtree-${process.pid}-${crypto.randomUUID()}`);
	try {
		const opts: ExecFileSyncOptionsWithStringEncoding = {
			cwd,
			env: { ...process.env, GIT_INDEX_FILE: tmpIndex },
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: TREE_HASH_TIMEOUT_MS,
		};
		try {
			execFileSync("git", ["read-tree", "HEAD"], opts);
		} catch {
			// No HEAD yet (fresh repo): the tracked set is empty.
			execFileSync("git", ["read-tree", "--empty"], opts);
		}
		// Updates tracked files to their WORKING-TREE content (mods + deletions);
		// untracked files stay out by definition of -u.
		execFileSync("git", ["add", "-u"], opts);
		const oid = execFileSync("git", ["write-tree"], opts).trim();
		return isValidTreeOid(oid) ? oid : undefined;
	} catch {
		return undefined;
	} finally {
		try {
			fs.rmSync(tmpIndex, { force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}

/** Fail-closed dirty probe: TRUE when the tree carries ANY change (tracked
 *  modification/deletion or untracked file) or when the probe itself fails
 *  (git unavailable/hangs — absence of proof of cleanliness is dirt). */
export function workingTreeDirty(cwd: string): boolean {
	try {
		const st = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: STATUS_TIMEOUT_MS,
		});
		return st.trim().length > 0;
	} catch {
		return true;
	}
}

/** Tri-state tracked-clean probe: true = no tracked changes; false = dirty;
 *  undefined = probe failed (callers decide their own fail direction). */
function trackedWorkingTreeClean(cwd: string): boolean | undefined {
	try {
		const st = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf-8",
			timeout: STATUS_TIMEOUT_MS,
		});
		return st.trim().length === 0;
	} catch {
		return undefined;
	}
}

/** Dispatch/gate-time tree binding snapshot (W2): tracked-tree OID + tracked-
 *  clean probe, with unavailable measurements OMITTED (never guessed) so the
 *  gate only ever acts on positive evidence of divergence or equality. */
export interface WorkingTreeBinding {
	/** {@link computeTrackedTreeOid} result; absent when it could not be computed. */
	oid?: string;
	/** {@link trackedWorkingTreeClean} result; absent when the probe failed. */
	clean?: boolean;
}

export function captureWorkingTreeBinding(cwd: string): WorkingTreeBinding {
	const binding: WorkingTreeBinding = {};
	const oid = computeTrackedTreeOid(cwd);
	if (oid !== undefined) binding.oid = oid;
	const clean = trackedWorkingTreeClean(cwd);
	if (clean !== undefined) binding.clean = clean;
	return binding;
}

/**
 * Deterministic memo key: resolved workspace path + FULL working-tree OID +
 * check list + node version. Undefined ⇒ memo disabled for this workspace:
 * a dirty tree (fail-closed, see {@link workingTreeDirty}) or an unhashable
 * non-git cwd. The resolved cwd is part of the key so a PASS recorded in one
 * workspace can never be replayed for another (fresh worktrees of the same
 * HEAD previously shared one index-derived key — the W2 replay bug).
 */
export function computeVerifyGateMemoKey(cwd: string, checks: VerifyGateCheck[]): string | undefined {
	if (workingTreeDirty(cwd)) return undefined;
	const oid = computeWorkspaceTreeOid(cwd);
	if (!oid) return undefined;
	const checkPart = checks.map((c) => `${c.name}::${c.command}::crit=${c.critical !== false}`).join("|");
	return `${path.resolve(cwd)}::${oid}::${process.version}::${checkPart}`;
}

/** In-host memo store (module-level: one per host process). */
const memoStore = new Map<string, VerifyGateOutcome>();

/** Test hook: wipe the store between unit tests. */
export function resetVerifyGateMemoStoreForTests(): void {
	memoStore.clear();
}

/** Build the memo-HIT outcome: verdict PASS with every check marked
 *  skipped-memo — evidence lines make the hit auditable in prompts/metrics. */
function memoHitOutcome(key: string, checks: VerifyGateCheck[]): VerifyGateOutcome {
	// Key layout: `<resolvedCwd>::<treeOid>::<node>::<checks>` — segment 1 is
	// the tree oid the evidence line names.
	const oid = key.split("::")[1] ?? "";
	return {
		verdict: "PASS",
		checks: checks.map((c) => ({
			name: c.name,
			command: c.command,
			exitCode: 0,
			passed: true,
			durationMs: 0,
			outputTail: "",
			skipped: true,
			error: `memoized (tree ${oid.slice(0, 12)} unchanged since recorded PASS)`,
		})),
		evidenceLines: [
			`verify-gate-memo: HIT — workspace tree ${oid.slice(0, 12)} + ${checks.length} check(s) unchanged since recorded PASS (W10-2)`,
		],
		allPassed: true,
		totalDurationMs: 0,
	};
}

/** Lookup a recorded PASS for this exact (workspace, full tree, checks, node)
 *  quadruple. Returns undefined on miss / disabled / unkeyable cwd. Typed-JSON
 *  gates (W10-9, check.output==="json") NEVER hit the memo — structured-output
 *  consumers read fresh structuredOutput every run. */
export function lookupVerifyGateMemo(cwd: string, checks: VerifyGateCheck[]): VerifyGateOutcome | undefined {
	if (checks.length === 0) return undefined;
	if (checks.some((c) => c.output === "json")) return undefined;
	const key = computeVerifyGateMemoKey(cwd, checks);
	if (!key) return undefined;
	const hit = memoStore.get(key);
	return hit ? memoHitOutcome(key, checks) : undefined;
}

/** Record an outcome — ONLY a ran PASS with real (non-memo) evidence on a
 *  CLEAN, hashable workspace. Memo-hit outcomes must not re-record (they
 *  carry skipped checks); a dirty tree yields no key (undefined ⇒ no record). */
export function recordVerifyGateMemo(cwd: string, checks: VerifyGateCheck[], outcome: VerifyGateOutcome): boolean {
	if (checks.length === 0) return false;
	if (checks.some((c) => c.output === "json")) return false;
	if (outcome.verdict !== "PASS" || !outcome.allPassed) return false;
	const ranReal = outcome.checks.some((c) => !c.skipped);
	if (!ranReal) return false;
	const key = computeVerifyGateMemoKey(cwd, checks);
	if (!key) return false;
	memoStore.set(key, outcome);
	return true;
}
