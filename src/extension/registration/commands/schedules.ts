/**
 * `/schedules` command — Scheduled Jobs UI tier E (headless-compatible).
 *
 * Pattern: `registration/commands/status.ts` — `pi.registerCommand` with a
 * handler whose ONLY output channel is `notifyCommandResult` (ctx.ui.notify
 * text block, capped at 800 chars). No TUI dependency: works under `pi -p`.
 *
 * Single source of truth (G17): jobs are read through `getScheduledJobs()`
 * from team-tool/handle-schedule.ts — never from a local defaults copy.
 * Rendering reuses the SAME pane renderer as the dashboard (tier A) via
 * `renderSchedulesTextBlock` → `renderSchedulesPane` — no copied table logic,
 * no drift. Clock (D6-T4): `now` is injected into the render path; the single
 * `new Date()` read lives here at the handler boundary, never in a renderer.
 *
 * `/schedules log <jobId-or-name>` resolves a job by id or name, takes its
 * LATEST spawned run (`loadRunManifestById`), and tails the most recent
 * output artifact (run summary + task result artifacts — the same candidate
 * set as team-tool/run.ts) bounded to SCHEDULES_LOG_TAIL_BYTES via
 * `readTextTail`, with every path resolved inside `artifactsRoot` through
 * `resolveRealContainedPath` (H-3 traversal guard).
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readTextTail } from "../../../runtime/agent-observability.ts";
import type { ScheduledJob } from "../../../runtime/scheduling/scheduler.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../state/types.ts";
import { renderSchedulesTextBlock } from "../../../ui/dashboard-panes/schedules-pane.ts";
import { resolveRealContainedPath } from "../../../utils/safe-paths.ts";
import { getCrewScheduler, getScheduledJobs, getScheduledJobsHiddenCountView } from "../../team-tool/handle-schedule.ts";
import { notifyCommandResult } from "../command-utils.ts";

/** Bounded tail for `/schedules log` — matches the dashboard's
 *  read-agent-output cap (32_000 bytes, commands/shared.ts). */
export const SCHEDULES_LOG_TAIL_BYTES = 32_000;

export type ParsedSchedulesArgs = { mode: "list" } | { mode: "log"; target: string } | { mode: "usage"; error: string };

/** Parse `/schedules` arguments: bare → list, `log <target>` → log tail
 *  (target may contain spaces — job names do), anything else → usage error. */
export function parseSchedulesArgs(args: string): ParsedSchedulesArgs {
	const trimmed = args.trim();
	if (trimmed === "") return { mode: "list" };
	const tokens = trimmed.split(/\s+/);
	if ((tokens[0] ?? "").toLowerCase() !== "log") {
		return { mode: "usage", error: `Unknown subcommand '${tokens[0]}'. Usage: /schedules [log <jobId-or-name>]` };
	}
	const target = tokens.slice(1).join(" ").trim();
	if (!target) return { mode: "usage", error: "Usage: /schedules log <jobId-or-name>" };
	return { mode: "log", target };
}

/** Resolve a job by exact id first, then by (case-insensitive) name. When
 *  several jobs share a name, the most recently created wins so `log` follows
 *  the newest schedule (ISO timestamps sort lexicographically). */
export function resolveScheduledJobByIdOrName(jobs: ScheduledJob[], target: string): ScheduledJob | undefined {
	const needle = target.trim();
	if (!needle) return undefined;
	const byId = jobs.find((job) => job.id === needle);
	if (byId) return byId;
	const lower = needle.toLowerCase();
	const byName = jobs.filter((job) => job.name.trim().toLowerCase() === lower);
	if (byName.length === 0) return undefined;
	return byName.reduce((newest, job) => (job.createdAt > newest.createdAt ? job : newest));
}

/**
 * Build the `/schedules` text block. Thin wrapper over the shared text-block
 * variant of the pane renderer — kept exported so the parity test can pin
 * byte-for-byte equality against `renderSchedulesPane` (no drift). The
 * optional `hiddenCount` (P2-1) flows straight through to the shared hint
 * line; omitted/0 keeps the legacy layout.
 */
export function buildSchedulesCommandLines(jobs: ScheduledJob[], now: Date, hiddenCount = 0): string[] {
	return renderSchedulesTextBlock(jobs, now, { hiddenCount });
}

/** Test seam for the run-manifest loader (defaults to the real state store). */
export interface SchedulesLogDeps {
	loadManifest?: typeof loadRunManifestById;
}

/**
 * Build the `/schedules log <jobId-or-name>` text: resolve the job, take its
 * latest spawned run, and tail the most recent output artifact. Pure-ish
 * read-only helper (no clock, no mutation) so tests can drive every branch.
 */
export function buildSchedulesLogText(
	cwd: string,
	jobs: ScheduledJob[],
	target: string,
	deps: SchedulesLogDeps = {},
): { isError: boolean; text: string } {
	const job = resolveScheduledJobByIdOrName(jobs, target);
	if (!job) return { isError: true, text: `No scheduled job with id or name '${target}'.` };
	const runId = job.spawnedRunIds?.[job.spawnedRunIds.length - 1];
	if (!runId) return { isError: true, text: `Job '${job.name}' has no spawned runs yet.` };
	// Security review F-3: runId is a persisted settings field under only a
	// weak shape guard; the state store's assertSafePathId THROWS on unsafe
	// charsets (traversal containment — it fails closed). Catch it here and
	// degrade to the run-not-found-style error toast instead of an unhandled
	// rejection inside the command handler.
	let loaded: ReturnType<typeof loadRunManifestById>;
	try {
		loaded = (deps.loadManifest ?? loadRunManifestById)(cwd, runId);
	} catch {
		return { isError: true, text: `Run '${runId}' is not a valid run id.` };
	}
	if (!loaded) return { isError: true, text: `Run '${runId}' not found (it may have been cleaned up).` };
	const artifact = pickMostRecentOutputArtifact(loaded.manifest, loaded.tasks);
	if (!artifact) return { isError: true, text: `Run '${runId}' has no output artifacts yet.` };
	const tail = readTextTail(artifact.path, SCHEDULES_LOG_TAIL_BYTES);
	const lines = [
		`Scheduled job '${job.name}' — latest run ${runId}`,
		`artifact: ${artifact.path} (${tail.bytes} bytes${tail.truncated ? `, showing last ${SCHEDULES_LOG_TAIL_BYTES}` : ""})`,
		tail.text.trimEnd(),
	];
	return { isError: false, text: lines.join("\n") };
}

/**
 * Most-recent output artifact of a run. Candidate set mirrors
 * team-tool/run.ts:252-273 — the run-level summary artifact plus per-task
 * result artifacts — each resolved inside `artifactsRoot` through
 * `resolveRealContainedPath` (rejects absolute paths and `..` traversal);
 * unresolvable/unreadable candidates are skipped, newest mtime wins.
 */
function pickMostRecentOutputArtifact(manifest: TeamRunManifest, tasks: TeamTaskState[]): { path: string; mtimeMs: number } | undefined {
	const relPaths: string[] = [];
	for (const artifact of manifest.artifacts ?? []) {
		if (artifact?.kind === "summary" || artifact?.kind === "result" || artifact?.kind === "log") relPaths.push(artifact.path);
	}
	for (const task of tasks) {
		if (task?.resultArtifact?.path) relPaths.push(task.resultArtifact.path);
	}
	let best: { path: string; mtimeMs: number } | undefined;
	for (const rel of relPaths) {
		try {
			const resolved = resolveRealContainedPath(manifest.artifactsRoot, rel);
			const mtimeMs = fs.statSync(resolved).mtimeMs;
			if (!best || mtimeMs > best.mtimeMs) best = { path: resolved, mtimeMs };
		} catch {
			/* traversal-guarded or missing artifact — skip */
		}
	}
	return best;
}

/** Error-level variant of notifyCommandResult (same 800-char bound). */
async function notifySchedulesError(ctx: ExtensionCommandContext, text: string): Promise<void> {
	ctx.ui.notify(text.length > 800 ? `${text.slice(0, 797)}...` : text, "error");
}

/** Tab-completion: `log` subcommand, then job ids (labeled by name). */
function suggestSchedulesArgs(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = argumentPrefix ?? "";
	if (prefix === "" || prefix === "l" || prefix === "lo" || prefix === "log") {
		return [{ value: "log", label: "log", description: "tail the latest run output of a job" }];
	}
	// Raw prefix (NOT trimmed) so `log ` (trailing space) means "suggest jobs".
	const match = prefix.match(/^log\s+(\S*)$/i);
	if (!match) return null;
	const query = match[1] ?? "";
	const items: AutocompleteItem[] = [];
	// Review round 1 minor-3: autocomplete runs on EVERY keystroke. Gate on
	// the registered scheduler (same discipline as the widget's default
	// reader) so a missing scheduler can never fall back to the settings-store
	// DISK read per keystroke — pre-registration simply suggests nothing.
	const jobs = getCrewScheduler() ? getScheduledJobs(process.cwd()) : [];
	for (const job of jobs) {
		if (query && !job.id.startsWith(query) && !job.name.toLowerCase().includes(query.toLowerCase())) continue;
		items.push({ value: `log ${job.id}`, label: job.name, description: `id ${job.id}` });
		if (items.length >= 10) break;
	}
	return items.length > 0 ? items : null;
}

/** Register the `/schedules` command (see module doc). Headless-safe: the
 *  handler touches only `ctx.cwd` and `ctx.ui.notify`. */
export function registerSchedulesCommands(pi: ExtensionAPI): void {
	pi.registerCommand("schedules", {
		description: "List scheduled jobs (/schedules log <jobId-or-name> tails the latest output)",
		getArgumentCompletions: (argumentPrefix: string) => suggestSchedulesArgs(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseSchedulesArgs(args);
			if (parsed.mode === "usage") {
				await notifyCommandResult(ctx, parsed.error);
				return;
			}
			const jobs = getScheduledJobs(ctx.cwd);
			if (parsed.mode === "log") {
				const outcome = buildSchedulesLogText(ctx.cwd, jobs, parsed.target);
				if (outcome.isError) {
					await notifySchedulesError(ctx, outcome.text);
					return;
				}
				await notifyCommandResult(ctx, outcome.text);
				return;
			}
			// D6-T4: the render path takes `now` as a parameter — this single
			// `new Date()` at the handler boundary is the clock injection point.
			// P2-1: the hidden count rides the same user-initiated invocation
			// (stash-first provider read — in-memory when the scheduler singleton
			// is registered, one tiers read otherwise; never on a render tick).
			await notifyCommandResult(
				ctx,
				buildSchedulesCommandLines(jobs, new Date(), getScheduledJobsHiddenCountView(ctx.cwd)).join("\n"),
			);
		},
	});
}
