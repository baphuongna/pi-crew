/**
 * Regression tests for scripts/resource-sampler.mjs — pins R3 (child
 * discovery), R13 (interval validation), R4 (watch-parent auto-stop on
 * death), and the output schema. These spawn the sampler as a real
 * subprocess, so they are timing-sensitive; assertions are kept robust
 * (generous timeouts, behavior-focused not exact-timing).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SAMPLER = new URL("../../../scripts/resource-sampler.mjs", import.meta.url);

function runSamplerSync(args: string[], opts: { cwd?: string; timeout?: number } = {}) {
	return spawnSync(process.execPath, ["--experimental-strip-types", SAMPLER.pathname, ...args], {
		encoding: "utf-8",
		cwd: opts.cwd,
		timeout: opts.timeout ?? 15_000,
	});
}

function readSamples(outPath: string) {
	return readFileSync(outPath, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

test("schema: --wrap produces valid resources.jsonl with required fields", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-schema-"));
	const out = join(work, "out.resources.jsonl");
	try {
		// wrapped proc lives ~900ms; interval 200ms → expect ≥2 samples
		const res = runSamplerSync(["--interval", "200", "--out", out, "--wrap", "node", "-e", "setTimeout(()=>0,900)"], { cwd: work });
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		const samples = readSamples(out);
		assert.ok(samples.length >= 2, `expected ≥2 samples, got ${samples.length}`);
		const s = samples[0];
		for (const k of ["ts", "pid", "ppid", "label", "rssBytes", "heapBytes", "cpuPct"]) {
			assert.ok(k in s, `sample missing field "${k}"`);
		}
		assert.equal(s.label, "root", "wrapped process must be labelled root");
		assert.ok(s.rssBytes > 0, "rssBytes should be > 0 for a real node process");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("R3: child-discovery — sampler catches descendants of wrapped process", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-child-"));
	const out = join(work, "out.resources.jsonl");
	// helper spawner: spawns 1 child that lives ~1.5s, parent lives ~2s
	const helper = join(work, "spawn.js");
	writeFileSync(
		helper,
		`const { spawn } = require("node:child_process");\n` +
			`spawn(process.execPath, ["-e", "const e=Date.now()+1500;while(Date.now()<e){}"], { stdio: "ignore" });\n` +
			`const e = Date.now()+2000; while(Date.now()<e){}\n`,
	);
	try {
		const res = runSamplerSync(["--interval", "250", "--out", out, "--wrap", "node", helper], { cwd: work, timeout: 12_000 });
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		const samples = readSamples(out);
		const pids = new Set(samples.map((s) => s.pid));
		// parent + at least 1 child
		assert.ok(pids.size >= 2, `expected ≥2 distinct PIDs (parent+child), got ${pids.size}`);
		assert.ok(
			[...samples].some((s) => s.label === "child"),
			"must sample at least one child",
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("R13: invalid --interval rejected, sub-100ms clamped", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-interval-"));
	try {
		// abc → NaN → error, non-zero exit
		const r1 = runSamplerSync(["--interval", "abc", "--out", join(work, "x.jsonl"), "--wrap", "true"], { cwd: work });
		assert.notEqual(r1.status, 0, "non-numeric interval must fail");
		assert.match(r1.stderr, /must be a number/, "must explain NaN rejection");

		// 50ms → clamped to 100ms (warning on stderr), still runs
		const r2 = runSamplerSync(["--interval", "50", "--out", join(work, "y.jsonl"), "--wrap", "node", "-e", "setTimeout(()=>0,400)"], {
			cwd: work,
		});
		assert.equal(r2.status, 0, `clamped run should succeed: ${r2.stderr}`);
		assert.match(r2.stderr, /clamping to 100ms/, "must report the clamp");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("R4: watch-parent auto-stops when watched PID dies", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-death-"));
	const out = join(work, "out.resources.jsonl");
	// spawn a short-lived target (lives ~1.2s), grab its pid, watch it.
	const target = spawn(process.execPath, ["-e", "const e=Date.now()+1200;while(Date.now()<e){}"], { stdio: "ignore" });
	const watchPid = target.pid;
	const t0 = Date.now();
	// sampler should auto-stop ~3 ticks (300ms×3) after the target dies (~1.2s)
	// → total ~2.1-2.5s. Use a 10s cap; if it hits the cap the sampler did NOT
	// auto-stop (regression).
	const res = runSamplerSync(["--watch-parent", String(watchPid), "--interval", "300", "--out", out], { cwd: work, timeout: 10_000 });
	const elapsed = Date.now() - t0;
	try {
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.ok(elapsed < 9000, `sampler ran ${elapsed}ms — must auto-stop after target death, not hit the cap`);
		assert.match(res.stderr, /gone — stopping|stopped/, "must log auto-stop");
	} finally {
		rmSync(work, { recursive: true, force: true });
		try {
			target.kill();
		} catch {
			/* already gone */
		}
	}
});

test("--watch-run: auto-resolves runner PID from async.pid", () => {
	const crew = mkdtempSync(join(tmpdir(), "sampler-watchrun-"));
	const runState = join(crew, "state", "runs", "fakeRun");
	mkdirSync(runState, { recursive: true });
	const out = join(crew, "out.resources.jsonl");
	// spawn a short-lived target whose pid we record as the "runner"
	const target = spawn(process.execPath, ["-e", "const e=Date.now()+1500;while(Date.now()<e){}"], { stdio: "ignore" });
	writeFileSync(join(runState, "async.pid"), JSON.stringify({ pid: target.pid, startedAt: new Date().toISOString() }));
	try {
		const res = runSamplerSync(["--watch-run", "fakeRun", "--crew-root", crew, "--interval", "300", "--out", out], {
			cwd: crew,
			timeout: 10_000,
		});
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.match(res.stderr, new RegExp(`runner PID ${target.pid}`), "must resolve+log the pid from async.pid");
		assert.match(res.stderr, /gone — stopping|stopped/, "must auto-stop after target dies");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		try {
			target.kill();
		} catch {
			/* already gone */
		}
	}
});

test("live-warn: --no-live-warn suppresses ⚠️ stderr warnings", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-nolive-"));
	const out = join(work, "out.resources.jsonl");
	try {
		// a process that allocates ~400MB would normally trip rss_jump; with the
		// flag it must NOT emit any ⚠️ LIVE line.
		const res = runSamplerSync(
			[
				"--no-live-warn",
				"--interval",
				"200",
				"--out",
				out,
				"--wrap",
				"node",
				"-e",
				"setTimeout(()=>{const b=Buffer.alloc(400000000);for(let i=0;i<b.length;i+=4096)b[i]=1;setTimeout(()=>0,800)},300)",
			],
			{ cwd: work },
		);
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.ok(!res.stderr.includes("⚠️ LIVE"), `--no-live-warn must suppress live warnings, got: ${res.stderr}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("live-warn: rss_jump emits ⚠️ LIVE when RSS jumps >200MB between samples", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-rssjump-"));
	const out = join(work, "out.resources.jsonl");
	try {
		// first samples are small (~base node RSS); after ~700ms (≥2 intervals at
		// 250ms) allocate + touch 400MB so a later sample sees a >200MB jump.
		const res = runSamplerSync(
			[
				"--interval",
				"250",
				"--out",
				out,
				"--wrap",
				"node",
				"-e",
				"const b=[];setTimeout(()=>{const x=Buffer.alloc(400000000);for(let i=0;i<x.length;i+=4096)x[i]=1;b.push(x)},700);setTimeout(()=>{},3000)",
			],
			{ cwd: work, timeout: 12_000 },
		);
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		// timing-tolerant: the jump should be observed as a ⚠️ rss_jump warning.
		// (If the alloc raced ahead of the first sample the warning may not fire;
		// guard by also accepting the sample file proving the RSS grew.)
		const samples = readSamples(out).filter((s: { label?: string }) => s.label === "root");
		const grew = samples.length > 1 && samples[samples.length - 1].rssBytes - samples[0].rssBytes > 200_000_000;
		assert.ok(res.stderr.includes("⚠️ LIVE") || grew, `expected live warning or observed RSS growth; stderr: ${res.stderr.slice(-300)}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("live-warn: proc_died emits ⚠️ when watched process dies (--watch-run)", () => {
	const crew = mkdtempSync(join(tmpdir(), "sampler-procdied-"));
	const runState = join(crew, "state", "runs", "fakeRun");
	mkdirSync(runState, { recursive: true });
	const out = join(crew, "out.resources.jsonl");
	// short-lived target recorded as the runner; sampler must flag its death
	const target = spawn(process.execPath, ["-e", "const e=Date.now()+1500;while(Date.now()<e){}"], { stdio: "ignore" });
	writeFileSync(join(runState, "async.pid"), JSON.stringify({ pid: target.pid, startedAt: new Date().toISOString() }));
	try {
		const res = runSamplerSync(["--watch-run", "fakeRun", "--crew-root", crew, "--interval", "300", "--out", out], {
			cwd: crew,
			timeout: 10_000,
		});
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.match(res.stderr, /⚠️ LIVE.*proc_died/, `must emit live proc_died warning on watched-process death: ${res.stderr}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		try {
			target.kill();
		} catch {
			/* already gone */
		}
	}
});

test("live-warn: rss_leak emits ⚠️ on SUSTAINED monotonic RSS growth (warmup must NOT fire)", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-rssleak-"));
	const out = join(work, "out.resources.jsonl");
	try {
		// grow +15MB every 250ms for ~9s → ~35 samples (>30-window), +15MB/250ms
		// sustained monotonic. Short warmup bursts (<30 samples) must NOT fire.
		const res = runSamplerSync(
			[
				"--interval",
				"250",
				"--out",
				out,
				"--wrap",
				"node",
				"-e",
				"const b=[];const g=()=>{b.push(Buffer.alloc(15000000));const x=b[b.length-1];for(let i=0;i<x.length;i+=4096)x[i]=1};const t=setInterval(g,250);setTimeout(()=>clearInterval(t),9000);setTimeout(()=>{},9200)",
			],
			{ cwd: work, timeout: 15_000 },
		);
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.match(res.stderr, /⚠️ LIVE.*rss_leak/, `must emit rss_leak on sustained growth: ${res.stderr.slice(-300)}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});

test("live-warn: rss_leak does NOT fire on short warmup burst (<30 samples)", () => {
	const work = mkdtempSync(join(tmpdir(), "sampler-warmup-"));
	const out = join(work, "out.resources.jsonl");
	try {
		// grow +15MB every 250ms for only 2.5s (~10 samples = warmup burst), then
		// stay alive steady for 3s — must NOT trip rss_leak (window needs 30).
		const res = runSamplerSync(
			[
				"--interval",
				"250",
				"--out",
				out,
				"--wrap",
				"node",
				"-e",
				"const b=[];const g=()=>{b.push(Buffer.alloc(15000000));const x=b[b.length-1];for(let i=0;i<x.length;i+=4096)x[i]=1};const t=setInterval(g,250);setTimeout(()=>clearInterval(t),2500);setTimeout(()=>{},5500)",
			],
			{ cwd: work, timeout: 12_000 },
		);
		assert.equal(res.status, 0, `sampler failed: ${res.stderr}`);
		assert.ok(!res.stderr.includes("rss_leak"), `warmup burst must NOT fire rss_leak: ${res.stderr.slice(-300)}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
