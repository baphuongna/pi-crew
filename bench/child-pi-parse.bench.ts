/**
 * Phase 0 baseline benchmark: measures ChildPiLineObserver hot-path cost.
 *
 * Feeds N JSON event lines through the observer and counts:
 * - wall-time
 * - JSON.parse invocations (instrumented via wrapper)
 *
 * Run: PI_CREW_USE_BUNDLE=0 node --experimental-strip-types bench/child-pi-parse.bench.ts
 *
 * Usage: results are appended to bench/baseline.txt / bench/after.txt for
 * before/after comparison across optimization phases.
 */

import type { AgentConfig } from "../src/agents/agent-config.ts";
import { ChildPiLineObserver } from "../src/runtime/child-pi.ts";
import type { ChildPiRunInput } from "../src/runtime/child-pi.ts";

// --- Instrument JSON.parse to count calls -----------------------------------
let parseCount = 0;
const origParse = JSON.parse;
const countedParse: typeof JSON.parse = function (...args: Parameters<typeof JSON.parse>) {
	parseCount++;
	return origParse.apply(JSON, args);
};
(JSON as { parse: typeof JSON.parse }).parse = countedParse;

// --- Event fixtures (representative mix) ------------------------------------
const assistantEvent = JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Working on the task. Let me read the file first." }],
	},
});
const toolCallEvent = JSON.stringify({
	type: "tool_execution_start",
	toolName: "read",
	args: { path: "src/runtime/child-pi.ts" },
});
const toolResultEvent = JSON.stringify({
	type: "tool_execution_end",
	toolName: "read",
	args: { path: "src/runtime/child-pi.ts" },
	result: { content: "x".repeat(2000) },
});
const messageEndEvent = JSON.stringify({
	type: "message_end",
	message: { role: "assistant", stopReason: "stop" },
	usage: { input: 1500, output: 120, cost: 0.002, turns: 1 },
});

const SAMPLE_AGENT: AgentConfig = {
	name: "explorer",
	systemPrompt: "",
	model: undefined,
	fallbackModels: [],
};

function buildObserver(): ChildPiLineObserver {
	const input: ChildPiRunInput = {
		cwd: process.cwd(),
		task: "bench",
		agent: SAMPLE_AGENT,
		onJsonEvent: () => {},
		onStdoutLine: () => {},
	};
	return new ChildPiLineObserver(input);
}

function runBench(eventCount: number): { ms: number; parses: number; parsesPerLine: number } {
	const observer = buildObserver();
	// Build a chunk of interleaved events (no trailing newline to leave in buffer).
	const events: string[] = [];
	const cycle = [assistantEvent, toolCallEvent, toolResultEvent, toolEndEvent()];
	const types = [assistantEvent, toolCallEvent, toolResultEvent, messageEndEvent];
	for (let i = 0; i < eventCount; i++) {
		events.push(types[i % types.length]);
	}
	void cycle; // keep referenced
	const chunk = events.join("\n") + "\n";

	parseCount = 0;
	const start = performance.now();
	observer.observe(chunk);
	const ms = performance.now() - start;
	return { ms, parses: parseCount, parsesPerLine: parseCount / eventCount };
}

// separate fn to avoid unused warning patterns
function toolEndEvent(): string {
	return messageEndEvent;
}

function main(): void {
	const sizes = [50, 200, 1000];
	const runs = 5;
	const results: string[] = [];
	results.push("# Phase 0 baseline — ChildPiLineObserver hot path");
	results.push(`# node ${process.version}, date ${new Date().toISOString()}`);
	results.push("");
	for (const size of sizes) {
		let bestMs = Infinity;
		let bestParses = 0;
		for (let r = 0; r < runs; r++) {
			const res = runBench(size);
			if (res.ms < bestMs) {
				bestMs = res.ms;
				bestParses = res.parses;
			}
		}
		const line = `${size} events: ${bestMs.toFixed(2)} ms, ${bestParses} JSON.parse (${(bestParses / size).toFixed(2)}/line)`;
		results.push(line);
		console.log(line);
	}
	const out = results.join("\n") + "\n";
	const fs = require("node:fs");
	const file = process.env.BENCH_OUT ?? "bench/baseline.txt";
	fs.appendFileSync(file, out, "utf-8");
	console.log(`\nappended to ${file}`);
}

// node:require shim for strip-types
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

main();
