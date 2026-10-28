import assert from "node:assert/strict";
import test from "node:test";
import registerPiTeamsPromptRuntime, { rewriteTeamWorkerPrompt } from "../../../src/prompt/prompt-runtime.ts";

test("rewriteTeamWorkerPrompt strips project context and skills", () => {
	const prompt = [
		"Base prompt",
		"",
		"# Project Context",
		"",
		"Project-specific instructions and guidelines:",
		"",
		"secret project rules",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"skill catalog",
		"Current date: 2026-04-26",
	].join("\n");
	const rewritten = rewriteTeamWorkerPrompt(prompt, {
		inheritProjectContext: false,
		inheritSkills: false,
	});
	assert.equal(rewritten.includes("secret project rules"), false);
	assert.equal(rewritten.includes("skill catalog"), false);
	assert.equal(rewritten.includes("Current date"), true);
});

// ── FIX-8 (GH #64 wave): before_agent_start rewrite handler guard ──────
// `systemPrompt` is typed `string` (readonly, runner always sets it). If a
// host ever handed a non-string through, the handler must SKIP (return
// undefined) — coercing "" would REPLACE the real system prompt with a
// blank one, because this handler STRIPS sections (unlike the append-only
// autonomous-policy / knowledge-injection hooks, which safely coerce "").

type BeforeAgentStartHook = (event: unknown) => { systemPrompt: string } | undefined;

function captureBeforeAgentStartHook(): BeforeAgentStartHook {
	const handlers: Record<string, BeforeAgentStartHook> = {};
	const fakePi = {
		on: (name: string, fn: BeforeAgentStartHook) => {
			handlers[name] = fn;
		},
		sendMessage: () => undefined,
		registerTool: () => undefined,
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	registerPiTeamsPromptRuntime(fakePi);
	const hook = handlers.before_agent_start;
	assert.ok(hook, "before_agent_start handler must be registered");
	return hook;
}

/** Remove every PI_CREW_ and PI_TEAMS_ prefixed env var (worker-host leakage — ambient
 *  broker/steering/scratchpad vars would make registerPiTeamsPromptRuntime
 *  touch real sockets/files when the suite runs inside a pi-crew worker) and
 *  return a restore closure. */
function scrubCrewEnv(): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_CREW_") || key.startsWith("PI_TEAMS_")) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	}
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

test("before_agent_start rewrite handler SKIPS when systemPrompt is not a string (FIX-8)", () => {
	const restore = scrubCrewEnv();
	try {
		process.env.PI_CREW_INHERIT_PROJECT_CONTEXT = "0";
		const hook = captureBeforeAgentStartHook();
		// No `systemPrompt` key at all — the hostile/legacy event shape. The
		// handler must return undefined (skip), NOT an object: returning
		// { systemPrompt: "" } would blank the worker's real system prompt.
		const result = hook({ prompt: "worker turn" });
		assert.equal(result, undefined, "handler must skip non-string systemPrompt, never coerce ''");
	} finally {
		restore();
	}
});

test("before_agent_start rewrite handler: normal event still strips project context (pin, FIX-8 no-op)", () => {
	const restore = scrubCrewEnv();
	try {
		process.env.PI_CREW_INHERIT_PROJECT_CONTEXT = "0";
		const hook = captureBeforeAgentStartHook();
		const result = hook({
			prompt: "worker turn",
			systemPrompt: "Base\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nsecret project rules\n",
		});
		assert.ok(result, "normal string systemPrompt must still be rewritten");
		assert.equal(result.systemPrompt.includes("secret project rules"), false);
		assert.ok(result.systemPrompt.startsWith("Base"), "non-section base must survive verbatim");
	} finally {
		restore();
	}
});
