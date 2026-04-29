import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildTeamDoctorReport } from "../../src/extension/team-tool/doctor.ts";

test("doctor report includes structured sections", () => {
	const report = buildTeamDoctorReport({
		cwd: process.cwd(),
		configPath: "/tmp/pi-crew-config.json",
		configErrors: [],
		configWarnings: ["warn1"],
		model: { provider: "provider", id: "model" },
		validationErrors: 0,
		validationWarnings: 1,
		smokeChildPi: { ok: true, detail: "completed" },
	});
	assert.match(report.text, /pi-crew doctor report/);
	assert.match(report.text, /\nRuntime\n/);
	assert.match(report.text, /\nFilesystem\n/);
	assert.match(report.text, /\nDiscovery\n/);
	assert.match(report.text, /\nResource validation\n/);
	assert.match(report.text, /resource model hints/);
	assert.match(report.text, /child Pi smoke/);
	assert.equal(report.hasErrors, false);
});

test("doctor report does not create missing state directories", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-report-"));
	const projectState = path.join(cwd, ".crew");
	const artifactsRoot = path.join(projectState, "artifacts");
	try {
		const report = buildTeamDoctorReport({
			cwd,
			configPath: path.join(cwd, "pi-crew-config.json"),
			configErrors: [],
			configWarnings: [],
			validationErrors: 0,
			validationWarnings: 0,
		});
		assert.match(report.text, /project state: /);
		assert.match(report.text, /artifacts root: /);
		assert.ok(!fs.existsSync(projectState));
		assert.ok(!fs.existsSync(artifactsRoot));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor report marks errors", () => {
	const report = buildTeamDoctorReport({
		cwd: process.cwd(),
		configPath: "/tmp/pi-crew-config.json",
		configErrors: ["bad config"],
		configWarnings: [],
		validationErrors: 2,
		validationWarnings: 0,
	});
	assert.equal(report.hasErrors, true);
	assert.match(report.text, /FAIL config/);
	assert.match(report.text, /FAIL resource validation/);
});
