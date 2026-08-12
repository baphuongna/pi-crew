/**
 * P2 — `PI_CREW_SCRATCHPAD_DEMOTE_BASH` adoption-lever tests.
 *
 * When scratchpad is armed for a role AND the operator opts in via
 * PI_CREW_SCRATCHPAD_DEMOTE_BASH=1, `resolveToolPolicy` removes `bash` from the
 * tool surface (allowlist filter + denylist add) so the model reaches for the
 * scratchpad `sh()` binding instead. This is the lever to break 0-adoption
 * (rlm-deep-review-2026-08-12.md §5.1A). Default off → zero behavior change.
 *
 * Pins both spawn paths stay correct: resolveToolPolicy is the single source of
 * truth for child-pi (`--tools`/`--exclude-tools`) AND live-session.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { resolveToolPolicy } from "../../src/agents/agent-config.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "builtin",
		filePath: "/tmp/test.md",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

const FLAG = "PI_CREW_SCRATCHPAD_DEMOTE_BASH";
let original: string | undefined;

beforeEach(() => {
	original = process.env[FLAG];
});

afterEach(() => {
	if (original === undefined) delete process.env[FLAG];
	else process.env[FLAG] = original;
});

test("P2 (a): flag OFF (default) — scratchpad-armed roles still have bash (no behavior change)", () => {
	delete process.env[FLAG];
	const verifier = makeAgent({ name: "verifier" });
	const policy = resolveToolPolicy(verifier, "verifier");
	assert.ok(policy.tools?.includes("bash"), "verifier keeps bash when flag is off");
	assert.ok(!policy.excludeTools?.includes("bash"), "verifier excludeTools must not add bash when flag is off");
});

test("P2 (b): flag ON — verifier (scratchpad-armed) loses bash from allowlist + denylisted", () => {
	process.env[FLAG] = "1";
	const verifier = makeAgent({ name: "verifier" });
	const policy = resolveToolPolicy(verifier, "verifier");
	assert.ok(!policy.tools?.includes("bash"), "verifier must NOT have bash in allowlist when flag on");
	assert.ok(policy.tools?.includes("scratchpad"), "verifier keeps scratchpad (still armed)");
	assert.ok(policy.excludeTools?.includes("bash"), "verifier must have bash in denylist when flag on");
});

test("P2 (c): flag ON — test-engineer (scratchpad-armed) loses bash", () => {
	process.env[FLAG] = "1";
	const te = makeAgent({ name: "test-engineer" });
	const policy = resolveToolPolicy(te, "test-engineer");
	assert.ok(!policy.tools?.includes("bash"), "test-engineer must lose bash");
	assert.ok(policy.tools?.includes("edit"), "test-engineer keeps edit/write");
	assert.ok(policy.tools?.includes("scratchpad"), "test-engineer keeps scratchpad");
	assert.ok(policy.excludeTools?.includes("bash"), "test-engineer denylists bash");
});

test("P2 (d): flag ON — executor (scratchpad-armed, no allowlist) gets bash denylisted", () => {
	process.env[FLAG] = "1";
	// executor has NO tools allowlist (full access by default). Demote must
	// still remove bash via the denylist even when there's no allowlist to filter.
	const executor = makeAgent({ name: "executor" });
	const policy = resolveToolPolicy(executor, "executor");
	assert.equal(policy.tools, undefined, "executor stays full-access (allowlist still undefined)");
	assert.ok(policy.excludeTools?.includes("bash"), "executor must denylist bash when flag on");
});

test("P2 (e): flag ON — NON-scratchpad roles keep bash (lever is scoped to scratchpad roles)", () => {
	process.env[FLAG] = "1";
	// explorer + reviewer have bash but are NOT scratchpad-armed — they must be
	// untouched (they have no sh() fallback, so removing bash would break them).
	const explorer = resolveToolPolicy(makeAgent({ name: "explorer" }), "explorer");
	assert.ok(explorer.tools?.includes("bash"), "explorer keeps bash (not scratchpad-armed)");

	const reviewer = resolveToolPolicy(makeAgent({ name: "reviewer" }), "reviewer");
	assert.ok(reviewer.tools?.includes("bash"), "reviewer keeps bash (not scratchpad-armed)");
	assert.ok(!reviewer.excludeTools?.includes("bash"), "reviewer excludeTools untouched");
});

test("P2 (f): flag ON — read-only role with scratchpad:true frontmatter is NOT demoted (S-6 gate)", () => {
	process.env[FLAG] = "1";
	// S-6: read-only roles never enable scratchpad regardless of frontmatter.
	// A demote would remove bash from a read-only role that has no sh() — wrong.
	// explorer is read-only; even an explicit scratchpad:true frontmatter opt-in
	// is gated out, so the demote must NOT fire.
	const explorer = makeAgent({ name: "explorer", scratchpad: true });
	const policy = resolveToolPolicy(explorer, "explorer");
	assert.ok(policy.tools?.includes("bash"), "read-only role keeps bash even with scratchpad:true (S-6 gate)");
});

test("P2 (g): flag ON — F6 kill-switch on a WRITE role keeps bash (verifier+scratchpad:false)", () => {
	process.env[FLAG] = "1";
	// F6: an explicit `scratchpad: false` frontmatter on a scratchpad-armed role
	// WINS over the role default → scratchpad is disabled → no sh() fallback →
	// bash must NOT be demoted. This pins the integration through the demote path
	// (isScratchpadEnabledForRole is unit-tested separately, but the {scratchpad:
	// agent.scratchpad} forwarding through resolveToolPolicy was untested).
	for (const roleName of ["verifier", "test-engineer", "executor"] as const) {
		const agent = makeAgent({ name: roleName, scratchpad: false });
		const policy = resolveToolPolicy(agent, roleName);
		assert.ok(!policy.excludeTools?.includes("bash"), `${roleName}: F6 kill-switch must not denylist bash`);
		if (roleName !== "executor") {
			assert.ok(policy.tools?.includes("bash"), `${roleName}: F6 kill-switch keeps bash in allowlist`);
		}
	}
});

test("P2 (h): flag ON — demote is ADDITIVE: verifier's existing excludes survive + bash added", () => {
	process.env[FLAG] = "1";
	// Guards against an accidental replacement (excludeTools=["bash"]) instead of
	// merge — which would silently strip the role's security excludes (edit/write/web).
	const verifier = makeAgent({ name: "verifier" });
	const policy = resolveToolPolicy(verifier, "verifier");
	assert.ok(policy.excludeTools?.includes("bash"), "bash added to denylist");
	assert.ok(policy.excludeTools?.includes("edit"), "verifier edit-exclude survives demote (additive merge)");
	assert.ok(policy.excludeTools?.includes("write"), "verifier write-exclude survives demote");
	assert.ok(policy.excludeTools?.includes("web"), "verifier web-exclude survives demote");
});

test("P2 (i): flag ON — agent disallowedTools already has bash → no duplicate in denylist", () => {
	process.env[FLAG] = "1";
	const verifier = makeAgent({ name: "verifier", disallowedTools: ["bash"] });
	const policy = resolveToolPolicy(verifier, "verifier");
	const bashCount = policy.excludeTools?.filter((t) => t === "bash").length ?? 0;
	assert.equal(bashCount, 1, "bash must appear exactly once in denylist (dedup via uniqueToolMerge)");
});

test("P2 (j): only exact env value '1' triggers demote — '0'/'true'/'yes'/'' do not", () => {
	for (const val of ["0", "true", "yes", "", " 1", "on"]) {
		process.env[FLAG] = val;
		const verifier = makeAgent({ name: "verifier" });
		const policy = resolveToolPolicy(verifier, "verifier");
		assert.ok(policy.tools?.includes("bash"), `env=${JSON.stringify(val)} must NOT trigger demote (only exact "1")`);
		assert.ok(!policy.excludeTools?.includes("bash"), `env=${JSON.stringify(val)} must not denylist bash`);
	}
});
