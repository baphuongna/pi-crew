import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTeamOnboarding } from "../../src/extension/team-onboard.ts";

test("buildTeamOnboarding: generates markdown", () => {
  const tmp = os.tmpdir();
  const onboarding = buildTeamOnboarding("default", tmp, { limit: 5 });

  assert.ok(onboarding.includes("# Team: default"));
  assert.ok(onboarding.includes("Multi-agent default team"));
  assert.ok(onboarding.includes("## Overview"));
  assert.ok(onboarding.includes("## How to Run"));
  assert.ok(onboarding.includes("team action='run'"));
});

test("buildTeamOnboarding: shows past runs if available", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-test-"));
  const crewRoot = path.join(tmp, ".crew");
  const runsRoot = path.join(crewRoot, "state", "runs");

  // Create a fake run manifest
  fs.mkdirSync(runsRoot, { recursive: true });
  const runId = "team_test_run_12345678";
  fs.mkdirSync(path.join(runsRoot, runId), { recursive: true });
  fs.writeFileSync(path.join(runsRoot, runId, "manifest.json"), JSON.stringify({
    runId,
    status: "completed",
    goal: "create a test file",
    team: "default",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [{ taskId: "01_test", role: "test-engineer", status: "completed" }],
  }), "utf-8");

  const onboarding = buildTeamOnboarding("default", tmp, { limit: 5 });
  assert.ok(onboarding.includes("## Past Runs"));
  assert.ok(onboarding.includes("create a test file"));
  assert.ok(onboarding.includes("✅ completed"));

  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildTeamOnboarding: handles empty runs", () => {
  const tmp = os.tmpdir();
  const onboarding = buildTeamOnboarding("nonexistent", tmp, { limit: 5 });

  assert.ok(onboarding.includes("# Team: nonexistent"));
  assert.ok(onboarding.includes("0"));
});

test("buildTeamOnboarding: limits past runs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-limit-"));
  const crewRoot = path.join(tmp, ".crew");
  const runsRoot = path.join(crewRoot, "state", "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  // Create multiple runs
  for (let i = 0; i < 10; i++) {
    const runId = `team_test_limit_${i}_12345678`;
    fs.mkdirSync(path.join(runsRoot, runId), { recursive: true });
    fs.writeFileSync(path.join(runsRoot, runId, "manifest.json"), JSON.stringify({
      runId,
      status: "completed",
      goal: `Goal ${i}`,
      team: "default",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    }), "utf-8");
  }

  const onboarding = buildTeamOnboarding("default", tmp, { limit: 3 });
  // Count table rows (excluding header)
  const tableRows = (onboarding.match(/\| `[a-f0-9]+` \|/g) ?? []).length;
  // With limit=3, should show at most 3 runs
  assert.ok(tableRows <= 3, `Expected <=3 rows, got ${tableRows}`);

  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("buildTeamOnboarding: includes team list section", () => {
  const tmp = os.tmpdir();
  const onboarding = buildTeamOnboarding("default", tmp);
  assert.ok(onboarding.includes("## Available Teams"));
});
