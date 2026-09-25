import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Round 22 (defensive caps): `autoRecoveryLast` is a module-level Map inside
 * `register.ts:484` that holds cooldown timestamps for "recovery notifications"
 * (5-minute gate per key). Without a cap, a long-running pi session that runs
 * thousands of teams accumulates thousands of entries.
 *
 * The cap is enforced inside an internal closure in the `register()` function
 * — there's no exported handle to invoke directly. We test the cap behavior
 * by:
 *   1. Static check: the source file MUST contain the cap constant
 *      (`AUTO_RECOVERY_LAST_MAX_ENTRIES`) and an eviction loop.
 *   2. The pattern matches the existing `NotificationRouter.SEEN_MAP_MAX_SIZE`
 *      eviction strategy in the same codebase (oldest-insertion-first).
 */
test("register.ts implements an autoRecoveryLast defensive cap (Round 22)", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// v0.9.42 register.ts decomposition: the autoRecoveryLast cap moved to
	// `src/extension/registration/lifecycle-handlers.ts` (the cap constant lives
	// in `context-builder.ts`; the eviction loop lives in `lifecycle-handlers.ts`).
	const ctxPath = path.resolve(here, "..", "..", "..", "..", "src", "extension", "registration", "context-builder.ts");
	const lifecyclePath = path.resolve(here, "..", "..", "..", "..", "src", "extension", "registration", "lifecycle-handlers.ts");
	const ctxSource = fs.readFileSync(ctxPath, "utf-8");
	const lifecycleSource = fs.readFileSync(lifecyclePath, "utf-8");

	assert.match(
		ctxSource,
		/AUTO_RECOVERY_LAST_MAX_ENTRIES\s*:\s*\d+/,
		"context-builder.ts should declare AUTO_RECOVERY_LAST_MAX_ENTRIES cap constant",
	);
	// v0.9.x FINDING 6 refactor: the eviction loop moved into
	// health-notify-policy.ts (recordHealthNotifyDecision) — lifecycle-handlers
	// delegates with { entries: ctx.autoRecoveryLast, maxEntries:
	// ctx.AUTO_RECOVERY_LAST_MAX_ENTRIES }. Assert the delegation AND the
	// policy module's cap loop (behavioral coverage: health-notify-policy.test.ts).
	const policyPath = path.resolve(here, "..", "..", "..", "..", "src", "extension", "registration", "health-notify-policy.ts");
	const policySource = fs.readFileSync(policyPath, "utf-8");
	assert.match(
		lifecycleSource,
		/entries:\s*ctx\.autoRecoveryLast,\s*maxEntries:\s*ctx\.AUTO_RECOVERY_LAST_MAX_ENTRIES/,
		"lifecycle-handlers.ts should delegate the map + cap to the notify policy",
	);
	assert.match(
		policySource,
		/while\s*\(\s*state\.entries\.size\s*>=\s*state\.maxEntries\s*\)/,
		"health-notify-policy.ts should evict oldest entries when the cap is reached",
	);
	assert.match(policySource, /lastAccessAt/, "health-notify-policy.ts should reference lastAccessAt for LRU-style eviction");
});

test("crew-agent-records.ts implements an agentEventSeqCache defensive cap (Round 22)", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const recordsPath = path.resolve(here, "..", "..", "..", "..", "src", "runtime", "crew-agent-records.ts");
	const source = fs.readFileSync(recordsPath, "utf-8");

	assert.match(
		source,
		/AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES\s*=\s*\d+/,
		"crew-agent-records.ts should declare AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES cap constant",
	);
	assert.match(
		source,
		/while\s*\(\s*agentEventSeqCache\.size\s*>\s*AGENT_EVENT_SEQ_CACHE_MAX_ENTRIES\s*\)/,
		"crew-agent-records.ts should evict oldest entries when the cap is reached",
	);
	assert.match(
		source,
		/agentEventSeqCache\.keys\(\)\.next\(\)\.value/,
		"crew-agent-records.ts should use Map's natural insertion order (oldest first) for eviction",
	);
});
