/**
 * Cross-extension wiring helper.
 *
 * Two small wires:
 *   • wireRpc — the in-process pi-crew RPC handle (other modules in
 *     the same extension can subscribe via `pi.events`).
 *   • wireGlobalRegistry — the cross-extension crew global registry,
 *     lazily loaded from team-tool.ts (heavy module) and installed under
 *     `globalThis[Symbol.for("pi-crew:registry")]` so peer extensions
 *     (e.g., pi-subagents3) can discover pi-crew at runtime.
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

	// Install the cross-extension crew global registry. Lazy import keeps
	// team-tool.ts (which pulls in the entire runtime chain) out of the
	// cold-start module graph.
	void import("../team-tool.ts").then(({ installCrewGlobalRegistry }) => {
		const manifestCacheForRegistry = ctx.getManifestCache(ctx.currentCtx?.cwd ?? process.cwd());
		installCrewGlobalRegistry({
			manifestCache: manifestCacheForRegistry,
			cwdProvider: () => ctx.currentCtx?.cwd ?? process.cwd(),
		});
	});
}
