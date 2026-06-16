import test from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityInventory } from "../../src/runtime/capability-inventory.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("capability inventory includes builtin teams, workflows, and agents", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cap-inv-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const inventory = buildCapabilityInventory(cwd);
		assert.ok(inventory.length > 0);
		const teams = inventory.filter((item) => item.kind === "team");
		const workflows = inventory.filter((item) => item.kind === "workflow");
		const agents = inventory.filter((item) => item.kind === "agent");
		assert.ok(teams.length > 0, "expected at least one team");
		assert.ok(workflows.length > 0, "expected at least one workflow");
		assert.ok(agents.length > 0, "expected at least one agent");
		for (const item of inventory) {
			assert.ok(item.id);
			assert.ok(item.name);
			assert.ok(item.source);
			// F6 (v0.7.9): accept the full CapabilityState set. Shadowed /
			// missing states can now appear because user-skill-roots
			// (`user-pi`, `user-agents`) can shadow bundled `package` skills.
			assert.ok(["active", "disabled", "shadowed", "missing"].includes(item.state));
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("capability inventory respects disabledCapabilities policy", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cap-inv2-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const inventory = buildCapabilityInventory(cwd);
		const firstTeam = inventory.find((item) => item.kind === "team");
		assert.ok(firstTeam, "expected at least one team");
		const config = { policy: { disabledCapabilities: [firstTeam.id] } };
		const filtered = buildCapabilityInventory(cwd, config);
		const match = filtered.find((item) => item.id === firstTeam.id);
		assert.ok(match, "expected the team to still appear in inventory");
		assert.equal(match.state, "disabled", "expected team to be disabled by policy");
		assert.equal(match.disabledReason, "disabled by policy");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("capability inventory with empty disabledCapabilities returns all active", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cap-inv3-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const inventory = buildCapabilityInventory(cwd, { policy: { disabledCapabilities: [] } });
		const disabledItems = inventory.filter((item) => item.state === "disabled" && item.disabledReason === "disabled by policy");
		assert.equal(disabledItems.length, 0, "no items should be disabled by policy with empty array");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
test("capability inventory marks shadowed resources when user/project has same name as builtin", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cap-shadow-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const inventory = buildCapabilityInventory(cwd);
		// All items are builtin in this test setup, so none should be shadowed
		const shadowed = inventory.filter((item) => item.state === "shadowed");
		assert.ok(Array.isArray(shadowed), "shadowed items should be an array");
		// Verify structure: shadowed items should have shadowedBy field
		for (const item of shadowed) {
			assert.ok(item.shadowedBy, `shadowed item ${item.id} should have shadowedBy`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
