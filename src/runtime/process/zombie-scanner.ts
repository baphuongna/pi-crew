/**
 * zombie-scanner.ts — safely detect orphaned pi-crew sub-agent processes.
 *
 * LESSON (learned the hard way): a heuristic like "old `pi` process + high RSS +
 * orphaned (ppid=1/bash)" will match a user's interactive MAIN session just as
 * readily as a real zombie. The result is a live main session being killed by
 * accident. This module replaces that heuristic with an authoritative signal.
 *
 * Authoritative marker (set by buildPiWorkerArgs on every child-pi spawn):
 *   - argv:   `--crew-subagent` is the first positional arg
 *   - env:    `PI_CREW_KIND=subagent` is the machine-readable signal
 *
 * A process is a "pi-crew sub-agent" ONLY IF it carries `PI_CREW_KIND=subagent`
 * in its environment. The user's main `pi` session NEVER has this var, so it can
 * never be matched here — by construction.
 *
 * A sub-agent is a "zombie" ONLY IF its `PI_CREW_PARENT_PID` points at a PID that
 * is no longer alive (parent crashed/exited without reaping the child). A sub-agent
 * whose parent is still running is NOT a zombie — it's a legitimate in-flight task.
 *
 * This module is READ-ONLY. It never kills anything. The caller (doctor --zombies)
 * prints the list and asks for explicit confirmation before any kill.
 */

import * as fs from "node:fs";

export interface ZombieSubagent {
	pid: number;
	ppid: number;
	/** PID recorded in PI_CREW_PARENT_PID (may differ from ppid if re-parented to init/bash). */
	crewParentPid: number;
	/** Whether the recorded crew parent PID is still alive. */
	parentAlive: boolean;
	role: string | undefined;
	rssKb: number;
	elapsedSec: number | undefined;
	cmd: string;
}

export interface ZombieScanResult {
	zombies: ZombieSubagent[];
	/** Sub-agents whose parent is still alive — shown for transparency, never killed. */
	live: ZombieSubagent[];
	/** Errors encountered while scanning (per-pid). Never aborts the whole scan. */
	errors: string[];
}

/** Read /proc/<pid>/environ as a key=value record. Returns {} if unreadable. */
function readProcEnviron(pid: number): Record<string, string> {
	try {
		// /proc/<pid>/environ is NUL-separated key=value pairs.
		const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
		const out: Record<string, string> = {};
		for (const entry of raw.split("\0")) {
			const eq = entry.indexOf("=");
			if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
		return out;
	} catch {
		return {};
	}
}

/** Read /proc/<pid>/stat to get ppid + elapsed. Returns undefined if unreadable. */
function readProcStat(pid: number): { ppid: number; elapsedSec: number | undefined } | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		// stat format: pid (comm) state ppid ... starttime ...
		// comm may contain spaces/parens, so parse from the LAST ')' backwards.
		const closeParen = stat.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const rest = stat
			.slice(closeParen + 2)
			.trim()
			.split(/\s+/);
		// rest[0] = state, rest[1] = ppid
		const ppid = Number.parseInt(rest[1] ?? "", 10);
		// starttime (clock ticks since boot) is field 22 in the full stat → index 19 in `rest`
		const starttimeTicksRaw = Number.parseInt(rest[19] ?? "", 10);
		const starttimeTicks = Number.isFinite(starttimeTicksRaw) ? starttimeTicksRaw : undefined;
		const elapsedSec = computeElapsedSec(starttimeTicks);
		return { ppid: Number.isFinite(ppid) ? ppid : 0, elapsedSec };
	} catch {
		return undefined;
	}
}

function computeElapsedSec(starttimeTicks: number | undefined): number | undefined {
	if (starttimeTicks === undefined || !Number.isFinite(starttimeTicks)) return undefined;
	try {
		// Linux CLK_TCK is virtually always 100 (sysconf(_SC_CLK_TCK)). Reading it
		// portably from Node requires a native addon; hardcoding 100 matches every
		// mainstream Linux distro and keeps this dependency-free.
		const ticksPerSec = 100;
		// /proc/uptime: first field is seconds since boot.
		const uptimeRaw = fs.readFileSync("/proc/uptime", "utf-8");
		const uptimeSec = Number.parseFloat(uptimeRaw.split(" ")[0] ?? "");
		if (!Number.isFinite(uptimeSec)) return undefined;
		// starttime (ticks since boot) → process age in seconds = uptime - starttime/ticksPerSec.
		const startAgeSec = starttimeTicks / ticksPerSec;
		return Math.max(0, uptimeSec - startAgeSec);
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		// process.kill(pid, 0) throws if the pid is not alive (or not ours).
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readProcCmdline(pid: number): string {
	try {
		// /proc/<pid>/cmdline is NUL-separated argv.
		const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		return raw.split("\0").filter(Boolean).join(" ").trim() || `pid ${pid}`;
	} catch {
		return `pid ${pid}`;
	}
}

function readProcRssKb(pid: number): number {
	try {
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
		const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
		return match ? Number.parseInt(match[1] ?? "", 10) : 0;
	} catch {
		return 0;
	}
}

/**
 * Enumerate candidate pi-crew sub-agent PIDs under the current uid.
 *
 * Reads /proc directly (Linux only) — no shelling out to pgrep/ps, so the
 * result is deterministic and unaffected by shell quoting or locale. On
 * non-Linux platforms the scanner returns an empty result with a note in
 * `errors` (zombie detection is best-effort; the doctor report still renders).
 */
function listCandidatePids(): number[] {
	if (process.platform !== "linux") return [];
	const pids: number[] = [];
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (/^\d+$/.test(entry)) pids.push(Number.parseInt(entry, 10));
		}
	} catch {
		// /proc unreadable (e.g. sandboxed). Caller surfaces via errors[].
	}
	return pids;
}

/**
 * Scan for orphaned pi-crew sub-agent processes. READ-ONLY — never kills.
 *
 * Returns the full picture: zombies (parent dead), live (parent alive), and
 * any scan errors. Callers decide what to do with the result; this module
 * has no side effects.
 */
export function scanZombieSubagents(): ZombieScanResult {
	const result: ZombieScanResult = { zombies: [], live: [], errors: [] };
	if (process.platform !== "linux") {
		result.errors.push("zombie scan is Linux-only (/proc required); skipping on " + process.platform);
		return result;
	}

	const myUid = tryGetUid();
	for (const pid of listCandidatePids()) {
		try {
			// Cheap rejection first: only inspect processes we own (avoid scanning system procs).
			if (myUid !== undefined && getProcUid(pid) !== myUid) continue;

			const environ = readProcEnviron(pid);
			// AUTHORITATIVE GATE: a process is a pi-crew sub-agent ONLY if it carries
			// PI_CREW_KIND=subagent. The user's main session never sets this, so it can
			// never be matched — this is the fix for accidentally killing main sessions.
			if (environ.PI_CREW_KIND !== "subagent") continue;

			const crewParentPid = Number.parseInt(environ.PI_CREW_PARENT_PID ?? "", 10);
			const stat = readProcStat(pid);
			const entry: ZombieSubagent = {
				pid,
				ppid: stat?.ppid ?? 0,
				crewParentPid: Number.isFinite(crewParentPid) ? crewParentPid : 0,
				parentAlive: Number.isFinite(crewParentPid) && isPidAlive(crewParentPid),
				role: environ.PI_CREW_ROLE,
				rssKb: readProcRssKb(pid),
				elapsedSec: stat?.elapsedSec,
				cmd: readProcCmdline(pid),
			};

			if (entry.parentAlive) {
				result.live.push(entry);
			} else {
				result.zombies.push(entry);
			}
		} catch (error) {
			// Race: process may have exited between readdir and read. Don't abort the scan.
			result.errors.push(`pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Sort: zombies first by descending RSS (biggest leaks first), live by pid.
	result.zombies.sort((a, b) => b.rssKb - a.rssKb);
	result.live.sort((a, b) => a.pid - b.pid);
	return result;
}

function tryGetUid(): number | undefined {
	try {
		return process.getuid?.();
	} catch {
		return undefined;
	}
}

function getProcUid(pid: number): number | undefined {
	try {
		// /proc/<pid>/status has Uid: <real> <eff> <sav> <fs>
		const status = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
		const match = status.match(/^Uid:\s+(\d+)/m);
		return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Render a ZombieScanResult as human-readable text for the doctor report.
 * Explicitly labels main-session safety and never suggests killing live parents.
 */
export function formatZombieReport(scan: ZombieScanResult): string {
	const lines: string[] = [];
	lines.push("## Zombie sub-agent scan (read-only — nothing killed)");
	lines.push("");
	lines.push(`Sub-agents identified by PI_CREW_KIND=subagent marker. Main sessions (no marker) are never listed.`);
	lines.push("");

	if (scan.zombies.length === 0 && scan.live.length === 0) {
		lines.push("No pi-crew sub-agent processes found.");
		if (scan.errors.length > 0) {
			lines.push("");
			lines.push(`Scan notes (${scan.errors.length}):`);
			for (const err of scan.errors.slice(0, 5)) lines.push(`  - ${err}`);
		}
		return lines.join("\n");
	}

	if (scan.zombies.length > 0) {
		lines.push(`### Zombies — parent dead (${scan.zombies.length})`);
		lines.push("These sub-agents are orphaned. Safe to kill after review:");
		lines.push("");
		lines.push("  PID       PARENT  RSS       ROLE          CMD");
		for (const z of scan.zombies) {
			lines.push(
				`  ${String(z.pid).padEnd(9)}${String(z.crewParentPid).padEnd(8)}${formatRss(z.rssKb).padEnd(10)}${(z.role ?? "?").padEnd(14)}${z.cmd.slice(0, 60)}`,
			);
		}
		lines.push("");
	}

	if (scan.live.length > 0) {
		lines.push(`### Live — parent still running (${scan.live.length})`);
		lines.push("NOT zombies. Do not kill (parent PID is alive and may still reap them).");
		lines.push("");
		lines.push("  PID       PARENT  RSS       ROLE          CMD");
		for (const l of scan.live) {
			lines.push(
				`  ${String(l.pid).padEnd(9)}${String(l.crewParentPid).padEnd(8)}${formatRss(l.rssKb).padEnd(10)}${(l.role ?? "?").padEnd(14)}${l.cmd.slice(0, 60)}`,
			);
		}
		lines.push("");
	}

	if (scan.errors.length > 0) {
		lines.push(`Scan errors (${scan.errors.length}, first 5 shown):`);
		for (const err of scan.errors.slice(0, 5)) lines.push(`  - ${err}`);
		lines.push("");
	}

	lines.push("To kill a zombie: `kill <PID>` (the OS will reap it). This tool never kills.");
	return lines.join("\n");
}

function formatRss(kb: number): string {
	if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
	if (kb >= 1024) return `${(kb / 1024).toFixed(0)}M`;
	return `${kb}K`;
}

// Re-export for tests + callers that want to inspect proc helpers in isolation.
export const __test = { readProcEnviron, isPidAlive, computeElapsedSec };
