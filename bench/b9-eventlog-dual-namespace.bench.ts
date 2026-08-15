/**
 * b9 — event-log dual lock-namespace regression bench (R16-B1 / R18, Phase 3.6+3.7+3.8).
 *
 * Durable replacement for the Round 17/18 /tmp repro scripts (deleted). Proves
 * BOTH effects of the R16-B1 finding against the REAL append exports:
 *
 *  Effect 1 (duplicate seq — .seqlock fix): two REAL child processes append to
 *  the SAME eventsPath concurrently — one via the sync family (appendEvent,
 *  `.mkdirlock`), one via the async family (appendEventAsync, `.alock`).
 *  Pre-fix, the disjoint lock namespaces let both reserve the same .seq
 *  sidecar value (Round 17: 527 duplicate seq values / 75% duplicate events
 *  over 3000 events). Post-fix, the shared `.seqlock` serializes the
 *  reservation → assert ZERO duplicate seq values.
 *
 *  Effect 2 (rotation stranding — archive-tail reader fix): while a sync child
 *  appends, the bench parent rotates the live file (rotateEventLogUnlocked,
 *  unlocked — the maximal-contention Round 18 repro). In-flight fd appends on
 *  the renamed inode land in the ARCHIVE. Post-fix, readEvents walks archive
 *  tails → assert total events read (live + archives, deduped by seq) equals
 *  total appended (no event lost/stranded).
 *
 * Deterministic assertions (join barrier = child process exit); no flaky
 * sleeps in the assertions themselves. Bounded counts keep the bench fast
 * enough for CI (<30s target).
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b9-eventlog-dual-namespace.bench.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { readEvents } from "../src/state/event-log/event-log.ts";
import { rotateEventLogUnlocked } from "../src/state/event-log/event-log-rotation.ts";
import { seqCounters } from "../src/state/event-log/sequence-cache.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b9-"));
const WORKER = path.resolve(import.meta.dirname, "b9-worker.ts");

function spawnWorker(mode: "sync" | "async", eventsPath: string, count: number): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, mode, eventsPath, String(count)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function awaitExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`))));
		child.on("error", reject);
	});
}

function seqStats(eventsPath: string): { total: number; unique: number; duplicates: number } {
	const seqs = readEvents(eventsPath)
		.map((e) => e.metadata?.seq ?? 0)
		.filter((s) => s > 0);
	const unique = new Set(seqs).size;
	return { total: seqs.length, unique, duplicates: seqs.length - unique };
}

async function effect1DuplicateSeq(): Promise<{
	eventsPerChild: number;
	totalEvents: number;
	duplicateSeqs: number;
	rotations?: undefined;
	wallMs: number;
}> {
	const eventsPath = path.join(tmpRoot, "effect1", "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	seqCounters.clear();
	const eventsPerChild = 150;
	const start = performance.now();
	const [syncChild, asyncChild] = [spawnWorker("sync", eventsPath, eventsPerChild), spawnWorker("async", eventsPath, eventsPerChild)];
	await Promise.all([awaitExit(syncChild), awaitExit(asyncChild)]);
	const wallMs = Math.round(performance.now() - start);
	const stats = seqStats(eventsPath);
	if (stats.duplicates !== 0) throw new Error(`EFFECT 1 FAILED: ${stats.duplicates} duplicate seq values across ${stats.total} events`);
	if (stats.total !== eventsPerChild * 2) throw new Error(`EFFECT 1 FAILED: expected ${eventsPerChild * 2} events, read ${stats.total}`);
	if (fs.existsSync(`${eventsPath}.seqlock`)) throw new Error("EFFECT 1 FAILED: .seqlock not released after child exits");
	console.log(`b9 effect1: ${stats.total} events across 2 processes (sync+async), duplicateSeqs=${stats.duplicates}, wallMs=${wallMs}`);
	return { eventsPerChild, totalEvents: stats.total, duplicateSeqs: stats.duplicates, wallMs };
}

async function effect2RotationStranding(): Promise<{
	appended: number;
	totalEvents: number;
	rotations: number;
	archiveEvents: number;
	wallMs: number;
}> {
	const eventsPath = path.join(tmpRoot, "effect2", "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	seqCounters.clear();
	const appended = 250;
	const start = performance.now();
	const child = spawnWorker("sync", eventsPath, appended);
	let rotations = 0;
	// Rotate while the sync appender is in flight (unlocked rotation = the
	// maximal-contention Round 18 repro; in-flight fd appends strand into the
	// archive). Bounded to 10 rotations for CI wall-clock (<30s target).
	const rotateTimer = setInterval(() => {
		if (rotations >= 10) {
			clearInterval(rotateTimer);
			return;
		}
		if (rotateEventLogUnlocked(eventsPath)) rotations++;
	}, 4);
	const childExited = awaitExit(child);
	await childExited;
	clearInterval(rotateTimer);
	const wallMs = Math.round(performance.now() - start);
	// Post-fix readEvents walks archive tails: nothing may be lost.
	const stats = seqStats(eventsPath);
	if (rotations < 1) {
		throw new Error(
			"EFFECT 2 FAILED: no rotation landed while the sync appender was in flight — the stranding scenario was never exercised (bench would pass trivially)",
		);
	}
	if (stats.total !== appended) {
		throw new Error(
			`EFFECT 2 FAILED: ${appended - stats.total} events stranded/lost (read ${stats.total} of ${appended} appended, rotations=${rotations})`,
		);
	}
	if (stats.duplicates !== 0) throw new Error(`EFFECT 2 FAILED: ${stats.duplicates} duplicate seqs`);
	// Evidence of the stranding race being exercised: events that landed in
	// ARCHIVE files (in-flight fd appends on renamed inodes). Not asserted >0
	// (the open→rename→write window per append is timing-dependent); reported
	// so a regression to 0 recovered-from-archive events is visible in results.
	const archiveEvents = fs
		.readdirSync(path.dirname(eventsPath))
		.filter((f) => f.startsWith(path.basename(eventsPath)) && f.endsWith(".archive.jsonl"))
		.reduce(
			(sum, f) =>
				sum +
				fs
					.readFileSync(path.join(path.dirname(eventsPath), f), "utf-8")
					.split("\n")
					.filter((l) => l.trim()).length,
			0,
		);
	console.log(
		`b9 effect2: ${stats.total}/${appended} events recovered across ${rotations} rotations (${archiveEvents} landed in archives), wallMs=${wallMs}`,
	);
	return { appended, totalEvents: stats.total, rotations, archiveEvents, wallMs };
}

async function main(): Promise<void> {
	const effect1 = await effect1DuplicateSeq();
	const effect2 = await effect2RotationStranding();
	const result = {
		name: "b9.eventlog-dual-namespace",
		unit: "events",
		effect1: {
			eventsPerChild: effect1.eventsPerChild,
			totalEvents: effect1.totalEvents,
			duplicateSeqs: effect1.duplicateSeqs,
			wallMs: effect1.wallMs,
		},
		effect2: {
			appended: effect2.appended,
			totalEvents: effect2.totalEvents,
			rotations: effect2.rotations,
			archiveEvents: effect2.archiveEvents,
			wallMs: effect2.wallMs,
		},
	};
	console.log(JSON.stringify(result));
}

try {
	await main();
} finally {
	seqCounters.clear();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
