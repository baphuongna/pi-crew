/**
 * sandbox-home-overshoot.test.ts — regression pins: the bwrap toolchain bind
 * walk must NEVER mount $HOME (or the pi agent dir holding auth.json).
 *
 * Finding (fixed): the --skill/--extension ancestor walk terminated only at
 * a package.json root, and user-global skill roots (~/.pi/agent/skills — the
 * default pi user-skill location) have none before $HOME — the walk emitted
 * `--ro-bind-try $HOME $HOME` (plus `~/.pi/agent`, the auth.json directory),
 * mounting the whole host home read-only inside the sandbox. The HOME=/tmp
 * env override never removed those mounts (absolute paths stayed readable).
 *
 * Pins (bind set = every source path following a mount flag):
 *   (h1) homedir-rooted --skill: the skill dir + its skills/ parent ARE
 *        bound (below the trust boundary), but $HOME, ~/.pi, ~/.pi/agent
 *        are NOT, and auth.json is not reachable through ANY bind.
 *   (h2) a --skill value pointing AT $HOME / ~/.pi / ~/.pi/agent is
 *        SKIPPED entirely (fail closed — HOME never mounted).
 *   (h3) PI_CODING_AGENT_DIR override: the override agent dir is protected
 *        AND the default ~/.pi/agent stays protected.
 *   (h4) package-root termination for non-home paths is unchanged.
 *   (h5) against the REAL homedir (no fixtures): a homedir-rooted --skill
 *        never binds $HOME or any ancestor of it.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { applySandboxToSpawnSpec } from "../../../../src/runtime/child-pi/sandbox.ts";

/** Every source path the wrapped argv BINDS (any mount kind). */
function bindTargets(args: string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--ro-bind-try" || args[i] === "--ro-bind" || args[i] === "--bind" || args[i] === "--bind-try") {
			targets.push(args[i + 1]);
		}
	}
	return targets;
}

/** True when binding `bind` would make `secret` (or anything under it) visible. */
function bindCovers(bind: string, secret: string): boolean {
	const rel = path.relative(bind, secret);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Run with a faked user home (HOME + USERPROFILE scoped; PI_CODING_AGENT_DIR unset by default). */
async function withFakeHome(run: (home: string) => Promise<void>): Promise<void> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fakehome-"));
	const skillDir = path.join(home, ".pi", "agent", "skills", "demo");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# demo\n");
	fs.mkdirSync(path.join(home, "custom-agent", "skills", "demo"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".pi", "agent", "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "sk-FIXTURE-not-real" } }),
	);
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		await run(home);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/** Shared assertions: the auth store is unreachable through every bind, and
 * no bind mounts a forbidden boundary (or anything containing it). */
function assertAuthUnreachableAndHomeUnbound(binds: string[], home: string, extraForbidden: string[] = []): void {
	const authJson = path.join(home, ".pi", "agent", "auth.json");
	for (const b of binds) {
		assert.ok(!bindCovers(b, authJson), `bind '${b}' would expose auth.json`);
	}
	for (const f of [home, path.join(home, ".pi"), path.join(home, ".pi", "agent"), ...extraForbidden]) {
		assert.ok(!binds.includes(f), `must NOT bind '${f}'`);
		for (const b of binds) {
			assert.ok(!bindCovers(b, f), `bind '${b}' would mount '${f}'`);
		}
	}
}

// ── (h1) the headline scenario from the finding ─────────────────────────

test("(h1) homedir-rooted --skill binds the skill subtree, NEVER $HOME or the auth.json directory", async () => {
	await withFakeHome(async (home) => {
		const skillPath = path.join(home, ".pi", "agent", "skills", "demo");
		const wrapped = applySandboxToSpawnSpec(
			{ command: "/usr/bin/node", args: ["cli.js", "--skill", skillPath, "-p", "x"] },
			{ cwd: path.join(home, "proj"), net: "share" },
		);
		const binds = bindTargets(wrapped.args);
		assert.ok(binds.includes(skillPath), "the resolved skill dir itself must be bound (read-only)");
		assert.ok(binds.includes(path.join(home, ".pi", "agent", "skills")), "the skills root below the agent dir may be bound");
		assertAuthUnreachableAndHomeUnbound(binds, home);
		// the fix is about MOUNTS, not env — HOME/TMPDIR overrides unchanged
		assert.deepEqual(wrapped.envOverrides, { HOME: "/tmp", TMPDIR: "/tmp" });
	});
});

// ── (h2) fail closed on trust-boundary values ───────────────────────────

test("(h2) a --skill value AT the trust boundary ($HOME, ~/.pi, ~/.pi/agent) is skipped entirely", async () => {
	await withFakeHome(async (home) => {
		for (const value of [home, path.join(home, ".pi"), path.join(home, ".pi", "agent")]) {
			const wrapped = applySandboxToSpawnSpec(
				{ command: "/usr/bin/node", args: ["cli.js", "--skill", value, "-p", "x"] },
				{ cwd: path.join(home, "proj"), net: "share" },
			);
			const binds = bindTargets(wrapped.args);
			assert.ok(!binds.includes(value), `--skill pointing at '${value}' must not be bound`);
			assertAuthUnreachableAndHomeUnbound(binds, home);
		}
	});
});

// ── (h3) agent-dir override + default agent dir both protected ──────────

test("(h3) PI_CODING_AGENT_DIR override: override agent dir protected AND default ~/.pi/agent stays protected", async () => {
	await withFakeHome(async (home) => {
		process.env.PI_CODING_AGENT_DIR = path.join(home, "custom-agent");
		const wrapped = applySandboxToSpawnSpec(
			{
				command: "/usr/bin/node",
				args: [
					"cli.js",
					"--skill",
					path.join(home, "custom-agent", "skills", "demo"),
					"--skill",
					path.join(home, ".pi", "agent", "skills", "demo"),
					"-p",
					"x",
				],
			},
			{ cwd: path.join(home, "proj"), net: "share" },
		);
		const binds = bindTargets(wrapped.args);
		assert.ok(binds.includes(path.join(home, "custom-agent", "skills")), "skills root below the OVERRIDE agent dir may be bound");
		assert.ok(binds.includes(path.join(home, ".pi", "agent", "skills")), "skills root below the DEFAULT agent dir may be bound");
		assertAuthUnreachableAndHomeUnbound(binds, home, [path.join(home, "custom-agent")]);
	});
});

// ── (h4) non-home package-root walk unchanged ───────────────────────────

test("(h4) package-root termination for non-home paths is unchanged (no extension walk regression)", () => {
	const pkgRoots = new Set<string>(["/pkg"]);
	const wrapped = applySandboxToSpawnSpec(
		{
			command: "/usr/bin/node",
			args: ["cli.js", "--extension", "/pkg/src/prompt/prompt-runtime.ts", "--skill", "/pkg/skills/demo/SKILL.md"],
		},
		{ cwd: "/work", net: "share", isPackageRoot: (d) => pkgRoots.has(d) },
	);
	const binds = bindTargets(wrapped.args);
	for (const p of [
		"/pkg/src/prompt/prompt-runtime.ts",
		"/pkg/src/prompt",
		"/pkg/src",
		"/pkg",
		"/pkg/skills/demo/SKILL.md",
		"/pkg/skills/demo",
		"/pkg/skills",
	]) {
		assert.ok(binds.includes(p), `${p} still bound up to the package root`);
	}
	assert.ok(!binds.includes("/"), "the walk must stop at the package root");
	assert.ok(!binds.includes(os.homedir()), "a non-home walk must never bind the real $HOME");
});

// ── (h5) real homedir, no fixtures, default fs probe ────────────────────

test("(h5) REAL homedir: a homedir-rooted --skill never binds $HOME, ~/.pi, or the agent dir", async () => {
	const home = os.homedir();
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		const wrapped = applySandboxToSpawnSpec(
			{ command: "/usr/bin/node", args: ["cli.js", "--skill", path.join(home, ".pi", "agent", "skills", "ghost-skill"), "-p", "x"] },
			{ cwd: "/work", net: "share" },
		);
		const binds = bindTargets(wrapped.args);
		assert.ok(
			binds.includes(path.join(home, ".pi", "agent", "skills", "ghost-skill")),
			"the skill value itself is still bound (bind-try tolerates a missing dir)",
		);
		assertAuthUnreachableAndHomeUnbound(binds, home);
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	}
});
