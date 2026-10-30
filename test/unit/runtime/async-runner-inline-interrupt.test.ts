/**
 * FIX-1 E2E wiring test (live catch, run team_20261030044630_3935473bc4886682):
 * a cross-session cancel must reach an INLINE async run executing IN the
 * owner-session process (the PI_CREW_TEST_ASYNC_INLINE=1 +
 * PI_CREW_ALLOW_MOCK=1 seam → spawnBackgroundTeamRun → executeBackgroundRun).
 *
 * In that live run the worker (pid 403288) kept running ≥75s post-cancel:
 * the interrupt guard was mounted ONLY in the detached main() path, so two
 * foreground-control.json requests sat acknowledged:false with nobody
 * polling. The core now mounts a run-scoped guard for signal-less (inline)
 * hosts.
 *
 * Flow: direct-agent run (builtin executor, no fixture team files needed) +
 * json-slow-success mock worker (deterministic multi-second `running` window)
 * → mid-run writeForegroundInterruptRequest → assert ack within ~3s,
 * async.interrupt_detected appended, the run reaches a terminal state (no
 * forever-hang), and a request written AFTER the run ended is NEVER consumed
 * (the core's guard interval was stopped — no leak).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { spawnBackgroundTeamRun } from "../../../src/runtime/async-runner.ts";
import { writeForegroundInterruptRequest } from "../../../src/runtime/foreground-control.ts";
import { flushEventLogBuffer } from "../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, updateRunStatus } from "../../../src/state/stores/state-store.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

const SILENT_WINDOW_MS = 4000;

const ENV_KEYS = [
	"PI_CREW_TEST_ASYNC_INLINE",
	"PI_CREW_ALLOW_MOCK",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_TEAMS_MOCK_STEER_WINDOW_MS",
	"PI_CREW_INTERRUPT_GUARD_INTERVAL_MS",
	"PI_TEAMS_EXECUTE_WORKERS",
] as const;

test("inline async run consumes a mid-run foreground interrupt (ack + event + abort + no leaked guard)", async () => {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inline-interrupt-"));
	try {
		// Canonicalize to long-name form matching production code
		try {
			const r = fs.realpathSync.native(cwd);
			cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const saved: Record<string, string | undefined> = {};
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		process.env.PI_CREW_TEST_ASYNC_INLINE = "1";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-slow-success";
		process.env.PI_TEAMS_MOCK_STEER_WINDOW_MS = String(SILENT_WINDOW_MS);
		process.env.PI_CREW_INTERRUPT_GUARD_INTERVAL_MS = "100";
		process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
		try {
			// direct-agent manifest: the core synthesizes team+workflow
			// (directTeamAndWorkflowFromRun) so no team/workflow fixture files
			// are needed; the builtin executor agent is always discoverable.
			const created = createRunManifest({
				cwd,
				team: {
					name: "direct-inline-interrupt",
					description: "inline interrupt probe",
					source: "builtin",
					filePath: "<test>",
					roles: [{ name: "agent", agent: "executor" }],
					workspaceMode: "single",
				},
				workflow: {
					name: "direct-agent",
					description: "inline interrupt probe",
					source: "builtin",
					filePath: "<test>",
					steps: [{ id: "01_agent", role: "agent", task: "{goal}" }],
				},
				goal: "stay busy while the owner session cancels",
			});
			const manifest = updateRunStatus(created.manifest, "running", "test dispatch");

			const spawned = await spawnBackgroundTeamRun(manifest);
			assert.equal(spawned.pid, process.pid, "inline seam returns the TEST process pid (no detached runner)");

			const readEvents = (): Array<Record<string, unknown>> => {
				try {
					return fs
						.readFileSync(manifest.eventsPath, "utf-8")
						.split("\n")
						.filter((line) => line.trim() !== "")
						.map((line) => JSON.parse(line) as Record<string, unknown>);
				} catch {
					return [];
				}
			};
			const taskStatus = (): string | undefined => loadRunManifestById(cwd, manifest.runId)?.tasks[0]?.status;
			const runStatus = (): string | undefined => loadRunManifestById(cwd, manifest.runId)?.manifest.status;

			// Wait until the task is actually RUNNING (mock sleeps
			// SILENT_WINDOW_MS before emitting anything → a wide window).
			const runningDeadline = Date.now() + 20_000;
			while (Date.now() < runningDeadline && taskStatus() !== "running" && runStatus() === "running") {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(taskStatus(), "running", `task must reach running before the interrupt (run status=${runStatus()})`);

			// ── MID-RUN cross-session cancel (the producer cancel.ts uses) ──
			writeForegroundInterruptRequest(manifest, "test: cancel the inline run");

			// 1) Request acknowledged within ~3s (guard interval is 100ms).
			const controlPath = path.join(manifest.stateRoot, "foreground-control.json");
			const ackDeadline = Date.now() + 3000;
			let acked = false;
			while (Date.now() < ackDeadline) {
				try {
					const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { requests?: Array<{ acknowledged?: boolean }> };
					if (parsed.requests?.at(-1)?.acknowledged === true) {
						acked = true;
						break;
					}
				} catch {
					/* not yet */
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(acked, "inline run must ACKNOWLEDGE the interrupt request (nobody polled before FIX-1)");

			// 2) async.interrupt_detected appended to the event log. Poll rather
			// than single-shot: the run itself writes events concurrently (buffered
			// batches contend on the event-log lock), so a single flush+read can
			// race the batch landing (live-caught flake, 1-in-5 on the dev box).
			const eventDeadline = Date.now() + 3000;
			let detected = false;
			while (Date.now() < eventDeadline) {
				await flushEventLogBuffer();
				if (readEvents().some((e) => e.type === "async.interrupt_detected" && e.runId === manifest.runId)) {
					detected = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(detected, "inline run must append async.interrupt_detected");

			// 3) The run aborts — terminal manifest status AND terminal tasks
			// within a bounded window (no forever-hang; the abort propagates
			// through the run's own controller → cancellation ladder). NOTE: the
			// manifest can flip to cancelled while an in-flight mock worker is
			// still unwinding — poll BOTH, do not single-read.
			const terminalDeadline = Date.now() + 25_000;
			while (Date.now() < terminalDeadline) {
				const loaded = loadRunManifestById(cwd, manifest.runId);
				const status = loaded?.manifest.status;
				const tasksRunning = (loaded?.tasks ?? []).some((task) => task.status === "running" || task.status === "queued");
				if (status !== "running" && status !== "queued" && !tasksRunning) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const finalLoaded = loadRunManifestById(cwd, manifest.runId);
			const finalStatus = finalLoaded?.manifest.status;
			assert.ok(
				finalStatus !== "running" && finalStatus !== "queued",
				`run must reach a terminal state after the interrupt (status=${finalStatus})`,
			);
			const finalTasks = finalLoaded?.tasks ?? [];
			assert.ok(
				finalTasks.every((task) => task.status !== "running" && task.status !== "queued"),
				`all tasks terminal after the interrupt (statuses=${finalTasks.map((t) => t.status).join(",")})`,
			);

			// 4) Guard interval cleaned up: a request written AFTER the run
			// ended is never consumed (≈6 ignored ticks at 100ms interval).
			await new Promise((resolve) => setTimeout(resolve, 300));
			fs.writeFileSync(
				controlPath,
				JSON.stringify(
					{
						requests: [
							{
								type: "interrupt",
								acknowledged: false,
								id: "post-terminal",
								createdAt: new Date().toISOString(),
								reason: "leak probe",
							},
						],
					},
					null,
					2,
				),
				"utf-8",
			);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const postRequest = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { requests?: Array<{ acknowledged?: boolean }> };
			assert.notEqual(
				postRequest.requests?.at(-1)?.acknowledged,
				true,
				"post-terminal request must NOT be acknowledged — the core's guard interval must be stopped",
			);
		} finally {
			for (const key of ENV_KEYS) {
				const value = saved[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	} finally {
		await removeDirWithRetry(cwd);
	}
});
