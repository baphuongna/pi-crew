/**
 * R3-21 / D4 behavior lock — crew skills are INFRASTRUCTURE, not user-skill inheritance.
 *
 * Verdict (D4, 2026-10-03): INTENTIONAL. The pi-crew host extension's
 * `resources_discover` hook (hook-registration.ts:65-77) injects
 * `packageRoot()/skills` into every session where the extension loads, and
 * this channel deliberately survives `--no-skills`:
 *
 *  1. SDK semantics: `--no-skills` gates only *discovered and configured*
 *     (user) skills — "Explicit `--skill` paths still load" (pi cli.md:190-191).
 *     Extension-contributed resources merge AFTER that gate
 *     (pi resource-loader.js:318-332 `extendResources` vs the gated static set
 *     at :419-423); `updateSkillsFromPaths` (:619-628) only blanks when
 *     `noSkills && skillPaths.length === 0`. Upstream treats a loaded
 *     extension's resources as capabilities of that extension.
 *  2. pi-crew design: `inheritSkills: false` is a TWO-layer control over the
 *     USER skill environment only — argv `--no-skills` (pi-args.ts:357,
 *     resource layer) + `PI_CREW_INHERIT_SKILLS=0` (pi-args.ts:401) which
 *     makes prompt-runtime's `before_agent_start` strip the whole
 *     `<available_skills>` advertisement from the worker system prompt
 *     (prompt-runtime.ts:1128-1140, `stripInheritedSkills`). So in real
 *     pi-crew worker spawns the 34 crew skills are LOADED (readable via the
 *     read tool, resource layer) but NOT advertised as inherited context.
 *  3. Intent evidence: pi-args.ts:338 — "prompt-runtime extension luôn nạp
 *     (hạ tầng phối hợp — không phải cắt xén)"; skill-instructions.ts —
 *     "Package skills … are from the pi-crew installation and are trusted"
 *     (SEC-003 package-first precedence); hook introduced in commit cfbacd86
 *     (Phase 11a, 2026-05-04) explicitly to "inject pi-crew skill paths".
 *
 * This file locks that behavior so a future refactor cannot silently flip it.
 * Full decision record: docs/reviews/pi-1.0.0-deep-learn-r3-2026-10-03.md
 * §"Round 3 — Leader decisions & execution record", row D4.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { installPiHooks } from "../../../../src/extension/registration/hook-registration.ts";
import type { RegistrationContext } from "../../../../src/extension/registration/registration-types.ts";
import { rewriteTeamWorkerPrompt } from "../../../../src/prompt/prompt-runtime.ts";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";
import { packageRoot } from "../../../../src/utils/paths.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** Minimal event recorder standing in for the ExtensionAPI `pi.on` surface. */
function createMockPi(): {
	on: (event: string, handler: (payload?: unknown) => unknown) => void;
	handlers: Map<string, Array<(payload?: unknown) => unknown>>;
} {
	const handlers = new Map<string, Array<(payload?: unknown) => unknown>>();
	return {
		on(event: string, handler: (payload?: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		handlers,
	};
}

/** Install hooks with a session cwd and return the resources_discover handler. */
function discoverHandler(cwd: string): () => { skillPaths?: string[] } {
	const pi = createMockPi();
	const ctx = { currentCtx: { cwd } } as unknown as RegistrationContext;
	installPiHooks(pi as unknown as Parameters<typeof installPiHooks>[0], ctx);
	const list = pi.handlers.get("resources_discover") ?? [];
	assert.equal(list.length, 1, "resources_discover handler must be registered exactly once");
	return list[0] as () => { skillPaths?: string[] };
}

const PACKAGE_SKILLS_DIR = path.join(packageRoot(), "skills");

test("R3-21/D4: crew skills dir is returned by resources_discover regardless of any skills flags", () => {
	// The hook has NO access to (and no awareness of) --no-skills / inheritSkills —
	// by design. Whenever the extension is loaded, the crew skills dir is offered.
	const dir = createTrackedTempDir("crew-skills-infra-noskillsdir-");
	const result = discoverHandler(dir)();
	// In the repo checkout the package skills dir always exists (34 skills).
	assert.ok(fs.existsSync(PACKAGE_SKILLS_DIR), "precondition: packageRoot()/skills exists in repo");
	assert.deepEqual(result.skillPaths, [PACKAGE_SKILLS_DIR], "crew skills dir must be injected unconditionally");
});

test("R3-21/D4: session-cwd skills/ is injected AFTER the package dir (SEC-003 trusted-first order)", () => {
	const dir = createTrackedTempDir("crew-skills-infra-cwd-");
	fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
	const result = discoverHandler(dir)();
	assert.deepEqual(result.skillPaths, [PACKAGE_SKILLS_DIR, path.join(dir, "skills")], "package skills first, project skills second");
});

test("R3-21/D4: cwd === packageRoot does not duplicate the skills dir", () => {
	// When the session cwd IS the package root, skillDir === extSkillDir and the
	// second push is skipped (hook-registration.ts:72 guard).
	const result = discoverHandler(packageRoot())();
	assert.deepEqual(result.skillPaths, [PACKAGE_SKILLS_DIR]);
});

test("R3-21/D4: symlinked cwd skills/ escaping the session dir is refused (path-traversal guard)", () => {
	const dir = createTrackedTempDir("crew-skills-infra-symlink-");
	const outside = createTrackedTempDir("crew-skills-infra-outside-");
	fs.symlinkSync(outside, path.join(dir, "skills"), "dir");
	const result = discoverHandler(dir)();
	assert.ok(!result.skillPaths?.includes(path.join(dir, "skills")), "symlinked project skills must be skipped");
	assert.deepEqual(result.skillPaths, [PACKAGE_SKILLS_DIR], "only the trusted package dir remains");
});

test("R3-21/D4: inheritSkills:false worker loadout keeps infra channels (prompt-runtime + explicit --skill survive --no-skills)", () => {
	// pi-args layer: inheritSkills:false emits --no-skills (user-skill gate) but
	// never strips the coordination infrastructure. Explicit --skill entries
	// survive --no-skills per pi cli.md:190-191, and prompt-runtime is always
	// loaded ("hạ tầng phối hợp — không phải cắt xén", pi-args.ts:338).
	const agent = {
		name: "executor",
		description: "d",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		inheritSkills: false,
	} as AgentConfig;
	const { args, env } = buildPiWorkerArgs({ task: "Task: x", agent, skillPaths: ["/some/selected-skill"] });
	assert.ok(args.includes("--no-skills"), "inheritSkills:false → --no-skills (user-skill gate)");
	const skillIdx = args.indexOf("--skill");
	assert.ok(skillIdx >= 0, "explicit --skill entries must survive --no-skills");
	assert.equal(args[skillIdx + 1], "/some/selected-skill");
	assert.ok(
		args.some((a, i) => a === "--extension" && args[i + 1]?.includes("prompt-runtime")),
		"prompt-runtime extension must stay loaded (infra)",
	);
	assert.equal(env.PI_CREW_INHERIT_SKILLS, "0", "env mirrors the argv gate for prompt-runtime");
});

test("R3-21/D4: inheritSkills:false strips the whole <available_skills> advertisement, crew skills included", () => {
	// Prompt layer compensation: even though the resource layer keeps crew
	// skills loaded (tests above), the worker's system-prompt advertisement is
	// stripped wholesale when inheritSkills is false — using pi's real
	// formatSkillsForPrompt shape (skills.js:281 header + XML body).
	const systemPrompt = [
		"You are a coding agent.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>safe-bash</name>",
		"    <description>Safe shell-command workflow.</description>",
		"    <location>/pi-crew/skills/safe-bash/SKILL.md</location>",
		"  </skill>",
		"  <skill>",
		"    <name>verification-before-done</name>",
		"    <description>Evidence before claims.</description>",
		"    <location>/pi-crew/skills/verification-before-done/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
		"",
		"Current date: 2026-10-03",
	].join("\n");
	const rewritten = rewriteTeamWorkerPrompt(systemPrompt, { inheritProjectContext: true, inheritSkills: false });
	assert.ok(!rewritten.includes("The following skills provide specialized instructions"), "header stripped");
	assert.ok(!rewritten.includes("<available_skills>"), "XML body stripped");
	assert.ok(!rewritten.includes("safe-bash"), "crew skill entries stripped from advertisement");
	assert.ok(rewritten.includes("Current date:"), "following sections preserved");
	assert.ok(rewritten.includes("You are a coding agent."), "base prompt preserved");
});
