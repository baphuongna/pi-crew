/**
 * Phase 2 regression tests — cross-session subagent isolation.
 *
 * Covers:
 *  (a) get_subagent_result on a record owned by another session is refused.
 *  (b) A legacy record (no ownerSessionId) is still served.
 *  (c) resultConsumed is NOT written when reading another session's record.
 *  (d) isOwnerSessionCurrent returns false for a different ownerSessionId
 *      even when the session generation matches.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildRegistrationContext } from "../../../src/extension/registration/context-builder.ts";
import { registerSubagentTools } from "../../../src/extension/registration/subagent-tools.ts";
import {
	readPersistedSubagentRecord,
	SubagentManager,
	type SubagentRecord,
	savePersistedSubagentRecord,
} from "../../../src/runtime/subagent-manager.ts";
import { firstText } from "../../fixtures/tool-result-helpers.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cross-session-"));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep as-is */
	}
	return dir;
}

/** Minimal fake pi with just enough to register tools. */
function createFakePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		api: {
			events: {
				on: () => () => undefined,
				emit: () => undefined,
			},
			on: () => () => undefined,
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		},
	};
}

/** Fake tool-execution ctx with a sessionManager that returns a fixed id. */
function fakeCtx(cwd: string, sessionId: string | undefined): any {
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: false,
		ui: {
			notify() {
				/* no-op */
			},
			setWidget() {
				/* no-op */
			},
			setStatus() {
				/* no-op */
			},
		},
	};
	if (sessionId !== undefined) {
		ctx.sessionManager = { getSessionId: () => sessionId };
	}
	return ctx;
}

/** Build a completed persisted record on disk. */
function seedRecord(cwd: string, id: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	const record: SubagentRecord = {
		id,
		type: "explorer",
		description: "Test agent",
		prompt: "Do work",
		status: "completed",
		startedAt: Date.now() - 5000,
		completedAt: Date.now(),
		result: "Task completed successfully.",
		background: true,
		...overrides,
	};
	savePersistedSubagentRecord(cwd, record);
	return record;
}

// ── Tests (a)–(c): get_subagent_result cross-session ownership ─────────────

test("(a) get_subagent_result refuses a record owned by another session", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_other_session", { ownerSessionId: "session-A" });
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		// Session B tries to read session A's record.
		const result = await resultTool.execute(
			"call-a",
			{ agent_id: "agent_other_session" },
			undefined,
			undefined,
			fakeCtx(cwd, "session-B"),
		);
		assert.match(firstText(result), /belongs to another session/);
		assert.equal(result.isError, true);
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(a2) get_subagent_result refuses when current session has no sessionManager (undefined id) but record has owner", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_owned_no_mgr", { ownerSessionId: "session-A" });
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		// ctx without sessionManager → currentSessionId is undefined.
		const result = await resultTool.execute(
			"call-a2",
			{ agent_id: "agent_owned_no_mgr" },
			undefined,
			undefined,
			fakeCtx(cwd, undefined),
		);
		assert.match(firstText(result), /belongs to another session/);
		assert.equal(result.isError, true);
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(b) get_subagent_result serves a legacy record (no ownerSessionId)", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_legacy", {});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		const result = await resultTool.execute(
			"call-b",
			{ agent_id: "agent_legacy", verbose: true },
			undefined,
			undefined,
			fakeCtx(cwd, "session-B"),
		);
		const text = firstText(result);
		assert.match(text, /Status: completed/);
		assert.doesNotMatch(text, /belongs to another session/);
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(b2) get_subagent_result serves own-session record", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_own", { ownerSessionId: "session-A" });
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		const result = await resultTool.execute(
			"call-b2",
			{ agent_id: "agent_own", verbose: true },
			undefined,
			undefined,
			fakeCtx(cwd, "session-A"),
		);
		const text = firstText(result);
		assert.match(text, /Status: completed/);
		assert.doesNotMatch(text, /belongs to another session/);
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(c) resultConsumed is NOT written when reading another session's record", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_clobber_test", {
			ownerSessionId: "session-A",
			resultConsumed: false,
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		// Session B tries to read session A's completed record.
		const result = await resultTool.execute(
			"call-c",
			{ agent_id: "agent_clobber_test" },
			undefined,
			undefined,
			fakeCtx(cwd, "session-B"),
		);
		assert.match(firstText(result), /belongs to another session/);
		// Verify the record on disk was NOT clobbered (resultConsumed still false).
		const persisted = readPersistedSubagentRecord(cwd, "agent_clobber_test");
		assert.ok(persisted, "record should still exist on disk");
		assert.notEqual(persisted?.resultConsumed, true, "resultConsumed must NOT be set by another session");
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("(c2) resultConsumed IS written when owner reads their own record", async () => {
	const cwd = makeTempDir();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const manager = new SubagentManager();
	try {
		seedRecord(cwd, "agent_own_consume", {
			ownerSessionId: "session-A",
			resultConsumed: false,
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const resultTool = fake.tools.get("get_subagent_result");
		await resultTool.execute("call-c2", { agent_id: "agent_own_consume" }, undefined, undefined, fakeCtx(cwd, "session-A"));
		const persisted = readPersistedSubagentRecord(cwd, "agent_own_consume");
		assert.equal(persisted?.resultConsumed, true, "owner session should consume the result");
	} finally {
		void manager.abortAll();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── Test (d): isOwnerSessionCurrent cross-process session-id awareness ─────

test("(d) isOwnerSessionCurrent returns false for a different ownerSessionId even when generation matches", () => {
	const fakePi = {
		events: { on: () => () => undefined, emit: () => undefined },
	} as never;
	const ctx = buildRegistrationContext(fakePi);

	// Simulate session A is active with generation 5.
	ctx.cleanedUp = false;
	ctx.sessionGeneration = 5;
	ctx.currentCtx = { sessionManager: { getSessionId: () => "session-A" } } as never;

	// Same session id + same generation → true.
	assert.equal(ctx.isOwnerSessionCurrent(5, "session-A"), true);

	// Different session id, SAME generation → false (the key fix: generation
	// alone was insufficient cross-process; now session id is also checked).
	assert.equal(ctx.isOwnerSessionCurrent(5, "session-B"), false);

	// Same session id, different generation → false.
	assert.equal(ctx.isOwnerSessionCurrent(6, "session-A"), false);

	// Legacy: undefined ownerSessionId → true (back-compat, passes on gen).
	assert.equal(ctx.isOwnerSessionCurrent(5, undefined), true);

	// Legacy: both undefined → true.
	assert.equal(ctx.isOwnerSessionCurrent(undefined, undefined), true);

	// After cleanup → always false.
	ctx.cleanedUp = true;
	assert.equal(ctx.isOwnerSessionCurrent(5, "session-A"), false);
	assert.equal(ctx.isOwnerSessionCurrent(undefined, undefined), false);
});

test("(d2) isOwnerSessionCurrent with no sessionManager (currentCtx undefined) passes legacy/undefined ownerSessionId", () => {
	const fakePi = {
		events: { on: () => () => undefined, emit: () => undefined },
	} as never;
	const ctx = buildRegistrationContext(fakePi);

	ctx.cleanedUp = false;
	ctx.sessionGeneration = 3;
	ctx.currentCtx = undefined;

	// currentSid is undefined → oid check passes for undefined oid (legacy).
	assert.equal(ctx.isOwnerSessionCurrent(3, undefined), true);
	assert.equal(ctx.isOwnerSessionCurrent(undefined, undefined), true);
	// But a record with a concrete ownerSessionId won't match undefined currentSid.
	assert.equal(ctx.isOwnerSessionCurrent(3, "session-X"), false);
});
