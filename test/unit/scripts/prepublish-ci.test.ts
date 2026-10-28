/**
 * prepublish-ci.test.ts — pin for the `prepublishOnly` env-scrub wrapper
 * (v0.11.39, bug class "publish from inside a crew worker → phantom test
 * failures").
 *
 * `prepublishOnly` used to be plain `npm run ci`. Inside a pi-crew worker the
 * harness exports PI_CREW_* / PI_TEAMS_* control plane into the environment,
 * and the suite asserts those are absent from child-pi spawns — so the gate
 * failed ~27 times for reasons unrelated to the tree being published. The
 * wrapper (scripts/prepublish-ci.mjs) scrubs those prefixes and forwards the
 * exit code.
 *
 * Test (iii) is the one that matters: it does not trust the scrub function,
 * it spawns a REAL child and asserts on the child's own view of
 * `process.env` — the leak that caused the phantom failures was exactly a
 * parent→child env inheritance, so only an end-to-end assertion pins it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error TS7016 — dev-only script, no .d.mts (test-runner-exit/gh-pr-comment pattern).
import { CREW_ENV_PREFIXES, PRESERVED_CREW_ENV_KEYS, runWithCleanEnv, scrubCrewEnv } from "../../../scripts/prepublish-ci.mjs";

describe("prepublish-ci: scrubCrewEnv", () => {
	it("(i) removes every PI_CREW_* and PI_TEAMS_* key and keeps everything else", () => {
		const env = {
			PATH: "/usr/bin",
			HOME: "/home/someone",
			npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
			PI_CREW_SCRATCHPAD: "1",
			PI_CREW_TASK_ID: "01_01-agent",
			PI_CREW_ARTIFACTS_ROOT: "/tmp/artifacts",
			PI_CREW_DEPTH: "1",
			PI_CREW_BROKER_RUN_ID: "team_x",
			PI_TEAMS_DEPTH: "1",
			PI_TEAMS_MOCK_CHILD_PI: "1",
			// NOT crew-owned: a look-alike prefix must survive.
			PI_CREWISH_THING: "keep-me",
		};

		const clean = scrubCrewEnv(env);

		for (const key of Object.keys(clean)) {
			for (const prefix of CREW_ENV_PREFIXES) {
				assert.equal(key.startsWith(prefix), false, `${key} leaked through the scrub`);
			}
		}
		assert.deepEqual(Object.keys(clean).sort(), ["HOME", "PATH", "PI_CREWISH_THING", "npm_execpath"]);
		assert.equal(clean.PATH, "/usr/bin");
		assert.equal(clean.PI_CREWISH_THING, "keep-me");
	});

	it("(i-b) preserves the preserved test/battery knobs verbatim", () => {
		const clean = scrubCrewEnv({ PI_CREW_TEST_NO_HOME_ISOLATION: "1", PI_CREW_BATTERY_SKIP: "1", PI_CREW_TASK_ID: "t" });

		for (const key of PRESERVED_CREW_ENV_KEYS) {
			assert.equal(clean[key], "1", `${key} must survive the scrub (sandboxes without a writable HOME / battery skip-hatch need it)`);
		}
		assert.equal(clean.PI_CREW_TASK_ID, undefined);
	});

	it("(i-c) preserves PI_CREW_BATTERY_SKIP — the battery's documented explicit-skip flag", () => {
		// When the battery fails on a host without a `pi` binary it tells the
		// caller to set exactly this variable; if the npm path (prepublish-ci →
		// battery) scrubbed it, the documented escape hatch would be dead.
		const clean = scrubCrewEnv({ PI_CREW_BATTERY_SKIP: "1", PI_CREW_BROKER_RUN_ID: "team_x" });

		assert.equal(
			clean.PI_CREW_BATTERY_SKIP,
			"1",
			"PI_CREW_BATTERY_SKIP must survive the scrub (battery failure message tells the caller to set it)",
		);
		assert.equal(clean.PI_CREW_BROKER_RUN_ID, undefined);
	});

	it("(ii) an env with no crew keys comes back equivalent (and unmutated)", () => {
		const env = { PATH: "/bin", HOME: "/root", LANG: "C.UTF-8" };
		const snapshot = { ...env };

		const clean = scrubCrewEnv(env);

		assert.deepEqual(clean, snapshot);
		assert.notEqual(clean, env, "must return a copy, never the live process.env object");
		assert.deepEqual(env, snapshot, "input must not be mutated");
	});
});

describe("prepublish-ci: child process sees a scrubbed env", () => {
	it("(iii) a spawned child cannot see PI_CREW_FAKE / PI_TEAMS_FAKE from the parent env", async () => {
		const probe = 'process.stdout.write(`${process.env.PI_CREW_FAKE ?? "absent"}/${process.env.PI_TEAMS_FAKE ?? "absent"}`)';
		const result = await runWithCleanEnv({
			command: process.execPath,
			args: ["-e", probe],
			env: { ...process.env, PI_CREW_FAKE: "1", PI_TEAMS_FAKE: "1", KEPT_BY_SCRUB_PROBE: "visible" },
			stdio: "pipe",
		});

		assert.equal(result.code, 0, `probe child failed: ${result.stderr}`);
		assert.equal(result.stdout, "absent/absent", `child inherited crew env from the parent: ${result.stdout}`);
	});

	it("(iii-b) non-crew env still reaches the child (scrub must not starve the gate)", async () => {
		const result = await runWithCleanEnv({
			command: process.execPath,
			args: ["-e", 'process.stdout.write(process.env.KEPT_BY_SCRUB_PROBE ?? "absent")'],
			env: { ...process.env, KEPT_BY_SCRUB_PROBE: "visible" },
			stdio: "pipe",
		});

		assert.equal(result.code, 0, `probe child failed: ${result.stderr}`);
		assert.equal(result.stdout, "visible");
	});

	it("(iii-c) the child's exit code propagates (a red gate must not print green)", async () => {
		const result = await runWithCleanEnv({
			command: process.execPath,
			args: ["-e", "process.exit(7)"],
			stdio: "pipe",
		});

		assert.equal(result.code, 7);
	});
});
