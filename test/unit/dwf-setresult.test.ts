/**
 * Regression test for RFC 17: dwf.runDynamicWorkflow must propagate setResult
 * to getWorkflowFinalResult via the frozen ctx.
 *
 * Live pi session was returning "(dynamic workflow X completed without calling
 * ctx.setResult())" even when the dwf called ctx.setResult(path). This test
 * reproduces the issue at the unit level so the bug is caught by CI.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const thisFile = fileURLToPath(import.meta.url);

// These tests execute PROJECT-sourced .dwf.ts scripts, which the F-01 trust
// gate denies unless PI_CREW_TRUST_PROJECT_DWF=1. The tests used to pass only
// when the ambient session env happened to set the var (B3 battery runs) and
// silently failed otherwise — set it explicitly and restore afterwards.
const prevTrust = process.env.PI_CREW_TRUST_PROJECT_DWF;
process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
test.after(() => {
	if (prevTrust === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	else process.env.PI_CREW_TRUST_PROJECT_DWF = prevTrust;
});

test("runDynamicWorkflow: dwf calling ctx.setResult(path) is recognized", async () => {
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = jitiMod.default ?? jitiMod;
	const jiti = createJiti(thisFile);
	const dwfMod = await jiti.import(path.join(repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string);
	const { runDynamicWorkflow } = dwfMod.default ?? dwfMod;
	assert.equal(typeof runDynamicWorkflow, "function");

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-sr-"));
	fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });

	const artifactPath = path.join(tmpCwd, "expected-result.txt");
	const dwfPath = path.join(tmpCwd, ".crew", "workflows", "setresult-test.dwf.ts");
	fs.writeFileSync(
		dwfPath,
		`export default async function run(ctx) {
  ctx.setResult(${JSON.stringify(artifactPath)});
}
`,
	);

	const runId = "team_dwf_sr_test_" + Date.now();
	const stateRoot = path.join(tmpCwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");

	const manifest = {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: "setresult-test",
		goal: "test setResult",
		status: "running" as const,
		workspaceMode: "single" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpCwd,
		stateRoot,
		artifactsRoot: path.join(tmpCwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	const workflow = {
		name: "setresult-test",
		description: "test",
		source: "project" as const,
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic" as const,
		dynamicScript: dwfPath,
	};
	const team = {
		name: "test-team",
		description: "test",
		source: "dynamic" as const,
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single" as const,
	};

	const result = await runDynamicWorkflow({
		manifest,
		workflow,
		team,
		signal: AbortSignal.timeout(5000),
	});
	assert.notEqual(
		result.manifest.summary,
		"(dynamic workflow 'setresult-test' completed without calling ctx.setResult())",
		`setResult was called by the dwf but the runner reports it wasn't. summary=${result.manifest.summary}`,
	);
});

// ---------------------------------------------------------------------------
// round-13 integration tests: AST determinism check (P0-2)
// ---------------------------------------------------------------------------

interface Round13DetFixture {
	repoRoot: string;
	require: NodeRequire;
	thisFile: string;
	jitiMod: { default?: unknown };
	createJiti: (...args: unknown[]) => {
		import(path: string): Promise<unknown>;
	};
	tmpCwd: string;
	dwfPath: string;
	artifactPath: string;
	runId: string;
	stateRoot: string;
	eventsPath: string;
	manifest: Record<string, unknown>;
	workflow: Record<string, unknown>;
	team: Record<string, unknown>;
}

function makeRound13DetFixture(name: string): Round13DetFixture {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const require = createRequire(import.meta.url);
	const thisFile = fileURLToPath(import.meta.url);
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = (jitiMod as { default?: unknown }).default ?? jitiMod;

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dwf-r13-det-${name}-`));
	fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });
	const artifactPath = path.join(tmpCwd, "result.txt");
	const dwfPath = path.join(tmpCwd, ".crew", "workflows", `r13-det-${name}.dwf.ts`);
	const runId = `team_dwf_r13_det_${name}_${Date.now()}`;
	const stateRoot = path.join(tmpCwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");

	const manifest = {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: `r13-det-${name}`,
		goal: "round-13 determinism test",
		status: "running" as const,
		workspaceMode: "single" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpCwd,
		stateRoot,
		artifactsRoot: path.join(tmpCwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	const workflow = {
		name: `r13-det-${name}`,
		description: "round-13 determinism test",
		source: "project" as const,
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic" as const,
		dynamicScript: dwfPath,
	};
	const team = {
		name: "test-team",
		description: "test",
		source: "dynamic" as const,
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single" as const,
	};

	return {
		repoRoot,
		require,
		thisFile,
		jitiMod: jitiMod as { default?: unknown },
		createJiti: createJiti as Round13DetFixture["createJiti"],
		tmpCwd,
		dwfPath,
		artifactPath,
		runId,
		stateRoot,
		eventsPath,
		manifest,
		workflow,
		team,
	};
}

async function runDwf(fx: Round13DetFixture): Promise<{ status: string; summary: string }> {
	const jiti = fx.createJiti(fx.thisFile);
	const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string)) as {
		default?: {
			runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
		};
	};
	const { runDynamicWorkflow } =
		dwfMod.default ??
		(dwfMod as unknown as {
			runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
		});
	const result = (await runDynamicWorkflow({
		manifest: fx.manifest,
		workflow: fx.workflow,
		team: fx.team,
		signal: AbortSignal.timeout(5000),
	})) as { manifest: { status: string; summary: string } };
	return result.manifest;
}

test("round-13 integration: dwf calling Date.now() is rejected with clear error", async () => {
	const fx = makeRound13DetFixture("datenow");
	const savedSkip = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const t = Date.now();
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "ok");
		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string)) as {
			default?: {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			});
		await assert.rejects(
			async () =>
				runDynamicWorkflow({
					manifest: fx.manifest,
					workflow: fx.workflow,
					team: fx.team,
					signal: AbortSignal.timeout(5000),
				}),
			/Date\.now\(\)\/Math\.random\(\)\/new Date\(\) are unavailable/,
		);
	} finally {
		if (savedSkip !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedSkip;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-13 integration: dwf calling Math.random() is rejected with clear error", async () => {
	const fx = makeRound13DetFixture("mathrandom");
	const savedSkip = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const r = Math.random();
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "ok");
		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string)) as {
			default?: {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			});
		await assert.rejects(
			async () =>
				runDynamicWorkflow({
					manifest: fx.manifest,
					workflow: fx.workflow,
					team: fx.team,
					signal: AbortSignal.timeout(5000),
				}),
			/Date\.now\(\)\/Math\.random\(\)\/new Date\(\) are unavailable/,
		);
	} finally {
		if (savedSkip !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedSkip;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-13 integration: dwf with new Date() is rejected with clear error", async () => {
	const fx = makeRound13DetFixture("newdate");
	const savedSkip = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const d = new Date();
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "ok");
		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string)) as {
			default?: {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			});
		await assert.rejects(
			async () =>
				runDynamicWorkflow({
					manifest: fx.manifest,
					workflow: fx.workflow,
					team: fx.team,
					signal: AbortSignal.timeout(5000),
				}),
			/Date\.now\(\)\/Math\.random\(\)\/new Date\(\) are unavailable/,
		);
	} finally {
		if (savedSkip !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedSkip;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-13 integration: dwf with literal string 'Date.now()' succeeds", async () => {
	const fx = makeRound13DetFixture("stringliteral");
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const label = "Date.now() is forbidden in this script";
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "literal ok");
		const finalManifest = await runDwf(fx);
		assert.equal(finalManifest.status, "completed");
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-13 integration: env var PI_CREW_DWF_SKIP_DETERMINISM_CHECK=1 allows opt-out", async () => {
	const fx = makeRound13DetFixture("skip");
	const savedSkip = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const t = Date.now(); // would normally be blocked
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "skipped ok");
		const finalManifest = await runDwf(fx);
		assert.equal(finalManifest.status, "completed", "skip env var should allow Date.now()");
	} finally {
		if (savedSkip === undefined) delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		else process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = savedSkip;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// round-12 integration tests: phase events + clone guard
// ---------------------------------------------------------------------------

interface Round12Args {
	repoRoot: string;
	require: NodeRequire;
	thisFile: string;
	jitiMod: { default?: unknown };
	createJiti: (...args: unknown[]) => {
		import(path: string): Promise<unknown>;
	};
	tmpCwd: string;
	dwfPath: string;
	artifactPath: string;
	runId: string;
	stateRoot: string;
	eventsPath: string;
	manifest: Record<string, unknown>;
	workflow: Record<string, unknown>;
	team: Record<string, unknown>;
}

function makeRound12Fixture(): Round12Args {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const require = createRequire(import.meta.url);
	const thisFile = fileURLToPath(import.meta.url);
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = (jitiMod as { default?: unknown }).default ?? jitiMod;

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dwf-r12-"));
	fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });
	const artifactPath = path.join(tmpCwd, "expected-result.txt");
	const dwfPath = path.join(tmpCwd, ".crew", "workflows", "r12-test.dwf.ts");
	const runId = "team_dwf_r12_test_" + Date.now();
	const stateRoot = path.join(tmpCwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");

	const manifest = {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: "r12-test",
		goal: "test round-12",
		status: "running" as const,
		workspaceMode: "single" as const,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpCwd,
		stateRoot,
		artifactsRoot: path.join(tmpCwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	const workflow = {
		name: "r12-test",
		description: "round-12 test",
		source: "project" as const,
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic" as const,
		dynamicScript: dwfPath,
	};
	const team = {
		name: "test-team",
		description: "test",
		source: "dynamic" as const,
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single" as const,
	};

	return {
		repoRoot,
		require,
		thisFile,
		jitiMod: jitiMod as { default?: unknown },
		createJiti: createJiti as Round12Args["createJiti"],
		tmpCwd,
		dwfPath,
		artifactPath,
		runId,
		stateRoot,
		eventsPath,
		manifest,
		workflow,
		team,
	};
}

test("round-12 integration: dwf calling ctx.phase() emits correct events; runner auto-closes last phase", async () => {
	const fx = makeRound12Fixture();
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  ctx.phase("Scan");
  ctx.phase("Audit");
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "scan + audit done\n");

		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts") as string)) as {
			default?: {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...args: unknown[]) => Promise<unknown>;
			});

		const result = (await runDynamicWorkflow({
			manifest: fx.manifest,
			workflow: fx.workflow,
			team: fx.team,
			signal: AbortSignal.timeout(5000),
		})) as { manifest: { status: string } };

		assert.equal(result.manifest.status, "completed", "workflow should complete normally");

		// Verify the events log contains the expected sequence.
		const eventLines = fs
			.readFileSync(fx.eventsPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						data?: { phase?: string };
					},
			);
		const phaseTypes = eventLines
			.filter((e) => e.type.startsWith("dwf."))
			.map((e) => `${e.type}${e.data?.phase ? `:${e.data.phase}` : ""}`);
		assert.deepEqual(phaseTypes, [
			"dwf.started",
			"dwf.phase_started:Scan",
			"dwf.phase_completed:Scan",
			"dwf.phase_started:Audit",
			"dwf.phase_completed:Audit",
			"dwf.completed",
		]);
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// round-14 integration tests: ctx.log + ctx.args (P1-3 / P1-5)
// ---------------------------------------------------------------------------

interface Round14Args {
	repoRoot: string;
	thisFile: string;
	createJiti: (...args: unknown[]) => { import(p: string): Promise<unknown> };
	tmpCwd: string;
	dwfPath: string;
	artifactPath: string;
	runId: string;
	eventsPath: string;
	manifest: Record<string, unknown>;
	workflow: Record<string, unknown>;
	team: Record<string, unknown>;
}

function makeRound14Fixture(name: string, args?: unknown): Round14Args {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const require = createRequire(import.meta.url);
	const thisFile = fileURLToPath(import.meta.url);
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = (jitiMod as { default?: unknown }).default ?? jitiMod;

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dwf-r14-${name}-`));
	fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });
	const artifactPath = path.join(tmpCwd, "result.txt");
	const dwfPath = path.join(tmpCwd, ".crew", "workflows", `r14-${name}.dwf.ts`);
	const runId = `team_dwf_r14_${name}_${Date.now()}`;
	const stateRoot = path.join(tmpCwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");

	const manifest: Record<string, unknown> = {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: `r14-${name}`,
		goal: "round-14 test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpCwd,
		stateRoot,
		artifactsRoot: path.join(tmpCwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	if (args !== undefined) manifest.args = args;

	const workflow = {
		name: `r14-${name}`,
		description: "round-14 test",
		source: "project",
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic",
		dynamicScript: dwfPath,
	};
	const team = {
		name: "test-team",
		description: "test",
		source: "dynamic",
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single",
	};

	return {
		repoRoot,
		thisFile,
		createJiti: createJiti as Round14Args["createJiti"],
		tmpCwd,
		dwfPath,
		artifactPath,
		runId,
		eventsPath,
		manifest,
		workflow,
		team,
	};
}

test("round-14 integration: dwf calling ctx.log() produces dwf.log events", async () => {
	const fx = makeRound14Fixture("log");
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  ctx.log("scan complete");
  ctx.log({ findings: 3 });
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		fs.writeFileSync(fx.artifactPath, "logged\n");

		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts"))) as {
			default?: {
				runDynamicWorkflow: (...a: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...a: unknown[]) => Promise<unknown>;
			});
		const result = (await runDynamicWorkflow({
			manifest: fx.manifest,
			workflow: fx.workflow,
			team: fx.team,
			signal: AbortSignal.timeout(5000),
		})) as { manifest: { status: string } };

		assert.equal(result.manifest.status, "completed");
		const eventLines = fs
			.readFileSync(fx.eventsPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim())
			.map(
				(l) =>
					JSON.parse(l) as {
						type: string;
						data?: { message?: string };
					},
			);
		const logEvents = eventLines.filter((e) => e.type === "dwf.log");
		assert.equal(logEvents.length, 2, "two dwf.log events emitted");
		assert.equal(logEvents[0]?.data?.message, "scan complete");
		assert.equal(logEvents[1]?.data?.message, '{"findings":3}');
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-14 integration: dwf calling ctx.args<T>() reads typed args from manifest", async () => {
	const fx = makeRound14Fixture("args", { target: "src/lib.ts", retries: 2 });
	try {
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  const args = ctx.args();
  ctx.log("target=" + args.target + " retries=" + args.retries);
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		// Pre-write the result artifact the way the phase/setResult fixtures do.
		fs.writeFileSync(fx.artifactPath, "args-test\n");

		const jiti = fx.createJiti(fx.thisFile);
		const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts"))) as {
			default?: {
				runDynamicWorkflow: (...a: unknown[]) => Promise<unknown>;
			};
		};
		const { runDynamicWorkflow } =
			dwfMod.default ??
			(dwfMod as unknown as {
				runDynamicWorkflow: (...a: unknown[]) => Promise<unknown>;
			});
		const result = (await runDynamicWorkflow({
			manifest: fx.manifest,
			workflow: fx.workflow,
			team: fx.team,
			signal: AbortSignal.timeout(5000),
		})) as { manifest: { status: string } };

		assert.equal(result.manifest.status, "completed");
		const eventLines = fs
			.readFileSync(fx.eventsPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim())
			.map(
				(l) =>
					JSON.parse(l) as {
						type: string;
						data?: { message?: string };
					},
			);
		const logEvents = eventLines.filter((e) => e.type === "dwf.log");
		assert.equal(logEvents[0]?.data?.message, "target=src/lib.ts retries=2", "ctx.args() read the manifest args end-to-end");
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// round-18 P2-3 integration tests: resume/checkpoint
// ---------------------------------------------------------------------------

interface Round18Fx {
	repoRoot: string;
	thisFile: string;
	createJiti: (...args: unknown[]) => { import(p: string): Promise<unknown> };
	tmpCwd: string;
	dwfPath: string;
	artifactPath: string;
	runId: string;
	stateRoot: string;
	checkpointPath: string;
	eventsPath: string;
	manifest: Record<string, unknown>;
	workflow: Record<string, unknown>;
	team: Record<string, unknown>;
}

function makeRound18Fixture(name: string): Round18Fx {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const require = createRequire(import.meta.url);
	const thisFile = fileURLToPath(import.meta.url);
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = (jitiMod as { default?: unknown }).default ?? jitiMod;

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dwf-r18-${name}-`));
	fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });
	const artifactPath = path.join(tmpCwd, "result.txt");
	const dwfPath = path.join(tmpCwd, ".crew", "workflows", `r18-${name}.dwf.ts`);
	const runId = `team_dwf_r18_${name}_${Date.now()}`;
	const stateRoot = path.join(tmpCwd, "state");
	fs.mkdirSync(stateRoot, { recursive: true });
	const checkpointPath = path.join(stateRoot, "dwf-checkpoint.json");
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");

	const manifest: Record<string, unknown> = {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: `r18-${name}`,
		goal: "round-18 test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpCwd,
		stateRoot,
		artifactsRoot: path.join(tmpCwd, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
	const workflow = {
		name: `r18-${name}`,
		description: "round-18 test",
		source: "project",
		filePath: dwfPath,
		steps: [],
		runtime: "dynamic",
		dynamicScript: dwfPath,
	};
	const team = {
		name: "test-team",
		description: "test",
		source: "dynamic",
		filePath: "<test>",
		roles: [{ name: "worker", agent: "executor" }],
		workspaceMode: "single",
	};

	return {
		repoRoot,
		thisFile,
		createJiti: createJiti as Round18Fx["createJiti"],
		tmpCwd,
		dwfPath,
		artifactPath,
		runId,
		stateRoot,
		checkpointPath,
		eventsPath,
		manifest,
		workflow,
		team,
	};
}

async function runRound18(fx: Round18Fx): Promise<{ status: string; summary: string }> {
	const jiti = fx.createJiti(fx.thisFile);
	const dwfMod = (await jiti.import(path.join(fx.repoRoot, "src/runtime/goal-workflow/dynamic-workflow-runner.ts"))) as {
		default?: { runDynamicWorkflow: (...a: unknown[]) => Promise<unknown> };
	};
	const { runDynamicWorkflow } =
		dwfMod.default ??
		(dwfMod as unknown as {
			runDynamicWorkflow: (...a: unknown[]) => Promise<unknown>;
		});
	const result = (await runDynamicWorkflow({
		manifest: fx.manifest,
		workflow: fx.workflow,
		team: fx.team,
		signal: AbortSignal.timeout(8000),
	})) as { manifest: { status: string; summary: string } };
	return result.manifest;
}

function readRound18Events(eventsPath: string): Array<{ type: string; data?: Record<string, unknown> }> {
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map(
			(l) =>
				JSON.parse(l) as {
					type: string;
					data?: Record<string, unknown>;
				},
		);
}

test("round-18 fresh run: no checkpoint loaded (no dwf.resumed event)", async () => {
	const fx = makeRound18Fixture("fresh");
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		fs.writeFileSync(fx.artifactPath, "fresh-result\n");
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  await ctx.agent({ role: "executor", prompt: "step" });
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		// No pre-existing checkpoint → this is a fresh run.
		assert.ok(!fs.existsSync(fx.checkpointPath), "no checkpoint before the fresh run");

		const m = await runRound18(fx);
		assert.equal(m.status, "completed");
		const events = readRound18Events(fx.eventsPath);
		assert.equal(events.filter((e) => e.type === "dwf.resumed").length, 0, "fresh run must NOT emit dwf.resumed");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-18 completed run: checkpoint is deleted after clean completion", async () => {
	const fx = makeRound18Fixture("completed");
	const savedMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const savedAllow = process.env.PI_CREW_ALLOW_MOCK;
	try {
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		fs.writeFileSync(fx.artifactPath, "completed-result\n");
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  await ctx.agent({ role: "executor", prompt: "step" });
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		await runRound18(fx);
		// After a clean completion the runner MUST delete the checkpoint so a re-run
		// with the same runId starts fresh rather than resuming stale state.
		assert.ok(!fs.existsSync(fx.checkpointPath), "checkpoint deleted after clean completion");
	} finally {
		if (savedMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = savedMock;
		if (savedAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = savedAllow;
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-18 resume: pre-existing checkpoint hydrates ctx + emits dwf.resumed", async () => {
	const fx = makeRound18Fixture("resume");
	try {
		fs.writeFileSync(fx.artifactPath, "resume-result\n");
		// Pre-write a checkpoint file at the run's stateRoot with vars the script will read.
		const checkpoint = {
			runId: fx.runId,
			vars: { lastPhase: "scan", carried: "RESUMED_VALUE_42" },
			phases: ["scan"],
			currentPhase: "scan",
			logs: ["prior-log"],
			spent: 111,
			agentCount: 1,
			updatedAt: "2026-06-23T00:00:00.000Z",
		};
		fs.writeFileSync(fx.checkpointPath, JSON.stringify(checkpoint));

		// The script reads ctx.vars (hydrated from the checkpoint) and logs them so we can
		// observe hydration end-to-end via the events log. No agent() call needed —
		// resume hydration is independent of agent spawning.
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  ctx.log("HYDRATED:" + JSON.stringify(ctx.vars));
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);

		const m = await runRound18(fx);
		assert.equal(m.status, "completed");

		// 1. The hydrated vars reached the events log.
		const events = readRound18Events(fx.eventsPath);
		const logEvents = events.filter((e) => e.type === "dwf.log");
		const hydrated = logEvents.map((e) => String(e.data?.message ?? "")).find((msg) => msg.startsWith("HYDRATED:"));
		assert.ok(hydrated, "ctx.vars were logged by the resumed script");
		const out = JSON.parse(hydrated!.slice("HYDRATED:".length));
		assert.equal(out.carried, "RESUMED_VALUE_42", "ctx.vars hydrated from the checkpoint end-to-end");
		assert.equal(out.lastPhase, "scan");

		// 2. A dwf.resumed event was emitted.
		const resumed = events.find((e) => e.type === "dwf.resumed");
		assert.ok(resumed, "dwf.resumed event emitted on resume");
		assert.equal(resumed?.data?.agentCount, 1, "resumed event carries the prior agentCount");

		// 3. The checkpoint is deleted after the resumed run completes cleanly.
		assert.ok(!fs.existsSync(fx.checkpointPath), "checkpoint deleted after resumed run completes");
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});

test("round-18 resume: corrupt checkpoint is treated as a fresh run (no throw)", async () => {
	const fx = makeRound18Fixture("corrupt");
	try {
		fs.writeFileSync(fx.artifactPath, "corrupt-result\n");
		// A corrupt checkpoint file must not crash the runner — load() returns undefined.
		fs.writeFileSync(fx.checkpointPath, "{not valid json at all");
		fs.writeFileSync(
			fx.dwfPath,
			`export default async function run(ctx) {
  ctx.setResult(${JSON.stringify(fx.artifactPath)});
}
`,
		);
		const m = await runRound18(fx);
		assert.equal(m.status, "completed", "corrupt checkpoint → fresh run → completes normally");
		const events = readRound18Events(fx.eventsPath);
		assert.equal(events.filter((e) => e.type === "dwf.resumed").length, 0, "corrupt checkpoint is NOT resumed");
	} finally {
		fs.rmSync(fx.tmpCwd, { recursive: true, force: true });
	}
});
