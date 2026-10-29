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
 *   - a run.completed event for the run created by THIS dispatch. The goal
 *     carries a per-invocation nonce (`[t7-nonce:<uuid>]`); only run dirs
 *     whose events.jsonl contain that nonce are judged, so a concurrent run
 *     (another crew, another terminal) can never be judged in its place.
 *   - ZERO occurrences of the v0.11.46 silent-death fingerprint
 *     ("empty-or-stderr-only-result") anywhere in that run's events
 *   - a NON-TERMINAL run (no run.completed/run.failed) is a FAIL — checked
 *     BEFORE the killed/hung diagnosis so it can never be shadowed. On any
 *     fail a capped tail of the dispatch's own stdout/stderr is recorded in
 *     the failure reason and the audit entry (the 0.11.46 class death was
 *     silent in production logs).
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
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_DIR = path.join(REPO, ".crew", "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "battery.jsonl");
const RUNS_DIR = path.join(REPO, ".crew", "state", "runs");

/** Paths whose changes require the live smoke (T7) — mirrors the
 * real-test-pi-crew decision table's spawn-affecting rows, plus (2026-10-28
 * cold-verify gap closure) the durable-state / workflow-engine src/ subtrees
 * and scripts/ itself: gate changes must live-test the gate (the nonce-binding
 * commit deliberately triggers T7 on its own pre-push). */
export const T7_TRIGGERS = [
	/^src\/runtime\//,
	/^src\/prompt\//,
	/^src\/config\//,
	/^src\/extension\//,
	/^src\/schema\//,
	/^src\/ui\//,
	/^src\/(state|utils|agents|teams|workflows|hooks|observability)\//,
	/^dist\//,
	/^workflows\//,
	/^agents\//,
	/^scripts\//,
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

// git C-quote escapes (quote.c cq_lookup): \a \b \t \n \v \f \r; everything
// else non-printable/non-ASCII plus '"' and '\\' becomes \NNN 3-digit octal.
const C_QUOTE_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Decode one git path from C-quoted output form back to the true path string.
 * Exported pure so the trigger-matching unit test can pin the exact forms git
 * emits (see test/unit/scripts/pre-publish-battery-changed-paths.test.ts).
 *
 * git C-quotes a path (wraps it in double quotes and escapes bytes) whenever
 * the name contains non-ASCII bytes (core.quotePath=true, the git default),
 * control characters, an embedded double quote or a backslash — in BOTH
 * `git diff --name-only` and `git status --porcelain` output. The battery's
 * anchored T7 regexes cannot match a string starting with '"', so a raw
 * quoted entry silently un-triggered the live smoke (audit w8:
 * quoted-path-trigger-blindness). Note that even with `-c core.quotePath=false`
 * names containing literal '"' or '\\' REMAIN quoted — so every entry is
 * decoded, not only the non-ASCII ones.
 *
 * Octal escapes are byte-buffered and the result is UTF-8-decoded, so
 * "src/runtime/h\303\240ck.ts" decodes to "src/runtime/hàck.ts" (0xC3 0xA0),
 * not to mojibake code units. A non-quoted input is returned verbatim.
 * Returns null for a malformed or unknown-escape form — callers must fail
 * CLOSED on null (never treat it as a matchable path).
 */
export function unquoteGitPath(p) {
	if (!p.startsWith('"')) return p;
	if (p.length < 2 || !p.endsWith('"')) return null;
	const body = p.slice(1, -1);
	const bytes = [];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch !== "\\") {
			for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
			continue;
		}
		const rest = body.slice(i + 1);
		const oct = /^([0-7]{3})/.exec(rest);
		if (oct) {
			bytes.push(Number.parseInt(oct[1], 8) & 0xff);
			i += 3;
			continue;
		}
		const next = rest[0];
		if (next in C_QUOTE_ESCAPES) {
			bytes.push(C_QUOTE_ESCAPES[next]);
		} else if (next === '"' || next === "\\") {
			bytes.push(next.charCodeAt(0));
		} else {
			return null; // unknown escape — undecodable, caller fails closed
		}
		i += 1;
	}
	return Buffer.from(bytes).toString("utf8");
}

/** All paths changed since the previous tag PLUS uncommitted work — quoting-
 * agnostic: every git-emitted entry is decoded to its true name before it can
 * influence the T7 trigger decision (see unquoteGitPath). */
function changedPaths() {
	const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
	const tags = run("git", ["tag", "--sort=-creatordate"])
		.stdout.split("\n")
		.filter(Boolean)
		// Only release-shaped tags (vX.Y.Z) are valid diff bases — any other tag
		// (marker/tmp tags) would shrink the diff window to a near-empty set and
		// silently un-trigger T7. No matching tag at all → conservative trigger
		// (see the no-prevTag branch below).
		.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
	let prevTag;
	for (const t of tags) {
		const sha = run("git", ["rev-list", "-1", t]).stdout.trim();
		if (sha !== head) {
			prevTag = t;
			break;
		}
	}
	const paths = new Set();
	// Quoting-agnostic trigger set (audit w8: quoted-path-trigger-blindness).
	// Two layers: pin core.quotePath=false on the git calls (mirrors
	// src/worktree/worktree-manager.ts:1015) AND decode every entry through
	// unquoteGitPath. A quoted entry that still cannot be decoded (malformed
	// form — git never emits it today) fails CLOSED: force the live smoke via
	// the same conservative fallback as the no-prevTag branch below, rather
	// than silently skipping a gate we cannot reason about.
	const addGitPath = (raw) => {
		const p = unquoteGitPath(raw);
		if (p === null) {
			T7_TRIGGERS.forEach(() => paths.add("src/runtime/"));
			return;
		}
		if (p) paths.add(p);
	};
	if (prevTag) {
		for (const f of run("git", ["-c", "core.quotePath=false", "diff", "--name-only", `${prevTag}..HEAD`]).stdout.split("\n")) {
			if (f.trim()) addGitPath(f.trim());
		}
	} else {
		// No previous tag found (fresh repo shape): be conservative, trigger T7.
		T7_TRIGGERS.forEach(() => paths.add("src/runtime/"));
	}
	const status = run("git", ["-c", "core.quotePath=false", "status", "--porcelain"]).stdout;
	for (const line of status.split("\n")) {
		const entry = line.slice(3).trim();
		if (!entry) continue;
		if (entry.includes(" -> ")) {
			// Staged rename "R  old -> new": BOTH sides are changed paths. Plain
			// slice(3) would keep "old -> new" as one mangled path that matches
			// no trigger pattern — renames would silently un-trigger T7. The old
			// naive quote-strip here kept git's octal escapes in place; both sides
			// now go through the same decoder as every other entry.
			for (const side of entry.split(" -> ")) {
				addGitPath(side.trim());
			}
		} else {
			addGitPath(entry);
		}
	}
	return { prevTag, paths: [...paths] };
}

function piAvailable() {
	const res = run("pi", ["--version"], { timeout: 15_000 });
	return res.code === 0 || /pi\s+\d/i.test(res.stdout);
}

/** Run one REAL pi -p dispatch of a trivial fast-fix team run and judge it
 * from the on-disk run state created after `startMs`. The dispatched goal
 * carries a per-invocation nonce (`[t7-nonce:<uuid>]`); ONLY run dirs whose
 * events.jsonl contain that nonce are judged — a concurrent run (another
 * crew, another terminal) can never be mistaken for the smoke's own run,
 * which was the old candidates[0] newest-mtime race. */
function t7LiveSmoke(cleanEnv, startMs) {
	return new Promise((resolve) => {
		const nonce = `t7-nonce:${randomUUID()}`;
		const prompt =
			'Call the team tool exactly once: action="run" team="fast-fix" workflow="fast-fix" async=false ' +
			`with goal "Reply with exactly one word: OK. Do not run any tests. [${nonce}]" ` +
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
		// The dispatch's own output is the ONLY forensics we get when the smoke
		// dies before creating a run — keep a capped tail of it. NOT debug-gated:
		// the v0.11.46 class death was silent in production logs.
		const CAP = 64 * 1024;
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout = (stdout + String(chunk)).slice(-CAP);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-CAP);
		});
		const tails = () => {
			const tail = (s) => (s.length > 1500 ? `…${s.slice(-1500)}` : s);
			return stdout || stderr ? { stdoutTail: tail(stdout), stderrTail: tail(stderr) } : {};
		};
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, reason: `spawn pi failed: ${e.message}`, runId: undefined, nonce, ...tails() });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			// Judge from disk: run dirs created after battery start, bound to THIS
			// dispatch by the nonce embedded in the goal.
			let candidates = [];
			try {
				candidates = readdirSync(RUNS_DIR)
					.filter((d) => d.startsWith("team_"))
					.map((d) => ({ dir: d, mtime: statSync(path.join(RUNS_DIR, d)).mtimeMs }))
					.filter((c) => c.mtime >= startMs - 60_000)
					.sort((a, b) => b.mtime - a.mtime);
			} catch {
				resolve({ ok: false, reason: `no run dir created — the dispatch never reached team-runner (pi exit ${code})`, runId: undefined, nonce, ...tails() });
				return;
			}
			if (candidates.length === 0) {
				resolve({ ok: false, reason: `no run dir created after battery start (pi exit ${code})`, runId: undefined, nonce, ...tails() });
				return;
			}
			const bound = [];
			for (const c of candidates) {
				try {
					if (readFileSync(path.join(RUNS_DIR, c.dir, "events.jsonl"), "utf8").includes(nonce)) bound.push(c);
				} catch {
					// no / unreadable events.jsonl → cannot contain the nonce → not ours.
				}
			}
			if (bound.length === 0) {
				resolve({
					ok: false,
					reason:
						`dispatch never created a run: no candidate run dir (mtime ≥ battery start−60s) contains the dispatch nonce — ` +
						`the smoke died before team-runner recorded it (pi exit ${code})`,
					runId: undefined,
					nonce,
					...tails(),
				});
				return;
			}
			// Newest nonce-bound dir = this dispatch's run.
			const runId = bound[0].dir;
			const eventsPath = path.join(RUNS_DIR, runId, "events.jsonl");
			let events = "";
			try {
				events = readFileSync(eventsPath, "utf8");
			} catch {
				resolve({ ok: false, reason: `run ${runId} has no events.jsonl`, runId, nonce, ...tails() });
				return;
			}
			if (events.includes("empty-or-stderr-only-result")) {
				resolve({
					ok: false,
					reason: `SILENT-DEATH FINGERPRINT (empty-or-stderr-only-result) present in run ${runId} — this is the v0.11.46 class regression`,
					runId,
					nonce,
					...tails(),
				});
				return;
			}
			const completed = /"type":"run\.completed"/.test(events);
			const failed = /"type":"run\.failed"/.test(events);
			// Terminal-state check FIRST: a non-terminal run is a FAIL no matter what
			// happened to the pi process — the old order let the killed/hung branch
			// shadow the no-terminal diagnosis.
			if (completed && !failed) {
				resolve({ ok: true, reason: "run completed clean", runId, nonce });
			} else if (failed) {
				resolve({ ok: false, reason: `run ${runId} FAILED (see ${eventsPath})`, runId, nonce, ...tails() });
			} else {
				resolve({
					ok: false,
					reason: `run ${runId} has no terminal event (no run.completed/run.failed)${killed ? " — pi process hung >420s and was killed" : ""}`,
					runId,
					nonce,
					...tails(),
				});
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
			// Forensics the caller would otherwise never see (the dispatch's own
			// output was piped, not inherited — zero listeners meant silence).
			if (t7.stdoutTail) log(`T7 dispatch stdout tail:\n${t7.stdoutTail}`);
			if (t7.stderrTail) log(`T7 dispatch stderr tail:\n${t7.stderrTail}`);
		} else {
			log(`T7: PASS (${t7.reason}, runId=${t7.runId})`);
		}
	}

	const t7Entry = { runId: t7.runId ?? null, reason: t7.reason };
	if (t7.nonce) t7Entry.nonce = t7.nonce; // cross-checkable in the run's events.jsonl
	if (t7.stdoutTail) t7Entry.stdoutTail = t7.stdoutTail;
	if (t7.stderrTail) t7Entry.stderrTail = t7.stderrTail;
	const entry = {
		ts: new Date().toISOString(),
		version,
		head,
		prevTag,
		changedPaths: paths.length,
		tiers,
		t7: t7Entry,
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

// CLI main-guard (the scripts/analyze-run.mjs idiom): run the gate ONLY when
// executed directly (.githooks/pre-push and prepublish-ci.mjs spawn this file
// as argv[1]). When imported by the trigger-matching unit test, main() must
// not fire — it spawns real pi sessions and gates publish. pathToFileURL (not
// string manipulation) so relative and absolute invocations match on every
// platform — the hand-built-URL variants are the Windows false-green class
// pinned by test/unit/scripts/main-guard-platform-safety.test.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
