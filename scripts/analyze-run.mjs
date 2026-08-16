#!/usr/bin/env node
/**
 * pi-crew run analyzer — phân tích run THẬT và tô đậm chỗ chậm/lỗi/vấn đề.
 *
 * Usage:
 *   node scripts/analyze-run.mjs <runId> [--crew-root <path>] [--resources <path>]
 *
 * Đọc: events.jsonl (timeline), transcripts/*.jsonl (token/cost/model thật),
 * manifest.json, tasks.json, agents.json. Reads are streamed line-by-line but
 * parsed objects are held in memory (O(file size)) — fine for realistic runs
 * (largest seen: ~1MB transcript). Would need true streaming aggregation for
 * pathological multi-GB runs, which pi-crew does not produce.
 *
 * Output:
 *   docs/perf-report-<runId>.md   — báo cáo tiếng Việt, bảng + 🔴 highlight
 *   bench/results/<runId>.json    — structured JSON
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ---------- CLI ----------
function parseArgs(argv) {
	const args = { runId: null, crewRoot: null, resources: null, events: false, agents: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--crew-root") args.crewRoot = argv[++i];
		else if (a === "--resources") args.resources = argv[++i];
		else if (a === "--events") args.events = true;
		else if (a === "--agents") args.agents = true;
		else if (a === "-h" || a === "--help") {
			process.stderr.write("Usage: analyze-run.mjs <runId> [--crew-root <path>] [--resources <path>] [--events]\n");
			process.exit(0);
		} else if (!a.startsWith("--")) {
			args.runId = a;
		}
	}
	if (!args.runId) {
		process.stderr.write("Error: runId required.\nUsage: analyze-run.mjs <runId> [--crew-root <path>]\n");
		process.exit(1);
	}
	args.crewRoot = args.crewRoot || join(process.env.HOME || "/home/bom", ".crew");
	return args;
}

const ms = (iso) => (iso ? new Date(iso).getTime() : null);
const mb = (b) => `${((b || 0) / 1024 / 1024).toFixed(1)}MB`;
const fmtMs = (n) => {
	if (n == null || Number.isNaN(n)) return "—";
	if (n < 1000) return `${Math.round(n)}ms`;
	const s = n / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${Math.round(s % 60)}s`;
};
const money = (n) => (n ? `$${n.toFixed(4)}` : "$0");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);

// ---------- line-by-line JSONL reader ----------
async function readJsonl(path) {
	const out = [];
	if (!existsSync(path)) return out;
	const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
	for await (const line of rl) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// ---------- per-event timeline (--events) ----------
// Builds a per-event timeline: each event with elapsed-since-run-start, gap
// from the previous event, type, taskId, and (if resource samples are
// available) the owning worker's RSS/CPU nearest to that event's timestamp.
// Note: per-event TOKENS are NOT available — events.jsonl redacts tokens to
// "***" and transcript records carry no timestamp, so only timing + resource
// can be resolved per event (tokens remain per-task totals).
// percentile (0-100) of a numeric array; 0 if empty. Used to contextualize
// peak vs typical-high (p95) for per-subagent resource.
function pctl(values, p) {
	const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
	if (!v.length) return 0;
	const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
	return v[idx];
}

// Detect performance/health anomalies from recorded run data so they can be
// surfaced as ⚠️ warnings in the report. Thresholds are grounded in real
// pi-crew runs (see docs/perf-report-team_20260806114118). Returns a list of
// { severity: 'HIGH'|'MEDIUM'|'LOW', category, subagent, message }.
// Severity guide: HIGH = action needed (failure/stuck/leak/sustained load),
// MEDIUM = investigate (slow phase, big gap, retries), LOW = informational
// (transient spike — real but brief).
function detectAnomalies(subagents, resources, problems, runCtx) {
	const runTerminalType = runCtx?.runTerminalType;
	const wallMs = runCtx?.wallMs;
	const out = [];
	const rsByTask = new Map((resources?.perSubagent || []).map((ps) => [ps.taskId, ps]));
	for (const s of subagents) {
		const tid = s.taskId;
		const ph = s.timeline?.phases || {};
		const rs = rsByTask.get(tid);

		// 1. Task failure / non-clean exit
		if (s.status && s.status !== "completed" && s.status !== "ok") {
			out.push({ severity: "HIGH", category: "task_failed", subagent: tid, message: `subagent exited status="${s.status}" (exitCode=${s.exitCode})${s.error ? ": " + s.error : ""}` });
		} else if (s.exitCode && s.exitCode !== 0) {
			out.push({ severity: "HIGH", category: "task_failed", subagent: tid, message: `non-zero exitCode=${s.exitCode}${s.error ? ": " + s.error : ""}` });
		}

		// 1b. Missing transcript — no transcript means token/cost for this
		// subagent is 0, a potential SILENT undercount of the run total (e.g.
		// worker crashed before writing its transcript). Defensive: grounded runs
		// always have transcripts, so this only fires on the crash edge case.
		if (s.hasTranscript === false && (s.messageEndCount || 0) === 0) {
			out.push({ severity: "MEDIUM", category: "missing_transcript", subagent: tid, message: "no transcript found — token/cost reported as 0 (potential silent undercount if the subagent did real work)" });
		}

		// 2. Model retry / fallback CASCADE — escalate to HIGH when pathological
		// (many attempts / many failed models / long chain). Grounded in a real
		// run that cascaded through 45 models (44 failed) on a 429 rate-limit storm.
		const chain = s.modelAttempts || [];
		const failedModels = chain.filter((m) => m && m.success === false);
		const uniqModels = [...new Set(chain.map((m) => m.model || "?"))];
		if ((s.attempts || 1) > 1 || chain.length > 1 || failedModels.length) {
			const pathological = (s.attempts || 1) > 5 || failedModels.length > 3 || uniqModels.length > 5;
			const sev = pathological ? "HIGH" : "MEDIUM";
			// truncate the chain so a 45-model cascade doesn't bloat the report
			const shown = uniqModels.length <= 4 ? uniqModels.join(" → ") : `${uniqModels.slice(0, 2).join(" → ")} → … → ${uniqModels[uniqModels.length - 1]} (+${uniqModels.length - 3} more)`;
			out.push({ severity: sev, category: pathological ? "model_cascade" : "model_retry", subagent: tid, message: `model retry/fallback: ${s.attempts} attempt(s), ${uniqModels.length} model(s) [${shown}]${failedModels.length ? ` (${failedModels.length} failed)` : ""}` });
		}

		// 3. Large inter-event gap (single turn/tool stalled)
		const gapMs = s.timeline?.maxGap || 0;
		if (gapMs > 15000) {
			out.push({ severity: "MEDIUM", category: "large_gap", subagent: tid, message: `single event-gap of ${(gapMs / 1000).toFixed(1)}s (>15s) — an LLM turn or tool stalled` });
		}

		// 4. Slow phase
		const slowPhase = ["activeWork", "total", "startup"].find((p) => (ph[p] || 0) > (p === "startup" ? 5000 : 40000));
		if (slowPhase) {
			const sev = slowPhase === "startup" ? "LOW" : "MEDIUM";
			const thr = slowPhase === "startup" ? 5000 : 40000;
			out.push({ severity: sev, category: "slow_phase", subagent: tid, message: `phase "${slowPhase}" took ${(ph[slowPhase] / 1000).toFixed(1)}s (>${thr / 1000}s)` });
		}

		// 4e. Launch delay (task.started → worker.spawned) — broker scheduling /
		// spawn latency. Skip when respawn churn already flagged (last spawn skews
		// launch). Grounded: normal runs launch in 4-8s; >15s = broker backlog.
		if ((s.spawnCount || 0) <= 2 && (ph.launch || 0) > 15000) {
			out.push({ severity: "MEDIUM", category: "launch_delay", subagent: tid, message: `launch (task→spawn) took ${(ph.launch / 1000).toFixed(1)}s (>15s) — broker scheduling/spawn backlog` });
		}
		// 4f. Drain stall (last progress → worker.exit) — worker hung after work
		// finished. Grounded: clean runs drain in ~0ms; >5s = stuck cleanup.
		if ((ph.drain || 0) > 5000) {
			out.push({ severity: "LOW", category: "drain_stall", subagent: tid, message: `drain (last progress→exit) took ${(ph.drain / 1000).toFixed(1)}s (>5s) — worker hung after finishing work` });
		}
		// 4g. Token imbalance — input ≫ output (huge context, little output).
		// Grounded: normal coding agents run in/out 6-19; >80 with large input is
		// anomalous (agent re-reading context without producing output).
		const u = s.usage || {};
		if ((u.output || 0) > 0 && (u.input || 0) > 20000 && u.input / u.output > 80) {
			out.push({ severity: "LOW", category: "token_imbalance", subagent: tid, message: `input/output ratio ${(u.input / u.output).toFixed(0)}× (${u.input} in → ${u.output} out) — huge context, little output (possible stuck re-read)` });
		}
		// 4h. Cache not warming — 0 cache-read across a task with substantial
		// input means every turn re-processes full context (cost/latency).
		if ((u.cacheRead || 0) === 0 && (u.input || 0) > 5000 && (s.messageEndCount || 0) > 1) {
			out.push({ severity: "LOW", category: "no_cache", subagent: tid, message: `0 cache-read on ${u.input} input tokens across ${s.messageEndCount} turns — cache not warming (every turn re-processes context)` });
		}

		// 4b. Worker respawn churn — worker.spawned count >> 1 means the worker
		// kept crashing & respawning within one task. Grounded in a real run with
		// 49 spawns/task (exit-code-1 storm).
		if ((s.spawnCount || 0) > 3) {
			const sev = s.spawnCount > 10 ? "HIGH" : "MEDIUM";
			out.push({ severity: sev, category: "worker_respawn_churn", subagent: tid, message: `${s.spawnCount} worker.spawned events for one task (worker respawned ${s.spawnCount - 1}×) — likely crash/restart loop (check exitCodes)` });
		}

		// 4c. API error storm — majority of LLM turns returned an errorMessage
		// (429/500/abort). Grounded in a run where every turn 429'd.
		const me = s.messageEndCount || 0;
		if (me >= 3 && (s.apiErrors || 0) / me > 0.5) {
			const pct = Math.round(((s.apiErrors || 0) / me) * 100);
			out.push({ severity: "HIGH", category: "api_error_storm", subagent: tid, message: `${s.apiErrors}/${me} LLM turns (${pct}%) returned an API error (429/5xx/abort) — provider rate-limit or outage` });
		}

		// 4d. Zero-output completion — task marked completed but produced ~0
		// output tokens (all turns failed). A silent failure: status lies "ok".
		if ((s.status === "completed" || s.status === "ok") && me > 0 && (s.usage?.output || 0) === 0) {
			out.push({ severity: "HIGH", category: "zero_output_completion", subagent: tid, message: `marked completed but 0 output tokens across ${me} turn(s) — likely all-API-errors (silent failure)` });
		}

		// 4j. Tool churn — many tool calls in one subagent (chatty/expensive).
		if ((s.toolCalls || 0) > 30) {
			out.push({ severity: "LOW", category: "tool_churn", subagent: tid, message: `${s.toolCalls} tool calls — chatty/expensive agent (check for tool-use loops)` });
		}

		// 4k. Sampler coverage gap — sampler collected samples for the run but
		// NONE attributed to this subagent (0 samples). Missing resource data
		// should be flagged, not silently blank. LOW: timing (attach-late) is a
		// legitimate cause.
		if (rs && !rs.attributed && (resources?.sampleCount || 0) > 0) {
			out.push({ severity: "LOW", category: "sampler_gap", subagent: tid, message: "no resource samples attributed (sampler missed this subagent or attached late)" });
		}

		if (!rs) continue;
		// 5. Sustained high CPU (p95 > 150% = CPU-bound, possible loop)
		if ((rs.p95CpuPct || 0) > 150) {
			const sev = rs.p95CpuPct > 300 ? "HIGH" : "MEDIUM";
			out.push({ severity: sev, category: "sustained_cpu", subagent: tid, message: `sustained high CPU ${rs.p95CpuPct}% (p95) — likely CPU-bound (loop / heavy tool)` });
		}
		// 6. Transient CPU spike (peak ≫ p95 = brief, not sustained)
		if ((rs.peakCpuPct || 0) > 120 && (rs.p95CpuPct || 0) > 0 && rs.peakCpuPct > rs.p95CpuPct * 1.8) {
			out.push({ severity: "LOW", category: "transient_cpu_spike", subagent: tid, message: `transient CPU spike ${rs.peakCpuPct}% (p95 only ${rs.p95CpuPct}%, avg ${rs.avgCpuPct}%) — brief, NOT sustained` });
		}
		// 7. Transient RSS spike
		if ((rs.peakRssBytes || 0) > 300_000_000 && (rs.p95RssBytes || 0) > 0 && rs.peakRssBytes > rs.p95RssBytes * 1.8) {
			out.push({ severity: "LOW", category: "transient_rss_spike", subagent: tid, message: `transient RSS spike ${mb(rs.peakRssBytes)} (p95 only ${mb(rs.p95RssBytes)}, avg ${mb(rs.avgRssBytes)}) — brief, NOT sustained` });
		}
		// 8. RSS growth / possible leak (worker-own only, filter out tool subprocess
		// noise). Conservative thresholds: normal V8 heap warmup (+tens of MB over
		// a short worker) must NOT fire — only substantial, sustained bloat.
		const own = (rs.trajectory || []).filter((t) => !t.isDescendant).map((t) => t.rssBytes).filter((x) => x > 0);
		if (own.length >= 6) {
			const first = own[0];
			const last = own[own.length - 1];
			const delta = last - first;
			if (first > 0 && delta > 150_000_000 && last > first * 1.6) {
				out.push({ severity: "LOW", category: "rss_growth", subagent: tid, message: `worker RSS grew ${mb(first)} → ${mb(last)} (+${mb(delta)}, ${((last / first) * 100 - 100).toFixed(0)}% over ${own.length} samples) — possible bloat (verify sustained)` });
			}
		}
	}

	// ---- run-level anomalies ----
	// 9. Run did not complete cleanly (cancelled / blocked / failed)
	if (runTerminalType && runTerminalType !== "run.completed") {
		out.push({ severity: "HIGH", category: "run_not_completed", subagent: "(run)", message: `run terminated via ${runTerminalType} (not run.completed) — aborted/blocked/failed` });
	}

	// 9b. High failure rate — majority of subagents failed. Defensive: grounded
	// runs all complete cleanly, so this only fires on genuinely broken runs.
	if (subagents.length >= 2) {
		const fails = subagents.filter((s) => (s.status && s.status !== "completed" && s.status !== "ok") || (s.exitCode && s.exitCode !== 0)).length;
		if (fails / subagents.length > 0.5) {
			out.push({ severity: "HIGH", category: "high_failure_rate", subagent: "(run)", message: `${fails}/${subagents.length} subagents failed (${Math.round((fails / subagents.length) * 100)}%) — run broadly broken` });
		}
	}

	// 9d. Cost unreported — provider did not report cost (all transcripts have
	// cost.total=0 despite tokens consumed). The $0 is NOT "free"; it is unknown.
	// Grounded: zai/glm-5.2 + opencode-go providers report cost=0 on every turn.
	const totalTok = subagents.reduce((a, s) => a + (s.usage?.totalTokens || 0), 0);
	const totalCost = subagents.reduce((a, s) => a + (s.cost?.total || 0), 0);
	if (totalTok > 0 && totalCost === 0) {
		out.push({ severity: "LOW", category: "cost_unreported", subagent: "(run)", message: `cost is $0 despite ${totalTok.toLocaleString()} tokens consumed — provider does not report cost; the cost metric is UNAVAILABLE (not free)` });
	}

	// 9c. Run idle / low parallelism — run wall ≫ Σ subagent wall means most of
	// the run was NOT subagent work (scheduling gaps / sequential execution).
	// NOTE: phases.wall is the FULL subagent lifetime (first-spawn → exit), so
	// respawn/churn time IS counted here — a 429-storm run that spent 87s/task
	// respawning correctly does NOT trip this (ratio ~1.14). Only genuine idle
	// (broker stalls, sequential-when-parallel-possible) fires. Grounded:
	// healthy parallel runs run ~1.1-1.3×; a sequential run hits ≥2×.
	if (subagents.length >= 2 && wallMs) {
		const sumWall = subagents.reduce((a, s) => a + (s.timeline?.phases?.wall || 0), 0);
		const idle = wallMs - sumWall;
		if (sumWall > 0 && wallMs > sumWall * 2 && idle > 60_000) {
			out.push({ severity: "MEDIUM", category: "run_idle", subagent: "(run)", message: `run wall ${(wallMs / 1000).toFixed(0)}s but Σ subagent wall only ${(sumWall / 1000).toFixed(0)}s — ${(idle / 1000).toFixed(0)}s idle (scheduling gaps / sequential / pre-success churn)` });
		}
	}

	// 10. Surface event-level problems already detected by the analyzer
	// (phase_guard_blocked, task.failed, workflow.phase_failed, recovery.*,
	// adaptive.plan_*, response timeouts, deliverable_warning) as anomalies so
	// they appear in the ⚠️ section. Problems severity is 1 (worst) .. 5.
	// Skip "retry"/"exit_code" — already covered by rules 1-2 above.
	const seen = new Set(out.map((a) => `${a.subagent}:${a.category}`));
	for (const p of problems || []) {
		if (p.type === "retry" || p.type === "exit_code") continue;
		const cat = String(p.type).replace(/[.].*$/, "");
		if (seen.has(`${p.taskId || "(run)"}:${cat}`)) continue;
		seen.add(`${p.taskId || "(run)"}:${cat}`);
		const sev = p.severity <= 2 ? "HIGH" : p.severity === 3 ? "MEDIUM" : "LOW";
		out.push({ severity: sev, category: cat, subagent: p.taskId || "(run)", message: `${p.type}: ${p.message || ""}` });
	}

	// severity order for stable display
	const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
	out.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.subagent.localeCompare(b.subagent));
	return out;
}

function nearestSample(samplesForPid, ts) {
	let best = null;
	let bd = Infinity;
	for (const s of samplesForPid) {
		const d = Math.abs(s.ts - ts);
		if (d < bd) {
			bd = d;
			best = s;
		}
	}
	return best;
}

function buildEventTimeline(events, samplesByPid, taskPid) {
	if (!events.length) return { rows: [], topGaps: [] };
	const start = ms(events[0].time);
	let prev = start;
	const rows = [];
	for (const e of events) {
		const t = ms(e.time);
		const dt = t - prev;
		prev = t;
		const pid = e.taskId ? taskPid[e.taskId] : null;
		let rss = null;
		let cpu = null;
		if (pid && samplesByPid?.has(pid)) {
			const n = nearestSample(samplesByPid.get(pid), t);
			if (n) {
				rss = n.rssBytes || 0;
				cpu = n.cpuPct || 0;
			}
		}
		rows.push({
			seq: e.metadata?.seq ?? null,
			elapsedMs: t - start,
			deltaMs: dt,
			type: e.type,
			taskId: e.taskId || null,
			workerPid: pid ?? null,
			rssBytes: rss,
			cpuPct: cpu,
		});
	}
	// top gaps (>1s, sorted desc) — where wall time actually went
	const topGaps = rows
		.filter((r) => r.deltaMs > 1000)
		.map((r) => ({ deltaMs: r.deltaMs, elapsedMs: r.elapsedMs, type: r.type, taskId: r.taskId }))
		.sort((a, b) => b.deltaMs - a.deltaMs)
		.slice(0, 15);
	return { rows, topGaps };
}

// ---------- analyze events ----------
function analyzeEvents(events, runId) {
	const ev = events.filter((e) => e.runId === runId);
	const tasks = new Map(); // taskId -> timeline data

	for (const e of ev) {
		const tid = e.taskId;
		if (!tid) continue;
		if (!tasks.has(tid)) tasks.set(tid, { taskId: tid, progress: [], progressTimes: [] });
		const t = tasks.get(tid);
		switch (e.type) {
			case "task.started":
				t.startedTime = ms(e.time);
				t.role = e.data?.role;
				t.agent = e.data?.agent;
				t.runtime = e.data?.runtime;
				break;
			case "worker.spawned":
				t.spawnTime = ms(e.time);
				t.pid = e.data?.pid;
				t.spawnCount = (t.spawnCount || 0) + 1;
				// firstSpawnTime is NOT overwritten — needed for accurate launch latency
				// and full-lifetime wall (spawnTime is the LAST spawn, which on a
				// respawn/churn run understates wall and overstates launch).
				if (t.firstSpawnTime == null) t.firstSpawnTime = t.spawnTime;
				break;
			case "worker.exit":
				t.exitTime = ms(e.time);
				t.exitCode = e.data?.exitCode;
				t.diagnostic = e.data?.diagnostic;
				break;
			case "task.completed":
				t.completedTime = ms(e.time);
				break;
			case "task.progress":
				t.progress.push(e);
				t.progressTimes.push(ms(e.time));
				break;
		}
	}

	// phase guard blocks + other run-level events
	const phaseGuards = ev.filter((e) => e.type === "workflow.phase_guard_blocked");
	const runCreated = ev.find((e) => e.type === "run.created");
	// R1 (audit): a run may terminate via run.completed OR run.cancelled /
	// run.blocked / run.failed. Failed/cancelled runs are exactly the ones we
	// most want to diagnose, so accept any terminal event; fall back to the
	// last event's timestamp if no terminal event is present at all.
	const runTerminal = ev.find((e) =>
		["run.completed", "run.cancelled", "run.blocked", "run.failed"].includes(e.type),
	);
	const firstEv = ev.length ? ev[0] : null;
	const lastEv = ev.length ? ev[ev.length - 1] : null;
	const responseTimeouts = ev.filter((e) => e.type.includes("timeout") || e.type.includes("abort"));
	const deliverableWarnings = ev.filter((e) => e.type.includes("deliverable") && e.type.includes("warning"));
	// R14 (audit): surface notable problem events the analyzer previously
	// dropped: task.failed, workflow.phase_failed, recovery.attempted, and the
	// adaptive-plan failures (plan_repair_failed / plan_missing are often the
	// ROOT CAUSE of a blocked run — without these the report only says
	// "blocked" with no reason).
	const notable = ev.filter((e) =>
		/^(task\.failed|workflow\.phase_failed|recovery\.|adaptive\.plan_(repair_failed|missing))/.test(e.type),
	);

	// event type histogram
	const typeCounts = {};
	for (const e of ev) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

	return {
		tasks,
		phaseGuards,
		responseTimeouts,
		deliverableWarnings,
		notable,
		typeCounts,
		eventCount: ev.length,
		runStart: runCreated ? ms(runCreated.time) : firstEv ? ms(firstEv.time) : null,
		runEnd: runTerminal ? ms(runTerminal.time) : lastEv ? ms(lastEv.time) : null,
		runTerminalType: runTerminal ? runTerminal.type : null,
	};
}

// ---------- compute timeline phases ----------
function computeTimeline(t) {
	const p = t.progressTimes;
	const firstProg = p.length ? p[0] : null;
	const lastProg = p.length ? p[p.length - 1] : null;
	const phases = {};
	const def = (name, a, b) => {
		// clamp tiny negative deltas (event ordering jitter) to 0
		phases[name] = a != null && b != null ? Math.max(0, b - a) : null;
	};
	def("launch", t.startedTime, t.firstSpawnTime ?? t.spawnTime); // task.started → FIRST spawn
	def("respawn", t.firstSpawnTime, t.spawnTime); // FIRST → LAST spawn (churn window; 0 for single-spawn)
	def("startup", t.spawnTime, firstProg); // last spawn → first progress
	def("activeWork", firstProg, lastProg); // first → last progress
	def("drain", lastProg, t.exitTime); // last progress → exit
	def("finalize", t.exitTime, t.completedTime); // exit → completed
	phases.total = t.startedTime != null && t.completedTime != null ? t.completedTime - t.startedTime : null;
	// wall = FULL subagent lifetime (FIRST spawn → exit), so respawn/churn time
	// is captured — using last-spawn would undercount wall and make run_idle
	// mis-flag churn as idle.
	const wallStart = t.firstSpawnTime ?? t.spawnTime;
	phases.wall = wallStart != null && t.exitTime != null ? t.exitTime - wallStart : null;

	// largest intra-progress gap
	let maxGap = 0;
	let maxGapAt = null;
	for (let i = 1; i < p.length; i++) {
		const g = p[i] - p[i - 1];
		if (g > maxGap) {
			maxGap = g;
			maxGapAt = new Date(p[i]).toISOString();
		}
	}
	return { phases, firstProg, lastProg, maxGap, maxGapAt, progressCount: p.length };
}

// ---------- analyze transcripts (token/cost/model) ----------
async function analyzeTranscripts(artifactsDir) {
	const tdir = join(artifactsDir, "transcripts");
	const files = existsSync(tdir) ? readdirSync(tdir).filter((f) => f.endsWith(".jsonl")) : [];
	const result = new Map(); // taskId -> usage data

	for (const file of files) {
		// filename: 02_execute.attempt-0.jsonl → taskId = 02_execute
		const taskId = file.replace(/\.attempt-\d+\.jsonl$/, "").replace(/\.jsonl$/, "");
		const lines = await readJsonl(join(tdir, file));
		let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const models = new Set();
		let assistantMsgs = 0;
		let toolResultMsgs = 0;
		let toolCalls = 0;
		let messageEndCount = 0;
		let apiErrors = 0; // message_end carrying an errorMessage (429/500/abort…)

		for (const rec of lines) {
			if (rec.type !== "message_end" || !rec.message) continue;
			messageEndCount++;
			const msg = rec.message;
			if (msg.errorMessage) apiErrors++;
			const u = msg.usage;
			if (!u) continue;
			usage.input += u.input || 0;
			usage.output += u.output || 0;
			usage.cacheRead += u.cacheRead || 0;
			usage.cacheWrite += u.cacheWrite || 0;
			usage.totalTokens += u.totalTokens || 0;
			if (u.cost) {
				cost.input += u.cost.input || 0;
				cost.output += u.cost.output || 0;
				cost.cacheRead += u.cost.cacheRead || 0;
				cost.cacheWrite += u.cost.cacheWrite || 0;
				cost.total += u.cost.total || 0;
			}
			// model: check message.model (confirmed path) then top-level
			const model = msg.model || rec.model;
			if (model) models.add(model);
			if (msg.role === "assistant") {
				assistantMsgs++;
				if (Array.isArray(msg.content)) {
					toolCalls += msg.content.filter((c) => c.type === "toolCall").length;
				}
			} else if (msg.role === "toolResult") {
				toolResultMsgs++;
			}
		}
		// R2 (audit): a task may have MULTIPLE attempt files (attempt-0 failed,
		// attempt-1 retried). The previous code did result.set(taskId, ...) which
		// OVERWROTE earlier attempts → undercounted tokens/cost for retried tasks.
		// Merge across attempts instead: sum usage/cost, union models, sum counts.
		const prev = result.get(taskId);
		if (prev) {
			prev.usage.input += usage.input;
			prev.usage.output += usage.output;
			prev.usage.cacheRead += usage.cacheRead;
			prev.usage.cacheWrite += usage.cacheWrite;
			prev.usage.totalTokens += usage.totalTokens;
			prev.cost.input += cost.input;
			prev.cost.output += cost.output;
			prev.cost.cacheRead += cost.cacheRead;
			prev.cost.cacheWrite += cost.cacheWrite;
			prev.cost.total += cost.total;
			for (const m of models) prev.models.add(m);
			prev.assistantMsgs += assistantMsgs;
			prev.toolResultMsgs += toolResultMsgs;
			prev.toolCalls += toolCalls;
			prev.messageEndCount += messageEndCount;
			prev.apiErrors = (prev.apiErrors || 0) + apiErrors;
			prev.lineCount += lines.length;
			prev.attemptFiles.push(file);
		} else {
			result.set(taskId, {
				taskId,
				file,
				usage,
				cost,
				models,
				assistantMsgs,
				toolResultMsgs,
				toolCalls,
				messageEndCount,
				apiErrors,
				lineCount: lines.length,
				attemptFiles: [file],
			});
		}
	}
	return result;
}

// ---------- resources ----------
function analyzeResources(path, subagents) {
	if (!path || !existsSync(path)) return null;
	const samples = readJsonlSync(path);
	if (!samples.length) return null;
	let peakRss = 0;
	let peakCpu = 0;
	const byPid = new Map();
	// Per-subagent attribution: previously exact-PID match only — so a
	// worker's TOOL subprocesses (test-runner, tsc, bash, … = grandchildren)
	// were NOT counted, understating tool-heavy subagents. The sampler records
	// ppid per sample and pi-crew's setsid does NOT reparent to init, so the
	// ppid chain stays intact (verified: 1GB test-runner chains up to its
	// worker). Fix: walk the ppid tree (first-seen ppid per pid) to find the
	// owning worker, then attribute within that worker's window.
	const perSubagent = new Map();
	for (const s of subagents) {
		if (s.pid != null) perSubagent.set(s.pid, { taskId: s.taskId, pid: s.pid, spawnMs: s.spawnMs, exitMs: s.exitMs, samples: 0, peakRss: 0, peakCpu: 0, rssSum: 0, cpuSum: 0, descendantPids: new Set(), ownRssSum: 0, ownCpuSum: 0, ownSamples: 0, ownCpuSamples: 0, trajectory: [] });
	}
	const workerPids = new Set(perSubagent.keys());
	// first-seen ppid per pid (spawn-time parent; robust while parent alive)
	const firstPpid = new Map();
	for (const s of samples) if (!firstPpid.has(s.pid)) firstPpid.set(s.pid, s.ppid);
	const ownerOf = (pid) => {
		if (workerPids.has(pid)) return pid;
		let cur = firstPpid.get(pid);
		const seen = new Set();
		while (cur != null && !seen.has(cur)) {
			if (workerPids.has(cur)) return cur;
			seen.add(cur);
			cur = firstPpid.get(cur);
		}
		return null;
	};
	for (const s of samples) {
		peakRss = Math.max(peakRss, s.rssBytes || 0);
		peakCpu = Math.max(peakCpu, s.cpuPct || 0);
		if (!byPid.has(s.pid)) byPid.set(s.pid, { pid: s.pid, label: s.label, peakRss: 0, peakCpu: 0, firstRss: s.rssBytes || 0, lastRss: s.rssBytes || 0 });
		const e = byPid.get(s.pid);
		e.peakRss = Math.max(e.peakRss, s.rssBytes || 0);
		e.peakCpu = Math.max(e.peakCpu, s.cpuPct || 0);
		e.lastRss = s.rssBytes || 0;
		// attribute to owning worker (exact PID OR ppid-tree descendant)
		const ownerPid = ownerOf(s.pid);
		const sa = ownerPid != null ? perSubagent.get(ownerPid) : null;
		if (sa) {
			const lo = sa.spawnMs ?? -Infinity;
			const hi = sa.exitMs ?? Infinity;
			if (s.ts >= lo && s.ts <= hi) {
				sa.samples++;
				sa.peakRss = Math.max(sa.peakRss, s.rssBytes || 0);
				sa.peakCpu = Math.max(sa.peakCpu, s.cpuPct || 0);
				sa.rssSum += s.rssBytes || 0;
				sa.cpuSum += s.cpuPct || 0;
				sa.trajectory.push({ ts: s.ts, pid: s.pid, rssBytes: s.rssBytes || 0, cpuPct: s.cpuPct || 0, isDescendant: s.pid !== ownerPid, firstSample: !!s.firstSample });
				if (s.pid !== ownerPid) {
					sa.descendantPids.add(s.pid);
				} else {
					// R9 (audit): avg reflects the agent process itself, not dragged
					// down by many short-lived low-RSS tool samples.
					sa.ownRssSum += s.rssBytes || 0;
					sa.ownSamples++;
					// firstSample (cpuPct=0 by construction — no previous tick to diff)
					// must NOT drag the CPU average down; track CPU samples separately.
					if (!s.firstSample) {
						sa.ownCpuSum += s.cpuPct || 0;
						sa.ownCpuSamples++;
					}
				}
			}
		}
	}
	const perSubagentList = [...perSubagent.values()].map((sa) => ({
		taskId: sa.taskId,
		pid: sa.pid,
		samples: sa.samples,
		peakRssBytes: sa.peakRss,
		peakCpuPct: sa.peakCpu,
		// p95 over the SAME population as peak (all attributed: worker + tool
		// subprocesses) — contextualizes the peak so a single-sample spike is
		// distinguishable from a sustained high load. Computed from the full
		// trajectory (before the 80-point cap applied below).
		p95RssBytes: pctl(sa.trajectory.map((t) => t.rssBytes), 95),
		p95CpuPct: pctl(sa.trajectory.filter((t) => !t.firstSample).map((t) => t.cpuPct), 95),
		avgRssBytes: sa.ownSamples ? Math.round(sa.ownRssSum / sa.ownSamples) : 0,
		avgCpuPct: sa.ownCpuSamples ? Math.round((sa.ownCpuSum / sa.ownCpuSamples) * 10) / 10 : 0,
		attributed: sa.samples > 0,
		descendantPids: [...sa.descendantPids],
		// trajectory: cap to ~80 points (even stride) so per-agent files stay readable
		trajectory: sa.trajectory.length <= 80 ? sa.trajectory : sa.trajectory.filter((_, i) => i % Math.ceil(sa.trajectory.length / 80) === 0),
	}));
	return {
		sampleCount: samples.length,
		peakRssBytes: peakRss,
		peakCpuPct: peakCpu,
		// R3 (audit): RSS growth is meaningless across different PIDs (first/last
		// sample are usually different processes). Compute per-PID growth then sum.
		rssGrowthBytes: [...byPid.values()].reduce((g, p) => g + ((p.lastRss || 0) - (p.firstRss || 0)), 0),
		spanMs: samples.length > 1 ? samples[samples.length - 1].ts - samples[0].ts : 0,
		byPid: [...byPid.values()],
		perSubagent: perSubagentList,
		firstSample: samples[0],
		lastSample: samples[samples.length - 1],
	};
}
function readJsonlSync(path) {
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* skip */
		}
	}
	return out;
}

// ---------- exit code meaning ----------
function exitMeaning(code) {
	if (code === 0) return "OK";
	if (code === 143) return "SIGTERM (143)";
	if (code === 137) return "OOM/SIGKILL (137)";
	if (code === 1) return "Error (1)";
	return `Exit ${code}`;
}

// ---------- main ----------
async function main() {
	const args = parseArgs(process.argv);
	const runId = args.runId;
	const stateDir = join(args.crewRoot, "state", "runs", runId);
	const artifactsDir = join(args.crewRoot, "artifacts", runId);

	// F1 (audit): validate runId to prevent path injection — runId flows into
	// join(crewRoot, "state", "runs", runId) AND into output filenames
	// (docs/perf-report-<runId>.md, bench/results/<runId>.json). Without this,
	// runId="../../tmp/x" would read/write outside the intended dirs.
	if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
		process.stderr.write(`Error: invalid runId (must be alphanumeric/_/./-): ${runId}\n`);
		process.exit(1);
	}

	if (!existsSync(stateDir)) {
		process.stderr.write(`Error: run state not found: ${stateDir}\n`);
		process.exit(1);
	}

	// load
	const events = await readJsonl(join(stateDir, "events.jsonl"));
	const manifest = readJson(join(stateDir, "manifest.json"));
	const tasksJson = readJson(join(stateDir, "tasks.json"));
	// R10 (audit): agents.json was read (41KB) but never used — removed.
	const ea = analyzeEvents(events, runId);
	const transcripts = await analyzeTranscripts(artifactsDir);

	// merge per-subagent
	const subagents = [];
	const taskList = tasksJson
		? Object.values(tasksJson).sort((a, b) => (a.id || "").localeCompare(b.id || ""))
		: [...ea.tasks.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));

	for (const t of ea.tasks.values()) {
		const tr = transcripts.get(t.taskId);
		const tl = computeTimeline(t);
		const taskMeta = taskList.find((x) => x.id === t.taskId);
		subagents.push({
			taskId: t.taskId,
			role: t.role || taskMeta?.role,
			agent: t.agent || taskMeta?.agent,
			pid: t.pid,
			spawnMs: t.spawnTime,
			exitMs: t.exitTime,
			exitCode: t.exitCode ?? taskMeta?.exitCode,
			usage: tr?.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			cost: tr?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			models: tr ? [...tr.models] : [],
			modelRouting: taskMeta?.modelRouting?.resolved,
			// R11 (audit): retry detection must count model-level retries too.
			// `attempts` only records the final attempt; `modelAttempts` records
			// each model try (incl. model fallback on failure). A task that
			// retried via model fallback has attempts=1 but modelAttempts=2, so
			// the old `attempts.length` check MISSED those retries.
			attempts: Math.max(taskMeta?.attempts?.length || 0, taskMeta?.modelAttempts?.length || 0),
			modelAttempts: (taskMeta?.modelAttempts || []).map((ma) => ({
				model: ma.model,
				success: ma.success,
				exitCode: ma.exitCode,
				error: ma.error,
			})),
			verification: taskMeta?.verification,
			status: taskMeta?.status,
			error: taskMeta?.error,
			assistantMsgs: tr?.assistantMsgs || 0,
			toolCalls: tr?.toolCalls || 0,
			messageEndCount: tr?.messageEndCount || 0,
			apiErrors: tr?.apiErrors || 0,
			spawnCount: t.spawnCount || 0,
			timeline: tl,
			hasTranscript: !!tr,
		});
	}

	// run totals
	const totalUsage = subagents.reduce(
		(acc, s) => {
			acc.input += s.usage.input;
			acc.output += s.usage.output;
			acc.cacheRead += s.usage.cacheRead;
			acc.cacheWrite += s.usage.cacheWrite;
			acc.totalTokens += s.usage.totalTokens;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	);
	const totalCost = subagents.reduce((a, s) => a + s.cost.total, 0);
	const modelBreakdown = {};
	for (const s of subagents) for (const m of s.models) modelBreakdown[m] = (modelBreakdown[m] || 0) + 1;
	const wallMs = ea.runStart && ea.runEnd ? ea.runEnd - ea.runStart : null;
	const outSec = wallMs ? wallMs / 1000 : 0;
	const tokensPerSec = outSec ? totalUsage.output / outSec : 0;
	const eventsPerSec = outSec ? ea.eventCount / outSec : 0;

	// problems
	const problems = [];
	for (const s of subagents) {
		const code = s.exitCode;
		if (code != null && code !== 0) {
			// R5 (audit): include the REAL error text from tasks.json (e.g. "Child Pi
			// exited with 143", "response_timeout", …) — previously dropped, leaving
			// only a generic label.
			const detail = s.error ? ` — ${s.error}` : "";
			problems.push({ severity: 1, type: "exit_code", taskId: s.taskId, message: `Worker exit ${exitMeaning(code)}${detail}`, value: code });
		}
		if (s.attempts > 1) {
			problems.push({ severity: 4, type: "retry", taskId: s.taskId, message: `${s.attempts} attempts (retry)`, value: s.attempts });
		}
		if (s.status && !["completed", "succeeded", "done"].includes(s.status)) {
			problems.push({ severity: 2, type: "task_status", taskId: s.taskId, message: `Task status: ${s.status}`, value: s.status });
		}
		// R12 (audit): a task may be status=completed but FAIL verification
		// (verification.satisfied===false) — that is a real "task ran but didn't
		// meet its goal" problem the analyzer previously ignored entirely.
		if (s.verification?.satisfied === false) {
			const note = s.verification.notes ? ` — ${s.verification.notes}` : "";
			problems.push({
				severity: 2,
				type: "verification_failed",
				taskId: s.taskId,
				message: `Verification failed (required ${s.verification.requiredGreenLevel ?? "?"}, observed ${s.verification.observedGreenLevel ?? "?"})${note}`,
			});
		}
	}
	for (const pg of ea.phaseGuards) {
		problems.push({
			severity: 3,
			type: "phase_guard_blocked",
			phaseName: pg.data?.phaseName,
			message: pg.message || `Phase guard blocked: ${pg.data?.reason}`,
			value: pg.data?.reason,
			seq: pg.metadata?.seq,
		});
	}
	for (const rt of ea.responseTimeouts) {
		problems.push({ severity: 2, type: rt.type, taskId: rt.taskId, message: rt.message, seq: rt.metadata?.seq });
	}
	for (const dw of ea.deliverableWarnings) {
		problems.push({ severity: 5, type: "deliverable_warning", taskId: dw.taskId, message: dw.message, seq: dw.metadata?.seq });
	}
	for (const n of ea.notable) {
		// R14: surface task.failed / workflow.phase_failed / recovery.attempted /
		// adaptive.plan_repair_failed|missing — these carry the real reason a
		// run struggled or blocked.
		const sev = n.type === "task.failed" || n.type === "workflow.phase_failed" ? 2 : 3;
		problems.push({
			severity: sev,
			type: n.type,
			taskId: n.taskId,
			message: n.message || n.data?.reason || n.data?.message || n.type,
			seq: n.metadata?.seq,
		});
	}
	problems.sort((a, b) => a.severity - b.severity);

	// bottlenecks (slow spots)
	const bottlenecks = [];
	for (const s of subagents) {
		const ph = s.timeline.phases;
		// R2 (audit): only flag genuinely slow totals (>30s) as bottlenecks;
		// previously EVERY subagent total was listed and all marked 🔴, even 24s
		// ones, contradicting the legend ("🔴 = >30s").
		if (ph.total != null && ph.total > 30000) bottlenecks.push({ taskId: s.taskId, phase: "total", durationMs: ph.total, label: `${s.role} total wall` });
		if (s.timeline.maxGap > 30000) bottlenecks.push({ taskId: s.taskId, phase: "intra_gap", durationMs: s.timeline.maxGap, label: `gap @ ${s.timeline.maxGapAt}` });
		if (ph.activeWork != null && ph.activeWork > 60000) bottlenecks.push({ taskId: s.taskId, phase: "activeWork", durationMs: ph.activeWork, label: `${s.role} active work` });
	}
	bottlenecks.sort((a, b) => b.durationMs - a.durationMs);

	// resources
	const resources = analyzeResources(args.resources, subagents);

	// per-event timeline (--events): needs taskId→pid map + samples-by-pid for
	// resource snapshots. Samples come from the --resources file (read once).
	let eventTimeline = null;
	if (args.events) {
		const taskPid = {};
		for (const [tid, t] of ea.tasks) if (t.pid != null) taskPid[tid] = t.pid;
		let samplesByPid = null;
		if (args.resources && existsSync(args.resources)) {
			samplesByPid = new Map();
			for (const s of readJsonlSync(args.resources)) {
				if (!samplesByPid.has(s.pid)) samplesByPid.set(s.pid, []);
				samplesByPid.get(s.pid).push(s);
			}
		}
		eventTimeline = buildEventTimeline(events, samplesByPid, taskPid);
	}

	// ---------- emit JSON ----------
	const anomalies = detectAnomalies(subagents, resources, problems, { runTerminalType: ea.runTerminalType, wallMs });
	const report = {
		runId,
		generatedAt: new Date().toISOString(),
		summary: {
			wallMs,
			totalCost,
			totalTokens: totalUsage,
			modelBreakdown,
			subagentCount: subagents.length,
			eventCount: ea.eventCount,
			tokensPerSec: Math.round(tokensPerSec * 100) / 100,
			eventsPerSec: Math.round(eventsPerSec * 100) / 100,
			workflow: manifest?.workflow,
			goal: manifest?.goal?.slice(0, 200),
			parentModel: manifest?.modelContext?.parentModel,
		},
		subagents: subagents.map((s) => ({
			taskId: s.taskId,
			role: s.role,
			model: s.models.join(", "),
			modelRouting: s.modelRouting,
			usage: s.usage,
			cost: s.cost,
			timeline: { phases: s.timeline.phases, progressCount: s.timeline.progressCount, maxGap: s.timeline.maxGap },
			tools: s.toolCalls,
			assistantMsgs: s.assistantMsgs,
			messageEndCount: s.messageEndCount,
			apiErrors: s.apiErrors,
			spawnCount: s.spawnCount,
			exitCode: s.exitCode,
			error: s.error,
			attempts: s.attempts,
			modelAttempts: s.modelAttempts,
			status: s.status,
			pid: s.pid,
			spawnMs: s.spawnMs,
			exitMs: s.exitMs,
			hasTranscript: s.hasTranscript,
			resource: resources?.perSubagent?.find((ps) => ps.taskId === s.taskId) || undefined,
		})),
		problems,
		bottlenecks,
		resources,
		anomalies,
		eventTimeline: eventTimeline ? { eventCount: eventTimeline.rows.length, topGaps: eventTimeline.topGaps } : undefined,
		typeCounts: ea.typeCounts,
	};

	const resultsDir = join(process.cwd(), "bench", "results");
	mkdirSync(resultsDir, { recursive: true });
	const docsDir = join(process.cwd(), "docs");
	mkdirSync(docsDir, { recursive: true });
	const jsonPath = join(resultsDir, `${runId}.json`);
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));

	// per-event timeline CSV (--events)
	if (args.events && eventTimeline) {
		const csvPath = join(resultsDir, `${runId}.events-timeline.csv`);
		const csv = [
			"seq,elapsed_s,delta_ms,type,taskId,workerPid,workerRSS,workerCPU",
			...eventTimeline.rows.map((r) =>
				[r.seq, (r.elapsedMs / 1000).toFixed(1), r.deltaMs, r.type, r.taskId ?? "", r.workerPid ?? "", r.rssBytes ?? "", r.cpuPct ?? ""].join(","),
			),
		].join("\n");
		writeFileSync(csvPath, csv + "\n");
		process.stderr.write(`[analyze-run] wrote ${csvPath}\n`);
	}

	// per-subagent detail files (--agents): one markdown per subagent
	if (args.agents) {
		const agentsDir = join(resultsDir, `${runId}.agents`);
		mkdirSync(agentsDir, { recursive: true });
		for (const sa of report.subagents) {
			const rows = eventTimeline ? eventTimeline.rows.filter((r) => r.taskId === sa.taskId) : [];
			const mdSa = renderSubagentFile(sa, report, rows);
			writeFileSync(join(agentsDir, `${sa.taskId}.md`), mdSa + "\n");
		}
		process.stderr.write(`[analyze-run] wrote ${report.subagents.length} per-agent files → ${agentsDir}/\n`);
	}

	// ---------- emit markdown ----------
	const md = renderMarkdown(report, ea, subagents, args.agents);
	const mdPath = join(docsDir, `perf-report-${runId}.md`);
	writeFileSync(mdPath, md);

	process.stderr.write(`[analyze-run] wrote ${mdPath}\n[analyze-run] wrote ${jsonPath}\n`);
}

// ---------- markdown renderer ----------
// ---------- per-subagent detail file (--agents) ----------
// One markdown file per subagent: identity, timeline, tokens, model attempts,
// per-event rows (this task), resource trajectory. Drill-down from main report.
function renderSubagentFile(sa, report, eventRows) {
	const L = [];
	const ph = sa.timeline.phases;
	const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;
	L.push(`# Subagent \`${sa.taskId}\` — run \`${report.runId}\``);
	L.push("");
	L.push("## Nhận dạng");
	L.push("");
	L.push("| Trường | Giá trị |");
	L.push("|--------|---------|");
	L.push(`| Vai trò | ${esc(sa.role)} |
`);
	L.push(`| PID | ${sa.pid ?? "—"} |
`);
	L.push(`| Model | ${esc(sa.model) || esc(sa.modelRouting) || "—"} |
`);
	L.push(`| Trạng thái | ${sa.status ?? "—"} (exit ${sa.exitCode ?? "—"}) |
`);
	L.push(`| Lỗi | ${sa.error ? esc(sa.error) : "—"} |
`);
	L.push(`| Attempts | ${sa.attempts} | verification: ${sa.verification ? (sa.verification.satisfied ? "✓" : "❌ " + esc(sa.verification.notes || "")) : "—"} |`);
	L.push("");
	// per-agent anomalies (filtered from the run-wide anomaly list)
	const myAnoms = (report.anomalies || []).filter((a) => a.subagent === sa.taskId);
	if (myAnoms.length) {
		const icon = (sev) => (sev === "HIGH" ? "🔴" : sev === "MEDIUM" ? "🟡" : "🔵");
		L.push("## ⚠️ Cảnh báo bất thường");
		L.push("");
		for (const a of myAnoms) L.push(`- ${icon(a.severity)} **${a.category}**: ${esc(a.message)}`);
		L.push("");
	}
	// Timeline phases
	L.push("## Timeline (phases)");
	L.push("");
	L.push("| Phase | ms |");
	L.push("|-------|----|");
	for (const [name, v] of Object.entries(ph)) L.push(`| ${name} | ${v ?? "—"} |`);
	L.push(`| maxGap | ${sa.timeline.maxGap ?? "—"} @ ${sa.timeline.maxGapAt ?? ""} |`);
	L.push("");
	// Tokens
	L.push("## Token / Cost");
	L.push("");
	L.push("| input | output | cacheRead | cacheWrite | cost | tool calls | msgs |");
	L.push("|-------|--------|-----------|------------|------|-----------|------|");
	L.push(`| ${sa.usage.input?.toLocaleString()} | ${sa.usage.output?.toLocaleString()} | ${sa.usage.cacheRead?.toLocaleString()} | ${sa.usage.cacheWrite?.toLocaleString()} | $${(sa.cost?.total ?? 0).toFixed(4)} | ${sa.tools} | ${sa.assistantMsgs} |`);
	if (sa.modelAttempts && sa.modelAttempts.length > 1) {
		L.push("");
		L.push("**Model attempts (retry/fallback):**");
		for (const ma of sa.modelAttempts) L.push(`- ${ma.model}${ma.success === false ? " ❌" : ma.success === true ? " ✓" : ""}${ma.exitCode ? ` (exit ${ma.exitCode})` : ""}${ma.error ? ` — ${esc(ma.error)}` : ""}`);
	}
	L.push("");
	// Resource
	if (sa.resource) {
		const r = sa.resource;
		L.push("## Tài nguyên (gồm tool subprocess qua ppid-tree)");
		L.push("");
		L.push(`Peak RSS **${mb(r.peakRssBytes)}** (avg worker-own ${mb(r.avgRssBytes)}), Peak CPU **${r.peakCpuPct}%** (avg ${r.avgCpuPct}%), ${r.samples} samples, ${r.descendantPids?.length || 0} tool subprocess.`);
		if (r.trajectory && r.trajectory.length) {
			L.push("");
			L.push("**Trajectory (RSS/CPU theo thời gian):**");
			L.push("");
			L.push("| elapsed | pid | RSS | CPU | loại |");
			L.push("|---------|-----|-----|-----|------|");
			const base = r.trajectory[0].ts;
			for (const t of r.trajectory.slice(0, 40)) L.push(`| ${((t.ts - base) / 1000).toFixed(1)}s | ${t.pid} | ${mb(t.rssBytes)} | ${t.cpuPct}% | ${t.isDescendant ? "tool" : "worker"} |`);
			if (r.trajectory.length > 40) L.push(`| … | | | | (${r.trajectory.length - 40} mẫu nữa, xem CSV) |`);
		}
		L.push("");
	}
	// Per-event rows for this task
	if (eventRows && eventRows.length) {
		L.push("## Per-event (task này)");
		L.push("");
		L.push("| seq | elapsed | Δms | type | RSS | CPU |");
		L.push("|-----|---------|-----|------|-----|-----|");
		for (const r of eventRows.slice(0, 50)) L.push(`| ${r.seq} | ${(r.elapsedMs / 1000).toFixed(1)}s | ${r.deltaMs} | ${esc(r.type)} | ${r.rssBytes != null ? mb(r.rssBytes) : "—"} | ${r.cpuPct != null ? r.cpuPct + "%" : "—"} |`);
		L.push("");
	}
	return L.join("\n");
}

function renderMarkdown(report, ea, subagents, perAgent = false) {
	const L = [];
	const flag = (ms) => (ms != null && ms > 30000 ? " 🔴" : "");
	const s = report.summary;

	L.push(`# Báo cáo hiệu năng — Run \`${report.runId}\``);
	L.push("");
	L.push(`> Sinh bởi \`scripts/analyze-run.mjs\` lúc ${report.generatedAt}. Số liệu THẬT từ events.jsonl + transcripts.`);
	L.push("");

	// Tóm tắt
	L.push("## 📋 Tóm tắt");
	L.push("");
	L.push(`| Chỉ số | Giá trị |`);
	L.push(`|--------|---------|`);
	L.push(`| Workflow | ${esc(s.workflow)} |`);
	L.push(`| Số subagent | ${s.subagentCount} |`);
	L.push(`| Tổng sự kiện | ${s.eventCount} |`);
	L.push(`| Thời gian chạy (wall) | ${fmtMs(s.wallMs)} |`);
	L.push(`| Tổng token (input+output+cache) | ${s.totalTokens.totalTokens?.toLocaleString()} |`);
	L.push(`| — Input | ${s.totalTokens.input?.toLocaleString()} |`);
	L.push(`| — Output | ${s.totalTokens.output?.toLocaleString()} |`);
	L.push(`| — Cache read | ${s.totalTokens.cacheRead?.toLocaleString()} |`);
	L.push(`| Tổng cost | ${s.totalCost > 0 || (s.totalTokens.totalTokens || 0) === 0 ? money(s.totalCost) : "— (provider không report cost)"} |`);
	L.push(`| Token/s (output) | ${s.tokensPerSec} |`);
	L.push(`| Sự kiện/s | ${s.eventsPerSec} |`);
	L.push(`| Parent model | ${esc(s.parentModel)} |`);
	L.push("");

	// Anomaly warnings — prominent, right after summary
	const an = report.anomalies || [];
	L.push("## ⚠️ Cảnh báo bất thường (anomaly)");
	L.push("");
	if (!an.length) {
		L.push("✅ Không phát hiện bất thường đáng kể (không failure/stuck/leak/spike bất thường). Anomaly detection tự động dựa trên ngưỡng từ run thật.");
	} else {
		const high = an.filter((a) => a.severity === "HIGH").length;
		const med = an.filter((a) => a.severity === "MEDIUM").length;
		const low = an.filter((a) => a.severity === "LOW").length;
		const icon = (sev) => (sev === "HIGH" ? "🔴" : sev === "MEDIUM" ? "🟡" : "🔵");
		L.push(`> ${high} HIGH 🔴 · ${med} MEDIUM 🟡 · ${low} LOW 🔵 (transient spike = thật nhưng ngắn, không sustained)`);
		L.push("");
		L.push("| Mức | Loại | Subagent | Chi tiết |");
		L.push("|-----|------|----------|----------|");
		for (const a of an) L.push(`| ${icon(a.severity)} ${a.severity} | ${a.category} | ${a.subagent} | ${esc(a.message)} |`);
	}
	L.push("");

	// Timeline
	L.push("## ⏱️ Timeline từng subagent");
	L.push("");
	L.push("| Subagent | Vai trò | PID | Launch | Respawn | Startup | Active work 🔴>30s | Drain | Finalize | Total | Exit |");
	L.push("|----------|---------|-----|--------|---------|---------|-------------------|-------|----------|-------|------|");
	for (const sa of report.subagents) {
		const ph = sa.timeline.phases;
		L.push(
			`| ${sa.taskId} | ${esc(sa.role)} | ${sa.pid ?? "—"} | ${fmtMs(ph.launch)} | ${fmtMs(ph.respawn)}${flag(ph.respawn)} | ${fmtMs(ph.startup)} | ${fmtMs(ph.activeWork)}${flag(ph.activeWork)} | ${fmtMs(ph.drain)} | ${fmtMs(ph.finalize)} | ${fmtMs(ph.total)} | ${exitMeaning(sa.exitCode)} |`,
		);
	}
	L.push("");
	L.push(`*(🔴 = phase vượt 30s — điểm chậm)*`);
	L.push("");

	// Token/Cost/Model
	L.push("## 💰 Token / Cost / Model thật (từ transcript)");
	L.push("");
	L.push("| Subagent | Model | Input | Output | Cache read | Cost | Msg (assistant) | Tool calls |");
	L.push("|----------|-------|-------|--------|------------|------|-----------------|------------|");
	for (const sa of report.subagents) {
		L.push(
			`| ${sa.taskId} | ${esc(sa.model) || esc(sa.modelRouting) || "—"} | ${sa.usage.input?.toLocaleString()} | ${sa.usage.output?.toLocaleString()} | ${sa.usage.cacheRead?.toLocaleString()} | ${money(sa.cost.total)} | ${sa.assistantMsgs} | ${sa.tools} |`,
		);
	}
	L.push(
		`| **TỔNG** | — | **${s.totalTokens.input?.toLocaleString()}** | **${s.totalTokens.output?.toLocaleString()}** | **${s.totalTokens.cacheRead?.toLocaleString()}** | **${s.totalCost > 0 || (s.totalTokens.totalTokens || 0) === 0 ? money(s.totalCost) : "— (không report)"}** | — | — |`,
	);
	L.push("");
	// R11 (audit): surface per-model attempts when a task tried >1 model (retry /
	// fallback). modelAttempts carries {model, success, exitCode, error} per try.
	const retried = report.subagents.filter((sa) => sa.modelAttempts && sa.modelAttempts.length > 1);
	if (retried.length) {
		L.push("**Thử model (retry/fallback):**");
		L.push("");
		for (const sa of retried) {
			const chain = sa.modelAttempts
				.map((ma) => `${ma.model}${ma.success === false ? " ❌" : ma.success === true ? " ✓" : ""}${ma.exitCode ? ` (exit ${ma.exitCode})` : ""}`)
				.join(" → ");
			L.push(`- ${sa.taskId}: ${chain}`);
		}
		L.push("");
	}
	if (report.subagents.some((sa) => !sa.hasTranscript)) {
		L.push(`> ⚠️ Một số subagent không có transcript (usage=0).`);
		L.push("");
	}

	// Top bottlenecks
	L.push("## 🐌 Top Bottlenecks (chậm)");
	L.push("");
	if (report.bottlenecks.length) {
		L.push("| Hạng | Subagent | Phase | Thời lượng | Ghi chú |");
		L.push("|------|----------|-------|-----------|---------|");
		report.bottlenecks.slice(0, 8).forEach((b, i) => {
			L.push(`| ${i + 1} | ${b.taskId} | ${b.phase} | **${fmtMs(b.durationMs)}**${b.durationMs > 30000 ? " 🔴" : ""} | ${esc(b.label)} |`);
		});
	} else {
		L.push("_Không phát hiện bottleneck (>60s)._");
	}
	L.push("");

	// Problems
	L.push("## 🚨 Lỗi & Vấn đề");
	L.push("");
	if (report.problems.length) {
		L.push("| Mức | Loại | Subagent | Chi tiết |");
		L.push("|-----|------|----------|----------|");
		const sevLabel = (n) => (n <= 1 ? "🔴🔴 Nghiêm trọng" : n === 2 ? "🔴 Lỗi" : n === 3 ? "🟡 Blocked" : n === 4 ? "🟡 Retry" : "⚪ Warning");
		report.problems.forEach((p) => {
			L.push(`| ${sevLabel(p.severity)} | ${esc(p.type)} | ${esc(p.taskId || p.phaseName)} | ${esc(p.message)} |`);
		});
	} else {
		L.push("_✅ Không phát hiện lỗi/vấn đề._");
	}
	L.push("");

	// Resources
	L.push("## 📊 Tài nguyên (CPU/RAM)");
	L.push("");
	if (report.resources) {
		const r = report.resources;
		const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;
		L.push(`| Chỉ số | Giá trị |`);
		L.push(`|--------|---------|`);
		L.push(`| Sample count | ${r.sampleCount} |`);
		L.push(`| Peak RSS | ${mb(r.peakRssBytes)} |`);
		L.push(`| Peak CPU% | ${r.peakCpuPct}% |`);
		L.push(`| RSS growth | ${mb(r.rssGrowthBytes)} |`);
		L.push(`| Span | ${fmtMs(r.spanMs)} |`);
		L.push("");
		// R4 (audit): the aggregate peak spans ALL sampled PIDs, including tool
		// subprocesses workers spawn (test-runners, tsc, …) which are NOT
		// attributed to any subagent. So aggregate peak >> any single subagent.
		// Point readers at the per-subagent table for the per-agent cost.
		L.push("> ⚠️ Peak/CPU tổng gồm runner (leader) + infra pi-crew (broker, scanner…) — không thuộc subagent nào. Tool subprocess mà worker spawn ĐƯỢC attribute qua ppid-tree (xem cột Tools). Xem **per-subagent** cho chi phí mỗi agent.");
		L.push("");
		L.push("**Per-PID:**");
		L.push("");
		L.push("| PID | Label | Peak RSS | Peak CPU% |");
		L.push("|-----|-------|----------|-----------|");
		for (const p of r.byPid) {
			L.push(`| ${p.pid} | ${p.label} | ${mb(p.peakRss)} | ${p.peakCpu}% |`);
		}
		// Per-subagent attribution (PID + time-window join) — the core answer to
		// "mỗi subagent tốn tài nguyên ra sao".
		if (r.perSubagent && r.perSubagent.length) {
			L.push("");
			L.push("**Per-subagent (RSS/CPU — gồm tool subprocess qua ppid-tree):**");
			L.push("");
			L.push("| Subagent | PID | Samples | Peak RSS | p95 RSS | Avg RSS | Peak CPU% | p95 CPU% | Avg CPU% | Tools |");
			L.push("|----------|-----|---------|----------|---------|---------|-----------|----------|----------|-------|");
			for (const sa of r.perSubagent) {
				if (sa.attributed) {
					const tools = sa.descendantPids ? sa.descendantPids.length : 0;
					L.push(`| ${sa.taskId} | ${sa.pid} | ${sa.samples} | ${mb(sa.peakRssBytes)} | ${mb(sa.p95RssBytes)} | ${mb(sa.avgRssBytes)} | ${sa.peakCpuPct}% | ${sa.p95CpuPct}% | ${sa.avgCpuPct}% | ${tools} |`);
				} else {
					L.push(`| ${sa.taskId} | ${sa.pid} | 0 | — | — | — | — | — | — | — |`);
				}
			}
			const unattributed = r.perSubagent.filter((sa) => !sa.attributed);
			if (unattributed.length) {
				L.push("");
				L.push(`> ⚠️ ${unattributed.length} subagent không khớp sampler.`);
			}
			L.push("");
			L.push("> **Peak** = max 1-sample (spike, gồm tool transient); **p95** = percentle 95 (typical high, cùng pop peak); **Avg** = worker-own (steady agent, loại tool). Peak≫p95≫avg = spike ngắn, không sustained.");
		}
		if (perAgent) {
			L.push("");
			L.push("→ **Drill-down mỗi agent** (timeline + token + model-chain + resource trajectory + per-event): bench/results/" + report.runId + ".agents/<taskId>.md");
		}
	} else {
		L.push("> _Không có data tài nguyên._ Để thu thập, chạy song song khi start run:");
		L.push(">");
		L.push("");
		L.push("```bash");
		L.push(`node scripts/resource-sampler.mjs --watch-parent <leader-pid> --run-id ${report.runId}`);
		L.push(`# sau đó: node scripts/analyze-run.mjs ${report.runId} --resources bench/results/${report.runId}.resources.jsonl`);
		L.push("```");
		L.push("");
	}
	L.push("");

	// Throughput
	L.push("## ⚡ Throughput");
	L.push("");
	L.push("| Chỉ số | Giá trị |");
	L.push("|--------|---------|");
	L.push(`| Sự kiện/s | ${s.eventsPerSec} |`);
	L.push(`| Token output/s | ${s.tokensPerSec} |`);
	L.push(`| Tổng sự kiện | ${s.eventCount} |`);
	const totalTools = report.subagents.reduce((a, sa) => a + sa.tools, 0);
	const totalMsgs = report.subagents.reduce((a, sa) => a + sa.assistantMsgs, 0);
	L.push(`| Tổng tool calls | ${totalTools} |`);
	L.push(`| Tổng assistant messages | ${totalMsgs} |`);
	L.push("");

	// Event type histogram (top)
	L.push("## 📈 Phân bố sự kiện (top loại)");
	L.push("");
	L.push("| Loại sự kiện | Số lượng |");
	L.push("|--------------|----------|");
	const sortedTypes = Object.entries(report.typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
	for (const [type, count] of sortedTypes) {
		L.push(`| ${esc(type)} | ${count} |`);
	}
	L.push("");

	// Khuyến nghị
	L.push("## 💡 Khuyến nghị");
	L.push("");
	const recs = [];
	if (report.bottlenecks.length) {
		recs.push(`- 🔴 Bottleneck lớn nhất: **${report.bottlenecks[0].taskId}** (${fmtMs(report.bottlenecks[0].durationMs)}) — kiểm tra độ trễ model / số token / retry.`);
	}
	const blocks = report.problems.filter((p) => p.type === "phase_guard_blocked");
	if (blocks.length) {
		recs.push(`- 🟡 ${blocks.length}× phase guard bị block (lý do: "${esc(blocks[0].value)}") — đảm bảo subagent tạo artifact yêu cầu trước khi kết thúc phase.`);
	}
	const nonZeroExit = report.problems.filter((p) => p.type === "exit_code");
	if (nonZeroExit.length) {
		recs.push(`- 🔴 ${nonZeroExit.length} subagent exit ≠ 0 — kiểm tra log worker.`);
	}
	if (!report.resources) {
		recs.push("- ⚪ Chưa có data CPU/RAM — chạy resource-sampler song song ở lần sau.");
	}
	if (!recs.length) recs.push("- ✅ Run sạch, không phát hiện vấn đề đáng kể.");
	L.push(...recs);
	L.push("");
	// Per-event top gaps (--events) — where wall time actually went
	if (report.eventTimeline && report.eventTimeline.topGaps?.length) {
		L.push("## 🔍 Per-event — top gaps (đâu mất thời gian)");
		L.push("");
		L.push(`Timeline đầy đủ: \`bench/results/${report.runId}.events-timeline.csv\` (${report.eventTimeline.eventCount} events).`);
		L.push("");
		L.push("| Δms | elapsed | event | task | ý nghĩa thường |");
		L.push("|-----|---------|-------|------|----------------|");
		const meaning = (g) => {
			if (g.type === "worker.spawned") return "spawn + pi boot (~1.2s) + schedule";
			if (g.type === "worker.exit") return "LLM turn cuối trước exit";
			if (g.type === "task.progress") return "LLM turn / tool execution";
			return "—";
		};
		for (const g of report.eventTimeline.topGaps.slice(0, 10)) {
			L.push(`| ${g.deltaMs} | ${(g.elapsedMs / 1000).toFixed(1)}s | ${esc(g.type)} | ${esc(g.taskId || "")} | ${meaning(g)} |`);
		}
		L.push("");
		L.push("> Per-event **token** không có (events.jsonl redact `\"***\"`, transcript không timestamp) — chỉ timing + resource per-event. Token vẫn là per-task tổng.");
		L.push("");
	}
	L.push("---");
	L.push(`*Báo cáo tự động — dữ liệu từ \`${esc(ea.eventCount)}\` sự kiện và transcripts.*`);

	return L.join("\n");
}

main().catch((e) => {
	process.stderr.write(`[analyze-run] fatal: ${e.stack || e}\n`);
	process.exit(1);
});
