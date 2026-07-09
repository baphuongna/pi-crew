import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CrewVibesConfig, loadConfig, PROVIDER_STATUS_ID, saveConfig } from "./config.ts";
import { intervalForSpeed } from "./figures.ts";
import { clearProviderUsageCache, fetchProviderUsage, providerSupportsQuota } from "./provider-usage.ts";
import {
	asCrewTheme,
	clearVibesStatus,
	crewIndicatorFrames,
	formatSpeed,
	getCapacityUsage,
	renderCapacity,
	renderProviderUsage,
	renderSpeedFooter,
	renderWorkingMessage,
	setCrewVibesWidget,
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
	let lastProviderText: string | undefined;
	let lastCapacityText: string | undefined;
	let currentProvider: string | undefined;

	// B7-adjacent: auto-detect provider from model name when ctx.model.provider
	// is missing (common during sub-agent runs where no model_select fires).
	function detectProviderFromModel(model?: { name?: string; provider?: string }): string | undefined {
		// Prefer explicit provider if available.
		if (model?.provider) return model.provider;
		// Infer from model name patterns.
		const name = (model?.name ?? "").toLowerCase();
		if (name.includes("claude") || name.includes("anthropic")) return "anthropic";
		if (name.includes("copilot") || name.includes("github")) return "github-copilot";
		if (name.includes("minimax")) return "minimax";
		if (name.includes("z-ai") || name.includes("zai")) return "zai";
		return undefined;
	}

	/** Try to refresh currentProvider from ctx.model — called on every turn/message
	 * so sub-agent runs that change the model stay in sync. */
	function refreshProvider(ctx: ExtensionContext): void {
		const detected = detectProviderFromModel(ctx.model as { name?: string; provider?: string } | undefined);
		if (detected && detected !== currentProvider) {
			currentProvider = detected;
			clearProviderUsageCache();
		}
	}

	/** Strip ANSI codes to measure visible width. */
	function visibleLen(text: string): number {
		return text.replace(/\u001b\[[0-9;]*m/g, "").length;
	}

	function themeOf(ctx: ExtensionContext) {
		return asCrewTheme(ctx.hasUI ? ctx.ui.theme : undefined);
	}

	function publishCapacity(ctx: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		if (!config.enabled || !config.capacity.enabled) {
			lastCapacityText = undefined;
			publishBoth(ctx);
			return;
		}
		lastCapacityText = renderCapacity(themeOf(ctx), config.capacity, getCapacityUsage(ctx));
		publishBoth(ctx);
	}

	/** Publish provider quota. Currently a no-op since both lines are pushed
	 * together in publishBoth() — kept as a hook so the provider timer can
	 * trigger a refresh without waiting for the next capacity tick. */
	function publishProviderQuota(ctx: ExtensionContext): void {
		publishBoth(ctx);
	}

	/** Push capacity + provider quota as a 2-line widget. setWidget uses
	 * `wrapTextWithAnsi` per line (no truncate, no "..."), so each line
	 * keeps its full content regardless of terminal width. */
	function publishBoth(ctx: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		if (!config.enabled) {
			setCrewVibesWidget(ctx, config, undefined, undefined);
			return;
		}
		const capText = config.capacity.enabled ? lastCapacityText : undefined;
		const quotaText = config.capacity.providerUsage ? lastProviderText : undefined;
		setCrewVibesWidget(ctx, config, capText, quotaText);
	}

	function publishSpeedFooter(ctx: ExtensionContext, speed = footerAnimator.value()): void {
		if (!config.enabled || !config.speed.enabled || !config.speed.footer) {
			setSpeedStatus(ctx, config, undefined);
			return;
		}
		setSpeedStatus(ctx, config, renderSpeedFooter(themeOf(ctx), config.speed, speed));
	}

	function applyIndicator(ctx: ExtensionContext, speed: number | null, force = false): void {
		if (!ctx.hasUI || !ctx.ui.setWorkingIndicator) return;
		if (!config.enabled || !config.speed.enabled || !config.speed.indicator) {
			ctx.ui.setWorkingIndicator();
			return;
		}
		const next = intervalForSpeed(config.speed, speed);
		if (!force && Math.abs(next - currentIntervalMs) < 10) return;
		ctx.ui.setWorkingIndicator({
			frames: crewIndicatorFrames(themeOf(ctx)),
			intervalMs: next,
		});
		currentIntervalMs = next;
	}

	function renderWorking(ctx: ExtensionContext, speed: number | null): void {
		if (!config.enabled || !config.speed.enabled || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(renderWorkingMessage(themeOf(ctx), config.speed, speed));
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
		capacityTimer = setInterval(() => publishCapacity(ctx), interval);
		capacityTimer.unref?.();
	}

	function startProviderTimer(ctx: ExtensionContext): void {
		if (providerTimer) return;
		if (!config.capacity.providerUsage) return;
		const interval = Math.max(10000, config.capacity.providerRefreshMs);

		async function tick(): Promise<void> {
			if (!config.enabled || !config.capacity.providerUsage) {
				stopProviderTimer();
				return;
			}
			try {
				const usage = await fetchProviderUsage(config.capacity.providerRefreshMs, currentProvider);
				lastProviderText = renderProviderUsage(themeOf(ctx), usage);
				publishProviderQuota(ctx);
			} catch {
				// Never crash on provider fetch failure
				lastProviderText = undefined;
				publishProviderQuota(ctx);
			}
		}

		tick(); // Fetch immediately on start
		providerTimer = setInterval(tick, interval);
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
			clearVibesStatus(ctx);
			return;
		}
		publishCapacity(ctx);
		publishProviderQuota(ctx);
		publishSpeedFooter(ctx);
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
		currentProvider = detectProviderFromModel(ctx.model as { name?: string; provider?: string } | undefined);
		if (!config.enabled) {
			clearVibesStatus(ctx);
			return;
		}
		publishCapacity(ctx);
		publishProviderQuota(ctx);
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
		refreshProvider(ctx);
		resetWorking(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!config.enabled) return;
		refreshProvider(ctx);
		resetWorking(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		refreshProvider(ctx);
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
		publishCapacity(ctx);
		publishProviderQuota(ctx);
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
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on("model_select", (event, ctx) => {
		currentProvider = detectProviderFromModel((event as { model?: { name?: string; provider?: string } }).model);
		clearProviderUsageCache();
		publishCapacity(ctx);
		publishProviderQuota(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		publishCapacity(ctx);
		publishProviderQuota(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		publishCapacity(ctx);
		publishProviderQuota(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopLiveTimer();
		stopFooterTimer();
		stopCapacityTimer();
		stopProviderTimer();
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
