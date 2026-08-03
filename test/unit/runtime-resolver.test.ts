import assert from "node:assert/strict";
import test from "node:test";
import { probeLiveSessionRuntime } from "../../src/runtime/live-session/live-session-runtime.ts";
import { resolveCrewRuntime } from "../../src/runtime/model/runtime-resolver.ts";

test("runtime resolver defaults auto to live-session when available", async () => {
	const runtime = await resolveCrewRuntime({}, {
		PI_CREW_MOCK_LIVE_SESSION: "success",
	} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "live-session");
	assert.equal(runtime.requestedMode, "auto");
});

test("runtime resolver auto falls back to child-process when live-session is unavailable", async () => {
	const runtime = await resolveCrewRuntime({}, {} as NodeJS.ProcessEnv);
	assert.ok(["live-session", "child-process"].includes(runtime.kind), `expected live-session or child-process, got ${runtime.kind}`);
	assert.equal(runtime.requestedMode, "auto");
});

test("runtime resolver supports explicit scaffold dry-run", async () => {
	const runtime = await resolveCrewRuntime({ runtime: { mode: "scaffold" } }, {} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "scaffold");
	assert.equal(runtime.safety, "explicit_dry_run");
	assert.equal(runtime.steer, false);
});

test("runtime resolver lets config disable workers", async () => {
	const runtime = await resolveCrewRuntime({ executeWorkers: false }, {} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "scaffold");
	assert.equal(runtime.available, false);
	assert.equal(runtime.safety, "blocked");
	assert.match(runtime.reason ?? "", /disabled/);
});

test("runtime resolver with PI_TEAMS_MOCK_CHILD_PI forces child-process in auto mode", async () => {
	const runtime = await resolveCrewRuntime({}, {
		PI_TEAMS_MOCK_CHILD_PI: "json-success",
	} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "child-process");
	assert.match(runtime.reason ?? "", /mock/i);
});

test("runtime resolver lets explicit live-session override child-process mock", async () => {
	const runtime = await resolveCrewRuntime({ runtime: { mode: "live-session" }, executeWorkers: true }, {
		PI_TEAMS_MOCK_CHILD_PI: "json-success",
		PI_CREW_MOCK_LIVE_SESSION: "success",
	} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "live-session");
	assert.equal(runtime.requestedMode, "live-session");
});

test("runtime resolver can request live-session with safe fallback", async () => {
	const runtime = await resolveCrewRuntime({ runtime: { mode: "live-session" }, executeWorkers: true }, {} as NodeJS.ProcessEnv);
	assert.ok(["live-session", "child-process", "scaffold"].includes(runtime.kind));
	assert.equal(runtime.requestedMode, "live-session");
});

test("runtime resolver uses mock live-session when enabled", async () => {
	const runtime = await resolveCrewRuntime({ runtime: { mode: "live-session" }, executeWorkers: true }, {
		PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION: "1",
		PI_CREW_MOCK_LIVE_SESSION: "success",
	} as NodeJS.ProcessEnv);
	assert.equal(runtime.kind, "live-session");
	assert.equal(runtime.requestedMode, "live-session");
});

test("live session probe returns a stable envelope", async () => {
	const probe = await probeLiveSessionRuntime();
	assert.equal(typeof probe.available, "boolean");
	assert.equal(typeof probe.reason, "string");
});
