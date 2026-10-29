/**
 * w4b-config security fix — sanitize-project-config.embeddedWorkers.project-tier-routing.
 *
 * `runtime.embeddedWorkers` is the THIRD in-process routing knob (besides
 * `runtime.mode` and `runtime.isolationPolicy`, both already sensitive-marked).
 * An embedded-routed worker's Pi session runs IN-PROCESS in the host pi
 * process where the two deterministic host protections do not exist: the
 * PI_CREW_SANDBOX=bwrap OS boundary is resolved only on the child spawn path
 * (child-pi.ts resolveSandboxConfig) and the env allowlist scrub
 * (sanitizeEnvSecrets) exists only for child envs. A repo-authored
 * .crew/config.json / .pi/pi-crew.json with
 * {enabled:true, roles:[executor,verifier]} therefore used to survive
 * sanitizeProjectConfig and route bash-capable roles onto the embedded tier —
 * silently voiding the user's sandbox opt-in.
 *
 * Fix: the whole `runtime.embeddedWorkers` block is sensitive-marked in the
 * schema → the schema-driven walk drops it from the PROJECT tier (and from
 * run-param patches, which share the walk) with the standard warning. The
 * user-tier config file remains the product knob — parseConfig still accepts
 * and preserves the block.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { __test__sanitizeProjectConfig, parseConfig } from "../../../src/config/config.ts";
import { embeddedTierRefusedBySandbox, embeddedTierSandboxRefusalReason } from "../../../src/config/sanitize-project-config.ts";
import type { PiTeamsConfig } from "../../../src/config/types.ts";
import { effectiveRunConfig } from "../../../src/extension/team-tool/config-patch.ts";
import { PiTeamsConfigSchema } from "../../../src/schema/config-schema.ts";
import { collectSensitiveConfigPaths } from "../../../src/schema/sensitive-config-paths.ts";

const PROJECT_PATH = "/tmp/pi-crew-test/embedded-workers.json";

function runtimeSchema(): Record<string, unknown> | undefined {
	const root = PiTeamsConfigSchema as unknown as { properties?: Record<string, unknown> };
	const runtime = root.properties?.runtime as { properties?: Record<string, unknown> } | undefined;
	return runtime?.properties;
}

test("schema mark: runtime.embeddedWorkers is sensitive-marked (terminal — same tier authority as runtime.mode/isolationPolicy)", () => {
	const prop = runtimeSchema()?.embeddedWorkers as { sensitive?: unknown } | undefined;
	assert.ok(prop, "embeddedWorkers must exist on the runtime schema");
	assert.equal(prop.sensitive, true, "embeddedWorkers must carry sensitive:true");
	const paths = collectSensitiveConfigPaths();
	assert.ok(paths.includes("runtime.embeddedWorkers"), "walk must collect runtime.embeddedWorkers");
});

test("(a) project config with runtime.embeddedWorkers is dropped by sanitize with the standard warning", () => {
	const projectConfig: PiTeamsConfig = {
		runtime: {
			embeddedWorkers: { enabled: true, roles: ["executor", "verifier"], maxConcurrent: 3, faultThreshold: 2 },
			maxTurns: 50,
			taskTimeoutMs: 300_000,
		},
	} as PiTeamsConfig;

	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, projectConfig);

	assert.equal(
		sanitized.runtime?.embeddedWorkers,
		undefined,
		"project-tier runtime.embeddedWorkers must be dropped (defaults apply — tier stays default-off)",
	);
	assert.equal(sanitized.runtime?.maxTurns, 50, "non-sensitive runtime sibling keys survive");
	assert.equal(sanitized.runtime?.taskTimeoutMs, 300_000, "non-sensitive runtime sibling keys survive");
	assert.ok(
		warnings.some((w) => w.includes("'runtime.embeddedWorkers'") && w.includes(PROJECT_PATH)),
		"drop must warn with the standard project-override format",
	);
});

test("(a) contrast pin: embeddedWorkers is treated exactly like the other routing knobs", () => {
	// The brief's observed PoC contrast: mode/isolationPolicy dropped with
	// warnings while embeddedWorkers survived. After the fix all three drop.
	const { config: sanitized, warnings } = __test__sanitizeProjectConfig(PROJECT_PATH, {}, {
		runtime: {
			mode: "live-session",
			isolationPolicy: { isolatedRoles: ["researcher"], defaultRuntime: "live-session" },
			embeddedWorkers: { enabled: true, roles: ["executor"] },
		},
	} as unknown as PiTeamsConfig);
	assert.equal(sanitized.runtime, undefined, "runtime with only routing knobs collapses to undefined");
	for (const dotted of ["runtime.mode", "runtime.isolationPolicy", "runtime.embeddedWorkers"]) {
		assert.ok(
			warnings.some((w) => w.includes(`'${dotted}'`)),
			`${dotted} must produce the standard sensitive-config warning`,
		);
	}
});

test("(a) run-param channel drops runtime.embeddedWorkers too (same sensitive walk — M1-8 doctrine)", () => {
	// params.config is worker/LLM-influenced tool input; the routing knobs must
	// not be param-settable there either (config-patch dropSensitivePatchPaths).
	const effective = effectiveRunConfig(
		{ runtime: { mode: "child-process" } },
		{ runtime: { embeddedWorkers: { enabled: true, roles: ["executor", "verifier"] } } as never },
	);
	assert.equal(effective.runtime?.embeddedWorkers, undefined, "runtime.embeddedWorkers must not be settable via run params");
	assert.equal(effective.runtime?.mode, "child-process", "base runtime untouched");
});

test("(b) user tier keeps the product knob: parseConfig preserves runtime.embeddedWorkers", () => {
	const raw = JSON.parse(JSON.stringify({ runtime: { embeddedWorkers: { enabled: true, roles: ["executor", "verifier"] } } }));
	const parsed = parseConfig(raw);
	assert.equal(
		parsed.runtime?.embeddedWorkers?.enabled,
		true,
		"the sensitive mark removes PROJECT-tier authority only — user config still parses/enables embeddedWorkers",
	);
	assert.deepEqual(parsed.runtime?.embeddedWorkers?.roles, ["executor", "verifier"]);
});

// ─── (c) defense-in-depth gate: embedded routing refused while sandbox is on ───
// Mirrors resolveSandboxConfig's value semantics (sandbox.ts): "" and "0" =
// OFF; any other non-empty value = sandbox intent ("bwrap" active; unknown
// values throw on the child path — refusing here is the same fail-closed
// posture). The routing consumer (planEmbeddedTier) is a documented follow-up
// wiring outside this wave's file ownership; the gate + wording ship tested.

test("(c) gate: PI_CREW_SANDBOX=bwrap refuses embedded routing", () => {
	assert.equal(embeddedTierRefusedBySandbox({ PI_CREW_SANDBOX: "bwrap" }), true);
});

test("(c) gate: unrecognized non-empty sandbox values refuse too (fail-closed, mirrors resolveSandboxConfig)", () => {
	for (const v of ["BWRAP", " bubblewrap ", "1", "yes", "docker"]) {
		assert.equal(embeddedTierRefusedBySandbox({ PI_CREW_SANDBOX: v }), true, `value '${v}' must refuse`);
	}
});

test("(c) gate: unset / empty / '0' allows embedded routing (sandbox OFF)", () => {
	assert.equal(embeddedTierRefusedBySandbox({}), false);
	assert.equal(embeddedTierRefusedBySandbox({ PI_CREW_SANDBOX: "" }), false);
	assert.equal(embeddedTierRefusedBySandbox({ PI_CREW_SANDBOX: "0" }), false);
	assert.equal(embeddedTierRefusedBySandbox({ PI_CREW_SANDBOX: "  " }), false);
});

test("(c) refusal wording names the env knob, the bypassed protections, and the subprocess fallback", () => {
	const msg = embeddedTierSandboxRefusalReason({ PI_CREW_SANDBOX: "bwrap" });
	assert.ok(msg.includes("PI_CREW_SANDBOX='bwrap'"), "message must name the knob + value");
	assert.ok(msg.includes("bwrap OS boundary"), "message must name the bypassed OS boundary");
	assert.ok(msg.includes("secret scrub"), "message must name the bypassed env scrub");
	assert.ok(msg.includes("subprocess tier"), "message must name the fallback tier");
});
