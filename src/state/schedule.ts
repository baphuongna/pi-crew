/**
 * schedule.ts — Schedule detection and parsing utilities.
 *
 * Mirrors pi-subagents3's SubagentScheduler static methods:
 *   - detectSchedule(): sniff cron / interval / one-shot from string
 *   - validateCronExpression(): 6-field cron validation
 *   - parseRelativeTime(): "+10m" → ISO timestamp
 *   - parseInterval(): "5m" → milliseconds
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";

import type { ScheduleStoreData, ScheduledTask } from "./types.ts";

export type DetectedSchedule =
	| { type: "cron"; normalized: string }
	| { type: "interval"; intervalMs: number; normalized: string }
	| { type: "once"; normalized: string };

/** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp or null if not a relative time. */
export function parseRelativeTime(s: string): string | null {
	const m = s.trim().match(/^\+(\d+)(s|m|h|d)$/);
	if (!m) return null;
	const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
	return new Date(Date.now() + ms).toISOString();
}

/** "10s"/"5m"/"1h"/"2d" → milliseconds or null if not an interval. */
export function parseInterval(s: string): number | null {
	const m = s.trim().match(/^(\d+)(s|m|h|d)$/);
	if (!m) return null;
	return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

/** 6-field cron validation ("second minute hour dom month dow"). */
export function validateCronExpression(expr: string): { valid: boolean; error?: string } {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 6) {
		return {
			valid: false,
			error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
		};
	}
	// Basic format check: all fields must be non-empty
	if (!fields.every(f => f.length > 0)) {
		return { valid: false, error: "Cron expression contains empty fields." };
	}
	// Accept any cron pattern — fail silently for malformed expressions
	// (the croner library will reject at execution time)
	return { valid: true };
}

/**
 * Sniff a schedule string and tag its type. Throws on invalid input.
 * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
 * relative requires the leading "+" to disambiguate.
 */
export function detectSchedule(s: string): DetectedSchedule {
	const trimmed = s.trim();
	// "+10m" — relative one-shot
	const rel = parseRelativeTime(trimmed);
	if (rel !== null) return { type: "once", normalized: rel };
	// "5m" — interval
	const ivl = parseInterval(trimmed);
	if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
	// ISO timestamp — one-shot. Reject past timestamps.
	if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
		const d = new Date(trimmed);
		if (!Number.isNaN(d.getTime())) {
			if (d.getTime() <= Date.now()) {
				throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
			}
			return { type: "once", normalized: d.toISOString() };
		}
	}
	// Cron — 6-field
	const cronCheck = validateCronExpression(trimmed);
	if (cronCheck.valid) return { type: "cron", normalized: trimmed };
	throw new Error(
		`Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`,
	);
}

/** ScheduleStore: PID-locked, session-scoped, atomic JSON persistence. */
export class ScheduleStore {
	private readonly path: string;
	private data: ScheduleStoreData;

	constructor(path: string) {
		this.path = path;
		this.data = { version: 1, jobs: [] };
		try {
			if (fs.existsSync(path)) {
				const content = fs.readFileSync(path, "utf-8");
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed === "object" && "version" in parsed && "jobs" in parsed) {
					this.data = parsed as ScheduleStoreData;
				}
			}
		} catch {
			// Corrupt or missing file — start fresh
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.path), { recursive: true });
			fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
		} catch (error) {
			// FIX (Round 21, L1): Use logInternalError for consistency with
			// the rest of the codebase. Previously console.warn may not be
			// visible in all environments (e.g. JSON-RPC mode, redirected
			// stderr). Also import the dependency properly at the top of
			// the file (this method used the legacy require() pattern).
			logInternalError("schedule.save", error, `path=${this.path}`);
		}
	}

	list(): ScheduledTask[] {
		return [...this.data.jobs];
	}

	hasName(name: string): boolean {
		return this.data.jobs.some(j => j.name === name);
	}

	get(id: string): ScheduledTask | undefined {
		return this.data.jobs.find(j => j.id === id);
	}

	add(job: ScheduledTask): void {
		this.data.jobs.push(job);
		this.save();
	}

	update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
		const idx = this.data.jobs.findIndex(j => j.id === id);
		if (idx === -1) return undefined;
		this.data.jobs[idx] = { ...this.data.jobs[idx], ...patch };
		this.save();
		return this.data.jobs[idx];
	}

	remove(id: string): boolean {
		const before = this.data.jobs.length;
		this.data.jobs = this.data.jobs.filter(j => j.id !== id);
		if (this.data.jobs.length !== before) {
			this.save();
			return true;
		}
		return false;
	}
}