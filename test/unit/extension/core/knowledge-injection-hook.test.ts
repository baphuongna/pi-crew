import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { registerKnowledgeInjection } from "../../../../src/extension/knowledge-injection.ts";

/**
 * FIX-8 (GH #64 wave, defense-in-depth): the registered `before_agent_start`
 * hook builds its output FROM `event.systemPrompt`. The type says `string`
 * (readonly, runner always sets it), but if a host ever handed `undefined`
 * through, the unguarded template `${event.systemPrompt}${fragment}` would
 * prefix the injected knowledge with the literal string "undefined". The
 * hook now coerces to "" (append-only, so an empty base is safe).
 *
 * These tests drive the REGISTERED hook (not buildKnowledgeFragment) with a
 * fake `pi` so the guard itself is pinned.
 */

type Hook = (event: unknown) => { systemPrompt: string } | undefined;

function registerHook(): Hook {
	const handlers: Record<string, Hook> = {};
	const fakePi = {
		on: (name: string, fn: Hook) => {
			handlers[name] = fn;
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	registerKnowledgeInjection(fakePi);
	const hook = handlers.before_agent_start;
	assert.ok(hook, "before_agent_start handler must be registered");
	return hook;
}

/** Remove every PI_CREW_ and PI_TEAMS_ prefixed env var (worker-host leakage — the
 *  hook early-returns when PI_CREW_KIND=subagent, which IS set when the
 *  suite runs inside a pi-crew worker) and return a restore closure. */
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

function makeKnowledgeDir(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ki-hook-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "knowledge.md"), "KNOWN_FRAGMENT_TOKEN_9Z convention body\n", "utf-8");
	return cwd;
}

test("knowledge hook WITHOUT systemPrompt: fragment appended to coerced empty base, no literal 'undefined' (FIX-8)", () => {
	const restore = scrubCrewEnv();
	const cwd = makeKnowledgeDir();
	try {
		const hook = registerHook();
		// No `systemPrompt` key at all — the hostile/legacy event shape.
		const result = hook({ systemPromptOptions: { cwd } });
		assert.ok(result, "handler must return a systemPrompt result when a fragment exists");
		assert.match(result.systemPrompt, /KNOWN_FRAGMENT_TOKEN_9Z/, "knowledge fragment must be injected");
		assert.equal(
			result.systemPrompt.includes("undefined"),
			false,
			"coerced empty base must not leak the literal 'undefined' into the system prompt",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		restore();
	}
});

test("knowledge hook WITH systemPrompt: unchanged concatenation (pin, FIX-8 guard is a no-op)", () => {
	const restore = scrubCrewEnv();
	const cwd = makeKnowledgeDir();
	try {
		const hook = registerHook();
		const result = hook({ systemPrompt: "BASE", systemPromptOptions: { cwd } });
		assert.ok(result);
		assert.ok(result.systemPrompt.startsWith("BASE"), "existing base must be preserved verbatim in order");
		assert.match(result.systemPrompt, /KNOWN_FRAGMENT_TOKEN_9Z/);
		assert.equal(result.systemPrompt.includes("undefined"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		restore();
	}
});

test("knowledge hook with no knowledge.md: still returns undefined (no injection)", () => {
	const restore = scrubCrewEnv();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ki-empty-"));
	try {
		const hook = registerHook();
		const result = hook({ systemPrompt: "BASE", systemPromptOptions: { cwd } });
		assert.equal(result, undefined, "no fragment → no result object");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		restore();
	}
});
