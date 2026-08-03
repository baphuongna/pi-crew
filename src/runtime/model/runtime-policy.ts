import type { CrewRuntimeConfig } from "../../config/config.ts";
import type { CrewRuntimeKind } from "../crew-agent-runtime.ts";
import { currentCrewDepth } from "./pi-args.ts";

/**
 * Resolve the effective runtime kind for a given task role using isolation policy.
 * - scaffold is never overridden — scaffold stays scaffold.
 * - If already nested (PI_CREW_DEPTH > 0), force child-process to avoid live-session nesting issues.
 * - If the role appears in `isolationPolicy.isolatedRoles`, use child-process (crash isolation).
 * - Otherwise, use `isolationPolicy.defaultRuntime` when configured, then fall back to globalKind.
 */
export function resolveTaskRuntimeKind(
	globalKind: CrewRuntimeKind,
	role: string,
	isolationPolicy: CrewRuntimeConfig["isolationPolicy"],
	env: NodeJS.ProcessEnv = process.env,
): CrewRuntimeKind {
	if (globalKind === "scaffold") return "scaffold";
	// Safety: when already inside a pi-crew worker (depth > 0), never nest live-session.
	// Live-session creates in-process Pi agent sessions, which would recursively
	// try to use pi-crew, leading to "Cannot read properties of undefined" errors.
	// Exception: when PI_CREW_MOCK_LIVE_SESSION is set, we're in a test harness
	// that mocks the live-session path — forcing child-process would spawn a real
	// pi process and hang the test.
	if (globalKind === "live-session" && currentCrewDepth(env) > 0 && env.PI_CREW_MOCK_LIVE_SESSION !== "success") return "child-process";
	const isolatedRoles = isolationPolicy?.isolatedRoles ?? [];
	if (isolatedRoles.includes(role)) return "child-process";
	return isolationPolicy?.defaultRuntime ?? globalKind;
}
