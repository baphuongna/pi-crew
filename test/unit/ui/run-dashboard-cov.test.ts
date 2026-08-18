import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { RunDashboard, type RunDashboardSelection } from "../../../src/ui/run-dashboard.ts";

function makeRun(id: string, status: TeamRunManifest["status"] = "running", overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "test-team",
		workflow: "test-workflow",
		goal: `Goal for ${id}`,
		status,
		workspaceMode: "single",
		createdAt: "2026-06-04T00:00:00.000Z",
		updatedAt: "2026-06-04T00:00:00.000Z",
		cwd: "/tmp",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/tasks.json",
		eventsPath: "/tmp/events.jsonl",
		artifacts: [],
		...overrides,
	};
}

describe("RunDashboard constructor", () => {
	it("creates dashboard with empty runs", () => {
		const dashboard = new RunDashboard([], () => undefined);
		const lines = dashboard.render(80);
		assert.ok(lines.some((l) => l.includes("No runs")));
		dashboard.dispose();
	});

	it("filters runs by workspaceId", () => {
		const runs = [
			makeRun("ws-run-1", "running", { ownerSessionId: "ws-1" }),
			makeRun("ws-run-2", "running", { ownerSessionId: "ws-2" }),
			makeRun("legacy-run", "completed"),
		];
		const dashboard = new RunDashboard(runs, () => undefined, {}, { workspaceId: "ws-1" });
		const lines = dashboard.render(80);
		assert.ok(lines.some((l) => l.includes("ws-run-1")));
		// Should not show ws-run-2 (different workspace)
		assert.ok(!lines.some((l) => l.includes("ws-run-2")));
		dashboard.dispose();
	});
});

describe("RunDashboard render", () => {
	it("renders run list with status icons", () => {
		const dashboard = new RunDashboard([makeRun("render-1", "completed"), makeRun("render-2", "failed")], () => undefined);
		const lines = dashboard.render(80);
		assert.ok(lines.some((l) => l.includes("2 runs")));
		assert.ok(lines.some((l) => l.includes("render-1")));
		assert.ok(lines.some((l) => l.includes("render-2")));
		dashboard.dispose();
	});

	it("caches rendering output for same width and state", () => {
		let renderCount = 0;
		const dashboard = new RunDashboard([makeRun("cache-run", "completed")], () => undefined);
		const lines1 = dashboard.render(80);
		renderCount++;
		const lines2 = dashboard.render(80);
		assert.deepEqual(lines1, lines2);
		dashboard.dispose();
	});

	it("handles zero width gracefully", () => {
		const dashboard = new RunDashboard([makeRun("zero-w", "running")], () => undefined);
		// Should not throw even with very small width
		const lines = dashboard.render(0);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});
});

describe("RunDashboard handleInput", () => {
	it("navigates up and down through runs", () => {
		let selected: RunDashboardSelection | undefined;
		const runs = [makeRun("nav-1", "completed"), makeRun("nav-2", "completed"), makeRun("nav-3", "completed")];
		const dashboard = new RunDashboard(runs, (s) => {
			selected = s;
		});

		// Start on first, press down, select
		dashboard.handleInput("j"); // down
		dashboard.handleInput("\r"); // select
		assert.ok(selected);
		assert.equal(selected!.runId, "nav-2");
		dashboard.dispose();
	});

	it("navigates up from first item (clamped to 0)", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("clamp-1")], (s) => {
			selected = s;
		});
		dashboard.handleInput("k"); // up from first = stays at 0
		dashboard.handleInput("\r");
		assert.ok(selected);
		assert.equal(selected!.runId, "clamp-1");
		dashboard.dispose();
	});

	it("closes on Escape", () => {
		let selected: RunDashboardSelection | undefined = {
			runId: "sentinel",
			action: "status",
		};
		const dashboard = new RunDashboard([makeRun("esc-run")], (s) => {
			selected = s;
		});
		dashboard.handleInput("\x1b"); // Escape
		assert.equal(selected, undefined);
		dashboard.dispose();
	});

	it("switches to progress pane on key 2", () => {
		const dashboard = new RunDashboard([makeRun("pane-prog")], () => undefined);
		dashboard.handleInput("2");
		// Should not throw on subsequent render
		const lines = dashboard.render(80);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});

	it("switches to mailbox pane on key 3", () => {
		const dashboard = new RunDashboard([makeRun("pane-mail")], () => undefined);
		dashboard.handleInput("3");
		const lines = dashboard.render(80);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});

	it("switches to output pane on key 4", () => {
		const dashboard = new RunDashboard([makeRun("pane-out")], () => undefined);
		dashboard.handleInput("4");
		const lines = dashboard.render(80);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});

	it("switches to health pane on key 5", () => {
		const dashboard = new RunDashboard([makeRun("pane-hp")], () => undefined);
		dashboard.handleInput("5");
		const lines = dashboard.render(80);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});

	it("switches to agents pane on key 1", () => {
		const dashboard = new RunDashboard([makeRun("pane-ag")], () => undefined);
		dashboard.handleInput("3"); // switch away first
		dashboard.handleInput("1"); // back to agents
		const lines = dashboard.render(80);
		assert.ok(Array.isArray(lines));
		dashboard.dispose();
	});

	it("handles reload action", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("reload-run")], (s) => {
			selected = s;
		});
		dashboard.handleInput("r");
		assert.ok(selected);
		assert.equal(selected!.action, "reload");
		dashboard.dispose();
	});

	it("handles summary action", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("summary-run")], (s) => {
			selected = s;
		});
		dashboard.handleInput("u");
		assert.ok(selected);
		assert.equal(selected!.action, "summary");
		dashboard.dispose();
	});

	it("handles agents action", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("agents-act")], (s) => {
			selected = s;
		});
		dashboard.handleInput("d");
		assert.ok(selected);
		assert.equal(selected!.action, "agents");
		dashboard.dispose();
	});
});

describe("RunDashboard with runProvider", () => {
	it("refreshes runs from provider on render", () => {
		let callCount = 0;
		const initial = [makeRun("provider-1", "running")];
		const dashboard = new RunDashboard(
			initial,
			() => undefined,
			{},
			{
				runProvider: () => {
					callCount++;
					return [makeRun("provider-1", "completed")];
				},
			},
		);
		dashboard.render(80);
		assert.ok(callCount >= 1);
		dashboard.dispose();
	});

	it("keeps selection on refresh when run still present", () => {
		const runs = [makeRun("keep-1"), makeRun("keep-2")];
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard(
			runs,
			(s) => {
				selected = s;
			},
			{},
			{
				runProvider: () => runs,
			},
		);
		dashboard.handleInput("j"); // select keep-2
		dashboard.handleInput("\r");
		assert.equal(selected?.runId, "keep-2");
		dashboard.render(80); // refresh
		dashboard.handleInput("\r"); // select again
		assert.equal(selected?.runId, "keep-2");
		dashboard.dispose();
	});
});

describe("RunDashboard dispose", () => {
	it("dispose is idempotent", () => {
		const dashboard = new RunDashboard([makeRun("disp")], () => undefined);
		dashboard.dispose();
		dashboard.dispose();
	});
});

describe("RunDashboard plan approval keys (WP-3)", () => {
	const pendingApproval = {
		required: true,
		status: "pending" as const,
		requestedAt: "2026-06-04T00:00:00.000Z",
		updatedAt: "2026-06-04T00:00:00.000Z",
	};

	it("A in the progress pane dispatches plan-approve for a pending run", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("plan-yes", "running", { planApproval: pendingApproval })], (s) => {
			selected = s;
		});
		dashboard.handleInput("2"); // enter progress pane
		dashboard.handleInput("A");
		assert.deepEqual(selected, { runId: "plan-yes", action: "plan-approve" });
		dashboard.dispose();
	});

	it("n in the progress pane dispatches plan-deny for a pending run", () => {
		let selected: RunDashboardSelection | undefined;
		const dashboard = new RunDashboard([makeRun("plan-no", "running", { planApproval: pendingApproval })], (s) => {
			selected = s;
		});
		dashboard.handleInput("2");
		dashboard.handleInput("n");
		assert.deepEqual(selected, { runId: "plan-no", action: "plan-deny" });
		dashboard.dispose();
	});

	it("A on a non-pending run is a silent no-op (dashboard stays open)", () => {
		let selected: RunDashboardSelection | undefined = { runId: "sentinel", action: "status" };
		const dashboard = new RunDashboard(
			[makeRun("plan-done", "running", { planApproval: { ...pendingApproval, status: "approved" } })],
			(s) => {
				selected = s;
			},
		);
		dashboard.handleInput("2");
		dashboard.handleInput("A");
		// done() never fires → sentinel stays, dashboard not closed/misrouted.
		assert.equal(selected?.runId, "sentinel");
		dashboard.dispose();
	});

	it("A outside the progress pane is unclaimed by plan bindings", () => {
		let selected: RunDashboardSelection | undefined = { runId: "sentinel", action: "status" };
		const dashboard = new RunDashboard([makeRun("plan-pg", "running", { planApproval: pendingApproval })], (s) => {
			selected = s;
		});
		dashboard.handleInput("1"); // agents pane — "A" must not dispatch here
		dashboard.handleInput("A");
		assert.equal(selected?.runId, "sentinel");
		dashboard.dispose();
	});
});
