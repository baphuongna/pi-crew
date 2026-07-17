import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { handleGoal } from "../../src/extension/team-tool/goal.ts";
import { GoalStore } from "../../src/runtime/goal-state-store.ts";

function fakeCtx(cwd: string): { cwd: string; sessionId: string } {
	return { cwd, sessionId: "rt-test-session" };
}
function tmpCwd() {
	return `${os.tmpdir()}/pi-crew-rt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
let pass = 0,
	fail = 0;
function check(n: string, c: boolean, d?: string): void {
	if (c) {
		pass++;
		console.log(`✓ ${n}`);
	} else {
		fail++;
		console.log(`✗ ${n}: ${d ?? ""}`);
	}
}

async function main() {
	console.log("\n─── P1d budget rejection ───");
	const cwd1 = tmpCwd();
	try {
		const r1 = await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "no budget",
					evaluatorModel: "stub",
				},
			},
			fakeCtx(cwd1),
		);
		check("no budget → error", r1.isError === true, `isError=${r1.isError}`);
		check(
			"no budget → mentions budget",
			/budget/i.test((r1.content[0] as { text?: string })?.text ?? ""),
			((r1.content[0] as { text?: string })?.text ?? "").slice(0, 100),
		);
		const r2 = await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "low",
					evaluatorModel: "stub",
				},
				budgetTotal: 500,
			},
			fakeCtx(cwd1),
		);
		check("budgetTotal:500 → error", r2.isError === true, `isError=${r2.isError}`);
		const r3 = await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "both",
					evaluatorModel: "stub",
					budgetUnlimited: true,
				},
				budgetTotal: 5000,
			},
			fakeCtx(cwd1),
		);
		check("both budgets → error", r3.isError === true, `isError=${r3.isError}`);
		check(
			"both → 'mutually exclusive'",
			/mutually exclusive/i.test((r3.content[0] as { text?: string })?.text ?? ""),
			((r3.content[0] as { text?: string })?.text ?? "").slice(0, 150),
		);
		const r4 = await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "unlimited ok",
					evaluatorModel: "stub",
					budgetUnlimited: true,
				},
			},
			fakeCtx(cwd1),
		);
		const r4t = (r4.content[0] as { text?: string })?.text ?? "";
		check(
			"budgetUnlimited alone → not budget-rejected",
			!(/requires either/i.test(r4t) && /budgetTotal/i.test(r4t)),
			r4t.slice(0, 150),
		);
		const r5 = await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "1000 ok",
					evaluatorModel: "stub",
				},
				budgetTotal: 1000,
			},
			fakeCtx(cwd1),
		);
		const r5t = (r5.content[0] as { text?: string })?.text ?? "";
		check(
			"budgetTotal:1000 → not budget-rejected",
			!(/requires either/i.test(r5t) && /budgetTotal/i.test(r5t) && !/spawn/i.test(r5t)),
			r5t.slice(0, 150),
		);
	} finally {
		rmSync(cwd1, { recursive: true, force: true });
	}

	console.log("\n─── P1a integrity snapshot ───");
	const cwd2 = tmpCwd();
	try {
		mkdirSync(cwd2, { recursive: true });
		writeFileSync(join(cwd2, "package.json"), JSON.stringify({ name: "rt-test", scripts: { test: "exit 0" } }));
		await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "snap",
					evaluatorModel: "stub",
					budgetUnlimited: true,
					verification: { commands: ["npm test"] },
				},
			},
			fakeCtx(cwd2),
		);
		const store = new GoalStore(cwd2);
		const goals = store.list();
		const g = goals.find((x) => x.objective === "snap");
		if (g) {
			check("verificationIntegrity is set", g.verificationIntegrity !== undefined, `state=${g.verificationIntegrity}`);
			if (g.verificationIntegrity && g.verificationIntegrity !== "none-text-only") {
				check(
					"snapshot has package.json",
					!!g.verificationIntegrity.snapshot["package.json"],
					`keys=${Object.keys(g.verificationIntegrity.snapshot)}`,
				);
				check("snapshot has takenAt", !!g.verificationIntegrity.takenAt, "");
			}
		} else {
			check("snap goal saved", false, "(not found)");
		}

		await handleGoal(
			{
				action: "goal",
				config: {
					subAction: "start",
					objective: "textonly",
					evaluatorModel: "stub",
					budgetUnlimited: true,
					verification: { mode: "text-only" },
				},
			},
			fakeCtx(cwd2),
		);
		const to = store.list().find((x) => x.objective === "textonly");
		if (to) check("text-only → 'none-text-only'", to.verificationIntegrity === "none-text-only", `state=${to.verificationIntegrity}`);
		else check("text-only goal saved", false, "(not found)");
	} finally {
		rmSync(cwd2, { recursive: true, force: true });
	}

	console.log(`\n═══ RESULTS: ${pass} pass / ${fail} fail ═══`);
	process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
	console.error("FATAL:", e);
	process.exit(2);
});
