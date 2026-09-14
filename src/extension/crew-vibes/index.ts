import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logInternalError } from "../../utils/internal-error.ts";

/**
 * Wrap a pi UI call in try/catch. If the call throws (e.g. theme helper
 * returns undefined or pi's API signature changed), log it and silently fall
 * back to pi's default behavior. Crew-vibes must NEVER break the user's
 * session.
 */
function safeUiCall(scope: string, fn: () => void): void {
	try {
		fn();
	} catch (error) {
		logInternalError(`crew-vibes.${scope}`, error, undefined, "warn");
	}
}

import { type CrewVibesConfig, loadConfig, saveConfig } from "./config.ts";
import { clearProviderUsageCache, fetchProviderUsage, type ProviderUsage } from "./provider-usage.ts";
import { asCrewTheme, clearVibesStatus, renderProviderUsage, setProviderStatus } from "./render.ts";

export const CREW_VIBES_STATUS_KEY = "pi-crew-vibes";

/**
 * crew-vibes — provider rate-limit quota publisher.
 *
 * Maintainer decisions 2026-09-13/14 (UI review follow-ups) stripped this
 * module down to its one remaining job: fetching the current provider's
 * rate-limit usage and publishing it as a STATUS entry on pi's NATIVE
 * footer. Removed entirely: the custom footer replacement (it had drifted
 * from native) and the tok/s speed UI (custom spinner + "Working N tok/s")
 * — pi's built-ins are always used.
 */
export function registerCrewVibes(pi: ExtensionAPI): void {
	let config: CrewVibesConfig = loadConfig();
	let providerTimer: ReturnType<typeof setInterval> | undefined;
	let lastProviderUsage: ProviderUsage | null = null;
	let currentProvider: string | undefined;

	function themeOf(ctx: ExtensionContext) {
		return asCrewTheme(ctx.hasUI ? ctx.ui.theme : undefined);
	}

	/** Publish the provider rate-limit quota as a STATUS entry (joined into
	 * pi's NATIVE footer status line; right-truncates on very narrow
	 * terminals — pi's documented behavior, accepted). */
	function publishQuotaStatus(ctx: ExtensionContext): void {
		safeUiCall("publish-quota-status", () =>
			setProviderStatus(ctx, config, lastProviderUsage ? renderProviderUsage(themeOf(ctx), lastProviderUsage) : undefined),
		);
	}

	function stopProviderTimer(): void {
		if (!providerTimer) return;
		clearInterval(providerTimer);
		providerTimer = undefined;
	}

	/** Fetch provider usage for currentProvider and publish the quota status.
	 *  Called on start, on each timer tick, and immediately when the
	 *  provider changes (model_select) so the quota reflects the new
	 *  provider without waiting for the next tick. */
	async function fetchProviderAndRefresh(ctx: ExtensionContext): Promise<void> {
		if (!config.enabled || !config.capacity.providerUsage) {
			lastProviderUsage = null;
			publishQuotaStatus(ctx);
			return;
		}
		try {
			lastProviderUsage = await fetchProviderUsage(config.capacity.providerRefreshMs, currentProvider);
		} catch {
			// Never crash on provider fetch failure
			lastProviderUsage = null;
		}
		publishQuotaStatus(ctx);
	}

	function startProviderTimer(ctx: ExtensionContext): void {
		if (providerTimer) return;
		if (!config.capacity.providerUsage) return;
		const interval = Math.max(10000, config.capacity.providerRefreshMs);

		fetchProviderAndRefresh(ctx); // Fetch immediately on start
		providerTimer = setInterval(() => fetchProviderAndRefresh(ctx), interval);
		providerTimer.unref?.();
	}

	function applyConfig(ctx: ExtensionContext): void {
		saveConfig(config);
		if (!config.enabled) {
			stopProviderTimer();
			clearVibesStatus(ctx);
			return;
		}
		if (config.capacity.providerUsage) startProviderTimer(ctx);
		else publishQuotaStatus(ctx); // clears the stale status when disabled
	}

	pi.on("session_start", (_event, ctx) => {
		stopProviderTimer();
		config = loadConfig();
		clearProviderUsageCache();
		// Initialize provider from current model — model_select only fires on manual switch
		currentProvider = (ctx.model as { provider?: string } | undefined)?.provider;
		if (!config.enabled) {
			clearVibesStatus(ctx);
			return;
		}
		startProviderTimer(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		currentProvider = (event as { model?: { provider?: string } }).model?.provider;
		clearProviderUsageCache();
		// Fetch immediately so the quota reflects the new provider without
		// waiting for the next timer tick.
		fetchProviderAndRefresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopProviderTimer();
		clearVibesStatus(ctx);
	});

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [first] = args.trim().split(/\s+/).filter(Boolean);

		if (!first) {
			const quota = lastProviderUsage
				? `${lastProviderUsage.providerName} 5h ${Math.round(lastProviderUsage.fiveHourPercent)}% · Wk ${Math.round(lastProviderUsage.weeklyPercent)}%`
				: "no data yet";
			ctx.ui.notify(`crew-vibes: ${config.enabled ? "on" : "off"} · quota ${quota}`, "info");
			return;
		}

		if (first === "on" || first === "off") {
			config = { ...config, enabled: first === "on" };
			applyConfig(ctx);
			ctx.ui.notify(`crew-vibes ${first === "on" ? "enabled" : "disabled"}`, "info");
			return;
		}

		ctx.ui.notify("Usage: /team-vibes [on|off]", "error");
	}

	pi.registerCommand("team-vibes", {
		description: "Toggle the provider-quota status (on/off)",
		handler: handleCommand,
	});
}
