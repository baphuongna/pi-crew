/**
 * Regression tests pinning the iterative-audit fixes (R1, R2, R5 + path
 * injection) on scripts/analyze-run.mjs.
 *
 * These tests exist because the audit loop made 5 fixes with ZERO tests — a
 * skill anti-pattern ("every fix needs a test that would have caught the bug").
 * They build a minimal fixture run state and drive the analyzer as a real
 * subprocess, asserting the JSON output.
 *
 * R1 — wall time present even when run terminates via run.cancelled (no
 *      run.completed). Previously showed "—".
 * R2 — multi-attempt transcripts: usage summed across attempts, not
 *      overwritten by the last attempt.
 * R5 — real error text from tasks.json appears in the problems list.
 * PI  — path-injection: invalid runId rejected with exit 1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ANALYZE = new URL("../../../scripts/analyze-run.mjs", import.meta.url);

/** Build a minimal fixture .crew state dir for runId `r`. */
function buildFixtureCrew() {
	const crew = mkdtempSync(join(tmpdir(), "analyze-audit-"));
	const runState = join(crew, "state", "runs", "r");
	const artifacts = join(crew, "artifacts", "r", "transcripts");
	mkdirSync(runState, { recursive: true });
	mkdirSync(artifacts, { recursive: true });

	const events = [
		{ time: "2026-08-06T08:00:00.000Z", type: "run.created", runId: "r", metadata: { seq: 1 } },
		{ time: "2026-08-06T08:00:01.000Z", type: "task.started", runId: "r", taskId: "01_plan", data: { role: "planner" } },
		{ time: "2026-08-06T08:00:01.500Z", type: "worker.spawned", runId: "r", taskId: "01_plan", data: { pid: 111 } },
		{ time: "2026-08-06T08:00:02.000Z", type: "task.progress", runId: "r", taskId: "01_plan", message: "p1" },
		{ time: "2026-08-06T08:00:03.000Z", type: "task.progress", runId: "r", taskId: "01_plan", message: "p2" },
		{ time: "2026-08-06T08:00:04.000Z", type: "worker.exit", runId: "r", taskId: "01_plan", data: { exitCode: 143 } },
		{ time: "2026-08-06T08:00:05.000Z", type: "run.cancelled", runId: "r", message: "aborted" },
	];
	writeFileSync(join(runState, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

	writeFileSync(
		join(runState, "tasks.json"),
		JSON.stringify([
			{
				id: "01_plan",
				role: "planner",
				agent: "worker",
				status: "failed",
				exitCode: 143,
				attempts: [{ attemptId: "a0" }, { attemptId: "a1" }],
				error: "Child Pi exited with 143",
				cwd: tmpdir(),
			},
		]),
	);

	const msg = (model: string, usage: Record<string, unknown>) => ({
		type: "message_end",
		message: { role: "assistant", model, usage },
	});
	writeFileSync(
		join(artifacts, "01_plan.attempt-0.jsonl"),
		JSON.stringify(msg("model-a", { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0.01 } })) + "\n",
	);
	writeFileSync(
		join(artifacts, "01_plan.attempt-1.jsonl"),
		JSON.stringify(msg("model-b", { input: 2000, output: 200, totalTokens: 2200, cost: { total: 0.02 } })) + "\n",
	);

	return { crew, work: mkdtempSync(join(tmpdir(), "analyze-audit-work-")) };
}

/** Build a crew with ONE clean subagent (status/exit configurable) and a
 * single attempt transcript. For anomaly tests that need a non-failed task. */
function buildCleanCrew(status: string, exitCode: number, attempts = 1) {
	const crew = mkdtempSync(join(tmpdir(), "analyze-clean-"));
	const runState = join(crew, "state", "runs", "r");
	const artifacts = join(crew, "artifacts", "r", "transcripts");
	mkdirSync(runState, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	const events = [
		{ time: "2026-08-06T08:00:00.000Z", type: "run.created", runId: "r", metadata: { seq: 1 } },
		{ time: "2026-08-06T08:00:01.000Z", type: "task.started", runId: "r", taskId: "01_plan", data: { role: "planner" } },
		{ time: "2026-08-06T08:00:01.500Z", type: "worker.spawned", runId: "r", taskId: "01_plan", data: { pid: 111 } },
		{ time: "2026-08-06T08:00:02.000Z", type: "task.progress", runId: "r", taskId: "01_plan", message: "p1" },
		{ time: "2026-08-06T08:00:04.000Z", type: "worker.exit", runId: "r", taskId: "01_plan", data: { exitCode } },
		...(status === "cancelled"
			? [{ time: "2026-08-06T08:00:05.000Z", type: "run.cancelled", runId: "r", message: "aborted" }]
			: [{ time: "2026-08-06T08:00:05.000Z", type: "run.completed", runId: "r" }]),
	];
	writeFileSync(join(runState, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const att = Array.from({ length: attempts }, (_, i) => ({ attemptId: `a${i}` }));
	writeFileSync(
		join(runState, "tasks.json"),
		JSON.stringify([{ id: "01_plan", role: "planner", agent: "worker", status, exitCode, attempts: att, cwd: tmpdir() }]),
	);
	const msg = {
		type: "message_end",
		message: { role: "assistant", model: "glm", usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0.01 } } },
	};
	for (let i = 0; i < attempts; i++) writeFileSync(join(artifacts, `01_plan.attempt-${i}.jsonl`), JSON.stringify(msg) + "\n");
	return { crew, work: mkdtempSync(join(tmpdir(), "analyze-clean-work-")) };
}

/** Write a resources jsonl for pid=111 with a per-sample CPU/RSS profile. ts
 * are UTC epoch (must match event ISO "Z"). */
function writeResources(path: string, profile: { cpuPct: number; rssBytes: number }[]) {
	const t0 = Date.parse("2026-08-06T08:00:01.500Z");
	const lines = profile.map((p, i) =>
		JSON.stringify({ ts: t0 + i * 100, pid: 111, ppid: 1, label: "root", rssBytes: p.rssBytes, heapBytes: 0, cpuPct: p.cpuPct }),
	);
	writeFileSync(path, lines.join("\n") + "\n");
}

/** Flexible crew builder for anomaly-rule tests. Controls status, attempts,
 * modelAttempts, output tokens, API-error turns, worker spawn count, terminal. */
function buildAnomalyCrew(opts: {
	status?: string;
	exitCode?: number;
	attemptCount?: number;
	modelAttempts?: { model: string; success: boolean }[];
	outputTokens?: number;
	inputTokens?: number;
	cacheRead?: number;
	apiErrors?: number; // message_end lines carrying errorMessage
	spawnCount?: number;
	launchMs?: number; // task.started → worker.spawned gap (default 1500)
	drainMs?: number; // last progress → worker.exit gap (default 2000)
	terminal?: string; // "run.completed" | "run.cancelled" | ...
	costTotal?: number; // usage.cost.total per turn (default 0.01; 0 = unreported)
	toolCalls?: number; // toolCall content entries in the clean message_end
}) {
	const status = opts.status ?? "completed";
	const exitCode = opts.exitCode ?? 0;
	const attN = opts.attemptCount ?? 1;
	const out = opts.outputTokens ?? 100;
	const inp = opts.inputTokens ?? 1000;
	const cache = opts.cacheRead ?? 1000;
	const costT = opts.costTotal ?? 0.01;
	const apiErr = opts.apiErrors ?? 0;
	const spawns = Math.max(1, opts.spawnCount ?? 1);
	const terminal = opts.terminal ?? "run.completed";
	const launchMs = opts.launchMs ?? 1500;
	const drainMs = opts.drainMs ?? 2000;
	const crew = mkdtempSync(join(tmpdir(), "analyze-anom-"));
	const runState = join(crew, "state", "runs", "r");
	const artifacts = join(crew, "artifacts", "r", "transcripts");
	mkdirSync(runState, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	const T0 = Date.parse("2026-08-06T08:00:01.000Z"); // task.started
	const iso = (ms: number) => new Date(ms).toISOString();
	const spawnT = T0 + launchMs;
	const progT = spawnT + 1000;
	const exitT = progT + drainMs;
	const ev: object[] = [
		{ time: iso(T0), type: "run.created", runId: "r", metadata: { seq: 1 } },
		{ time: iso(T0), type: "task.started", runId: "r", taskId: "01_plan", data: { role: "planner" } },
	];
	for (let i = 0; i < spawns; i++)
		ev.push({ time: iso(spawnT + i * 100), type: "worker.spawned", runId: "r", taskId: "01_plan", data: { pid: 111 } });
	ev.push(
		{ time: iso(progT), type: "task.progress", runId: "r", taskId: "01_plan", message: "p1" },
		{ time: iso(exitT), type: "worker.exit", runId: "r", taskId: "01_plan", data: { exitCode } },
		{ time: iso(exitT + 1000), type: terminal, runId: "r" },
	);
	writeFileSync(join(runState, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const taskObj: Record<string, unknown> = {
		id: "01_plan",
		role: "planner",
		agent: "worker",
		status,
		exitCode,
		attempts: Array.from({ length: attN }, (_, i) => ({ attemptId: `a${i}` })),
		cwd: tmpdir(),
	};
	if (opts.modelAttempts) taskObj.modelAttempts = opts.modelAttempts;
	writeFileSync(join(runState, "tasks.json"), JSON.stringify([taskObj]));
	const lines: string[] = [];
	for (let i = 0; i < apiErr; i++)
		lines.push(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					model: "glm",
					usage: { input: inp, output: 0, cacheRead: cache, totalTokens: inp, cost: { total: 0 } },
					errorMessage: "429 rate limited",
				},
			}),
		);
	lines.push(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "glm",
				content: opts.toolCalls ? Array.from({ length: opts.toolCalls }, () => ({ type: "toolCall" })) : undefined,
				usage: { input: inp, output: out, cacheRead: cache, totalTokens: inp + out, cost: { total: costT } },
			},
		}),
	);
	writeFileSync(join(artifacts, "01_plan.attempt-0.jsonl"), lines.join("\n") + "\n");
	return { crew, work: mkdtempSync(join(tmpdir(), "analyze-anom-work-")) };
}

const anomCats = (rep: { anomalies?: { severity: string; category: string }[] }) =>
	(rep.anomalies || []).map((a) => `${a.severity}:${a.category}`);

/** Build a crew with N subagents for run-level anomaly tests. Each task runs a
 * short spawn→exit window; the run wall is controlled by `runSpanMs`. */
function buildMultiCrew(tasks: { id: string; status: string; exitCode: number }[], runSpanMs: number) {
	const crew = mkdtempSync(join(tmpdir(), "analyze-multi-"));
	const runState = join(crew, "state", "runs", "r");
	const artifacts = join(crew, "artifacts", "r", "transcripts");
	mkdirSync(runState, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	const T0 = Date.parse("2026-08-06T08:00:00.000Z");
	const iso = (ms: number) => new Date(ms).toISOString();
	const ev: object[] = [{ time: iso(T0), type: "run.created", runId: "r", metadata: { seq: 1 } }];
	let cursor = T0 + 1000;
	for (const t of tasks) {
		ev.push(
			{ time: iso(cursor), type: "task.started", runId: "r", taskId: t.id, data: { role: "worker" } },
			{ time: iso(cursor), type: "worker.spawned", runId: "r", taskId: t.id, data: { pid: 100 + tasks.indexOf(t) } },
			{ time: iso(cursor + 1000), type: "task.progress", runId: "r", taskId: t.id, message: "p" },
			{ time: iso(cursor + 2000), type: "worker.exit", runId: "r", taskId: t.id, data: { exitCode: t.exitCode } },
		);
		cursor += 3000;
	}
	ev.push({ time: iso(T0 + runSpanMs), type: "run.completed", runId: "r" });
	writeFileSync(join(runState, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(
		join(runState, "tasks.json"),
		JSON.stringify(
			tasks.map((t) => ({
				id: t.id,
				role: "worker",
				agent: "worker",
				status: t.status,
				exitCode: t.exitCode,
				attempts: [{ attemptId: "a0" }],
				cwd: tmpdir(),
			})),
		),
	);
	for (const t of tasks)
		writeFileSync(
			join(artifacts, `${t.id}.attempt-0.jsonl`),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", model: "glm", usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0.01 } } },
			}) + "\n",
		);
	return { crew, work: mkdtempSync(join(tmpdir(), "analyze-multi-work-")) };
}

function runAnalyzer(runId: string, crewRoot: string, workCwd: string, resourcesPath?: string, events = false) {
	const cmd = ["--experimental-strip-types", ANALYZE.pathname, runId, "--crew-root", crewRoot];
	if (resourcesPath) cmd.push("--resources", resourcesPath);
	if (events) cmd.push("--events");
	const res = spawnSync(process.execPath, cmd, { encoding: "utf-8", cwd: workCwd, timeout: 30_000 });
	return res;
}

/** Read the JSON report the analyzer writes to <work>/bench/results/<runId>.json. */
function readReport(workCwd: string, runId: string) {
	const raw = readFileSync(join(workCwd, "bench", "results", `${runId}.json`), "utf-8");
	return JSON.parse(raw);
}

test("R1: wall time present for cancelled run (no run.completed)", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const res = runAnalyzer("r", crew, work);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		// run.created @ 08:00:00 → run.cancelled @ 08:00:05 = 5000ms
		assert.equal(report.summary.wallMs, 5000, "wallMs must be 5000 for cancelled run");
		assert.ok(report.summary.eventsPerSec > 0, "eventsPerSec must be non-zero");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("R2: multi-attempt transcripts summed (not overwritten)", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const res = runAnalyzer("r", crew, work);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		const plan = report.subagents.find((s: { taskId: string }) => s.taskId === "01_plan");
		// attempt-0 input 1000 + attempt-1 input 2000 = 3000
		assert.equal(plan.usage.input, 3000, "input must sum across attempts (was overwrite bug)");
		assert.equal(plan.usage.output, 300, "output must sum across attempts");
		assert.equal(plan.cost.total, 0.03, "cost must sum across attempts");
		// both models captured (retry switched model)
		assert.ok(plan.model.includes("model-a") && plan.model.includes("model-b"), `models: ${plan.model}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("R5: real error text from tasks.json surfaces in problems", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const res = runAnalyzer("r", crew, work);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		const exitProblem = report.problems.find((p: { type: string; message: string }) => p.type === "exit_code");
		assert.ok(exitProblem, "expected an exit_code problem");
		assert.match(exitProblem.message, /Child Pi exited with 143/, "must include the real error text");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("path-injection: invalid runId rejected (exit 1)", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const res = runAnalyzer("../../tmp/evil", crew, work);
		assert.notEqual(res.status, 0, "invalid runId must not succeed");
		assert.match(res.stderr, /invalid runId/, "must explain the rejection");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

/** R12: a task that is status=completed but verification.satisfied===false
 * must be surfaced as a problem. Uses its own fixture (completed + verify-fail). */
test("p95: distinguishes a single-sample spike from typical high", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		// 20 samples for worker pid=111: 19 steady at 50MB/10%, 1 spike at 800MB/300%.
		// → peak=800MB/300% (the spike), p95≈50MB/10% (typical high excludes the
		// single spike), avg≈50MB/10%. Proves p95 contextualizes the peak.
		const lo = Date.parse("2026-08-06T08:00:01.500Z");
		const resPath = join(work, "p95.resources.jsonl");
		const lines = [];
		for (let i = 0; i < 20; i++) {
			const spike = i === 5;
			lines.push(
				JSON.stringify({
					ts: lo + i * 100,
					pid: 111,
					ppid: 1,
					label: "root",
					rssBytes: spike ? 800_000_000 : 50_000_000,
					heapBytes: 0,
					cpuPct: spike ? 300 : 10,
				}),
			);
		}
		writeFileSync(resPath, lines.join("\n") + "\n");
		const res = runAnalyzer("r", crew, work, resPath);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		const plan = report.resources.perSubagent.find((s: { taskId: string }) => s.taskId === "01_plan");
		assert.equal(plan.peakRssBytes, 800_000_000, "peak = the spike");
		assert.equal(plan.peakCpuPct, 300, "peak CPU = the spike");
		assert.ok(plan.p95RssBytes < plan.peakRssBytes, `p95 RSS (${plan.p95RssBytes}) must be < peak (spike excluded)`);
		assert.ok(plan.p95CpuPct < plan.peakCpuPct, `p95 CPU (${plan.p95CpuPct}) must be < peak`);
		assert.equal(plan.p95RssBytes, 50_000_000, "p95 RSS = steady value (spike is <5% of samples)");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: failed task + model retry + transient spike → HIGH/MEDIUM/LOW", () => {
	const { crew, work } = buildFixtureCrew(); // 01_plan failed, 2 attempts (model-a/model-b)
	try {
		// resource: 19 steady at 50%/100MB + 1 spike at 300%/800MB
		const res = join(work, "spike.jsonl");
		writeResources(
			res,
			Array.from({ length: 20 }, (_, i) =>
				i === 5 ? { cpuPct: 300, rssBytes: 800_000_000 } : { cpuPct: 50, rssBytes: 100_000_000 },
			),
		);
		const r = runAnalyzer("r", crew, work, res);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const rep = readReport(work, "r");
		const cats = (rep.anomalies || []).map((a: { category: string; severity: string }) => `${a.severity}:${a.category}`);
		assert.ok(cats.includes("HIGH:task_failed"), `expected HIGH task_failed in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("MEDIUM:model_retry"), `expected MEDIUM model_retry in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("LOW:transient_cpu_spike"), `expected LOW transient_cpu_spike in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("LOW:transient_rss_spike"), `expected LOW transient_rss_spike in ${JSON.stringify(cats)}`);
		// no false positives: fixture is fast (no slow_phase/large_gap) and spike is transient (not sustained)
		assert.ok(
			!cats.some((c: string) => c.endsWith("sustained_cpu")),
			`sustained_cpu must NOT fire for a transient spike: ${JSON.stringify(cats)}`,
		);
		assert.ok(
			!cats.some((c: string) => c.endsWith("rss_growth")),
			`rss_growth must NOT fire for steady worker RSS: ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: sustained high CPU (p95>150) → HIGH", () => {
	const { crew, work } = buildCleanCrew("completed", 0, 1);
	try {
		// 20 samples ALL at 350% CPU / 100MB → p95=350% (sustained HIGH), peak≈p95 (no transient spike)
		const res = join(work, "sustained.jsonl");
		writeResources(
			res,
			Array.from({ length: 20 }, () => ({ cpuPct: 350, rssBytes: 100_000_000 })),
		);
		const r = runAnalyzer("r", crew, work, res);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const rep = readReport(work, "r");
		const cats = (rep.anomalies || []).map((a: { category: string; severity: string }) => `${a.severity}:${a.category}`);
		assert.ok(cats.includes("HIGH:sustained_cpu"), `expected HIGH sustained_cpu (p95>150) in ${JSON.stringify(cats)}`);
		// peak≈p95 so transient_spike must NOT fire
		assert.ok(
			!cats.some((c: string) => c.endsWith("transient_cpu_spike")),
			`transient must NOT fire when peak≈p95: ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: clean steady run → no anomalies", () => {
	const { crew, work } = buildCleanCrew("completed", 0, 1);
	try {
		// steady low load, no spike, no growth, fast timeline
		const res = join(work, "clean.jsonl");
		writeResources(
			res,
			Array.from({ length: 20 }, () => ({ cpuPct: 30, rssBytes: 100_000_000 })),
		);
		const r = runAnalyzer("r", crew, work, res);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const rep = readReport(work, "r");
		assert.equal(rep.anomalies.length, 0, `clean run must have ZERO anomalies: ${JSON.stringify(rep.anomalies)}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: model cascade (>5 attempts) → HIGH with truncated chain", () => {
	const { crew, work } = buildAnomalyCrew({ attemptCount: 6 }); // 6 attempts → pathological
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("HIGH:model_cascade"), `expected HIGH model_cascade in ${JSON.stringify(cats)}`);
		const a = readReport(work, "r").anomalies.find((x: { category: string }) => x.category === "model_cascade");
		assert.ok(!/more than 40 chars per model/.test(a.message), "chain must be truncated");
		assert.ok(a.message.includes("6 attempt"), `message must mention 6 attempts: ${a.message}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: API error storm + zero-output completion (429 fixture) → HIGH", () => {
	// 4 message_end: 3 with errorMessage(429)+output0, 1 clean → 75% errored, output>0 on clean
	const { crew, work } = buildAnomalyCrew({ apiErrors: 3, outputTokens: 50 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("HIGH:api_error_storm"), `expected HIGH api_error_storm (3/4=75%>50%) in ${JSON.stringify(cats)}`);
		// output=50>0 so zero_output_completion must NOT fire
		assert.ok(
			!cats.some((c: string) => c.endsWith("zero_output_completion")),
			`zero_output must NOT fire when output>0: ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: zero-output completion (all 429, output=0) → HIGH", () => {
	// 4 message_end all errored with output 0 → zero_output_completion fires
	const { crew, work } = buildAnomalyCrew({ apiErrors: 4, outputTokens: 0 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("HIGH:zero_output_completion"), `expected HIGH zero_output_completion in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("HIGH:api_error_storm"), `api_error_storm also fires`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: worker respawn churn (5 spawns) → MEDIUM", () => {
	const { crew, work } = buildAnomalyCrew({ spawnCount: 5 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(
			cats.includes("MEDIUM:worker_respawn_churn"),
			`expected MEDIUM worker_respawn_churn (5 spawns) in ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: run not completed (cancelled) → HIGH run-level", () => {
	const { crew, work } = buildAnomalyCrew({ terminal: "run.cancelled" });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const rep = readReport(work, "r");
		const cats = anomCats(rep);
		assert.ok(cats.includes("HIGH:run_not_completed"), `expected HIGH run_not_completed in ${JSON.stringify(cats)}`);
		const a = rep.anomalies.find((x: { category: string }) => x.category === "run_not_completed");
		assert.equal(a.subagent, "(run)", `run-level anomaly subagent must be "(run)": ${a.subagent}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: launch_delay + drain_stall + token_imbalance + no_cache (grounded thresholds)", () => {
	// one fixture tuned to hit all 4 new conservative rules at once:
	// launch 16s, drain 6s, input/output 1000× with 0 cache-read, 2 turns.
	const { crew, work } = buildAnomalyCrew({
		launchMs: 16000,
		drainMs: 6000,
		inputTokens: 100_000,
		outputTokens: 100,
		cacheRead: 0,
		apiErrors: 1,
	});
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("MEDIUM:launch_delay"), `expected launch_delay in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("LOW:drain_stall"), `expected drain_stall in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("LOW:token_imbalance"), `expected token_imbalance in ${JSON.stringify(cats)}`);
		assert.ok(cats.includes("LOW:no_cache"), `expected no_cache in ${JSON.stringify(cats)}`);
		// 1/2 = 50% is NOT >50%, so api_error_storm must NOT fire; output>0 so zero_output neither
		assert.ok(
			!cats.some((c: string) => c.endsWith("api_error_storm")),
			`50% errors must not fire api_error_storm: ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: run_idle — run wall ≫ Σ subagent wall → MEDIUM", () => {
	// 2 subagents each spawn→exit ~2s (sumWall ~4s); run spans 120s → ~116s idle
	const { crew, work } = buildMultiCrew(
		[
			{ id: "01_a", status: "completed", exitCode: 0 },
			{ id: "02_b", status: "completed", exitCode: 0 },
		],
		120_000,
	);
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("MEDIUM:run_idle"), `expected run_idle (wall≫sumWall) in ${JSON.stringify(cats)}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: high_failure_rate — >50% subagents failed → HIGH", () => {
	// 2 of 3 failed → 67% > 50%
	const { crew, work } = buildMultiCrew(
		[
			{ id: "01_a", status: "failed", exitCode: 1 },
			{ id: "02_b", status: "failed", exitCode: 1 },
			{ id: "03_c", status: "completed", exitCode: 0 },
		],
		10_000,
	);
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("HIGH:high_failure_rate"), `expected high_failure_rate (2/3 failed) in ${JSON.stringify(cats)}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: missing_transcript — task with no transcript → MEDIUM (silent undercount)", () => {
	const { crew, work } = buildMultiCrew(
		[
			{ id: "01_a", status: "completed", exitCode: 0 },
			{ id: "02_b", status: "completed", exitCode: 0 },
		],
		10_000,
	);
	try {
		// delete 02_b's transcript → hasTranscript=false, 0 tokens → must warn
		rmSync(join(crew, "artifacts", "r", "transcripts", "02_b.attempt-0.jsonl"));
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("MEDIUM:missing_transcript"), `expected missing_transcript for 02_b in ${JSON.stringify(cats)}`);
		const a = readReport(work, "r").anomalies.find((x: { category: string }) => x.category === "missing_transcript");
		assert.equal(a.subagent, "02_b", `must flag the transcript-less task`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("accuracy: respawn run — launch=first-spawn, wall=full-lifetime, respawn phase set", () => {
	// 3 worker.spawned (spawn churn); launch must be task→FIRST spawn (not last),
	// wall must span FIRST spawn→exit (not last→exit), and a `respawn` phase must
	// capture the churn window. Previously launch was 100s and wall missed churn.
	const { crew, work } = buildAnomalyCrew({ spawnCount: 3, launchMs: 5000, drainMs: 2000 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const ph = readReport(work, "r").subagents[0].timeline.phases;
		assert.ok(Math.abs(ph.launch - 5000) <= 50, `launch must be ~5000 (task→FIRST spawn), got ${ph.launch}`);
		assert.ok(ph.respawn >= 150 && ph.respawn <= 300, `respawn phase must capture 3×100ms churn (~200ms), got ${ph.respawn}`);
		// wall = FIRST spawn → exit = launchMs(spawn offset) ... actually firstSpawn→exit
		assert.ok(ph.wall > ph.respawn, `wall must span full lifetime (>${ph.respawn}ms churn), got ${ph.wall}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: cost_unreported — tokens>0 & cost=0 → LOW (metric unavailable)", () => {
	const { crew, work } = buildAnomalyCrew({ outputTokens: 100, costTotal: 0 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("LOW:cost_unreported"), `expected cost_unreported (tokens>0, cost=0) in ${JSON.stringify(cats)}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: cost_unreported does NOT fire when cost is reported (>0)", () => {
	const { crew, work } = buildAnomalyCrew({ outputTokens: 100, costTotal: 0.05 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(
			!cats.some((c: string) => c.endsWith("cost_unreported")),
			`cost_unreported must NOT fire when cost>0: ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("accuracy: avg CPU excludes firstSample (cpuPct=0 by construction)", () => {
	const { crew, work } = buildCleanCrew("completed", 0, 1);
	try {
		const t0 = Date.parse("2026-08-06T08:00:01.500Z");
		const res = join(work, "fs.jsonl");
		const lines = [
			{ ts: t0, pid: 111, ppid: 1, label: "root", rssBytes: 100_000_000, cpuPct: 0, firstSample: true },
			{ ts: t0 + 100, pid: 111, ppid: 1, label: "root", rssBytes: 100_000_000, cpuPct: 50 },
			{ ts: t0 + 200, pid: 111, ppid: 1, label: "root", rssBytes: 100_000_000, cpuPct: 50 },
		];
		writeFileSync(res, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		const r = runAnalyzer("r", crew, work, res);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const sa = readReport(work, "r").resources.perSubagent.find((x: { taskId: string }) => x.taskId === "01_plan");
		assert.equal(sa.avgCpuPct, 50, `avg CPU must exclude firstSample (was 33 when dragged): ${sa.avgCpuPct}`);
		assert.equal(sa.avgRssBytes, 100_000_000, "avg RSS must KEEP the first sample (absolute read)");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: sampler_gap — resources collected but none attributed to subagent → LOW", () => {
	const { crew, work } = buildAnomalyCrew({});
	try {
		// resources sample for pid 999 (NOT 111 = 01_plan's worker) → 01_plan gets 0 samples
		const res = join(work, "gap.jsonl");
		const t0 = Date.parse("2026-08-06T08:00:01.500Z");
		writeFileSync(res, JSON.stringify({ ts: t0, pid: 999, ppid: 1, label: "child", rssBytes: 50_000_000, cpuPct: 10 }) + "\n");
		const r = runAnalyzer("r", crew, work, res);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(
			cats.includes("LOW:sampler_gap"),
			`expected sampler_gap (samples exist but 01_plan unattributed) in ${JSON.stringify(cats)}`,
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("anomaly: tool_churn — >30 tool calls → LOW", () => {
	const { crew, work } = buildAnomalyCrew({ toolCalls: 35 });
	try {
		const r = runAnalyzer("r", crew, work);
		assert.equal(r.status, 0, `analyzer failed: ${r.stderr}`);
		const cats = anomCats(readReport(work, "r"));
		assert.ok(cats.includes("LOW:tool_churn"), `expected tool_churn (35 calls>30) in ${JSON.stringify(cats)}`);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("--agents: writes one detail file per subagent", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const res = runAnalyzer("r", crew, work, undefined, true);
		// runAnalyzer 5th arg is `events`; --agents needs a separate invocation path.
		// Re-run with both via direct spawn to exercise --agents.
		const res2 = spawnSync(
			process.execPath,
			["--experimental-strip-types", ANALYZE.pathname, "r", "--crew-root", crew, "--agents", "--events"],
			{ encoding: "utf-8", cwd: work, timeout: 30_000 },
		);
		assert.equal(res2.status, 0, `analyzer failed: ${res2.stderr}`);
		const agentsDir = join(work, "bench", "results", "r.agents");
		assert.ok(existsSync(agentsDir), "r.agents/ dir must exist");
		const planFile = join(agentsDir, "01_plan.md");
		assert.ok(existsSync(planFile), "01_plan.md must exist");
		const md = readFileSync(planFile, "utf-8");
		assert.match(md, /Subagent `01_plan`/, "file is a subagent report");
		assert.match(md, /Timeline \(phases\)/, "has timeline section");
		assert.match(md, /Token \/ Cost/, "has token section");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("--events: per-event timeline CSV + topGaps", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		const resPath = join(work, "ev.resources.jsonl");
		const lo = Date.parse("2026-08-06T08:00:01.500Z");
		writeFileSync(
			resPath,
			[lo + 500, lo + 1500, lo + 2500]
				.map((ts, i) =>
					JSON.stringify({
						ts,
						pid: 111,
						ppid: 1,
						label: "root",
						rssBytes: 50_000_000 + i * 10_000_000,
						heapBytes: 0,
						cpuPct: 10 + i * 5,
					}),
				)
				.join("\n") + "\n",
		);
		const res = runAnalyzer("r", crew, work, resPath, true);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		// CSV written
		const csvPath = join(work, "bench", "results", "r.events-timeline.csv");
		assert.ok(existsSync(csvPath), "events-timeline.csv must be written");
		const csv = readFileSync(csvPath, "utf-8");
		assert.ok(csv.startsWith("seq,elapsed_s,delta_ms,type,taskId,workerPid,workerRSS,workerCPU"), "CSV header correct");
		assert.ok(csv.trim().split("\n").length > 5, "CSV has event rows");
		// report.eventTimeline present
		const report = readReport(work, "r");
		assert.ok(report.eventTimeline, "report.eventTimeline must be present with --events");
		assert.ok(report.eventTimeline.eventCount > 0, "eventCount > 0");
		assert.ok(Array.isArray(report.eventTimeline.topGaps), "topGaps is an array");
		// topGaps sorted descending by deltaMs
		const deltas = report.eventTimeline.topGaps.map((g: { deltaMs: number }) => g.deltaMs);
		assert.deepEqual(
			[...deltas].sort((a: number, b: number) => b - a),
			deltas,
			"topGaps sorted desc",
		);
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("RS-tree: grandchildren attributed via ppid-tree walk", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		// worker.spawned pid=111 (01_plan). Add samples for a GRANDCHILD chain:
		// pid=222 ppid=111 (direct child of worker), pid=333 ppid=222 (deeper).
		// Neither 222 nor 333 is a worker PID, but both must attribute to 01_plan.
		const lo = Date.parse("2026-08-06T08:00:01.500Z");
		const hi = Date.parse("2026-08-06T08:00:04.000Z");
		const resPath = join(work, "tree.resources.jsonl");
		const mk = (ts: number, pid: number, ppid: number, rss: number) =>
			JSON.stringify({ ts, pid, ppid, label: pid === 111 ? "root" : "child", rssBytes: rss, heapBytes: 0, cpuPct: 0 });
		const lines = [
			mk(lo + 500, 111, 1, 50_000_000), // worker itself
			mk(lo + 1000, 222, 111, 400_000_000), // child-of-worker (e.g. bash)
			mk(lo + 1500, 333, 222, 800_000_000), // grandchild (e.g. test-runner)
			mk(lo + 2000, 111, 1, 60_000_000), // worker again
		];
		writeFileSync(resPath, lines.join("\n") + "\n");
		const res = runAnalyzer("r", crew, work, resPath);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		const plan = report.resources.perSubagent.find((s: { taskId: string }) => s.taskId === "01_plan");
		assert.ok(plan.attributed, "worker must be attributed");
		assert.equal(plan.peakRssBytes, 800_000_000, "peak must include grandchild (800MB), not just worker (60MB)");
		assert.ok((plan.descendantPids || []).includes(222) && plan.descendantPids.includes(333), "both descendants must be listed");
		assert.ok(plan.samples >= 4, "all 4 samples (worker+child+grandchild) must count");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("RS: per-subagent resource attribution via PID + time-window join", () => {
	const { crew, work } = buildFixtureCrew();
	try {
		// The fixture's worker.spawned is pid=111 @ 2026-08-06T08:00:01.500Z and
		// worker.exit @ 2026-08-06T08:00:04.000Z. Build sampler samples for pid=111
		// INSIDE that window, plus one OUTSIDE (must be excluded).
		const lo = Date.parse("2026-08-06T08:00:01.500Z");
		const hi = Date.parse("2026-08-06T08:00:04.000Z");
		const resPath = join(work, "fake.resources.jsonl");
		const mk = (ts: number, pid: number, rss: number, cpu: number) =>
			JSON.stringify({ ts, pid, ppid: 1, label: pid === 111 ? "root" : "child", rssBytes: rss, heapBytes: 0, cpuPct: cpu });
		const lines = [
			mk(lo + 500, 111, 50_000_000, 40), // inside window
			mk(lo + 1500, 111, 120_000_000, 90), // inside, peak
			mk(lo + 2500, 111, 80_000_000, 30), // inside
			mk(hi + 5000, 111, 999_000_000, 99), // OUTSIDE window — must NOT count
			mk(lo + 1000, 999, 5_000_000, 10), // unrelated PID
		];
		writeFileSync(resPath, lines.join("\n") + "\n");
		const res = runAnalyzer("r", crew, work, resPath);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "r");
		assert.ok(report.resources, "resources must be present");
		const plan = report.resources.perSubagent.find((s: { taskId: string }) => s.taskId === "01_plan");
		assert.ok(plan, "01_plan must have per-subagent resource entry");
		assert.equal(plan.attributed, true, "must be attributed (samples in window)");
		assert.equal(plan.samples, 3, "only 3 in-window samples count (outside excluded)");
		assert.equal(plan.peakRssBytes, 120_000_000, "peak RSS must be the in-window max");
		assert.equal(plan.peakCpuPct, 90, "peak CPU must be the in-window max");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});

test("R12: verification failure surfaced even when status=completed", () => {
	const crew = mkdtempSync(join(tmpdir(), "analyze-audit-vf-"));
	const work = mkdtempSync(join(tmpdir(), "analyze-audit-vf-work-"));
	const runState = join(crew, "state", "runs", "v");
	const artifacts = join(crew, "artifacts", "v", "transcripts");
	mkdirSync(runState, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	const ev = [
		{ time: "2026-08-06T08:00:00.000Z", type: "run.created", runId: "v", metadata: { seq: 1 } },
		{ time: "2026-08-06T08:00:01.000Z", type: "task.started", runId: "v", taskId: "01_x", data: { role: "executor" } },
		{ time: "2026-08-06T08:00:02.000Z", type: "task.completed", runId: "v", taskId: "01_x" },
		{ time: "2026-08-06T08:00:03.000Z", type: "run.completed", runId: "v", metadata: { seq: 4 } },
	];
	writeFileSync(join(runState, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(
		join(runState, "tasks.json"),
		JSON.stringify([
			{
				id: "01_x",
				role: "executor",
				status: "completed",
				verification: {
					requiredGreenLevel: "targeted",
					observedGreenLevel: "none",
					satisfied: false,
					notes: "tests failed",
				},
				cwd: tmpdir(),
			},
		]),
	);
	try {
		const res = runAnalyzer("v", crew, work);
		assert.equal(res.status, 0, `analyzer failed: ${res.stderr}`);
		const report = readReport(work, "v");
		const vf = report.problems.find((p: { type: string }) => p.type === "verification_failed");
		assert.ok(vf, "verification_failed problem must be present");
		assert.match(vf.message, /tests failed/, "must include verification notes");
	} finally {
		rmSync(crew, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
});
