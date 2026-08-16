/**
 * bug-026 sub-issue B — doctor Filesystem "fs failure causes" line.
 *
 * buildTeamDoctorReport must surface a compact count + last occurrence of
 * tasks carrying a fatal-fs failureCause across the most recent runs, as an
 * INFORMATIONAL line (ok:true) so a historical disk-full incident never
 * permanently fails doctor.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTeamDoctorReport } from "../../../../src/extension/team-tool/doctor.ts";

interface FixtureTask {
	id: string;
	status: string;
	failureCause?: string;
	finishedAt?: string;
}

function writeFixtureRun(cwd: string, runId: string, tasks: FixtureTask[]): void {
	const runDir = path.join(cwd, ".crew", "state", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "tasks.json"), JSON.stringify(tasks), "utf-8");
}

test("doctor Filesystem section reports fs failureCause count + last occurrence", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-fs-"));
	try {
		writeFixtureRun(cwd, "team_fixture_older", [
			{ id: "t1", status: "completed" },
			{ id: "t2", status: "failed", failureCause: "enospc", finishedAt: "2026-08-15T14:00:00.000Z" },
		]);
		writeFixtureRun(cwd, "team_fixture_newer", [
			{ id: "t3", status: "completed" },
			{ id: "t4", status: "failed", failureCause: "emfile", finishedAt: "2026-08-16T02:00:00.000Z" },
		]);
		const report = buildTeamDoctorReport({
			cwd,
			configPath: path.join(cwd, "pi-crew-config.json"),
			configErrors: [],
			configWarnings: [],
			validationErrors: 0,
			validationWarnings: 0,
		});
		assert.match(report.text, /fs failure causes/);
		assert.match(report.text, /2 task\(s\) in last 10 runs/);
		assert.match(report.text, /last: team_fixture_newer/);
		assert.match(report.text, /too many open files/);
		// Informational only — historical incidents must not fail doctor.
		assert.equal(report.hasErrors, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor fs failure causes line reports none when no fixture failures exist", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-fs-none-"));
	try {
		writeFixtureRun(cwd, "team_fixture_clean", [{ id: "t1", status: "completed" }]);
		const report = buildTeamDoctorReport({
			cwd,
			configPath: path.join(cwd, "pi-crew-config.json"),
			configErrors: [],
			configWarnings: [],
			validationErrors: 0,
			validationWarnings: 0,
		});
		assert.match(report.text, /fs failure causes/);
		assert.match(report.text, /none in last 10 runs/);
		assert.equal(report.hasErrors, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor fs failure causes line tolerates a missing runs root", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-fs-missing-"));
	try {
		const report = buildTeamDoctorReport({
			cwd,
			configPath: path.join(cwd, "pi-crew-config.json"),
			configErrors: [],
			configWarnings: [],
			validationErrors: 0,
			validationWarnings: 0,
		});
		assert.match(report.text, /fs failure causes/);
		assert.match(report.text, /no run history/);
		assert.equal(report.hasErrors, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
