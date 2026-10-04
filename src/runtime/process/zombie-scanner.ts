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
 * R3-16 (2026-10-04): a SECOND class — "foreign pi processes" — is detected via
 * the CLI-entry markers `AI_AGENT=pi` / `PI_CODING_AGENT=true` (SDK docs
 * environment-variables.md:15-16: both are set at runtime by the CLI/RPC entry
 * points and inherited by children). Because they are set POST-exec, they show
 * up in a process's own frozen /proc/<pid>/environ ONLY when that process was
 * spawned BY another pi process — a top-level interactive main session's
 * at-exec environ never carries them. Discriminator hierarchy:
 *   1. `PI_CREW_KIND=subagent` → crew worker (zombies/live arrays, authoritative);
 *   2. markers + pi-looking argv + not self/not an ancestor → foreign, REPORT ONLY.
 * The argv gate matters: every shell/tool/MCP-server process pi spawns INHERITS
 * the markers (uv/python/bash/xclip …), so marker presence alone over-matches.
 * Residual ambiguity: a pi the USER deliberately starts from inside a pi shell
 * tool (nested pi) inherits the markers too and is indistinguishable from a
 * leak. No 100%-reliable discriminator exists for that residue → foreign
 * entries are a WARN listing with caveat, NEVER offered as kill candidates.
 *
 * This module is READ-ONLY. It never kills anything. The caller (doctor --zombies)
 * prints the list and asks for explicit confirmation before any kill.
 */

import * as fs from "node:fs";
import { fieldsAfterComm, PROC_STAT_PPID_INDEX, PROC_STAT_STARTTIME_INDEX } from "./proc-stat.ts";

export interface ZombieSubagent {
	pid: number;
	ppid: number;
	/** PID recorded in PI_CREW_PARENT_PID (may differ from ppid if re-parented to init/bash). */
	crewParentPid: number;
	/** Whether the recorded crew parent PID is still alive. */
	parentAlive: boolean;
	role: string | undefined;
	/**
	 * Mux kind from PI_CREW_SURFACE ("tmux"|"herdr") when the worker booted in
	 * a surface pane (T12). Surface workers have NO heartbeat (T9 handoff) —
	 * env markers are the only identity signal, so the scanner never gates a
	 * surface entry on liveness telemetry.
	 */
	surface?: "tmux" | "herdr";
	/** Pane id from PI_CREW_SURFACE_PANE — doctor closes orphan panes by it. */
	surfacePaneId?: string;
	rssKb: number;
	elapsedSec: number | undefined;
	cmd: string;
}

export interface ZombieScanResult {
	zombies: ZombieSubagent[];
	/** Sub-agents whose parent is still alive — shown for transparency, never killed. */
	live: ZombieSubagent[];
	/** R3-16: non-crew pi processes carrying the CLI markers
	 *  (AI_AGENT=pi / PI_CODING_AGENT=true) with a pi-looking argv. REPORT ONLY —
	 *  never a kill candidate (a user-started nested pi is indistinguishable
	 *  from a leaked one; see module header). */
	foreign: ForeignPiProcess[];
	/** Errors encountered while scanning (per-pid). Never aborts the whole scan. */
	errors: string[];
}

export interface ForeignPiProcess {
	pid: number;
	ppid: number;
	/** Parent dead or re-parented to init (ppid=1) — strongest available orphan signal. */
	orphaned: boolean;
	/** argv carries headless markers (`--mode json` / `-p` / `--print`) — an
	 *  interactive TUI session never does; combined with orphaned this is the
	 *  highest-confidence "likely leak" pair, still WARN-only. */
	headless: boolean;
	rssKb: number;
	elapsedSec: number | undefined;
	cmd: string;
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
		// Shared paren-aware cut (proc-stat.ts) — MUST index identically with
		// surface-spawn's PI_CREW_PARENT_START_TIME capture.
		const rest = fieldsAfterComm(stat);
		if (!rest) return undefined;
		const ppid = Number.parseInt(rest[PROC_STAT_PPID_INDEX] ?? "", 10);
		const starttimeTicksRaw = Number.parseInt(rest[PROC_STAT_STARTTIME_INDEX] ?? "", 10);
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
	return readProcCmdlineTokens(pid).join(" ").trim() || `pid ${pid}`;
}

/** /proc/<pid>/cmdline as argv tokens (NUL-split). Empty array if unreadable. */
function readProcCmdlineTokens(pid: number): string[] {
	try {
		// /proc/<pid>/cmdline is NUL-separated argv.
		const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		return raw.split("\0").filter(Boolean);
	} catch {
		return [];
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
	const result: ZombieScanResult = { zombies: [], live: [], foreign: [], errors: [] };
	if (process.platform !== "linux") {
		result.errors.push("zombie scan is Linux-only (/proc required); skipping on " + process.platform);
		return result;
	}

	const myUid = tryGetUid();
	// R3-16: self + ancestors are live hosting sessions (main session / crew
	// host chain) — never reportable as foreign, even when they carry markers.
	const ancestors = collectAncestorPids();
	for (const pid of listCandidatePids()) {
		try {
			// Cheap rejection first: only inspect processes we own (avoid scanning system procs).
			if (myUid !== undefined && getProcUid(pid) !== myUid) continue;

			const environ = readProcEnviron(pid);
			// AUTHORITATIVE GATE: a process is a pi-crew sub-agent ONLY if it carries
			// PI_CREW_KIND=subagent. The user's main session never sets this, so it can
			// never be matched — this is the fix for accidentally killing main sessions.
			// R3-16: non-crew processes get ONE extra look — the foreign pi branch
			// below (markers + pi-looking argv, REPORT ONLY); all else is invisible.
			if (environ.PI_CREW_KIND !== "subagent") {
				// Exact value match matters: other agents reuse the AI_AGENT name with
				// their own value (claude-code sets AI_AGENT=claude-code_…_agent), and
				// marker INHERITORS (shells, MCP servers, xclip) are filtered by the
				// argv gate below. Crew workers never reach here — the gate above owns
				// them (pi-crew also scrubs these markers from worker env).
				const hasPiMarker = environ.AI_AGENT === "pi" || environ.PI_CODING_AGENT === "true";
				if (hasPiMarker && pid !== process.pid && !ancestors.has(pid)) {
					const tokens = readProcCmdlineTokens(pid);
					if (looksLikePiBinary(tokens)) {
						const foreignStat = readProcStat(pid);
						const ppid = foreignStat?.ppid ?? 0;
						result.foreign.push({
							pid,
							ppid,
							orphaned: ppid <= 1 || !isPidAlive(ppid),
							headless: isHeadlessArgv(tokens),
							rssKb: readProcRssKb(pid),
							elapsedSec: foreignStat?.elapsedSec,
							cmd: readProcCmdline(pid),
						});
					}
				}
				continue;
			}

			const crewParentPid = Number.parseInt(environ.PI_CREW_PARENT_PID ?? "", 10);
			const stat = readProcStat(pid);
			// Surface identity (T12): strict allowlist — an unrelated PI_CREW_SURFACE
			// value must not half-populate the fields doctor relies on for pane close.
			const surface = environ.PI_CREW_SURFACE === "tmux" || environ.PI_CREW_SURFACE === "herdr" ? environ.PI_CREW_SURFACE : undefined;
			const entry: ZombieSubagent = {
				pid,
				ppid: stat?.ppid ?? 0,
				crewParentPid: Number.isFinite(crewParentPid) ? crewParentPid : 0,
				parentAlive: Number.isFinite(crewParentPid) && isPidAlive(crewParentPid),
				role: environ.PI_CREW_ROLE,
				surface,
				surfacePaneId: environ.PI_CREW_SURFACE_PANE || undefined,
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

	// Sort: zombies first by descending RSS (biggest leaks first), live by pid;
	// foreign: orphans first (the likely leaks), then by descending RSS.
	result.zombies.sort((a, b) => b.rssKb - a.rssKb);
	result.live.sort((a, b) => a.pid - b.pid);
	result.foreign.sort((a, b) => Number(b.orphaned) - Number(a.orphaned) || b.rssKb - a.rssKb);
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

function pathBasename(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * R3-16: does the argv look like the pi CLI binary itself?
 *
 * Every process pi spawns (bash, uv, python MCP servers, xclip, …) INHERITS the
 * AI_AGENT/PI_CODING_AGENT markers, so marker presence alone over-matches the
 * user's own tool processes. Only pi-looking argv[0..1] counts (argv[0] itself,
 * or a node-style script path at argv[1]): basename `pi` (covers
 * /usr/local/bin/pi, .nvm/…/bin/pi, ./pi), `pi-coding-agent`, or a path
 * containing pi-coding-agent (node …/pi-coding-agent/dist/…). Tokens deeper
 * than argv[1] are ARGUMENTS (e.g. `bash -c "pi …"`) — never the binary.
 */
function looksLikePiBinary(tokens: string[]): boolean {
	for (const token of tokens.slice(0, 2)) {
		const base = pathBasename(token);
		if (base === "pi" || base === "pi-coding-agent" || base === "pi.js") return true;
		if (token.includes("pi-coding-agent")) return true;
	}
	return false;
}

/** R3-16: headless argv detection — an interactive TUI session never carries these. */
function isHeadlessArgv(tokens: string[]): boolean {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "-p" || token === "--print" || token === "--mode=json") return true;
		if (token === "--mode" && tokens[i + 1] === "json") return true;
	}
	return false;
}

/**
 * R3-16: the scanner's own ancestor chain (self's parent up to init).
 *
 * Any pi process on this chain is a LIVE hosting session (the user's main
 * session / a crew host) and must never be reported — even in the nested case
 * (worker runs doctor → its parent crew host and the user's main session above
 * it sit on this chain and carry markers when pi-in-pi). Bounded at 64 hops to
 * survive a hypothetical pid cycle.
 */
function collectAncestorPids(): Set<number> {
	const chain = new Set<number>();
	let current = process.ppid;
	let guard = 0;
	while (current > 1 && guard++ < 64) {
		chain.add(current);
		const stat = readProcStat(current);
		if (!stat || stat.ppid <= 0) break;
		current = stat.ppid;
	}
	return chain;
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

	if (scan.zombies.length === 0 && scan.live.length === 0 && scan.foreign.length === 0) {
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
		lines.push("  PID       PARENT  RSS       ROLE          SURFACE          CMD");
		for (const z of scan.zombies) {
			lines.push(formatZombieRow(z));
		}
		lines.push("");
	}

	if (scan.live.length > 0) {
		lines.push(`### Live — parent still running (${scan.live.length})`);
		lines.push("NOT zombies. Do not kill (parent PID is alive and may still reap them).");
		lines.push("");
		lines.push("  PID       PARENT  RSS       ROLE          SURFACE          CMD");
		for (const l of scan.live) {
			lines.push(formatZombieRow(l));
		}
		lines.push("");
	}

	if (scan.foreign.length > 0) {
		lines.push(`### WARN — Foreign pi processes, REPORT ONLY (${scan.foreign.length})`);
		lines.push("CLI-spawned pi processes (AI_AGENT=pi / PI_CODING_AGENT=true markers) that are");
		lines.push("NOT pi-crew children. A top-level interactive session never carries these");
		lines.push("markers in its own environment (the CLI sets them post-exec) — but a pi YOU");
		lines.push("deliberately started from inside a pi shell looks identical to a leak.");
		lines.push("NO reliable discriminator exists for that residue: verify cmd / session-dir");
		lines.push("/ cwd by hand before ever killing one. These are never kill candidates and");
		lines.push("never feed pane cleanup. This tool never kills.");
		lines.push("");
		lines.push("  PID       PPID     STATE             RSS       CMD");
		for (const f of scan.foreign) {
			lines.push(formatForeignRow(f));
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

/** One table row — shared by the zombie + live sections so columns stay aligned. */
function formatZombieRow(z: ZombieSubagent): string {
	// SURFACE = "kind:paneId" (T12) — the pane doctor closes when orphaned.
	const surface = z.surface ? `${z.surface}:${z.surfacePaneId ?? "?"}` : "-";
	return `  ${String(z.pid).padEnd(9)}${String(z.crewParentPid).padEnd(8)}${formatRss(z.rssKb).padEnd(10)}${(z.role ?? "?").padEnd(14)}${surface.padEnd(16)}${z.cmd.slice(0, 44)}`;
}

/** One table row for the R3-16 foreign section — state carries the triage flags. */
function formatForeignRow(f: ForeignPiProcess): string {
	// "orphaned" = parent dead/re-parented to init (strongest leak signal);
	// "headless" = --mode json / -p argv (never an interactive TUI session).
	const state = `${f.orphaned ? "orphaned" : "live-parent"}${f.headless ? " headless" : ""}`;
	return `  ${String(f.pid).padEnd(9)}${String(f.ppid).padEnd(8)}${state.padEnd(17)}${formatRss(f.rssKb).padEnd(10)}${f.cmd.slice(0, 40)}`;
}

function formatRss(kb: number): string {
	if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
	if (kb >= 1024) return `${(kb / 1024).toFixed(0)}M`;
	return `${kb}K`;
}

// Re-export for tests + callers that want to inspect proc helpers in isolation.
export const __test = {
	readProcEnviron,
	isPidAlive,
	computeElapsedSec,
	readProcCmdlineTokens,
	looksLikePiBinary,
	isHeadlessArgv,
	collectAncestorPids,
};
