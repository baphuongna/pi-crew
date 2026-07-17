import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildTeamDoctorReport, type TeamDoctorReportInput } from "../../src/extension/team-tool/doctor.ts";

// Round 29 optimization: use a fresh empty temp cwd per test file run.
// Previously this used cwd: "/tmp" which forced discoverX() to walk the
// entire /tmp tree on every test (12 tests × ~2s = 24s). The tests don't
// care about discovered resources, only the report text, so an empty dir
// is semantically equivalent and dramatically faster.
let tmpCwd: string;
let tmpConfig: string;

before(() => {
	tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-doctor-cov-"));
	tmpConfig = path.join(tmpCwd, "pi-crew.yaml");
});

after(() => {
	try {
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

function makeInput(overrides?: Partial<TeamDoctorReportInput>): TeamDoctorReportInput {
	return {
		cwd: tmpCwd,
		configPath: tmpConfig,
		configErrors: [],
		configWarnings: [],
		validationErrors: 0,
		validationWarnings: 0,
		...overrides,
	};
}

describe("buildTeamDoctorReport", () => {
	it("produces a report with text and no errors for healthy input", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text);
		assert.ok(report.text.includes("pi-crew doctor report"));
		assert.equal(report.hasErrors, false);
	});

	it("flags errors when configErrors is non-empty", () => {
		const report = buildTeamDoctorReport(makeInput({ configErrors: ["bad config"] }));
		assert.equal(report.hasErrors, true);
		assert.ok(report.text.includes("FAIL"));
	});

	it("includes model info when provided", () => {
		const report = buildTeamDoctorReport(makeInput({ model: { provider: "anthropic", id: "claude-3" } }));
		assert.ok(report.text.includes("anthropic/claude-3"));
	});

	it("indicates model not available when omitted", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text.includes("not available in this context"));
	});

	it("reports validation errors and warnings", () => {
		const report = buildTeamDoctorReport(makeInput({ validationErrors: 2, validationWarnings: 1 }));
		assert.ok(report.text.includes("2 errors"));
		assert.ok(report.text.includes("1 warnings"));
		assert.equal(report.hasErrors, true);
	});

	it("includes smoke child pi results when provided", () => {
		const report = buildTeamDoctorReport(makeInput({ smokeChildPi: { ok: true, detail: "passed" } }));
		assert.ok(report.text.includes("Child check"));
		assert.ok(report.text.includes("passed"));
	});

	it("shows FAIL for smoke child pi failure", () => {
		const report = buildTeamDoctorReport(makeInput({ smokeChildPi: { ok: false, detail: "timeout" } }));
		assert.ok(report.text.includes("FAIL"));
		assert.ok(report.text.includes("timeout"));
	});

	it("includes Runtime section with platform info", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text.includes("Runtime"));
		assert.ok(report.text.includes("platform"));
	});

	it("includes Filesystem section", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text.includes("Filesystem"));
	});

	it("includes Discovery section", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text.includes("Discovery"));
	});

	it("includes Schema section", () => {
		const report = buildTeamDoctorReport(makeInput());
		assert.ok(report.text.includes("Schema"));
	});

	it("includes config warnings count", () => {
		const report = buildTeamDoctorReport(makeInput({ configWarnings: ["w1", "w2"] }));
		assert.ok(report.text.includes("2 warnings"));
	});
});
