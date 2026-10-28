import assert from "node:assert/strict";
import test from "node:test";
import {
	appendAutonomousPolicy,
	buildAutonomousPolicy,
	detectTeamIntent,
	registerAutonomousPolicy,
} from "../../../../src/extension/autonomous-policy.ts";

test("detectTeamIntent detects default, custom, and task-list signals", () => {
	assert.deepEqual(detectTeamIntent("autoteam refactor this"), ["implementation"]);
	assert.deepEqual(
		detectTeamIntent("please swarm this", {
			magicKeywords: { custom: ["swarm"] },
		}),
		["custom"],
	);
	assert.deepEqual(detectTeamIntent("Hãy thực hiện các task sau:\n- sửa config parser\n- thêm test\n- cập nhật docs"), ["taskList"]);
});

test("detectTeamIntent handles docs-only task-list bullets", () => {
	assert.deepEqual(detectTeamIntent("- docs cho API\n- docs cho CLI\n- docs cho config"), ["taskList"]);
});

test("buildAutonomousPolicy contains routing guidance", () => {
	const policy = buildAutonomousPolicy("review-team this diff", {
		preferAsyncForLongTasks: true,
	});
	assert.match(policy, /pi-crew Delegation Policy/);
	assert.match(policy, /team='review'/);
	assert.match(policy, /review/);
	assert.match(policy, /Decision Table/);
	assert.match(policy, /Conflict-safe task splitting/);
	assert.match(policy, /prefer async/);
});

test("appendAutonomousPolicy appends to system prompt", () => {
	const prompt = appendAutonomousPolicy("base", "quick fix bug");
	assert.match(prompt, /^base/);
	assert.match(prompt, /fastFix/);
});

// ── registerAutonomousPolicy hook: promptless turns (PR #64 regression) ──
// `BeforeAgentStartEvent.prompt` is typed `string` but ABSENT at runtime on
// turns with no user text (background-task notifications, goal continuations,
// timer turns). Unguarded it reached detectTeamIntent → prompt.toLowerCase()
// and threw — silently SKIPPING the delegation policy on exactly the
// autonomous turns where no human is present to correct the decision
// (0.11.44 → 0.11.48; caught by GH#64).

type Hook = (event: unknown) => { systemPrompt: string } | undefined;

function registerHook(): Hook {
	const handlers: Record<string, Hook> = {};
	const fakePi = {
		on: (name: string, fn: Hook) => {
			handlers[name] = fn;
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	registerAutonomousPolicy(fakePi);
	const hook = handlers.before_agent_start;
	assert.ok(hook, "before_agent_start handler must be registered");
	return hook;
}

test("before_agent_start WITHOUT prompt: no throw, policy still injected (PR #64)", () => {
	const hook = registerHook();
	// No `prompt` key at all — the runtime shape of promptless turns.
	const result = hook({
		systemPrompt: "BASE",
		systemPromptOptions: { cwd: "/tmp" },
	});
	assert.ok(result, "handler must return a systemPrompt result");
	assert.match(result.systemPrompt, /^BASE/);
	assert.match(result.systemPrompt, /pi-crew Delegation Policy/, "policy block must be injected on promptless turns");
	assert.match(result.systemPrompt, /Decision Table/);
});

test("before_agent_start WITH prompt: unchanged behavior (PR #64 guard is a no-op)", () => {
	const hook = registerHook();
	const result = hook({
		systemPrompt: "BASE",
		prompt: "autoteam refactor this",
		systemPromptOptions: { cwd: "/tmp" },
	});
	assert.ok(result);
	assert.match(result.systemPrompt, /pi-crew Delegation Policy/);
	// intent detection still works on the real prompt (implementation hint)
	assert.match(result.systemPrompt, /team='implementation'/);
});

test("before_agent_start WITHOUT systemPrompt: no literal 'undefined' in output (FIX-8)", () => {
	const hook = registerHook();
	// No `prompt` AND no `systemPrompt` key — the hostile/legacy event shape
	// FIX-8 guards against. `systemPrompt` is typed `string` and the runner
	// always sets it, but if it ever leaked through undefined, the unguarded
	// template `${event.systemPrompt}\n\n…` would start with the literal
	// string "undefined".
	const result = hook({ systemPromptOptions: { cwd: "/tmp" } });
	assert.ok(result, "handler must still return a systemPrompt result");
	assert.equal(
		result.systemPrompt.includes("undefined"),
		false,
		"coerced empty base must not leak the literal 'undefined' into the system prompt",
	);
	assert.match(result.systemPrompt, /pi-crew Delegation Policy/, "policy block still injected on the coerced-empty base");
});
