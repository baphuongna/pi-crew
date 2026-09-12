import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { discoverAgents } from "../../../src/agents/discover-agents.ts";
import { packageRoot } from "../../../src/utils/paths.ts";

/**
 * PROMPT-1 acceptance criterion (CI-grepable): every builtin agent body ends
 * with an output contract. Batches 4–8 gave all 17 builtin agents a
 * structured `## Output format` section containing a fenced output block —
 * this test keeps that invariant as new agents are added: a stub agent with
 * no output contract fails here before it can ship.
 */

function agentBody(file: string): string {
	const content = fs.readFileSync(file, "utf-8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match) return content;
	return content.slice(match[0].length);
}

test("PROMPT-1: every builtin agent body carries an output-format section with a fenced output block", () => {
	const agentsDir = path.join(packageRoot(), "agents");
	const { builtin } = discoverAgents(process.cwd());
	assert.ok(builtin.length >= 17, `expected ≥17 builtin agents, found ${builtin.length}`);

	const missing: string[] = [];
	for (const agent of builtin) {
		const file = path.join(agentsDir, `${agent.name}.md`);
		if (!fs.existsSync(file)) continue; // dynamically registered, not a file
		const body = agentBody(file);
		const headingMatch = /##\s+output\s+format/i.exec(body);
		if (!headingMatch) {
			missing.push(`${agent.name}: no "## Output format" heading`);
			continue;
		}
		const afterHeading = body.slice(headingMatch.index);
		if (!afterHeading.includes("```")) {
			missing.push(`${agent.name}: output-format section has no fenced block`);
		}
	}

	assert.deepEqual(
		missing,
		[],
		`builtin agents without an output contract (add "## Output format" + fenced block):\n${missing.join("\n")}`,
	);
});
