/**
 * Regression test for RFC 17: dwf.runDynamicWorkflow must propagate setResult
 * to getWorkflowFinalResult via the frozen ctx.
 *
 * Live pi session was returning "(dynamic workflow X completed without calling
 * ctx.setResult())" even when the dwf called ctx.setResult(path). This test
 * reproduces the issue at the unit level so the bug is caught by CI.
 */
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const thisFile = fileURLToPath(import.meta.url);

test("runDynamicWorkflow: dwf calling ctx.setResult(path) is recognized", async () => {
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = jitiMod.default ?? jitiMod;
	const jiti = createJiti(thisFile);
	const dwfMod = await jiti.import(path.join(repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string);
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
	createJiti: (...args: unknown[]) => { import(path: string): Promise<unknown> };
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
	const dwfMod = (await jiti.import(
		path.join(fx.repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string,
	)) as { default?: { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> } };
	const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> });
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
		const dwfMod = (await jiti.import(
			path.join(fx.repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string,
		)) as { default?: { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> } };
		const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> });
		await assert.rejects(
			async () => runDynamicWorkflow({
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
		const dwfMod = (await jiti.import(
			path.join(fx.repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string,
		)) as { default?: { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> } };
		const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> });
		await assert.rejects(
			async () => runDynamicWorkflow({
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
		const dwfMod = (await jiti.import(
			path.join(fx.repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string,
		)) as { default?: { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> } };
		const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> });
		await assert.rejects(
			async () => runDynamicWorkflow({
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
	createJiti: (...args: unknown[]) => { import(path: string): Promise<unknown> };
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
		const dwfMod = (await jiti.import(
			path.join(fx.repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string,
		)) as { default?: { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> } };
		const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (...args: unknown[]) => Promise<unknown> });

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
			.map((line) => JSON.parse(line) as { type: string; data?: { phase?: string } });
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

