/**
 * W2 fix wave (2026-10-29) regression pins — three CONFIRMED findings around
 * the deterministic verifier pre-gate's ground truth:
 *
 *   1. verify-gate.nonmanifest-ground-truth-self-grading — the gate only
 *      pinned the 8 manifest hashes, so tracked-unstaged harness stubs made
 *      the pinned checks execute worker-controlled code (self-grading).
 *      Closure: resolveHostVerifyGateSpec pins a dispatch-time TRACKED
 *      working-tree binding (treeOid + cleanTree); runVerifierGatePreGate
 *      fails the gate to the LLM verifier spawn on ANY divergence (or an
 *      unmeasurable tree) BEFORE any command runs.
 *   2. pi-crew.verify-gate-memo.index-tree-key-mismatch — the memo keyed
 *      PASS verdicts on `git write-tree` over the git INDEX, which is blind
 *      to unstaged worker edits and identical across fresh worktrees of the
 *      same HEAD. Closure: the key embeds the resolved workspace path + the
 *      FULL working tree (temp-index add -A) and a dirty tree disables the
 *      memo entirely (fail closed).
 *   3. pi-crew.verify-gate.worktree-verifier-gate-excludes-work — in
 *      worktree mode the gate evaluates the verifier's pristine tree, which
 *      structurally excludes the executor's uncommitted work; its PASS (plus
 *      the old memo) skipped the only reviewer that reads that work.
 *      Closure: dependency-worktree probes refuse the skip (reason
 *      "unverified_worktree_work") for fresh AND memoized PASS verdicts.
 *
 * All fixtures are REAL throwaway git repos — the tree bindings are the
 * security boundary, so the tests exercise real git, not mocks.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	findTasksWithWorktreeWork,
	resolveHostVerifyGateSpec,
	runVerifierGatePreGate,
	type VerifyGateHostSpec,
	worktreeHasUncommittedWork,
} from "../../../../src/runtime/verification/verify-gate.ts";
import {
	computeTrackedTreeOid,
	computeVerifyGateMemoKey,
	lookupVerifyGateMemo,
	recordVerifyGateMemo,
	resetVerifyGateMemoStoreForTests,
	workingTreeDirty,
} from "../../../../src/runtime/verification/verify-gate-memo.ts";

const CHECKS = [
	{ name: "typecheck", command: "npm run --silent typecheck", critical: true },
	{ name: "test-critical", command: "npm run --silent test:critical", critical: true },
];

const GREEN = [{ name: "always-green", command: "true", critical: true }];

function greenOutcome() {
	return {
		verdict: "PASS" as const,
		checks: CHECKS.map((c) => ({ ...c, exitCode: 0, passed: true, durationMs: 5, outputTail: "ok" })),
		evidenceLines: ["typecheck: exit=0 PASS"],
		allPassed: true,
		totalDurationMs: 10,
	};
}

/** Real git repo with a committed NON-manifest tracked file (run.js) — the
 *  tamper target mirroring the PoC's tracked-unstaged harness stubs. */
function makeGitRepo(label: string, extraFiles?: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { typecheck: "tsc" } }));
	fs.writeFileSync(path.join(dir, "run.js"), "console.log('clean');\n");
	for (const [rel, content] of Object.entries(extraFiles ?? {})) {
		fs.writeFileSync(path.join(dir, rel), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
	return dir;
}

/** Sibling linked worktree of `repo` (OUTSIDE the repo dir, so the repo's own
 *  status stays clean) — fresh worktrees previously shared the memo key. */
function makeSiblingWorktree(repo: string, suffix: string): string {
	const wt = `${repo}-${suffix}`;
	execFileSync("git", ["worktree", "add", "-q", "-b", `wt-branch-${suffix}`, wt], { cwd: repo });
	return wt;
}

describe("W2 finding 2: memo key binds the FULL working tree + workspace", () => {
	it("A1: unstaged tracked edit → MISS; restoring the content → HIT again", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-a1-");
		assert.equal(recordVerifyGateMemo(repo, CHECKS, greenOutcome()), true);
		assert.ok(lookupVerifyGateMemo(repo, CHECKS), "sanity: hit on the recorded tree");
		// THE REGRESSION: the old index-derived key stayed constant here, so the
		// memo served a PASS for a tree whose own checks would FAIL.
		fs.writeFileSync(path.join(repo, "run.js"), "console.log('tampered');\n");
		assert.equal(lookupVerifyGateMemo(repo, CHECKS), undefined, "unstaged tracked edit must MISS");
		// The miss is tree-keyed, not a permanent lockout.
		fs.writeFileSync(path.join(repo, "run.js"), "console.log('clean');\n");
		assert.ok(lookupVerifyGateMemo(repo, CHECKS), "restored content hits again");
	});

	it("A2: untracked file → MISS; removal → HIT", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-a2-");
		assert.equal(recordVerifyGateMemo(repo, CHECKS, greenOutcome()), true);
		fs.writeFileSync(path.join(repo, "planted.ts"), "export const p = 1;\n");
		assert.equal(lookupVerifyGateMemo(repo, CHECKS), undefined, "untracked file must MISS");
		fs.rmSync(path.join(repo, "planted.ts"));
		assert.ok(lookupVerifyGateMemo(repo, CHECKS), "clean tree hits again");
	});

	it("A3: dirty tree → key undefined, record refused (fail closed)", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-a3-");
		fs.writeFileSync(path.join(repo, "run.js"), "dirty;\n");
		assert.equal(workingTreeDirty(repo), true);
		assert.equal(computeVerifyGateMemoKey(repo, CHECKS), undefined);
		assert.equal(lookupVerifyGateMemo(repo, CHECKS), undefined);
		assert.equal(recordVerifyGateMemo(repo, CHECKS, greenOutcome()), false, "dirty-tree PASS must never memoize");
	});

	it("A4: identical content in a DIFFERENT workspace → MISS (cwd scoping)", () => {
		resetVerifyGateMemoStoreForTests();
		const repoA = makeGitRepo("vgwi-a4-");
		const repoB = makeGitRepo("vgwi-a4b-");
		assert.notEqual(computeVerifyGateMemoKey(repoA, CHECKS), undefined);
		recordVerifyGateMemo(repoA, CHECKS, greenOutcome());
		// Same committed content, same node, same checks — but a different
		// workspace: the old key had no cwd component, so repoB was served
		// repoA's PASS across worktrees.
		assert.equal(lookupVerifyGateMemo(repoB, CHECKS), undefined, "cross-workspace replay must MISS");
		assert.notEqual(computeVerifyGateMemoKey(repoA, CHECKS), computeVerifyGateMemoKey(repoB, CHECKS));
	});

	it("A5: sibling worktree at the same HEAD → MISS", () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-a5-");
		recordVerifyGateMemo(repo, CHECKS, greenOutcome());
		const wt = makeSiblingWorktree(repo, "a5");
		// Fresh worktrees are created from HEAD with HEAD-matching indexes — the
		// old key resolved to the same index tree OID here (the finding-3 PoC's
		// "wt2 served wt1's recorded PASS" replay).
		assert.equal(lookupVerifyGateMemo(wt, CHECKS), undefined, "same-HEAD sibling worktree must MISS");
	});

	it("A6: tracked-tree oid moves on an unstaged edit and only on tracked content", () => {
		const repo = makeGitRepo("vgwi-a6-");
		const before = computeTrackedTreeOid(repo);
		assert.ok(before, "tracked-tree oid computable on a committed repo");
		fs.writeFileSync(path.join(repo, "run.js"), "changed;\n");
		const during = computeTrackedTreeOid(repo);
		assert.ok(during);
		assert.notEqual(during, before, "unstaged tracked edit moves the tracked-tree binding");
		fs.writeFileSync(path.join(repo, "run.js"), "console.log('clean');\n");
		assert.equal(computeTrackedTreeOid(repo), before, "restored content restores the binding");
		// Untracked files do NOT move the tracked binding (they legitimately
		// differ between the leader workspace and fresh task worktrees).
		fs.writeFileSync(path.join(repo, "untracked.ts"), "export const u = 1;\n");
		assert.equal(computeTrackedTreeOid(repo), before, "untracked files stay out of the tracked binding");
	});
});

describe("W2 finding 1: dispatch tree binding blocks non-manifest self-grading", () => {
	it("B1: resolveHostVerifyGateSpec pins the tracked-tree binding", () => {
		const repo = makeGitRepo("vgwi-b1-");
		const spec = resolveHostVerifyGateSpec(repo);
		assert.ok(spec, "spec exists for a manifest-bearing repo");
		assert.ok(spec.treeOid, "treeOid pinned");
		assert.match(spec.treeOid!, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
		assert.equal(spec.cleanTree, true, "clean tree pinned clean");
	});

	it("B2: tracked-unstaged tamper after dispatch ⇒ FAILED, zero commands run, never a skip (PoC A)", async () => {
		const repo = makeGitRepo("vgwi-b2-");
		const spec = resolveHostVerifyGateSpec(repo);
		assert.ok(spec);
		// Worker tampering AFTER dispatch: a tracked-unstaged harness stub the
		// manifest bookends cannot see (package.json untouched — exact PoC A).
		fs.writeFileSync(path.join(repo, "run.js"), "process.exit(0); // stubbed harness\n");
		const result = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(result.outcome.verdict, "FAILED");
		assert.equal(result.outcome.checks.length, 0, "no command ran on unproven ground truth");
		assert.equal(result.decision.skipVerifier, false);
		assert.equal(result.decision.reason, "deterministic_failed");
		assert.match(result.outcome.evidenceLines.join("\n"), /working-tree-integrity: tracked files changed since the host snapshot/);
		assert.match(result.promptContext, /Working-tree integrity check FAILED/);
	});

	it("B3: unchanged tree + pinned binding ⇒ gate proceeds (PASS still saves the spawn)", async () => {
		const repo = makeGitRepo("vgwi-b3-");
		const spec = resolveHostVerifyGateSpec(repo);
		assert.ok(spec);
		const result = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(result.outcome.verdict, "PASS");
		assert.equal(result.decision.skipVerifier, true);
		assert.equal(result.promptContext, "");
	});

	it("B4: memo replay after an unstaged re-tamper is blocked at the pre-gate (PoC B)", async () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-b4-");
		const spec = resolveHostVerifyGateSpec(repo);
		assert.ok(spec);
		// Run 1: genuinely green — records a memo PASS (clean tree).
		const first = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(first.outcome.verdict, "PASS");
		// Unstaged re-tamper (the PoC: the index oid is unchanged, the working
		// tree is not — old memo served the recorded PASS with checks skipped).
		fs.writeFileSync(path.join(repo, "run.js"), "process.exit(1); // sabotaged check target\n");
		const second = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(second.outcome.verdict, "FAILED", "tree drift fails the gate before the memo lookup");
		assert.equal(second.decision.skipVerifier, false);
		const evidence = second.outcome.evidenceLines.join("\n");
		assert.match(evidence, /working-tree-integrity/);
		assert.ok(!evidence.includes("verify-gate-memo: HIT"), "no memo hit on a diverged tree");
	});

	it("B5: legacy pinned spec WITHOUT the binding keeps pre-W2 behavior (compat)", async () => {
		const repo = makeGitRepo("vgwi-b5-");
		const base = resolveHostVerifyGateSpec(repo);
		assert.ok(base);
		// Old manifests / hand-built specs carry no treeOid/cleanTree — the gate
		// must not invent a binding it was never pinned: old behavior preserved.
		const legacySpec: VerifyGateHostSpec = { snapshot: base.snapshot, checks: [GREEN[0]!] };
		fs.writeFileSync(path.join(repo, "run.js"), "tampered;\n");
		const result = await runVerifierGatePreGate({ cwd: repo, hostSpec: legacySpec, checks: GREEN });
		assert.equal(result.outcome.verdict, "PASS");
		assert.equal(result.decision.skipVerifier, true);
		assert.ok(!result.outcome.evidenceLines.join("\n").includes("working-tree-integrity"));
	});

	it("B6: tracked tamper DURING the gate downgrades PASS ⇒ INCONCLUSIVE (bookend)", async () => {
		const repo = makeGitRepo("vgwi-b6-", {
			// The npm script itself mutates a tracked file then exits 0 — the
			// mid-gate harness-swap race the after-bookend exists to catch.
			"mutator.js": "require('node:fs').appendFileSync('run.js', '\\n// mid-gate tamper\\n');\n",
		});
		fs.writeFileSync(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "t", scripts: { typecheck: "tsc", mutate: "node mutator.js" } }),
		);
		execFileSync("git", ["add", "-A"], { cwd: repo });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "mutator"], { cwd: repo });
		const base = resolveHostVerifyGateSpec(repo);
		assert.ok(base);
		const spec: VerifyGateHostSpec = {
			...base,
			checks: [{ name: "mutate-green", command: "npm run --silent mutate", critical: true }],
		};
		const result = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec });
		assert.equal(result.outcome.verdict, "INCONCLUSIVE", "a green verdict on a tree that changed mid-run is not evidence");
		assert.equal(result.decision.skipVerifier, false);
		assert.match(result.outcome.evidenceLines.join("\n"), /working-tree-integrity: tracked files changed since the host snapshot/);
	});

	it("B7: dispatch-dirty tree binds by oid equality — unchanged ⇒ no drift, further tamper ⇒ drift", async () => {
		const repo = makeGitRepo("vgwi-b7-");
		fs.writeFileSync(path.join(repo, "run.js"), "dirty-at-dispatch;\n");
		const spec = resolveHostVerifyGateSpec(repo);
		assert.ok(spec);
		assert.equal(spec.cleanTree, false, "dirty at dispatch pinned as dirty");
		assert.ok(spec.treeOid, "dirty tree still binds by oid");
		// Same content as dispatch ⇒ proven identical ⇒ the gate may run.
		const stable = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(stable.outcome.verdict, "PASS");
		assert.equal(stable.decision.skipVerifier, true);
		// Further tracked tamper after dispatch ⇒ drift.
		fs.writeFileSync(path.join(repo, "run.js"), "tampered-after-dispatch;\n");
		const drifted = await runVerifierGatePreGate({ cwd: repo, hostSpec: spec, checks: GREEN });
		assert.equal(drifted.outcome.verdict, "FAILED");
		assert.equal(drifted.decision.skipVerifier, false);
		assert.match(drifted.outcome.evidenceLines.join("\n"), /working-tree-integrity/);
	});
});

describe("W2 finding 3: dependency worktree work refuses the gate skip", () => {
	it("C1: worktreeHasUncommittedWork — clean/tracked-dirty/untracked/missing", () => {
		const repo = makeGitRepo("vgwi-c1-");
		const wt = makeSiblingWorktree(repo, "c1");
		assert.equal(worktreeHasUncommittedWork(wt), false, "pristine worktree is clean");
		fs.writeFileSync(path.join(wt, "run.js"), "executor edit;\n");
		assert.equal(worktreeHasUncommittedWork(wt), true, "tracked-unstaged edit is work");
		fs.writeFileSync(path.join(wt, "new.ts"), "export const n = 1;\n");
		assert.equal(worktreeHasUncommittedWork(wt), true, "untracked output is work");
		assert.equal(worktreeHasUncommittedWork(`${wt}-does-not-exist`), true, "missing path fails closed");
	});

	it("C2: findTasksWithWorktreeWork lists dirty deps, skips pathless probes", () => {
		const repo = makeGitRepo("vgwi-c2-");
		const wt = makeSiblingWorktree(repo, "c2");
		assert.deepEqual(findTasksWithWorktreeWork([{ taskId: "shared-cwd-dep" }]), [], "no worktree path ⇒ no probe");
		assert.deepEqual(findTasksWithWorktreeWork([{ taskId: "t2", worktreePath: wt }]), [], "clean worktree not listed");
		fs.writeFileSync(path.join(wt, "run.js"), "executor edit;\n");
		assert.deepEqual(findTasksWithWorktreeWork([{ taskId: "t1" }, { taskId: "t2", worktreePath: wt }]), ["t2"]);
	});

	it("C3: dirty dependency worktree refuses a fresh green gate's skip", async () => {
		const repo = makeGitRepo("vgwi-c3-");
		const wt = makeSiblingWorktree(repo, "c3");
		fs.writeFileSync(path.join(wt, "run.js"), "executor edit;\n");
		const result = await runVerifierGatePreGate({
			cwd: repo,
			checks: GREEN,
			dependencyWorktreeProbes: [{ taskId: "dep-1", worktreePath: wt }],
		});
		// The gate itself ran green on ITS tree — but that tree never saw the
		// dependency's work, so the PASS carries no skip authority.
		assert.equal(result.outcome.verdict, "PASS");
		assert.equal(result.decision.skipVerifier, false);
		assert.equal(result.decision.reason, "unverified_worktree_work");
		assert.equal(result.decision.attachGateContext, true);
		assert.match(result.outcome.evidenceLines.join("\n"), /worktree-guard: dependency task\(s\) dep-1/);
		assert.match(result.promptContext, /worktree-guard/);
		assert.match(result.promptContext, /dep-1/);
		assert.match(result.promptContext, /Gate verdict: PASS/);
	});

	it("C4: clean dependency worktree keeps the skip (guard silent)", async () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-c4-");
		const wt = makeSiblingWorktree(repo, "c4");
		const result = await runVerifierGatePreGate({
			cwd: repo,
			checks: GREEN,
			dependencyWorktreeProbes: [{ taskId: "dep-1", worktreePath: wt }],
		});
		assert.equal(result.outcome.verdict, "PASS");
		assert.equal(result.decision.skipVerifier, true);
		assert.equal(result.decision.reason, "deterministic_pass");
		assert.equal(result.promptContext, "");
	});

	it("C5: guard fires on a MEMO HIT too (the verifier-2 replay PoC)", async () => {
		resetVerifyGateMemoStoreForTests();
		const repo = makeGitRepo("vgwi-c5-");
		const wt = makeSiblingWorktree(repo, "c5");
		const probes = [{ taskId: "dep-1", worktreePath: wt }];
		// Run 1: green gate, clean dep worktree → PASS + skip + memo record.
		const first = await runVerifierGatePreGate({ cwd: repo, checks: GREEN, dependencyWorktreeProbes: probes });
		assert.equal(first.decision.skipVerifier, true);
		// Run 2: memo HIT serves the recorded PASS (same clean tree) — skip.
		const second = await runVerifierGatePreGate({ cwd: repo, checks: GREEN, dependencyWorktreeProbes: probes });
		assert.equal(second.decision.skipVerifier, true);
		assert.match(second.outcome.evidenceLines.join("\n"), /verify-gate-memo: HIT/);
		assert.equal(second.promptContext, "");
		// Run 3: the executor's work lands in ITS worktree (the gate's repo tree
		// is untouched — the old memo+skip combination certified it sight-unseen).
		fs.writeFileSync(path.join(wt, "run.js"), "executor edit;\n");
		fs.writeFileSync(path.join(wt, "feature.ts"), "export const f = 1;\n");
		const third = await runVerifierGatePreGate({ cwd: repo, checks: GREEN, dependencyWorktreeProbes: probes });
		assert.equal(third.decision.skipVerifier, false, "memoized PASS must not skip when dep work exists");
		assert.equal(third.decision.reason, "unverified_worktree_work");
		const evidence = third.outcome.evidenceLines.join("\n");
		assert.match(evidence, /verify-gate-memo: HIT/);
		assert.match(evidence, /worktree-guard/);
		assert.ok(third.promptContext.includes("worktree-guard"), "guard-forced spawn carries the WHY in its prompt");
	});
});
