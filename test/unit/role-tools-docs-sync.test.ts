import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ROLE_TOOL_CONFIGS } from "../../src/config/role-tools.ts";

// Quick Win 17 (Pattern 17 — schema-driven docs): the builtin `agents/*.md`
// frontmatter `tools:` lists MUST stay in sync with the enforced source of
// truth `ROLE_TOOL_CONFIGS` (role-tools.ts). Without this pin, docs drift from
// runtime enforcement (4 real drifts were found pre-QW17: explorer/security-
// reviewer/writer/test-engineer). One source of truth, test pins the derivation.
//
// Two invariants:
//  - roles WITH a role-level `tools` allowlist (8): set(frontmatter) === set(config)
//  - roles WITHOUT one (vacuous: analyst/executor/cold-verifier — policy falls
//    back to frontmatter): set(frontmatter) ∩ set(config.excludeTools) === ∅
//    (a frontmatter tool may not be on the role's own denylist).

const AGENTS_DIR = path.resolve(new URL("../../agents", import.meta.url).pathname);

interface ParsedFrontmatter {
	tools: string[];
}

function parseAgentFrontmatter(name: string): ParsedFrontmatter {
	const file = path.join(AGENTS_DIR, `${name}.md`);
	const text = fs.readFileSync(file, "utf8");
	// frontmatter is between the first two `---` lines.
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(m, `${file}: no frontmatter`);
	const block = m[1];
	const toolsLine = block.split("\n").find((l) => /^tools:\s/.test(l));
	const raw = toolsLine ? toolsLine.replace(/^tools:\s/, "").trim() : "";
	const tools = raw
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return { tools };
}

const PINNED_ROLES = ["explorer", "planner", "critic", "reviewer", "security-reviewer", "writer", "verifier", "test-engineer"];
const VACUOUS_ROLES = ["analyst", "executor", "cold-verifier"];

test("QW17: pinned roles — frontmatter tools === ROLE_TOOL_CONFIGS allowlist (set equality)", () => {
	for (const role of PINNED_ROLES) {
		const config = ROLE_TOOL_CONFIGS[role];
		assert.ok(config, `${role}: missing from ROLE_TOOL_CONFIGS`);
		assert.ok(Array.isArray(config.tools) && config.tools.length > 0, `${role}: no role-level tools allowlist (move to VACUOUS)`);
		const { tools: frontmatter } = parseAgentFrontmatter(role);
		const configSet = new Set(config.tools);
		const frontmatterSet = new Set(frontmatter);
		assert.deepEqual(
			[...frontmatterSet].sort(),
			[...configSet].sort(),
			`${role}: frontmatter tools ${JSON.stringify([...frontmatterSet].sort())} !== config ${JSON.stringify([...configSet].sort())}`,
		);
	}
});

test("QW17: vacuous roles — frontmatter tools ∩ excludeTools === ∅ (no self-deny)", () => {
	for (const role of VACUOUS_ROLES) {
		const config = ROLE_TOOL_CONFIGS[role] ?? { excludeTools: [] };
		const exclude = new Set(config.excludeTools ?? []);
		const { tools: frontmatter } = parseAgentFrontmatter(role);
		const overlap = frontmatter.filter((t) => exclude.has(t));
		assert.deepEqual(overlap, [], `${role}: frontmatter lists a tool that the role itself excludes: ${overlap.join(", ")}`);
	}
});

test("QW17: every pinned-role frontmatter tool is NOT in the role's excludeTools (defense-in-depth)", () => {
	// A granted tool must never also be denied — catches config contradictions
	// (e.g. a future edit granting `bash` to a role whose excludeTools has `bash`).
	for (const role of PINNED_ROLES) {
		const config = ROLE_TOOL_CONFIGS[role];
		const exclude = new Set(config.excludeTools ?? []);
		const granted = new Set(config.tools ?? []);
		const contradiction = [...granted].filter((t) => exclude.has(t));
		assert.deepEqual(contradiction, [], `${role}: a tool is both granted and excluded: ${contradiction.join(", ")}`);
	}
});
