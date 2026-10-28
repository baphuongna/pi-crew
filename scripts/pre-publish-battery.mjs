#!/usr/bin/env node
/**
 * pre-publish-battery.mjs — the HARD release gate for live (real-Pi) behavior
 * (2026-10-28, born from the v0.11.46/0.11.47 silent-worker incident).
 *
 * WHY THIS EXISTS
 * ---------------
 * The publish process already had "battery theo decision table" as prose — and
 * two consecutive releases shipped without running it, because a prose gate the
 * agent may choose to skip is a gate that WILL be skipped under pressure
 * (measured 2/2). Every gate that survived those same waves was a SCRIPT with
 * an exit code (wc-gate, lazy-imports, staleness, CI). This file turns the
 * battery into exactly that: one command, path-triggered tiers, evidence on
 * disk, exit 0/1. It is wired into:
 *
 *   - .githooks/pre-push  (after the full unit suite, main pushes only)
 *   - scripts/prepublish-ci.mjs  (prepublishOnly, before `npm run ci`)
 *
 * TIERS (always on):
 *   T1  test:critical            — broker/UI fast suites
 *   T3  check-bundle-staleness   — dist fresh vs src
 *   T11j staleness --committed-hash — committed dist == fresh build
 *
 * T7 LIVE SMOKE (auto-triggered by changed paths since the previous tag,
 * matching the real-test-pi-crew decision table): spawn a REAL `pi -p`
 * session that dispatches one trivial fast-fix team run, then verify the run
 * from its on-disk events — NOT from the agent's prose:
 *   - a run.completed event for a run created after battery start
 *   - ZERO occurrences of the v0.11.46 silent-death fingerprint
 *     ("empty-or-stderr-only-result") anywhere in that run's events
 *
 * If no `pi` binary is available (CI containers run fake-pi fixtures), the
 * tier SKIPS ONLY when PI_CREW_BATTERY_SKIP=1 is explicitly set (the caller
 * owns the justification and it lands in the audit trail). A silent skip is
 * a FAIL.
 *
 * Evidence: one JSON line per invocation appended to .crew/audit/battery.jsonl
 * ({ts, version, head, changedPaths, tiers, t7:{runId,status}, result}).
 * The publish checklist may verify an entry exists for the version at hand:
 * "gate KHÔNG CHẠY = KHÔNG PUBLISH".
 *
 * Env: crew control-plane prefixes (PI_CREW_/PI_TEAMS_, except the preserved
 * test knobs) are scrubbed from the T7 child exactly like prepublish-ci.mjs —
 * inherited worker-env noise must not shape the smoke run.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_DIR = path.join(REPO, ".crew", "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "battery.jsonl");
const RUNS_DIR = path.join(REPO, ".crew", "state", "runs");

/** Paths whose changes require the live smoke (T7) — mirrors the
 * real-test-pi-crew decision table's spawn-affecting rows. */
const T7_TRIGGERS = [
	/^src\/runtime\//,
	/^src\/prompt\//,
	/^src\/config\//,
	/^src\/extension\//,
	/^src\/schema\//,
	/^src\/ui\//,
	/^dist\//,
	/^workflows\//,
	/^agents\//,
	/^\.github\/workflows\//,
];

const CREW_ENV_PREFIXES = ["PI_CREW_", "PI_TEAMS_"];
const PRESERVED_CREW_ENV_KEYS = ["PI_CREW_TEST_NO_HOME_ISOLATION", "PI_CREW_BATTERY_SKIP"];

const log = (msg) => process.stdout.write(`[battery] ${msg}\n`);
const fail = (msg) => {
	process.stderr.write(`[battery] ✋ ${msg}\n`);
};

function scrubCrewEnv(env) {
	const clean = { ...env };
	for (const key of Object.keys(clean)) {
		if (PRESERVED_CREW_ENV_KEYS.includes(key)) continue;
		if (CREW_ENV_PREFIXES.some((p) => key.startsWith(p))) delete clean[key];
	}
	return clean;
}

function run(cmd, args, opts = {}) {
	const res = spawnSync(cmd, args, { encoding: "utf8", cwd: REPO, env: scrubCrewEnv(process.env), ...opts });
	return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** All paths changed since the previous tag PLUS uncommitted work. */
function changedPaths() {
	const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
	const tags = run("git", ["tag", "--sort=-creatordate"]).stdout.split("\n").filter(Boolean);
	let prevTag;
	for (const t of tags) {
		const sha = run("git", ["rev-list", "-1", t]).stdout.trim();
		if (sha !== head) {
			prevTag = t;
			break;
		}
	}
	const paths = new Set();
	if (prevTag) {
		for (const f of run("git", ["diff", "--name-only", `${prevTag}..HEAD`]).stdout.split("\n")) {
			if (f.trim()) paths.add(f.trim());
		}
	} else {
		// No previous tag found (fresh repo shape): be conservative, trigger T7.
		T7_TRIGGERS.forEach(() => paths.add("src/runtime/"));
	}
	const status = run("git", ["status", "--porcelain"]).stdout;
	for (const line of status.split("\n")) {
		const f = line.slice(3).trim();
		if (f) paths.add(f);
	}
	return { prevTag, paths: [...paths] };
}

function piAvailable() {
	const res = run("pi", ["--version"], { timeout: 15_000 });
	return res.code === 0 || /pi\s+\d/i.test(res.stdout);
}

/** Run one REAL pi -p dispatch of a trivial fast-fix team run and judge it
 * from the on-disk run state created after `startMs`. */
function t7LiveSmoke(cleanEnv, startMs) {
	return new Promise((resolve) => {
		const prompt =
			'Call the team tool exactly once: action="run" team="fast-fix" workflow="fast-fix" async=false ' +
			'with goal "Reply with exactly one word: OK. Do not run any tests." ' +
			"Report the final run status only.";
		const child = spawn("pi", ["-p", prompt], {
			cwd: REPO,
			env: cleanEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, 420_000);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, reason: `spawn pi failed: ${e.message}`, runId: undefined });
		});
		child.on("close", () => {
			clearTimeout(timer);
			// Judge from disk: newest run dirs created after battery start.
			let candidates = [];
			try {
				candidates = readdirSync(RUNS_DIR)
					.filter((d) => d.startsWith("team_"))
					.map((d) => ({ dir: d, mtime: statSync(path.join(RUNS_DIR, d)).mtimeMs }))
					.filter((c) => c.mtime >= startMs - 60_000)
					.sort((a, b) => b.mtime - a.mtime);
			} catch {
				resolve({ ok: false, reason: "no run dir created — the dispatch never reached team-runner", runId: undefined });
				return;
			}
			if (candidates.length === 0) {
				resolve({ ok: false, reason: "no run dir created after battery start", runId: undefined });
				return;
			}
			const runId = candidates[0].dir;
			const eventsPath = path.join(RUNS_DIR, runId, "events.jsonl");
			let events = "";
			try {
				events = readFileSync(eventsPath, "utf8");
			} catch {
				resolve({ ok: false, reason: `run ${runId} has no events.jsonl`, runId });
				return;
			}
			if (events.includes("empty-or-stderr-only-result")) {
				resolve({
					ok: false,
					reason: `SILENT-DEATH FINGERPRINT (empty-or-stderr-only-result) present in run ${runId} — this is the v0.11.46 class regression`,
					runId,
				});
				return;
			}
			const completed = /"type":"run\.completed"/.test(events);
			const failed = /"type":"run\.failed"/.test(events);
			if (completed && !failed) {
				resolve({ ok: true, reason: "run completed clean", runId });
			} else if (failed) {
				resolve({ ok: false, reason: `run ${runId} FAILED (see ${eventsPath})`, runId });
			} else if (killed) {
				resolve({ ok: false, reason: "pi process hung >420s and was killed", runId });
			} else {
				resolve({ ok: false, reason: `run ${runId} has no terminal event (no run.completed/run.failed)`, runId });
			}
		});
	});
}

async function main() {
	const started = Date.now();
	const startMs = started;
	const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
	const head = run("git", ["rev-parse", "HEAD"]).stdout.trim().slice(0, 8);
	const { prevTag, paths } = changedPaths();
	const needsT7 = paths.some((p) => T7_TRIGGERS.some((re) => re.test(p)));
	const tiers = {};
	let allOk = true;

	log(`version=${version} head=${head} prevTag=${prevTag ?? "<none>"} changed=${paths.length}`);

	// T1 — critical suites
	log("T1: test:critical …");
	const t1 = run("npm", ["run", "test:critical"], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
	tiers.t1 = t1.code === 0 ? "pass" : "fail";
	if (t1.code !== 0) {
		allOk = false;
		fail("T1 test:critical failed");
	}

	// T3 — bundle staleness
	log("T3: check-bundle-staleness …");
	const t3 = run("node", ["scripts/check-bundle-staleness.mjs"], { timeout: 60_000 });
	tiers.t3 = t3.code === 0 ? "pass" : "fail";
	if (t3.code !== 0) {
		allOk = false;
		fail("T3 staleness failed");
	}

	// T11j — committed dist hash
	log("T11j: staleness --committed-hash …");
	const t11 = run("node", ["scripts/check-bundle-staleness.mjs", "--committed-hash"], { timeout: 120_000 });
	tiers.t11j = t11.code === 0 ? "pass" : "fail";
	if (t11.code !== 0) {
		allOk = false;
		fail("T11j committed-hash failed");
	}

	// T7 — live smoke (path-triggered)
	let t7 = { ok: null, reason: "not triggered (no matching changed paths)" };
	if (!needsT7) {
		tiers.t7 = "skip";
		log("T7: not triggered by changed paths");
	} else if (!piAvailable()) {
		if (process.env.PI_CREW_BATTERY_SKIP === "1") {
			tiers.t7 = "skip-flagged";
			t7 = { ok: null, reason: "PI_CREW_BATTERY_SKIP=1 set by caller (no pi binary)" };
			log("T7: SKIPPED via explicit PI_CREW_BATTERY_SKIP=1 (recorded in audit)");
		} else {
			tiers.t7 = "fail";
			t7 = { ok: false, reason: "no `pi` binary and PI_CREW_BATTERY_SKIP is not set — set it with a justification or run on a host with pi" };
			allOk = false;
			fail(t7.reason);
		}
	} else {
		log("T7: live fast-fix smoke (real pi -p) … this takes ~1-3 min");
		t7 = await t7LiveSmoke(scrubCrewEnv(process.env), startMs);
		tiers.t7 = t7.ok ? "pass" : "fail";
		if (!t7.ok) {
			allOk = false;
			fail(`T7 live smoke FAILED: ${t7.reason}`);
		} else {
			log(`T7: PASS (${t7.reason}, runId=${t7.runId})`);
		}
	}

	const entry = {
		ts: new Date().toISOString(),
		version,
		head,
		prevTag,
		changedPaths: paths.length,
		tiers,
		t7: { runId: t7.runId ?? null, reason: t7.reason },
		result: allOk ? "pass" : "fail",
	};
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
	} catch (e) {
		// Audit failure must not silently pass an otherwise-failing gate, but a
		// pass with an unwritable audit dir is still a pass — warn loudly.
		log(`WARN: could not append audit entry: ${e.message}`);
	}
	log(allOk ? `ALL GREEN (${((Date.now() - started) / 1000).toFixed(0)}s) — evidence in .crew/audit/battery.jsonl` : "BATTERY RED — see above");
	process.exit(allOk ? 0 : 1);
}

await main();
