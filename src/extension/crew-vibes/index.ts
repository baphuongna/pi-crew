import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestRender, setFooter } from "../../ui/pi-ui-compat.ts";
import { logInternalError } from "../../utils/internal-error.ts";

/**
 * Wrap a pi UI call in try/catch. If the call throws (e.g. terminal doesn't
 * support PUA glyphs, theme helper returns undefined, or pi's API signature
 * changed), log it and silently fall back to pi's default behavior — which
 * is simply "do nothing", letting pi show its own built-in indicator.
 *
 * Crew-vibes must NEVER break the user's session. A broken spinner is not
 * worth a crashed pi.
 */
function safeUiCall(scope: string, fn: () => void): void {
	try {
		fn();
	} catch (error) {
		logInternalError(`crew-vibes.${scope}`, error, undefined, "warn");
	}
}

import { type CrewVibesConfig, loadConfig, saveConfig } from "./config.ts";
import { intervalForSpeed } from "./figures.ts";
import { type CrewVibesFooterSource, createCrewVibesFooter } from "./footer.ts";
import { clearProviderUsageCache, fetchProviderUsage, type ProviderUsage } from "./provider-usage.ts";
import {
	asCrewTheme,
	clearVibesStatus,
	crewIndicatorFrames,
	formatSpeed,
	getCapacityUsage,
	renderSpeedFooter,
	renderWorkingMessage,
	setSpeedStatus,
} from "./render.ts";
import { SpeedAnimator, SpeedTracker } from "./speed.ts";

export const CREW_VIBES_STATUS_KEY = "pi-crew-vibes";

function isAssistantMessage(message: unknown): boolean {
	return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

function assistantUsageOutput(message: unknown): number | undefined {
	const usage = (message as { usage?: { output?: unknown } }).usage;
	const output = usage?.output;
	return typeof output === "number" && Number.isFinite(output) ? output : undefined;
}

function assistantStopReason(message: unknown): string | undefined {
	const reason = (message as { stopReason?: unknown }).stopReason;
	return typeof reason === "string" ? reason : undefined;
}

function assistantEventType(event: unknown): string | undefined {
	return typeof (event as { type?: string }).type === "string" ? (event as { type: string }).type : undefined;
}

export function registerCrewVibes(pi: ExtensionAPI): void {
	let config: CrewVibesConfig = loadConfig();
	let lastRenderedAt = 0;
	let currentIntervalMs = 0;
	const speedTracker = new SpeedTracker(config.speed);
	const footerAnimator = new SpeedAnimator(config.speed.renderIntervalMs);
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let footerTimer: ReturnType<typeof setInterval> | undefined;
	let capacityTimer: ReturnType<typeof setInterval> | undefined;
	let providerTimer: ReturnType<typeof setInterval> | undefined;
	let lastProviderUsage: ProviderUsage | null = null;
	let currentProvider: string | undefined;
	let currentThinkingLevel: string | undefined;

	function themeOf(ctx: ExtensionContext) {
		return asCrewTheme(ctx.hasUI ? ctx.ui.theme : undefined);
	}

	const footerSource: CrewVibesFooterSource = {
		getConfig: () => config,
		getQuotaUsage: () => lastProviderUsage,
		getThinkingLevel: () => currentThinkingLevel,
	};

	/** Whether the custom footer has crew-vibes meters to add on top of pi's stats. */
	function metersActive(): boolean {
		return config.enabled && (config.capacity.enabled || config.capacity.providerUsage);
	}

	/** Install our custom footer, or restore pi's built-in footer when idle.
	 * Unlike setStatus (joined + right-truncated), the footer's render(width)
	 * gets the real width and owns line layout, so the quota is never chopped. */
	function installFooter(ctx: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		if (!metersActive()) {
			safeUiCall("clear-footer", () => setFooter(ctx, undefined));
			return;
		}
		safeUiCall("install-footer", () => {
			setFooter(ctx, (tui, theme, footerData) => createCrewVibesFooter({ tui, theme, footerData, ctx, source: footerSource }));
			requestRender(ctx);
		});
	}

	/** Trigger a footer repaint; the footer recomputes capacity/quota on render. */
	function refreshFooter(ctx: ExtensionContext): void {
		if (ctx?.hasUI) safeUiCall("refresh-footer", () => requestRender(ctx));
	}

	function publishSpeedFooter(ctx: ExtensionContext, speed = footerAnimator.value()): void {
		if (!config.enabled || !config.speed.enabled || !config.speed.footer) {
			safeUiCall("clear-speed-status", () => setSpeedStatus(ctx, config, undefined));
			return;
		}
		safeUiCall("publish-speed-status", () => setSpeedStatus(ctx, config, renderSpeedFooter(themeOf(ctx), config.speed, speed)));
	}

	function applyIndicator(ctx: ExtensionContext, speed: number | null, force = false): void {
		if (!ctx.hasUI || !ctx.ui.setWorkingIndicator) return;
		if (!config.enabled || !config.speed.enabled || !config.speed.indicator) {
			safeUiCall("reset-indicator", () => ctx.ui.setWorkingIndicator?.());
			return;
		}
		const next = intervalForSpeed(config.speed, speed);
		if (!force && Math.abs(next - currentIntervalMs) < 10) return;
		safeUiCall("set-indicator", () =>
			ctx.ui.setWorkingIndicator?.({
				frames: crewIndicatorFrames(themeOf(ctx)),
				intervalMs: next,
			}),
		);
		currentIntervalMs = next;
	}

	function renderWorking(ctx: ExtensionContext, speed: number | null): void {
		if (!config.enabled || !config.speed.enabled || !ctx.hasUI) return;
		safeUiCall("set-working-message", () => ctx.ui.setWorkingMessage?.(renderWorkingMessage(themeOf(ctx), config.speed, speed)));
	}

	function stopLiveTimer(): void {
		if (!liveTimer) return;
		clearInterval(liveTimer);
		liveTimer = undefined;
	}

	function stopFooterTimer(): void {
		if (!footerTimer) return;
		clearInterval(footerTimer);
		footerTimer = undefined;
	}

	function stopCapacityTimer(): void {
		if (!capacityTimer) return;
		clearInterval(capacityTimer);
		capacityTimer = undefined;
	}

	function stopProviderTimer(): void {
		if (!providerTimer) return;
		clearInterval(providerTimer);
		providerTimer = undefined;
	}

	function startLiveTimer(ctx: ExtensionContext): void {
		if (liveTimer || !ctx.hasUI) return;
		liveTimer = setInterval(() => {
			if (!config.enabled || !config.speed.enabled || !speedTracker.isStreaming) {
				stopLiveTimer();
				return;
			}
			const speed = speedTracker.liveTokS();
			applyIndicator(ctx, speed);
			renderWorking(ctx, speed);
		}, config.speed.renderIntervalMs);
		liveTimer.unref?.();
	}

	function startFooterTimer(ctx: ExtensionContext): void {
		if (footerTimer || !ctx.hasUI) return;
		footerTimer = setInterval(() => {
			if (!config.enabled || !config.speed.enabled) {
				stopFooterTimer();
				return;
			}
			publishSpeedFooter(ctx);
			if (!footerAnimator.isAnimating()) stopFooterTimer();
		}, config.speed.renderIntervalMs);
		footerTimer.unref?.();
	}

	function startCapacityTimer(ctx: ExtensionContext): void {
		if (capacityTimer) return;
		const interval = Math.max(250, config.capacity.refreshIntervalMs);
		capacityTimer = setInterval(() => refreshFooter(ctx), interval);
		capacityTimer.unref?.();
	}

	/** Fetch provider usage for currentProvider and refresh the footer.
	 *  Called on start, on each timer tick, and immediately when the
	 *  provider changes (model_select) so the quota reflects the new
	 *  provider without waiting for the next 5-minute tick. */
	async function fetchProviderAndRefresh(ctx: ExtensionContext): Promise<void> {
		if (!config.enabled || !config.capacity.providerUsage) {
			lastProviderUsage = null;
			refreshFooter(ctx);
			return;
		}
		try {
			lastProviderUsage = await fetchProviderUsage(config.capacity.providerRefreshMs, currentProvider);
		} catch {
			// Never crash on provider fetch failure
			lastProviderUsage = null;
		}
		refreshFooter(ctx);
	}

	function startProviderTimer(ctx: ExtensionContext): void {
		if (providerTimer) return;
		if (!config.capacity.providerUsage) return;
		const interval = Math.max(10000, config.capacity.providerRefreshMs);

		fetchProviderAndRefresh(ctx); // Fetch immediately on start
		providerTimer = setInterval(() => fetchProviderAndRefresh(ctx), interval);
		providerTimer.unref?.();
	}

	function resetWorking(ctx: ExtensionContext): void {
		applyIndicator(ctx, null, true);
		renderWorking(ctx, speedTracker.lastTokS);
	}

	function applyConfig(ctx: ExtensionContext): void {
		saveConfig(config);
		speedTracker.updateConfig(config.speed);
		footerAnimator.updateDuration(config.speed.renderIntervalMs);
		if (!config.enabled) {
			stopLiveTimer();
			stopFooterTimer();
			stopCapacityTimer();
			stopProviderTimer();
			setFooter(ctx, undefined);
			clearVibesStatus(ctx);
			return;
		}
		installFooter(ctx);
		publishSpeedFooter(ctx);
		startCapacityTimer(ctx);
		if (config.capacity.providerUsage) startProviderTimer(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		stopLiveTimer();
		stopFooterTimer();
		stopCapacityTimer();
		stopProviderTimer();
		config = loadConfig();
		speedTracker.updateConfig(config.speed);
		footerAnimator.updateDuration(config.speed.renderIntervalMs);
		speedTracker.resetSession();
		footerAnimator.reset(null);
		clearProviderUsageCache();
		// Initialize provider from current model — model_select only fires on manual switch
		currentProvider = (ctx.model as { provider?: string } | undefined)?.provider;
		currentThinkingLevel = undefined;
		if (!config.enabled) {
			setFooter(ctx, undefined);
			clearVibesStatus(ctx);
			return;
		}
		installFooter(ctx);
		publishSpeedFooter(ctx);
		startCapacityTimer(ctx);
		startProviderTimer(ctx);
		// Set the working indicator early (matches pi's official working-indicator
		// example) so pi has the custom frames configured before streaming begins.
		// Calls before the loading animation exists are ignored, so we re-apply on
		// agent_start/message_update as well.
		applyIndicator(ctx, null, true);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!config.enabled) return;
		resetWorking(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!config.enabled) return;
		resetWorking(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (!config.enabled || !config.speed.enabled || !isAssistantMessage(event.message)) return;
		speedTracker.startMessage();
		footerAnimator.reset(speedTracker.lastTokS);
		startLiveTimer(ctx);
		lastRenderedAt = 0;
	});

	pi.on("message_update", (event, ctx) => {
		if (!config.enabled || !config.speed.enabled || !isAssistantMessage(event.message) || !speedTracker.isStreaming) return;

		const ev = event.assistantMessageEvent;
		const type = assistantEventType(ev);
		if (type === "text_delta" || type === "thinking_delta") {
			const delta = (ev as { delta?: string }).delta ?? "";
			speedTracker.recordDelta(delta, assistantUsageOutput(event.message));
		}
		if (type === "start") resetWorking(ctx);

		const now = Date.now();
		if (now - lastRenderedAt < config.speed.renderIntervalMs && type !== "done") return;
		lastRenderedAt = now;

		const speed = speedTracker.liveTokS();
		applyIndicator(ctx, speed);
		renderWorking(ctx, speed);
	});

	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		refreshFooter(ctx);
		if (!config.enabled || !config.speed.enabled || !speedTracker.isStreaming) return;

		const completed = speedTracker.finishMessage(assistantUsageOutput(event.message) ?? 0, assistantStopReason(event.message));
		if (!completed) return;

		footerAnimator.setTarget(speedTracker.sessionAvgTokS());
		publishSpeedFooter(ctx);
		startFooterTimer(ctx);
		applyIndicator(ctx, speedTracker.lastTokS);
	});

	pi.on("turn_end", () => {
		speedTracker.stopMessage();
		stopLiveTimer();
	});

	pi.on("agent_end", (_event, ctx) => {
		speedTracker.stopMessage();
		stopLiveTimer();
		if (ctx && config.enabled && ctx.hasUI) {
			applyIndicator(ctx, speedTracker.lastTokS);
			safeUiCall("clear-working-message", () => ctx.ui.setWorkingMessage?.());
		}
	});

	pi.on("model_select", (event, ctx) => {
		currentProvider = (event as { model?: { provider?: string } }).model?.provider;
		clearProviderUsageCache();
		// Fetch immediately so the quota reflects the new provider without
		// waiting for the next 5-minute timer tick.
		fetchProviderAndRefresh(ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		currentThinkingLevel = (event as { level?: unknown }).level as string | undefined;
		refreshFooter(ctx);
	});
	pi.on("session_compact", (_event, ctx) => refreshFooter(ctx));
	pi.on("session_tree", (_event, ctx) => refreshFooter(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		stopLiveTimer();
		stopFooterTimer();
		stopCapacityTimer();
		stopProviderTimer();
		setFooter(ctx, undefined);
		clearVibesStatus(ctx);
	});

	async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		const [first, second] = tokens;

		const mutate = (next: CrewVibesConfig): void => {
			config = next;
			applyConfig(ctx);
		};

		if (!first) {
			const speed = speedTracker.liveTokS();
			const usage = getCapacityUsage(ctx);
			const stage = config.capacity.icons.length
				? config.capacity.labels[
						Math.max(
							0,
							Math.min(
								config.capacity.labels.length - 1,
								Math.floor(((usage.percent ?? 0) / 100) * config.capacity.labels.length),
							),
						)
					]
				: "?";
			ctx.ui.notify(
				`crew-vibes: ${config.enabled ? "on" : "off"} · speed ${config.speed.enabled ? "on" : "off"} (${formatSpeed(config.speed, speed)}) · capacity ${config.capacity.enabled ? "on" : "off"} (${stage})`,
				"info",
			);
			return;
		}

		if (first === "on" || first === "off") {
			mutate({ ...config, enabled: first === "on" });
			ctx.ui.notify(`crew-vibes ${first === "on" ? "enabled" : "disabled"}`, "info");
			return;
		}

		if (first === "speed" && (second === "on" || second === "off")) {
			mutate({ ...config, speed: { ...config.speed, enabled: second === "on" } });
			ctx.ui.notify(`crew-vibes speed ${second === "on" ? "enabled" : "disabled"}`, "info");
			return;
		}

		if (first === "capacity" && (second === "on" || second === "off")) {
			mutate({ ...config, capacity: { ...config.capacity, enabled: second === "on" } });
			ctx.ui.notify(`crew-vibes capacity ${second === "on" ? "enabled" : "disabled"}`, "info");
			return;
		}

		ctx.ui.notify("Usage: /team-vibes [on|off|speed on|off|capacity on|off]", "error");
	}

	pi.registerCommand("team-vibes", {
		description: "Toggle crew-vibes speed + context meters (on/off, speed, capacity)",
		handler: handleCommand,
	});
}
