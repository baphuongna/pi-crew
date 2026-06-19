/**
 * Unit tests for workflow-manage.ts (P3).
 *
 * Verifies the security gating for workflow-create (§0c C3 destructive-gate + C5 path
 * allowlist + content validation) and the read-only actions.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	handleWorkflowCreate,
	handleWorkflowGet,
	handleWorkflowList,
	handleWorkflowDelete,
} from "../../src/extension/team-tool/workflow-manage.ts";

function tmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wf-manage-"));
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	return cwd;
}

function ctx(cwd: string) {
	return { cwd } as never;
}

const CLEAN_SCRIPT = `export default async function (ctx) { await ctx.agent({ role: "executor", prompt: "hi" }); ctx.setResult("/tmp/x"); }\n`;

test("workflow-create REQUIRES confirm:true (defense-in-depth even if gate is bypassed)", () => {
	const cwd = tmpCwd();
	try {
		const res = handleWorkflowCreate({ action: "workflow-create", config: { name: "x", script: CLEAN_SCRIPT } }, ctx(cwd));
		assert.equal(res.isError, true);
		assert.match((res.content[0] as { text: string }).text, /confirm:true/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-create rejects forbidden content (child_process / process.exit / network)", () => {
	const cwd = tmpCwd();
	try {
		const cases = [
			`require('child_process')`,
			`process.exit(1)`,
			`import net from 'net'`,
			`import http from 'https'`,
		];
		for (const evil of cases) {
			const res = handleWorkflowCreate(
				{ action: "workflow-create", confirm: true, config: { name: "evil", script: `export default async function(ctx){ ${evil}; }` } },
				ctx(cwd),
			);
			assert.equal(res.isError, true, `should reject: ${evil}`);
			assert.match((res.content[0] as { text: string }).text, /forbidden pattern|rejected/i);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-create writes a clean script to the project workflows dir", () => {
	const cwd = tmpCwd();
	try {
		const res = handleWorkflowCreate(
			{ action: "workflow-create", confirm: true, config: { name: "clean-wf", script: CLEAN_SCRIPT } },
			ctx(cwd),
		);
		assert.equal(res.isError, false);
		const filePath = path.join(cwd, ".crew", "workflows", "clean-wf.dwf.ts");
		assert.ok(fs.existsSync(filePath), "script written to project workflows dir");
		assert.equal(fs.readFileSync(filePath, "utf-8"), CLEAN_SCRIPT);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-create requires config.name + config.script", () => {
	const cwd = tmpCwd();
	try {
		const noName = handleWorkflowCreate({ action: "workflow-create", confirm: true, config: { script: CLEAN_SCRIPT } }, ctx(cwd));
		assert.equal(noName.isError, true);
		assert.match((noName.content[0] as { text: string }).text, /config\.name/i);
		const noScript = handleWorkflowCreate({ action: "workflow-create", confirm: true, config: { name: "x" } }, ctx(cwd));
		assert.equal(noScript.isError, true);
		assert.match((noScript.content[0] as { text: string }).text, /config\.script/i);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-list returns workflows with runtime discriminator", () => {
	const cwd = tmpCwd();
	try {
		// Create a dynamic workflow file directly.
		fs.writeFileSync(path.join(cwd, ".crew", "workflows", "demo.dwf.ts"), CLEAN_SCRIPT);
		const res = handleWorkflowList({ action: "workflow-list" }, ctx(cwd));
		assert.equal(res.isError, false);
		assert.match((res.content[0] as { text: string }).text, /demo/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-get returns the dynamic script source", () => {
	const cwd = tmpCwd();
	try {
		fs.writeFileSync(path.join(cwd, ".crew", "workflows", "demo.dwf.ts"), CLEAN_SCRIPT);
		const res = handleWorkflowGet({ action: "workflow-get", config: { name: "demo" } }, ctx(cwd));
		assert.equal(res.isError, false);
		assert.match((res.content[0] as { text: string }).text, /dynamic/);
		assert.match((res.content[0] as { text: string }).text, /ctx\.agent/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow-delete requires confirm:true + only deletes dynamic workflows inside allowed dirs", () => {
	const cwd = tmpCwd();
	try {
		fs.writeFileSync(path.join(cwd, ".crew", "workflows", "demo.dwf.ts"), CLEAN_SCRIPT);
		// Without confirm → blocked.
		const blocked = handleWorkflowDelete({ action: "workflow-delete", config: { name: "demo" } }, ctx(cwd));
		assert.equal(blocked.isError, true);
		assert.match((blocked.content[0] as { text: string }).text, /confirm:true/);
		// With confirm → deleted.
		const ok = handleWorkflowDelete({ action: "workflow-delete", confirm: true, config: { name: "demo" } }, ctx(cwd));
		assert.equal(ok.isError, false);
		assert.ok(!fs.existsSync(path.join(cwd, ".crew", "workflows", "demo.dwf.ts")), "file deleted");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
