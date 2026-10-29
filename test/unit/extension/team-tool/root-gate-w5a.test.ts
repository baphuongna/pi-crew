/**
 * w5a-rootgate regression tests (security fix wave w5a, run-1).
 *
 * Finding 1 (HIGH, rootGateDryRunPreviewExemptsMutatingHandlers): the
 * root-session gate used to exempt `goal start` and `create` from the
 * user-tier gate when a dryRun carrier (top-level `params.dryRun` OR
 * `config.dryRun`) was present — but handleStart (goal.ts) has NO dryRun
 * branch (it persists goal-loop state and spawns the detached runner) and
 * handleCreate (management.ts) honors only top-level `params.dryRun`. A
 * config-carrier "preview" therefore mutated for real from a non-root
 * session. Fix: previews traverse the SAME gate matrix as execution (schedule
 * precedent); unrecognized carrier shapes fail closed.
 *
 * Finding 2 (MEDIUM, rootGateActionMatrixOmitsDeleteCleanupInit):
 * assertRootOnlyAction had no case for `delete` / `cleanup` / `init`, so all
 * three hit `default: return undefined` and non-root sessions could unlink
 * user-tier agents/teams/workflows, rmSync the whole user-tier pi-crew state
 * directory (cleanup scope=user + force) and rewrite the global pi-crew
 * config (init defaults to configScope 'global'). Fix: the matrix covers all
 * three, with `delete` additionally re-gated in handleDelete on the RESOLVED
 * resource tier (mirroring handleUpdate) and `cleanup`/`init` reading the
 * carriers their handlers actually read (top-level params.scope /
 * config.configScope ∪ config.scope).
 *
 * Env model mirrors root-gate.test.ts: worker sessions are simulated with
 * PI_CREW_KIND=subagent + PI_CREW_DEPTH=1 and a redirected hermetic HOME
 * (PI_CREW_HOME/PI_TEAMS_HOME) so nothing can touch the real user tier even
 * if the gate ever regresses.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { assertRootOnlyAction, rootGateBlockReason } from "../../../../src/extension/team-tool/destructive-gate.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { userPiRoot } from "../../../../src/utils/paths.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const WORKER_ENV = { PI_CREW_KIND: "subagent", PI_CREW_DEPTH: "1" } as const;
const ROOT_ENV = { PI_CREW_KIND: "", PI_CREW_DEPTH: "0" } as const;

function tmpCtx(): { ctx: TeamContext; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "root-gate-w5a-"));
	return { ctx: { cwd: dir }, dir };
}

// ---------------------------------------------------------------------------
// Finding 1: dryRun carriers no longer exempt mutating actions (pure facade)
// ---------------------------------------------------------------------------

describe("w5a fix 1: dryRun carriers traverse the same gate matrix (pure)", () => {
	it("goal start is gated for workers on EVERY dryRun carrier shape (brief PoC included)", () => {
		// The exact PoC shape from the brief: budgetTotal on the top level,
		// dryRun on the CONFIG carrier — used to pass as a "preview" and fully
		// start a persistent autonomous goal loop. (budgetTotal is exercised in
		// the E2E suite below; the pure gate reads only action/config/dryRun.)
		assert.ok(
			rootGateBlockReason(
				{ action: "goal", config: { subAction: "start", objective: "o", evaluatorModel: "m", dryRun: true } },
				WORKER_ENV,
			),
		);
		// top-level carrier
		assert.ok(
			rootGateBlockReason(
				{ action: "goal", dryRun: true, config: { subAction: "start", objective: "o", evaluatorModel: "m" } },
				WORKER_ENV,
			),
		);
		// both carriers
		assert.ok(
			rootGateBlockReason(
				{
					action: "goal",
					dryRun: true,
					config: { subAction: "start", objective: "o", evaluatorModel: "m", dryRun: true },
				},
				WORKER_ENV,
			),
		);
		// no carrier (pre-existing control — was already gated)
		assert.ok(rootGateBlockReason({ action: "goal", config: { subAction: "start", objective: "o", evaluatorModel: "m" } }, WORKER_ENV));
		// budgetUnlimited variant is equally gated (caller-controlled unbounded spend)
		assert.ok(
			rootGateBlockReason(
				{ action: "goal", config: { subAction: "start", objective: "o", budgetUnlimited: true, dryRun: true } },
				WORKER_ENV,
			),
		);
		// root session: previews and executions alike stay allowed
		assert.equal(
			rootGateBlockReason(
				{ action: "goal", config: { subAction: "start", objective: "o", evaluatorModel: "m", dryRun: true } },
				ROOT_ENV,
			),
			undefined,
		);
		// non-mutating goal ops stay open for workers (no over-block)
		assert.equal(rootGateBlockReason({ action: "goal", config: { subAction: "status", dryRun: true } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "goal", config: { subAction: "stop", goalId: "g" } }, WORKER_ENV), undefined);
	});

	it("create is gated for workers on EVERY dryRun carrier shape (brief PoC included)", () => {
		// The exact PoC shape from the brief: dryRun on the CONFIG carrier —
		// used to pass as a "preview" while handleCreate (which reads only the
		// top-level carrier) planted a user-tier agent for real. (resource is
		// exercised in the E2E suite; the pure gate reads only action/config.)
		assert.ok(
			rootGateBlockReason(
				{ action: "create", config: { name: "probe-a", description: "d", systemPrompt: "p", tools: ["bash"], dryRun: true } },
				WORKER_ENV,
			),
		);
		// top-level carrier
		assert.ok(
			rootGateBlockReason(
				{ action: "create", dryRun: true, config: { name: "probe-a", description: "d", systemPrompt: "p" } },
				WORKER_ENV,
			),
		);
		// both carriers + confirm:true (confirm is caller-controlled, never a bypass)
		assert.ok(
			rootGateBlockReason(
				{
					action: "create",
					dryRun: true,
					confirm: true,
					config: { name: "probe-a", description: "d", systemPrompt: "p", dryRun: true },
				},
				WORKER_ENV,
			),
		);
		// no carrier (pre-existing control — was already gated)
		assert.ok(rootGateBlockReason({ action: "create", config: { name: "probe-a", description: "d", systemPrompt: "p" } }, WORKER_ENV));
		// project-scope create previews stay worker-reachable (no over-block)
		assert.equal(
			rootGateBlockReason({ action: "create", dryRun: true, config: { name: "ok", description: "d", scope: "project" } }, WORKER_ENV),
			undefined,
		);
		// root session unaffected
		assert.equal(
			rootGateBlockReason(
				{ action: "create", config: { name: "probe-a", description: "d", systemPrompt: "p", dryRun: true } },
				ROOT_ENV,
			),
			undefined,
		);
	});

	it("assertRootOnlyAction pins: goal-start/create/delete/cleanup/init vs root (pure matrix)", () => {
		assert.ok(assertRootOnlyAction("goal", "start", "project", WORKER_ENV));
		assert.ok(assertRootOnlyAction("goal", "start", "user", WORKER_ENV));
		assert.ok(assertRootOnlyAction("create", undefined, "user", WORKER_ENV));
		// w5a fix 2: the completed matrix — delete/cleanup/init gate at the user
		// tier, project tier stays worker-reachable, root stays open.
		assert.ok(assertRootOnlyAction("delete", undefined, "user", WORKER_ENV));
		assert.equal(assertRootOnlyAction("delete", undefined, "project", WORKER_ENV), undefined);
		assert.ok(assertRootOnlyAction("cleanup", undefined, "user", WORKER_ENV));
		assert.equal(assertRootOnlyAction("cleanup", undefined, "project", WORKER_ENV), undefined);
		// init: scope "user" is the resolved-global bucket (see resolveInitConfigScope)
		assert.ok(assertRootOnlyAction("init", undefined, "user", WORKER_ENV));
		assert.equal(assertRootOnlyAction("init", undefined, "project", WORKER_ENV), undefined);
		assert.equal(assertRootOnlyAction("goal", "start", undefined, ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("create", undefined, "user", ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("delete", undefined, "user", ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("cleanup", undefined, "user", ROOT_ENV), undefined);
		assert.equal(assertRootOnlyAction("init", undefined, "user", ROOT_ENV), undefined);
	});
});

// ---------------------------------------------------------------------------
// Finding 2: delete/cleanup/init join the root-gate matrix (pure facade)
// ---------------------------------------------------------------------------

describe("w5a fix 2: delete/cleanup/init require the root gate (pure)", () => {
	it("delete: gated for workers (default + explicit user tier); project stays open; root open", () => {
		// PoC shape: no cfg scope — resolveMutable pools user+project, so the
		// facade fails closed on the user default (matches create/settings/config).
		// (resource/agent keys are exercised in the E2E suite; the pure gate reads
		// only action/confirm/config.)
		assert.ok(rootGateBlockReason({ action: "delete", confirm: true }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "delete", confirm: true, config: { name: "victim" } }, WORKER_ENV));
		// explicit user tier via the canonical carrier — gated even with confirm
		assert.ok(rootGateBlockReason({ action: "delete", confirm: true, config: { name: "victim", scope: "user" } }, WORKER_ENV));
		// dryRun previews traverse the same matrix (delete always mutates)
		assert.ok(rootGateBlockReason({ action: "delete", dryRun: true, confirm: true, config: { name: "victim" } }, WORKER_ENV));
		// project tier stays worker-reachable via the canonical carrier
		assert.equal(
			rootGateBlockReason({ action: "delete", confirm: true, config: { name: "ok", scope: "project" } }, WORKER_ENV),
			undefined,
		);
		// root session: everything allowed
		assert.equal(rootGateBlockReason({ action: "delete", confirm: true }, ROOT_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "delete", confirm: true, config: { name: "v", scope: "user" } }, ROOT_ENV), undefined);
	});

	it("cleanup: scope=user gated for workers (top-level carrier, the one handleCleanup reads)", () => {
		// PoC shape: handleCleanup routes on TOP-LEVEL params.scope === "user"
		// (config.scope is a carrier key it ignores).
		assert.ok(rootGateBlockReason({ action: "cleanup", scope: "user", confirm: true, force: true }, WORKER_ENV));
		// everything else routes to project/run cleanup — project tier, open
		assert.equal(rootGateBlockReason({ action: "cleanup", confirm: true, force: true }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "cleanup", scope: "project", confirm: true, force: true }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "cleanup", scope: "both", confirm: true, force: true }, WORKER_ENV), undefined);
		// config-carrier "user" must NOT gate (the handler ignores that carrier —
		// gating it would block a project-tier cleanup)
		assert.equal(rootGateBlockReason({ action: "cleanup", confirm: true, config: { scope: "user" } }, WORKER_ENV), undefined);
		// dryRun does NOT exempt user cleanup (fail-closed: previews of mutating
		// actions traverse the same matrix — w5a fix 1's lesson applied uniformly;
		// protects against future drift in handleUserCleanup's dryRun branch)
		assert.ok(rootGateBlockReason({ action: "cleanup", scope: "user", dryRun: true }, WORKER_ENV));
		// root session: allowed
		assert.equal(rootGateBlockReason({ action: "cleanup", scope: "user", confirm: true, force: true }, ROOT_ENV), undefined);
	});

	it("init: global (the default) gated for workers; project/none stay worker-reachable", () => {
		// PoC shape: no config → configScope defaults to 'global' → writes
		// ~/.pi/agent/pi-crew.json; overwrite:true replaces a customized config.
		assert.ok(rootGateBlockReason({ action: "init", config: { overwrite: true } }, WORKER_ENV));
		assert.ok(rootGateBlockReason({ action: "init" }, WORKER_ENV));
		// explicit global — gated
		assert.ok(rootGateBlockReason({ action: "init", config: { configScope: "global" } }, WORKER_ENV));
		// unknown configScope falls through to global in dispatch/manage.ts —
		// fail closed, mirroring the handler
		assert.ok(rootGateBlockReason({ action: "init", config: { configScope: "bogus" } }, WORKER_ENV));
		// project / none outcomes write no user-tier config — open, mirroring
		// the dispatch union (either carrier decides)
		assert.equal(rootGateBlockReason({ action: "init", config: { configScope: "project" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "init", config: { scope: "project" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "init", config: { configScope: "none" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "init", config: { configScope: "global", scope: "none" } }, WORKER_ENV), undefined);
		assert.equal(rootGateBlockReason({ action: "init", config: { configScope: "none", scope: "project" } }, WORKER_ENV), undefined);
		// root session: allowed
		assert.equal(rootGateBlockReason({ action: "init", config: { overwrite: true } }, ROOT_ENV), undefined);
	});
});

// ---------------------------------------------------------------------------
// End-to-end through handleTeamTool (worker env + hermetic home)
// ---------------------------------------------------------------------------

describe("w5a handleTeamTool root-gate (end-to-end, hermetic home)", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let savedHome: string | undefined;
	let homeDir: string;

	/** User-tier path under the HERMETIC home (see beforeEach). */
	const userTierPath = (...parts: string[]) => path.join(userPiRoot(), ...parts);

	beforeEach(() => {
		savedEnv = { ...process.env };
		savedHome = process.env.HOME;
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "root-gate-w5a-home-"));
		// Mirror root-gate.test.ts: redirect every home mirror so user-tier
		// assertions are real (never the developer's actual ~/.pi).
		process.env.HOME = homeDir;
		process.env.PI_TEAMS_HOME = homeDir;
		process.env.PI_CREW_HOME = homeDir;
		process.env.PI_CREW_KIND = "subagent";
		process.env.PI_CREW_DEPTH = "1";
	});

	afterEach(async () => {
		process.env.PI_CREW_KIND = savedEnv.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = savedEnv.PI_CREW_DEPTH;
		process.env.PI_TEAMS_HOME = savedEnv.PI_TEAMS_HOME;
		process.env.PI_CREW_HOME = savedEnv.PI_CREW_HOME;
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		await removeDirWithRetry(homeDir);
	});

	function setRootEnv(): void {
		delete process.env.PI_CREW_KIND;
		process.env.PI_CREW_DEPTH = "0";
	}

	function setWorkerEnv(): void {
		process.env.PI_CREW_KIND = "subagent";
		process.env.PI_CREW_DEPTH = "1";
	}

	async function run(params: TeamToolParamsValue, ctx: TeamContext) {
		const res = await handleTeamTool(params, ctx);
		return { isError: res.isError === true, text: textFromToolResult(res) ?? "" };
	}

	it("w5a-1: worker goal-start with config-carrier dryRun (brief PoC) REJECTED — no loop started", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run(
				{
					action: "goal",
					budgetTotal: 5000,
					config: { subAction: "start", objective: "pwn", evaluatorModel: "m", dryRun: true },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			assert.doesNotMatch(r.text, /Goal loop started/);
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-1: worker create with config-carrier dryRun (brief PoC) REJECTED — no user-tier file planted", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run(
				{
					action: "create",
					resource: "agent",
					config: {
						name: "probe-a",
						description: "d",
						systemPrompt: "ATTACKER-CONTROLLED SYSTEM PROMPT",
						tools: ["bash", "read"],
						dryRun: true,
					},
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			// the amplification sink (user tier shadows builtins for every future
			// session) stays clean
			assert.equal(fs.existsSync(userTierPath("agents", "probe-a.md")), false);
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-1: worker project-scope create preview still allowed (no over-block); writes nothing", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const r = await run(
				{
					action: "create",
					resource: "agent",
					dryRun: true,
					config: { name: "probe-p", description: "d", scope: "project", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(r.text, /root-session required/);
			assert.match(r.text, /\[dry-run\]/);
			assert.equal(fs.existsSync(path.join(dir, ".crew", "agents", "probe-p.md")), false);
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-1: root create with config-carrier dryRun unaffected (handler contract unchanged, gate-side fix)", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			setRootEnv();
			const r = await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "root-a", description: "d", systemPrompt: "p", dryRun: true },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(r.text, /root-session required/);
			// handleCreate honors only the top-level dryRun carrier, so root's
			// config-carrier "preview" writes for real — trusted tier, unchanged.
			assert.ok(fs.existsSync(userTierPath("agents", "root-a.md")));
		} finally {
			setWorkerEnv();
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-2: worker delete of a user-tier agent REJECTED (facade default) — file preserved", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			setRootEnv();
			const seeded = await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "victim", description: "d", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.ok(fs.existsSync(userTierPath("agents", "victim.md")), "seed");
			setWorkerEnv();
			const r = await run({ action: "delete", resource: "agent", agent: "victim", confirm: true } as TeamToolParamsValue, ctx);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			assert.ok(fs.existsSync(userTierPath("agents", "victim.md")), "user-tier file must survive the blocked delete");
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-2: divergent-carrier worker delete (top-level user, cfg project) caught by the handleDelete resolved-tier gate", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			setRootEnv();
			await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "victim2", description: "d", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			setWorkerEnv();
			// Facade reads config.scope ('project' → open); resolveMutable reads
			// TOP-LEVEL scope ('user' → user-only pool) and resolves the user-tier
			// resource — the in-handler gate (management.ts, mirrors handleUpdate)
			// must block it.
			const r = await run(
				{
					action: "delete",
					resource: "agent",
					agent: "victim2",
					confirm: true,
					scope: "user",
					config: { name: "victim2", scope: "project" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			assert.ok(fs.existsSync(userTierPath("agents", "victim2.md")), "user-tier file must survive");
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-2: worker project-tier delete stays worker-reachable; root delete (confirm:true) works", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			// worker creates + deletes a PROJECT-tier agent via the canonical carrier
			const created = await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "proj-v", description: "d", scope: "project", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(created.text, /root-session required/);
			assert.ok(fs.existsSync(path.join(dir, ".crew", "agents", "proj-v.md")), "seed");
			const deleted = await run(
				{
					action: "delete",
					resource: "agent",
					agent: "proj-v",
					confirm: true,
					config: { name: "proj-v", scope: "project" },
				} as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(deleted.text, /root-session required/);
			assert.notEqual(deleted.isError, true);
			assert.equal(fs.existsSync(path.join(dir, ".crew", "agents", "proj-v.md")), false);
			// root deletes a user-tier resource with confirm:true (confirm path works)
			setRootEnv();
			await run(
				{
					action: "create",
					resource: "agent",
					config: { name: "root-victim", description: "d", systemPrompt: "p" },
				} as TeamToolParamsValue,
				ctx,
			);
			const rootDeleted = await run(
				{ action: "delete", resource: "agent", agent: "root-victim", confirm: true } as TeamToolParamsValue,
				ctx,
			);
			assert.doesNotMatch(rootDeleted.text, /root-session required/);
			assert.notEqual(rootDeleted.isError, true);
			assert.equal(fs.existsSync(userTierPath("agents", "root-victim.md")), false);
		} finally {
			setWorkerEnv();
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-2: worker cleanup scope=user REJECTED — global config preserved", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const globalConfig = userTierPath("pi-crew.json");
			fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
			fs.writeFileSync(globalConfig, '{"USER_CUSTOMIZED":true}\n', "utf-8");
			const r = await run({ action: "cleanup", scope: "user", confirm: true, force: true } as TeamToolParamsValue, ctx);
			assert.equal(r.isError, true);
			assert.match(r.text, /root-session required/);
			assert.ok(fs.existsSync(globalConfig), "global config must survive the blocked cleanup");
		} finally {
			await removeDirWithRetry(dir);
		}
	});

	it("w5a-2: worker init (default global) REJECTED — no global config written; project init stays open", async () => {
		const { ctx, dir } = tmpCtx();
		try {
			const globalConfig = userTierPath("pi-crew.json");
			const blocked = await run({ action: "init", config: { overwrite: true } } as TeamToolParamsValue, ctx);
			assert.equal(blocked.isError, true);
			assert.match(blocked.text, /root-session required/);
			assert.equal(fs.existsSync(globalConfig), false, "global config must not be created");
			// project-scoped init stays worker-reachable (no global write)
			const projectInit = await run({ action: "init", config: { configScope: "project" } } as TeamToolParamsValue, ctx);
			assert.doesNotMatch(projectInit.text, /root-session required/);
			assert.equal(fs.existsSync(globalConfig), false);
			assert.ok(fs.existsSync(path.join(dir, ".pi", "pi-crew.json")), "project config created");
		} finally {
			await removeDirWithRetry(dir);
		}
	});
});
