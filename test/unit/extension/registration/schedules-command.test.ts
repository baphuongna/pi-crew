/**
 * Unit tests for the `/schedules` command (Scheduled Jobs UI tier E).
 * Covers: pane-renderer parity (no drift), phrase rewrite + autocomplete
 * suggestion, log resolution by id and by name, missing-job error text,
 * bounded tail, traversal-guarded artifact picking, and the headless shape
 * (handler runs on a minimal ctx with only cwd + ui.notify — no TUI).
 * @see src/extension/registration/commands/schedules.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { suggestCrewPhrases } from "../../../../src/extension/crew-autocomplete.ts";
import { CREW_PHRASES, rewriteCrewInput } from "../../../../src/extension/crew-input-router.ts";
import {
	buildSchedulesCommandLines,
	buildSchedulesLogText,
	parseSchedulesArgs,
	registerSchedulesCommands,
	resolveScheduledJobByIdOrName,
	SCHEDULES_LOG_TAIL_BYTES,
} from "../../../../src/extension/registration/commands/schedules.ts";
import {
	getCrewScheduler,
	registerCrewScheduler,
	stashScheduledJobsHiddenCount,
	unregisterCrewScheduler,
} from "../../../../src/extension/team-tool/handle-schedule.ts";
import type { ScheduledJob } from "../../../../src/runtime/scheduling/scheduler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { renderSchedulesPane, renderSchedulesTextBlock, SCHEDULES_EMPTY_STATE } from "../../../../src/ui/dashboard-panes/schedules-pane.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-alpha",
		name: "nightly build",
		description: "",
		schedule: "0 9 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: "2026-09-01T00:00:00.000Z",
		// Time anchors so relative columns react to the injected clock.
		nextRun: new Date(NOW.getTime() + 84 * 60 * 1000).toISOString(),
		lastRun: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
		lastStatus: "success",
		runCount: 3,
		...overrides,
	};
}

const JOBS: ScheduledJob[] = [makeJob(), makeJob({ id: "job-beta", name: "weekly audit", createdAt: "2026-09-05T00:00:00.000Z" })];

// ─── parseSchedulesArgs ───────────────────────────────────────────────────────

describe("parseSchedulesArgs", () => {
	it("bare / whitespace args → list mode", () => {
		assert.deepEqual(parseSchedulesArgs(""), { mode: "list" });
		assert.deepEqual(parseSchedulesArgs("   "), { mode: "list" });
	});

	it("'log <target>' → log mode with multi-word target", () => {
		assert.deepEqual(parseSchedulesArgs("log job-alpha"), { mode: "log", target: "job-alpha" });
		assert.deepEqual(parseSchedulesArgs("  log   nightly   build  "), { mode: "log", target: "nightly build" });
	});

	it("'log' without target → usage error", () => {
		const parsed = parseSchedulesArgs("log");
		assert.equal(parsed.mode, "usage");
		if (parsed.mode === "usage") assert.match(parsed.error, /Usage: \/schedules log/);
	});

	it("unknown subcommand → usage error naming it", () => {
		const parsed = parseSchedulesArgs("logs x");
		assert.equal(parsed.mode, "usage");
		if (parsed.mode === "usage") {
			assert.match(parsed.error, /Unknown subcommand 'logs'/);
			assert.match(parsed.error, /Usage: \/schedules/);
		}
	});
});

// ─── pane-renderer parity (no drift) ─────────────────────────────────────────

describe("buildSchedulesCommandLines — parity with renderSchedulesPane", () => {
	it("renders the identical table (foreground:false, includeIds:true) + manage hint", () => {
		const lines = buildSchedulesCommandLines(JOBS, NOW);
		const pane = renderSchedulesPane(JOBS, NOW, { foreground: false, includeIds: true });
		assert.deepEqual(lines.slice(0, pane.length), pane, "command table must equal the pane renderer output");
		assert.equal(lines.length, pane.length + 1);
		assert.match(lines[lines.length - 1] ?? "", /^Manage: team action='schedule'/);
	});

	it("empty jobs → the shared empty state, no separate defaults", () => {
		const lines = buildSchedulesCommandLines([], NOW);
		assert.deepEqual(lines, [SCHEDULES_EMPTY_STATE]);
		assert.equal(renderSchedulesPane([], NOW)[0], SCHEDULES_EMPTY_STATE);
	});

	it("clock is injected — a different now changes the relative columns", () => {
		const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
		assert.notDeepEqual(buildSchedulesCommandLines(JOBS, NOW), buildSchedulesCommandLines(JOBS, later));
	});
});

// ─── job resolution (id OR name) ─────────────────────────────────────────────

describe("resolveScheduledJobByIdOrName", () => {
	it("resolves by exact id", () => {
		assert.equal(resolveScheduledJobByIdOrName(JOBS, "job-beta")?.id, "job-beta");
	});

	it("resolves by name (case-insensitive, trimmed)", () => {
		assert.equal(resolveScheduledJobByIdOrName(JOBS, "Nightly Build")?.id, "job-alpha");
		assert.equal(resolveScheduledJobByIdOrName(JOBS, "  weekly audit ")?.id, "job-beta");
	});

	it("duplicate names → most recently created wins", () => {
		const older = makeJob({ id: "old", name: "dup", createdAt: "2026-08-01T00:00:00.000Z" });
		const newer = makeJob({ id: "new", name: "dup", createdAt: "2026-09-10T00:00:00.000Z" });
		assert.equal(resolveScheduledJobByIdOrName([older, newer], "dup")?.id, "new");
	});

	it("no match → undefined", () => {
		assert.equal(resolveScheduledJobByIdOrName(JOBS, "nope"), undefined);
		assert.equal(resolveScheduledJobByIdOrName(JOBS, ""), undefined);
	});
});

// ─── /schedules log — artifact tail via fake manifest + real files ───────────

/** Minimal manifest fake — pickMostRecentOutputArtifact reads only
 *  artifactsRoot + artifacts; loadManifest is the injected seam. */
function fakeManifest(artifactsRoot: string, artifactPaths: Array<{ kind: string; rel: string }>): TeamRunManifest {
	return {
		runId: "run_1",
		artifactsRoot,
		artifacts: artifactPaths.map((a) => ({
			kind: a.kind,
			path: a.rel,
			createdAt: "2026-09-13T00:00:00.000Z",
			producer: "test",
			retention: "run",
		})),
	} as unknown as TeamRunManifest;
}

function fakeTask(rel: string): TeamTaskState {
	return {
		id: "task-1",
		resultArtifact: { kind: "result", path: rel, createdAt: "", producer: "", retention: "run" },
	} as unknown as TeamTaskState;
}

function writeArtifact(root: string, rel: string, text: string, mtime: Date): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf-8");
	fs.utimesSync(file, mtime, mtime);
}

describe("buildSchedulesLogText", () => {
	it("resolves by id AND by name → tails the most recent output artifact", () => {
		const tmp = createTrackedTempDir("schedules-log-");
		try {
			const older = new Date("2026-09-13T10:00:00.000Z");
			const newer = new Date("2026-09-13T11:30:00.000Z");
			writeArtifact(tmp, "results/summary.md", "summary output", older);
			writeArtifact(tmp, "results/task-1.md", "latest task output", newer);
			const manifest = fakeManifest(tmp, [{ kind: "summary", rel: "results/summary.md" }]);
			const loadManifest = () => ({ manifest, tasks: [fakeTask("results/task-1.md")] });
			const job = makeJob({ spawnedRunIds: ["run_old", "run_new"] });

			const byId = buildSchedulesLogText(tmp, [job], "job-alpha", { loadManifest });
			const byName = buildSchedulesLogText(tmp, [job], "nightly build", { loadManifest });

			assert.equal(byId.isError, false);
			assert.equal(byName.isError, false);
			assert.equal(byId.text, byName.text, "id and name resolution must land on the same job");
			assert.match(byId.text, /Scheduled job 'nightly build' — latest run run_new/);
			assert.match(byId.text, /results\/task-1\.md/);
			assert.match(byId.text, /latest task output/);
			assert.doesNotMatch(byId.text, /summary output/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("missing job → exact error text", () => {
		const outcome = buildSchedulesLogText("/tmp", JOBS, "zzz");
		assert.equal(outcome.isError, true);
		assert.equal(outcome.text, "No scheduled job with id or name 'zzz'.");
	});

	it("job without spawned runs → explicit error", () => {
		const outcome = buildSchedulesLogText("/tmp", [makeJob()], "job-alpha");
		assert.equal(outcome.isError, true);
		assert.match(outcome.text, /has no spawned runs yet/);
	});

	it("manifest not found → explicit error", () => {
		const job = makeJob({ spawnedRunIds: ["run_gone"] });
		const outcome = buildSchedulesLogText("/tmp", [job], "job-alpha", { loadManifest: () => undefined });
		assert.equal(outcome.isError, true);
		assert.match(outcome.text, /Run 'run_gone' not found/);
	});

	it("run without readable artifacts → explicit error (traversal paths skipped)", () => {
		const tmp = createTrackedTempDir("schedules-log-guard-");
		try {
			writeArtifact(tmp, "results/ok.md", "kept", new Date());
			const manifest = fakeManifest(tmp, [
				{ kind: "summary", rel: "../escape.md" },
				{ kind: "result", rel: "results/ok.md" },
			]);
			// Traversal candidate must be skipped by resolveRealContainedPath;
			// the contained one still wins.
			const ok = buildSchedulesLogText(tmp, [makeJob({ spawnedRunIds: ["r"] })], "job-alpha", {
				loadManifest: () => ({ manifest, tasks: [] }),
			});
			assert.equal(ok.isError, false);
			assert.match(ok.text, /kept/);

			const empty = fakeManifest(tmp, [{ kind: "summary", rel: "../escape.md" }]);
			const none = buildSchedulesLogText(tmp, [makeJob({ spawnedRunIds: ["r"] })], "job-alpha", {
				loadManifest: () => ({ manifest: empty, tasks: [] }),
			});
			assert.equal(none.isError, true);
			assert.match(none.text, /no output artifacts yet/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("unsafe-charset runId (assertSafePathId throw) → graceful error, not an unhandled rejection", () => {
		// Security review F-3: a crafted settings entry can persist a
		// spawnedRunIds value the state store's path-id guard rejects by
		// THROWING. The command must degrade to an error result (mirrors the
		// run-not-found branch) instead of blowing up the handler.
		const throwing = (): never => {
			throw new Error("Invalid runId");
		};
		const outcome = buildSchedulesLogText("/tmp", [makeJob({ spawnedRunIds: ["../../x"] })], "job-alpha", {
			loadManifest: throwing,
		});
		assert.equal(outcome.isError, true);
		assert.match(outcome.text, /is not a valid run id/);
	});

	it("bounded tail — files larger than the cap show only the last bytes", () => {
		const tmp = createTrackedTempDir("schedules-log-bound-");
		try {
			const big = "x".repeat(SCHEDULES_LOG_TAIL_BYTES + 5000) + "TAIL_MARKER";
			writeArtifact(tmp, "results/big.md", big, new Date());
			const manifest = fakeManifest(tmp, [{ kind: "summary", rel: "results/big.md" }]);
			const outcome = buildSchedulesLogText(tmp, [makeJob({ spawnedRunIds: ["r"] })], "job-alpha", {
				loadManifest: () => ({ manifest, tasks: [] }),
			});
			assert.equal(outcome.isError, false);
			assert.match(outcome.text, new RegExp(`showing last ${SCHEDULES_LOG_TAIL_BYTES}`));
			assert.match(outcome.text, /TAIL_MARKER/);
			const tailText = outcome.text.split("\n").slice(2).join("\n");
			assert.ok(tailText.length <= SCHEDULES_LOG_TAIL_BYTES + 2, `tail must stay bounded, got ${tailText.length}`);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── natural-language phrases ────────────────────────────────────────────────

describe("crew phrases → /schedules", () => {
	it("rewrites 'crew schedule' and 'scheduled jobs'", () => {
		assert.equal(rewriteCrewInput("crew schedule"), "/schedules");
		assert.equal(rewriteCrewInput("team schedule"), "/schedules");
		assert.equal(rewriteCrewInput("scheduled jobs"), "/schedules");
	});

	it("carries log args forward through the phrase", () => {
		assert.equal(rewriteCrewInput("crew schedule log job-alpha"), "/schedules log job-alpha");
		assert.equal(rewriteCrewInput("scheduled jobs log nightly build"), "/schedules log nightly build");
	});

	it("does not shadow ordinary sentences", () => {
		assert.equal(rewriteCrewInput("the scheduled jobs are fine"), null);
	});

	it("CREW_PHRASES carries both entries (shared with autocomplete)", () => {
		assert.ok(CREW_PHRASES.some((p) => p.phrase === "crew schedule" && p.command === "/schedules"));
		assert.ok(CREW_PHRASES.some((p) => p.phrase === "scheduled jobs" && p.command === "/schedules"));
	});

	it("autocomplete suggests 'crew schedule' while typing", () => {
		const items = suggestCrewPhrases("sche");
		const hit = items.find((item) => item.value === "crew schedule");
		assert.ok(hit, "expected a 'crew schedule' suggestion");
		assert.equal(hit.description, "→ /schedules");
	});
});

// ─── P2-1: hidden project-tier jobs gate hint ──────────────────────────────

describe("buildSchedulesCommandLines — hidden-jobs gate hint (P2-1)", () => {
	it("hiddenCount > 0 → exactly one hint line with count + opt-in file + BOTH flags", () => {
		const lines = buildSchedulesCommandLines(JOBS, NOW, 2);
		const hintLines = lines.filter((l) => l.includes("hidden"));
		assert.equal(hintLines.length, 1, `exactly one hint line, got: ${lines.join("|")}`);
		assert.match(hintLines[0] ?? "", /2 project-tier jobs hidden/);
		assert.match(hintLines[0] ?? "", /~\/\.pi\/crew-settings\.json/);
		assert.match(hintLines[0] ?? "", /schedulingEnabled \+ allowProjectScheduledJobs/);
		assert.match(lines[lines.length - 1] ?? "", /^Manage: team action='schedule'/, "manage hint stays last");
	});

	it("empty jobs + hiddenCount > 0 → shared empty state + hint (not a bare empty state)", () => {
		const lines = buildSchedulesCommandLines([], NOW, 1);
		assert.equal(lines.length, 2);
		assert.equal(lines[0], SCHEDULES_EMPTY_STATE);
		assert.match(lines[1] ?? "", /1 project-tier job hidden/);
	});

	it("byte-parity with renderSchedulesTextBlock when hiddenCount is consistent (no drift)", () => {
		assert.deepEqual(buildSchedulesCommandLines(JOBS, NOW, 2), renderSchedulesTextBlock(JOBS, NOW, { hiddenCount: 2 }));
		assert.deepEqual(buildSchedulesCommandLines([], NOW, 2), renderSchedulesTextBlock([], NOW, { hiddenCount: 2 }));
		assert.deepEqual(
			buildSchedulesCommandLines(JOBS, NOW, 2),
			renderSchedulesPane(JOBS, NOW, { foreground: false, includeIds: true, hiddenCount: 2 }).concat([
				"Manage: team action='schedule' subAction='enable|disable|remove|run-now' jobId='<id>'",
			]),
		);
	});

	it("hiddenCount 0/omitted → no hint (legacy layout preserved)", () => {
		assert.ok(!buildSchedulesCommandLines(JOBS, NOW).some((l) => l.includes("hidden")));
		assert.ok(!buildSchedulesCommandLines([], NOW, 0).some((l) => l.includes("hidden")));
		assert.deepEqual(buildSchedulesCommandLines([], NOW), [SCHEDULES_EMPTY_STATE]);
	});
});

describe("/schedules handler surfaces the hidden count (P2-1)", () => {
	it("registered scheduler + stashed count → notify text carries the hint line", async () => {
		const tmp = createTrackedTempDir("schedules-cmd-hidden-");
		try {
			const notices: RecordedNotice[] = [];
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			registerSchedulesCommands({
				registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					handler = def.handler;
				},
			} as never);
			assert.ok(handler);
			const h = handler;
			// Manual register/restore (not withScheduler) so the WHOLE handler
			// invocation — and the stash cleanup — is awaited deterministically.
			const saved = getCrewScheduler();
			registerCrewScheduler({
				add: () => undefined,
				list: () => JOBS,
				remove: () => false,
				update: () => undefined,
				runNow: () => ({ ok: false, error: "not started" }),
			});
			stashScheduledJobsHiddenCount(2);
			try {
				await h("", headlessCtx(tmp, notices));
			} finally {
				stashScheduledJobsHiddenCount(undefined);
				if (saved) registerCrewScheduler(saved);
				else unregisterCrewScheduler();
			}
			assert.equal(notices.length, 1);
			assert.match(notices[0]?.text ?? "", /2 project-tier jobs hidden/);
			assert.match(notices[0]?.text ?? "", /allowProjectScheduledJobs/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("registered scheduler WITHOUT a stash → no hint (hermetic — no real settings read)", async () => {
		const notices: RecordedNotice[] = [];
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerSchedulesCommands({
			registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				handler = def.handler;
			},
		} as never);
		assert.ok(handler);
		const h = handler;
		withScheduler([], async () => {
			await h("", headlessCtx("/tmp", notices));
		});
		assert.equal(notices.length, 1);
		assert.ok(!notices[0]?.text.includes("hidden"), `no hint without a stash, got: ${notices[0]?.text}`);
		assert.match(notices[0]?.text ?? "", new RegExp(SCHEDULES_EMPTY_STATE));
	});
});

// ─── headless command shape ──────────────────────────────────────────────────

/** Register/unregister the module-scoped scheduler around a test body. */
function withScheduler(jobs: ScheduledJob[], fn: () => void): void {
	const saved = getCrewScheduler();
	registerCrewScheduler({
		add: () => undefined,
		list: () => jobs,
		remove: () => false,
		update: () => undefined,
		runNow: () => ({ ok: false, error: "not started" }),
	});
	try {
		fn();
	} finally {
		if (saved) registerCrewScheduler(saved);
		else unregisterCrewScheduler();
	}
}

interface RecordedNotice {
	text: string;
	level: string;
}

/** Minimal HEADLESS ctx: only cwd + ui.notify — no TUI surface at all. Any
 *  TUI access (ctx.ui.custom, hasUI-driven branches) would throw here. */
function headlessCtx(cwd: string, notices: RecordedNotice[]): { cwd: string; ui: { notify: (text: string, level: string) => void } } {
	return {
		cwd,
		ui: {
			notify: (text: string, level: string) => {
				notices.push({ text, level });
			},
		},
	};
}

describe("registerSchedulesCommands — headless shape", () => {
	it("registers exactly the 'schedules' command", () => {
		const registered: Array<{ name: string; def: { description?: string } }> = [];
		const fakePi = {
			registerCommand: (name: string, def: { description?: string }) => registered.push({ name, def }),
		};
		registerSchedulesCommands(fakePi as never);
		assert.equal(registered.length, 1);
		assert.equal(registered[0]?.name, "schedules");
		assert.match(registered[0]?.def.description ?? "", /scheduled jobs/i);
	});

	it("bare invocation renders the pane text block via notify (no TUI)", async () => {
		const tmp = createTrackedTempDir("schedules-cmd-");
		try {
			const notices: RecordedNotice[] = [];
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			registerSchedulesCommands({
				registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					handler = def.handler;
				},
			} as never);
			assert.ok(handler);
			// Empty registered scheduler → deterministic shared empty state
			// (settings fallback would read real user-tier jobs otherwise).
			const h = handler;
			withScheduler([], async () => {
				await h("", headlessCtx(tmp, notices));
			});
			assert.equal(notices.length, 1);
			assert.equal(notices[0]?.level, "info");
			assert.equal(notices[0]?.text, buildSchedulesCommandLines([], NOW).join("\n"));
			assert.match(notices[0]?.text ?? "", new RegExp(SCHEDULES_EMPTY_STATE));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("log with a missing job notifies at error level with the exact text (no TUI)", async () => {
		const notices: RecordedNotice[] = [];
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerSchedulesCommands({
			registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				handler = def.handler;
			},
		} as never);
		assert.ok(handler);
		const h = handler;
		withScheduler([], async () => {
			await h("log zzz", headlessCtx("/tmp", notices));
		});
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "error");
		assert.equal(notices[0]?.text, "No scheduled job with id or name 'zzz'.");
	});

	it("log without a target notifies the usage text", async () => {
		const notices: RecordedNotice[] = [];
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerSchedulesCommands({
			registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				handler = def.handler;
			},
		} as never);
		assert.ok(handler);
		await handler("log", headlessCtx("/tmp", notices));
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "info");
		assert.match(notices[0]?.text ?? "", /Usage: \/schedules log/);
	});

	it("with a registered scheduler, the list renders its jobs", async () => {
		const tmp = createTrackedTempDir("schedules-cmd-live-");
		try {
			const notices: RecordedNotice[] = [];
			let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
			registerSchedulesCommands({
				registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					handler = def.handler;
				},
			} as never);
			assert.ok(handler);
			const h = handler;
			withScheduler(JOBS, async () => {
				await h("", headlessCtx(tmp, notices));
			});
			assert.equal(notices.length, 1);
			assert.match(notices[0]?.text ?? "", /Scheduled jobs \(2\):/);
			assert.match(notices[0]?.text ?? "", /id: job-alpha/);
			assert.match(notices[0]?.text ?? "", /^Manage: team action='schedule'/m);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
