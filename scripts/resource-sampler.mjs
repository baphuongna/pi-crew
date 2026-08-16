/**
 * pi-crew resource sampler — external process monitor.
 *
 * Samples RSS / heap / CPU% for a PID and all its descendants, writing one
 * JSONL line per PID per tick. Runs as a standalone external process so it
 * works regardless of pi-crew's bundle/runtime (no src/ instrumentation).
 *
 * Modes:
 *   --watch-parent <pid> [--run-id <id>] [--interval 2000] [--out <path>]
 *       Polls <pid> + children until SIGINT/SIGTERM.
 *   --wrap <cmd...> [--run-id <id>] [--interval 2000] [--out <path>]
 *       Spawns <cmd>, samples it + children until exit, exits with child code.
 *
 * Output JSONL line: {ts,pid,ppid,label,rssBytes,heapBytes,cpuPct}
 *
 * Linux path uses /proc; non-Linux falls back to `ps -o rss=,pcpu=`.
 *
 * Run: node scripts/resource-sampler.mjs --wrap pi --version
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------- CLI parsing ----------
// Known options may appear ANYWHERE (before or after --wrap). Everything
// after --wrap that is NOT a known option becomes the wrapped command.
const KNOWN_FLAGS = new Set(["--watch-parent", "--watch-run", "--crew-root", "--wrap", "--interval", "--run-id", "--out", "--no-live-warn", "-h", "--help"]);

function parseArgs(argv) {
	const args = { interval: 2000, mode: null, parentPid: null, wrap: [], runId: null, out: null, watchRun: null, crewRoot: null, liveWarn: true };
	let wrapStarted = false;
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		// Once --wrap is seen, collect non-flag tokens as the command. A known
		// flag is still parsed as an option (so `--wrap sleep 5 --interval 500`
		// works), but an unknown token is treated as part of the command.
		if (wrapStarted && !KNOWN_FLAGS.has(a)) {
			args.wrap.push(a);
			continue;
		}
		if (a === "--watch-parent") {
			args.mode = "watch";
			args.parentPid = Number.parseInt(argv[++i], 10);
		} else if (a === "--watch-run") {
			// auto-resolve the run's leader/runner PID from pi-crew state (no manual
			// pgrep). Reads async.pid / manifest.async.pid / heartbeat.json.
			args.mode = "watch";
			args.watchRun = argv[++i];
			if (!args.runId) args.runId = args.watchRun;
		} else if (a === "--crew-root") {
			args.crewRoot = argv[++i];
		} else if (a === "--wrap") {
			args.mode = "wrap";
			wrapStarted = true;
		} else if (a === "--interval") {
			// R13 (audit): reject NaN and clamp tiny intervals — setInterval(fn, 0)
			// or setInterval(fn, NaN) spins ~60-130×/s, writing huge files and
			// burning CPU (each tick also scans all of /proc).
			const raw = argv[++i];
			const parsed = Number.parseInt(raw, 10);
			if (Number.isNaN(parsed)) {
				process.stderr.write(`Error: --interval must be a number (ms), got "${raw}"\n`);
				process.exit(1);
			}
			if (parsed < 100) {
				process.stderr.write(`[resource-sampler] --interval ${parsed}ms < 100ms; clamping to 100ms\n`);
				args.interval = 100;
			} else {
				args.interval = parsed;
			}
		} else if (a === "--run-id") {
			args.runId = argv[++i];
		} else if (a === "--out") {
			args.out = argv[++i];
		} else if (a === "--no-live-warn") {
			args.liveWarn = false;
		} else if (a === "-h" || a === "--help") {
			printHelp();
			process.exit(0);
		} else if (wrapStarted) {
			// unknown token after --wrap → part of the command
			args.wrap.push(a);
		}
	}
	if (!args.mode) {
		printHelp();
		process.exit(1);
	}
	return args;
}

function printHelp() {
	process.stderr.write(
		[
			"Usage:",
			"  resource-sampler.mjs --watch-parent <pid> [--run-id <id>] [--interval 2000] [--out <path>]",
			"  resource-sampler.mjs --wrap <cmd...> [--run-id <id>] [--interval 2000] [--out <path>]",
			"",
		].join("\n"),
	);
}

// ---------- /proc readers (Linux) ----------
const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) on essentially all Linux/x86/arm

function readProcStat(pid) {
	// /proc/<pid>/stat — comm (field 2) may contain spaces inside parens.
	let raw;
	try {
		raw = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const open = raw.indexOf("(");
	const close = raw.lastIndexOf(")");
	if (open < 0 || close < 0) return null;
	const comm = raw.slice(open + 1, close);
	const rest = raw.slice(close + 2).trim().split(/\s+/);
	// rest[0] = field3 (state), rest[1] = field4 (ppid), rest[11] = utime(f14), rest[12] = stime(f15), rest[19] = starttime(f22)
	return {
		pid,
		comm,
		state: rest[0],
		ppid: Number.parseInt(rest[1], 10) || 0,
		utime: Number.parseInt(rest[11], 10) || 0,
		stime: Number.parseInt(rest[12], 10) || 0,
		starttime: Number.parseInt(rest[19], 10) || 0,
	};
}

function readProcStatus(pid) {
	let raw;
	try {
		raw = readFileSync(`/proc/${pid}/status`, "utf8");
	} catch {
		return null;
	}
	let rssKb = 0;
	let dataKb = 0;
	for (const line of raw.split("\n")) {
		if (line.startsWith("VmRSS:")) rssKb = Number.parseInt(line.slice(6).trim(), 10) || 0;
		else if (line.startsWith("VmData:")) dataKb = Number.parseInt(line.slice(7).trim(), 10) || 0;
	}
	return { rssKb, dataKb };
}

// ---------- fallback via ps (non-Linux) ----------
function readPs(pid) {
	const res = spawnSync("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], { encoding: "utf8" });
	if (res.status !== 0 || !res.stdout.trim()) return null;
	const parts = res.stdout.trim().split(/\s+/);
	return {
		pid,
		ppid: 0,
		rssKb: Number.parseInt(parts[0], 10) || 0,
		dataKb: 0,
		cpuPct: Number.parseFloat(parts[1]) || 0,
		ps: true,
	};
}

// ---------- child discovery ----------
function findDescendants(rootPid) {
	// BFS over /proc to find all PIDs whose ppid chain leads to rootPid.
	if (!existsSync("/proc")) return [rootPid];
	const all = [];
	try {
		for (const name of readdirSync("/proc")) {
			if (/^\d+$/.test(name)) all.push(Number.parseInt(name, 10));
		}
	} catch {
		return [rootPid];
	}
	const ppidOf = new Map();
	for (const pid of all) {
		const s = readProcStat(pid);
		if (s) ppidOf.set(pid, s.ppid);
	}
	const result = new Set([rootPid]);
	let frontier = [rootPid];
	while (frontier.length) {
		const next = [];
		for (const [pid, ppid] of ppidOf) {
			if (result.has(ppid) && !result.has(pid)) {
				result.add(pid);
				next.push(pid);
			}
		}
		frontier = next;
	}
	return [...result];
}

// ---------- sampling ----------
const cpuPrev = new Map(); // pid -> {ticks, ts}

// ---- live anomaly warnings (stderr, rate-limited) ----
// Emitted DURING sampling so the user sees resource anomalies in real time,
// not only in the post-hoc analyze-run report. Rate-limited per (pid,category)
// so a sustained spike doesn't spam every tick.
const rssPrev = new Map(); // pid -> { rss, ts } (for one-interval RSS jump)
const rssHist = new Map(); // pid -> number[] (recent rssBytes, for slow-leak trend)
const warnCooldown = new Map(); // `${pid}:${cat}` -> last emit ts
const LIVE_CPU_PCT = 300; // single-process CPU% (multi-core: 300% = 3 cores)
const LIVE_RSS_JUMP = 200_000_000; // +200MB in one interval (fast spike)
const LIVE_RSS_HIGH = 1_000_000_000; // 1GB absolute
const LIVE_LEAK_WINDOW = 30; // samples to evaluate slow-leak trend (30s at 1s interval)
const LIVE_LEAK_GROWTH = 100_000_000; // +100MB net over the window = leak
const LIVE_LEAK_MONOTONIC = 0.75; // ≥75% of pairs increasing = monotonic-ish
const WARN_COOLDOWN_MS = 10_000;
let liveWarnEnabled = true;
function liveWarn(pid, label, cat, msg) {
	if (!liveWarnEnabled) return;
	const key = `${pid}:${cat}`;
	const now = Date.now();
	if (now - (warnCooldown.get(key) || 0) < WARN_COOLDOWN_MS) return;
	warnCooldown.set(key, now);
	process.stderr.write(`[resource-sampler] ⚠️ LIVE ${new Date(now).toISOString().slice(11, 19)} ${cat} pid=${pid}${label ? ` (${label})` : ""}: ${msg}\n`);
}

function samplePid(pid, rootPid) {
	// Linux /proc path
	if (existsSync(`/proc/${pid}/stat`)) {
		const stat = readProcStat(pid);
		const status = readProcStatus(pid);
		if (!stat) return null;
		const now = Date.now();
		const ticks = stat.utime + stat.stime;
		let cpuPct = 0;
		const prev = cpuPrev.get(pid);
		// firstSample: no usable baseline yet (first-ever sample OR PID reused).
		// cpuPct is 0 here by construction — consumers should exclude it from CPU
		// averages so short-lived subagents aren't dragged down by the first tick.
		const firstSample = !prev || prev.starttime !== stat.starttime;
		// PID-reuse guard: if starttime changed, a NEW process recycled this PID
		// (common under respawn churn) — the old cpuPrev ticks are stale and would
		// underreport. Treat as a first sample (cpuPct=0) and reset the baseline.
		if (!firstSample) {
			const dtick = ticks - prev.ticks;
			const dsec = (now - prev.ts) / 1000;
			if (dsec > 0) cpuPct = (dtick / CLK_TCK / dsec) * 100;
		}
		cpuPrev.set(pid, { ticks, ts: now, starttime: stat.starttime });
		return {
			ts: now,
			pid,
			ppid: stat.ppid,
			label: pid === rootPid ? "root" : "child",
			rssBytes: status ? status.rssKb * 1024 : 0,
			heapBytes: status ? status.dataKb * 1024 : 0,
			cpuPct: Math.max(0, Math.round(cpuPct * 10) / 10),
			firstSample,
		};
	}
	// fallback: ps
	const ps = readPs(pid);
	if (!ps) return null;
	return {
		ts: Date.now(),
		pid,
		ppid: ps.ppid,
		label: pid === rootPid ? "root" : "child",
		rssBytes: ps.rssKb * 1024,
		heapBytes: 0,
		cpuPct: Math.round(ps.cpuPct * 10) / 10,
	};
}

function tick(rootPid, outPath) {
	const pids = findDescendants(rootPid);
	const seen = new Set(pids);
	for (const pid of pids) {
		const sample = samplePid(pid, rootPid);
		if (sample) {
			appendFileSync(outPath, JSON.stringify(sample) + "\n");
			// live anomaly checks (rate-limited, stderr) — real-time observability
			// zombie/dead child still in /proc (parent not reaping) — flag it live
			if (pid !== rootPid && !isAlive(pid)) liveWarn(pid, sample.label, "proc_zombie", "process zombie/dead (state Z/X) — parent not reaping child");
			if (sample.cpuPct >= LIVE_CPU_PCT) liveWarn(pid, sample.label, "high_cpu", `CPU ${sample.cpuPct}% (≥${LIVE_CPU_PCT}%)`);
			const rp = rssPrev.get(pid);
			if (rp) {
				const jump = sample.rssBytes - rp.rss;
				if (jump >= LIVE_RSS_JUMP) liveWarn(pid, sample.label, "rss_jump", `RSS +${(jump / 1024 / 1024).toFixed(0)}MB (${(rp.rss / 1024 / 1024).toFixed(0)}→${(sample.rssBytes / 1024 / 1024).toFixed(0)}MB) in one interval`);
			}
			rssPrev.set(pid, { rss: sample.rssBytes, ts: sample.ts });
			if (sample.rssBytes >= LIVE_RSS_HIGH) liveWarn(pid, sample.label, "rss_high", `RSS ${(sample.rssBytes / 1024 / 1024).toFixed(0)}MB (≥1GB)`);
			// slow-leak trend: gradual monotonic growth that no single-interval jump
			// catches (e.g. +5MB/interval × 50). LONG window (30 samples) so warmup
			// growth (V8 heap fill ~10-15s then plateau) does NOT fire — only
			// SUSTAINED growth (30s+) is a leak signal. Validated on real e2e data:
			// subagent warmup plateaus (no fire), long-lived session growth fires.
			const h = rssHist.get(pid) || [];
			h.push(sample.rssBytes);
			if (h.length > LIVE_LEAK_WINDOW) h.shift();
			rssHist.set(pid, h);
			if (h.length >= LIVE_LEAK_WINDOW) {
				const growth = h[h.length - 1] - h[0];
				let inc = 0;
				for (let i = 1; i < h.length; i++) if (h[i] > h[i - 1]) inc++;
				if (growth >= LIVE_LEAK_GROWTH && inc / (h.length - 1) >= LIVE_LEAK_MONOTONIC) {
					liveWarn(pid, sample.label, "rss_leak", `slow RSS leak +${(growth / 1024 / 1024).toFixed(0)}MB over ${h.length} samples (${(h[0] / 1024 / 1024).toFixed(0)}→${(h[h.length - 1] / 1024 / 1024).toFixed(0)}MB, monotonic) — possible memory leak`);
				}
			}
		} else {
			rssPrev.delete(pid);
			rssHist.delete(pid);
		}
	}
	// F4 (audit): prune cpuPrev entries for PIDs no longer alive — prevents the
	// Map from accumulating stale entries for short-lived children over a long
	// sampling session.
	for (const pid of cpuPrev.keys()) {
		if (!seen.has(pid)) {
			cpuPrev.delete(pid);
			rssPrev.delete(pid);
			rssHist.delete(pid);
		}
	}
	// prune warnCooldown for gone PIDs (keep rootPid entry)
	for (const key of warnCooldown.keys()) {
		const pid = Number(key.split(":")[0]);
		if (!seen.has(pid) && pid !== rootPid) warnCooldown.delete(key);
	}
}

// R4/sampler-test (audit): robust liveness — a process that exited but whose
// parent can't reap it yet is a ZOMBIE, and /proc/<pid>/stat still exists for
// zombies. Checking only file existence would never detect death in that
// case. Treat state 'Z' (zombie) and 'X' (dead) as not-alive.
function isAlive(pid) {
	if (existsSync("/proc")) {
		const stat = readProcStat(pid);
		if (!stat) return false;
		return stat.state !== "Z" && stat.state !== "X";
	}
	return readPs(pid) != null;
}
// Resolve a run's leader/runner PID from pi-crew state. Tries async.pid (a
// dedicated JSON file), manifest.async.pid, and heartbeat.json.pid. Polls
// briefly (the file may not exist the instant the run starts).
function resolveRunnerPid(runDir) {
	const readJsonSafe = (p) => {
		try {
			return JSON.parse(readFileSync(p, "utf8"));
		} catch {
			return null;
		}
	};
	for (let i = 0; i < 20; i++) {
		const asyncPid = readJsonSafe(join(runDir, "async.pid"));
		if (asyncPid && typeof asyncPid.pid === "number") return asyncPid.pid;
		const manifest = readJsonSafe(join(runDir, "manifest.json"));
		if (manifest && manifest.async && typeof manifest.async.pid === "number") return manifest.async.pid;
		const hb = readJsonSafe(join(runDir, "heartbeat.json"));
		if (hb && typeof hb.pid === "number") return hb.pid;
		// R7 (audit): block-wait instead of spawning a throwaway node process
		// every poll. Atomics.wait on the main thread is permitted in Node.
		const waitBuf = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(waitBuf, 0, 0, 500);
	}
	return null;
}
function main() {
	const args = parseArgs(process.argv);
	liveWarnEnabled = args.liveWarn;
	const outDir = join(process.cwd(), "bench", "results");
	mkdirSync(outDir, { recursive: true });
	const outFile =
		args.out ||
		join(outDir, `${args.runId || "wrap-" + Date.now()}.resources.jsonl`);
	process.stderr.write(`[resource-sampler] writing → ${outFile}\n`);

	if (args.mode === "wrap") {
		if (args.wrap.length === 0) {
			process.stderr.write("--wrap requires a command\n");
			process.exit(1);
		}
		const child = spawn(args.wrap[0], args.wrap.slice(1), { stdio: "inherit" });
		const rootPid = child.pid;
		let exited = false;
		// sample immediately, then on interval
		tick(rootPid, outFile);
		const handle = setInterval(() => tick(rootPid, outFile), args.interval);
		const cleanup = () => {
			clearInterval(handle);
			// F3 (audit): kill the wrapped child so it is not orphaned when the
			// sampler is signalled (SIGINT/SIGTERM). tryKill is best-effort.
			try {
				if (!exited) child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		};
		process.on("SIGINT", () => {
			cleanup();
			process.exit(130);
		});
		process.on("SIGTERM", () => {
			cleanup();
			process.exit(143);
		});
		child.on("exit", (code, signal) => {
			exited = true;
			clearInterval(handle);
			// final sample
			tick(rootPid, outFile);
			process.stderr.write(`[resource-sampler] child exited code=${code} signal=${signal}\n`);
			process.exit(code ?? 1);
		});
	} else {
		// watch-parent (or --watch-run, which resolves the runner PID from state)
		let rootPid = args.parentPid;
		if (args.watchRun) {
			const crew = args.crewRoot || join(process.env.HOME || "/home/bom", ".crew");
			const runDir = join(crew, "state", "runs", args.watchRun);
			rootPid = resolveRunnerPid(runDir);
			if (!rootPid) {
				process.stderr.write(`--watch-run: could not resolve runner PID for ${args.watchRun} in ${runDir} (async.pid / manifest.async.pid / heartbeat.json)\n`);
				process.exit(1);
			}
			process.stderr.write(`[resource-sampler] --watch-run ${args.watchRun} → runner PID ${rootPid}\n`);
		}
		if (!rootPid) {
			process.stderr.write("--watch-parent requires a PID\n");
			process.exit(1);
		}
		// R4 (audit): auto-stop when the watched tree dies. Previously the sampler
		// kept ticking forever (writing nothing) after rootPid exited, until the
		// user remembered to Ctrl-C. Now: if rootPid is not alive for 3
		// consecutive ticks, stop cleanly. rootPid (the team leader) outlives the
		// whole run, so its death = run over.
		// PLUS (perf-obs): in --watch-run mode the runner PID may be the
		// long-lived foreground pi process (sync runs) — it stays alive after the
		// run, so ALSO stop when the run's manifest.json reaches a terminal
		// status (completed/failed/cancelled/blocked).
		const runDir = args.watchRun ? join(args.crewRoot || join(process.env.HOME || "/home/bom", ".crew"), "state", "runs", args.watchRun) : null;
		const runIsTerminal = () => {
			if (!runDir) return false;
			try {
				const m = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
				return ["completed", "failed", "cancelled", "blocked"].includes(m.status);
			} catch {
				return false;
			}
		};
		let deadTicks = 0;
		const tickWatch = () => {
			const alive = isAlive(rootPid);
			if (alive) {
				deadTicks = 0;
				if (runIsTerminal()) {
					if (handle) clearInterval(handle);
					process.stderr.write(`[resource-sampler] run ${args.watchRun} reached terminal status — stopping\n`);
					process.exit(0);
				}
				tick(rootPid, outFile);
			} else {
				deadTicks++;
				if (deadTicks === 1) liveWarn(rootPid, "root", "proc_died", `watched PID ${rootPid} no longer alive`);
				if (deadTicks >= 3) {
					clearInterval(handle);
					process.stderr.write(`[resource-sampler] watched PID ${rootPid} gone — stopping\n`);
					process.exit(0);
				}
			}
		};
		let handle;
		tickWatch();
		handle = setInterval(tickWatch, args.interval);
		const shutdown = () => {
			clearInterval(handle);
			tick(rootPid, outFile);
			process.stderr.write("[resource-sampler] stopped\n");
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}
}

main();
