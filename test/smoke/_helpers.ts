/**
 * Shared helpers for smoke tests (HB-004).
 *
 * Smoke tests shell out to the REAL `pi` binary (not mocked). They are gated
 * behind PI_CREW_SMOKE=1 so CI doesn't bill tokens by default — run manually:
 *
 *   PI_CREW_SMOKE=1 npm run test:smoke
 *   PI_CREW_SMOKE=1 npx tsx --test test/smoke/agent-disabletools.smoke.ts
 *
 * Why these exist: the unit suite mocks child-pi, so it cannot catch bugs that
 * only manifest against the real binary (argv rejection, persona interactions,
 * spawn-lifecycle races). See HB-003a in docs/HARNESS_BACKLOG.md for the
 * incident that motivated this harness.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

/** Skip sentinel: every smoke test checks this. */
export const SMOKE_ENABLED = process.env.PI_CREW_SMOKE === "1";

/** Reason shown in the skip output when smoke is disabled. */
export const SKIP_REASON = "set PI_CREW_SMOKE=1 to run real-binary smoke tests (bills tokens)";

/**
 * Smoke tests spawn the REAL `pi` binary, which needs a resolvable model +
 * API key. On a fresh CI runner with neither PI_AUTH_JSON nor a
 * ~/.pi/agent/auth.json, `pi` exits 1 ("No API key found for the selected
 * model"). Detect that and skip gracefully so a token-free weekly canary
 * (weekly-smoke.yml) can still pass: it validates build/install/bundle, and
 * the model-billing smoke only runs where auth is actually configured.
 */
function hasModelAuth(): boolean {
	if (process.env.PI_AUTH_JSON) return true;
	const home = process.env.HOME || process.env.USERPROFILE || "";
	try {
		return fs.existsSync(path.join(home, ".pi", "agent", "auth.json"));
	} catch {
		return false;
	}
}
export const MODEL_AUTH_AVAILABLE = hasModelAuth();
export const SMOKE_SKIP_NO_AUTH =
	"smoke tests require a real model/API key — set PI_AUTH_JSON (repo secret) or run `pi /login`; skipped on token-free canaries";

/** Unified skip gate: run only when smoke is enabled AND a model is resolvable. */
export function smokeSkipReason(): string | false {
	if (!SMOKE_ENABLED) return SKIP_REASON;
	if (!MODEL_AUTH_AVAILABLE) return SMOKE_SKIP_NO_AUTH;
	return false;
}

/** Create a unique temp cwd and return it + a cleanup fn. */
export function makeTmpCwd(prefix: string): {
	cwd: string;
	cleanup: () => void;
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-smoke-${prefix}-`));
	return {
		cwd,
		cleanup: (): void => {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/** A minimal executor-style agent config suitable for runChildPi. */
export function fakeExecutorAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "smoke-executor",
		description: "smoke test agent",
		source: "user",
		filePath: "<smoke>",
		systemPrompt: "You are a smoke-test agent. Follow instructions exactly.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		tools: ["read", "bash"],
		...overrides,
	};
}

/**
 * Assert that the agent produced the expected marker string. Centralised so
 * failure messages are uniform across smoke tests.
 */
export function assertHasAnswer(stdout: string, marker: string, context: string): void {
	if (!stdout.includes(marker)) {
		throw new Error(`${context}: expected stdout to contain "${marker}". Got (last 200 chars): ${stdout.slice(-200) || "(empty)"}`);
	}
}
