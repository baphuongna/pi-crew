/**
 * Round-14 P1-1: authoring types compile check.
 *
 * Verifies that a `.dwf.ts` script using the `pi-crew/workflow` authoring types
 * type-checks against the package's `./workflow` export (`types/dwf.d.ts`).
 *
 * The sample is placed INSIDE the repo so NodeNext module resolution finds the
 * `pi-crew` package.json and resolves the self-reference. We spawn the local
 * `typescript` compiler (a devDependency) so this mirrors real authoring.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const typesFile = path.join(repoRoot, "types", "dwf.d.ts");

/** The sample .dwf.ts used for the compile check — exercises budget/log/args/phase/agent/setResult. */
const SAMPLE_DWF = `import type { WorkflowCtx, AgentResult } from "pi-crew/workflow";

export default async function run(ctx: WorkflowCtx): Promise<void> {
	ctx.log("starting scan");
	ctx.phase("scan");
	const res: AgentResult = await ctx.agent({ role: "explorer", prompt: "survey" });
	// round-14 P1-2: budget surface
	const b = ctx.budget;
	if (b.total !== null && b.remaining() <= 0) {
		ctx.log({ exhausted: true, spent: b.spent() });
		return;
	}
	// round-14 P1-5: typed args
	const args = ctx.args<{ target: string }>();
	ctx.setResult(res.artifactPath ?? "", { target: args.target });
}
`;

function readPackageJson(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
}

function runTsc(samplePath: string): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
	const res = spawnSync(
		process.execPath,
		[
			tscBin,
			"--noEmit",
			// TS 7.0+: when a file path is passed on the command line and a tsconfig.json
			// exists in the cwd, tsc errors with TS5112 unless --ignoreConfig is passed.
			// This compile check supplies its own flags and intentionally ignores the
			// repo tsconfig.json (the sample lives in a temp dir under the repo root).
			"--ignoreConfig",
			"--moduleResolution",
			"NodeNext",
			"--module",
			"NodeNext",
			"--target",
			"ES2022",
			"--strict",
			"--skipLibCheck",
			"--types",
			"node",
			samplePath,
		],
		{ encoding: "utf-8" },
	);
	return {
		status: res.status ?? -1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

test("round-14 P1-1: types/dwf.d.ts ships and package.json declares the ./workflow export", () => {
	assert.ok(fs.existsSync(typesFile), "types/dwf.d.ts must exist");
	const pkg = readPackageJson();
	const exports = pkg.exports as Record<string, unknown> | undefined;
	assert.ok(exports, "package.json must have an exports map");
	assert.ok(exports["./workflow"], "package.json must declare the './workflow' export");
	const wfExport = exports["./workflow"] as Record<string, unknown>;
	assert.equal(wfExport.types, "./types/dwf.d.ts", "./workflow export must point at ./types/dwf.d.ts");
});

test("round-14 P1-1: package.json files[] includes the types/ directory", () => {
	const pkg = readPackageJson();
	const files = pkg.files as unknown[] | undefined;
	assert.ok(Array.isArray(files), "package.json must have a files[] array");
	assert.ok(files.includes("types/"), "files[] must include 'types/' so the .d.ts ships to npm");
});

test("round-14 P1-1: a .dwf.ts using pi-crew/workflow authoring types compiles cleanly", () => {
	// Place the sample inside the repo so the `pi-crew` self-reference resolves.
	const tmpDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-dwf-types-"));
	const samplePath = path.join(tmpDir, "sample.dwf.ts");
	try {
		fs.writeFileSync(samplePath, SAMPLE_DWF);
		const out = runTsc(samplePath);
		assert.equal(out.status, 0, `sample .dwf.ts must compile with zero errors. tsc output:\n${out.stdout}${out.stderr}`);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("round-14 P1-1: mistyped ctx usage is REJECTED by the authoring types (negative check)", () => {
	// A deliberately wrong call (agent returns AgentResult; accessing .nonexistent is an error)
	// proves the types are actually enforcing the contract, not just permissive `any`.
	const badDwf = `import type { WorkflowCtx } from "pi-crew/workflow";
export default async function run(ctx: WorkflowCtx): Promise<void> {
	const res = await ctx.agent({ role: "explorer", prompt: "x" });
	// @ts-expect-error — AgentResult has no 'definitelyNotAField' member
	res.definitelyNotAField;
}
`;
	const tmpDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-dwf-types-bad-"));
	const samplePath = path.join(tmpDir, "bad.dwf.ts");
	try {
		fs.writeFileSync(samplePath, badDwf);
		const out = runTsc(samplePath);
		assert.equal(out.status, 0, "the @ts-expect-error should suppress the single error → status 0. Got:\n" + out.stdout + out.stderr);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
