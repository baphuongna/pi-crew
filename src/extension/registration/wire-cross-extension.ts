/**
 * Cross-extension wiring helper.
 *
 * Two small wires:
 *   • wireRpc — the in-process pi-crew RPC handle (other modules in
 *     the same extension can subscribe via `pi.events`).
 *   • wireGlobalRegistry — the crew registry, lazily loaded from
 *     team-tool.ts (heavy module) and installed in module-scoped state so
 *     the rest of pi-crew can discover pi-crew's RPC handle at runtime
 *     (EXT-9: no longer on globalThis[Symbol.for(...)]).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiCrewRpc } from "../cross-extension-rpc.ts";
import type { RegistrationContext } from "./registration-types.ts";

/** Install both wires on the registration context. */
export function installCrossExtensionWiring(pi: ExtensionAPI, ctx: RegistrationContext): void {
	// Wire the in-process RPC handle.
	const getPiEvents = (): Parameters<typeof registerPiCrewRpc>[0] | undefined => {
		if (pi && typeof pi === "object" && "events" in pi) {
			return (pi as { events?: Parameters<typeof registerPiCrewRpc>[0] }).events;
		}
		return undefined;
	};
	ctx.rpcHandle = registerPiCrewRpc(getPiEvents(), () => ctx.currentCtx);

	// Install the crew registry. Lazy import keeps team-tool.ts (which pulls
	// in the entire runtime chain) out of the cold-start module graph. EXT-9:
	// the registry now lives in module-scoped state, not globalThis.
	void import("../team-tool.ts").then(({ installCrewGlobalRegistry }) => {
		const manifestCacheForRegistry = ctx.getManifestCache(ctx.currentCtx?.cwd ?? process.cwd());
		installCrewGlobalRegistry({
			manifestCache: manifestCacheForRegistry,
			cwdProvider: () => ctx.currentCtx?.cwd ?? process.cwd(),
		});
	});
}

/**
 * F13 (RR-018): refresh the extension-lifetime cross-extension wiring for a
 * new session. Called on every `session_start`.
 *
 * The RPC handle is installed ONCE at registration and survives session
 * switches — its `getCtx` closure resolves the CURRENT session context at
 * request time, so nothing needs reinstalling (re-registering would double
 * the pi-crew:rpc:* subscriptions). The crew global registry IS rebound to
 * the current session's manifest cache so a cross-project switch never
 * leaves it reading a stale project's runs. Idempotent and cheap (a plain
 * object construction — installCrewGlobalRegistry swaps the module-scoped
 * singleton atomically).
 */
export function refreshCrossExtensionWiringForSession(pi: ExtensionAPI, ctx: RegistrationContext): void {
	if (!ctx.rpcHandle) {
		// Edge: registration never installed the handle (or a full shutdown
		// removed it) — install it once, idempotently.
		installCrossExtensionWiring(pi, ctx);
		return;
	}
	void import("../team-tool.ts").then(({ installCrewGlobalRegistry }) => {
		installCrewGlobalRegistry({
			manifestCache: ctx.getManifestCache(ctx.currentCtx?.cwd ?? process.cwd()),
			cwdProvider: () => ctx.currentCtx?.cwd ?? process.cwd(),
		});
	});
}
