import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type CrewVibesConfig, loadConfig, saveConfig } from "./config.ts";
import { intervalForSpeed } from "./figures.ts";
import {
	asCrewTheme,
	clearVibesStatus,
	crewIndicatorFrames,
	formatSpeed,
	getCapacityUsage,
	renderCapacity,
	renderSpeedFooter,
	renderWorkingMessage,
	setCapacityStatus,
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

	function themeOf(ctx: ExtensionContext) {
		return asCrewTheme(ctx.hasUI ? ctx.ui.theme : undefined);
	}

	function publishCapacity(ctx: ExtensionContext): void {
		if (!ctx || !ctx.hasUI) return;
		if (!config.enabled || !config.capacity.enabled) {
			setCapacityStatus(ctx, config, undefined);
			return;
		}
		const text = renderCapacity(themeOf(ctx), config.capacity, getCapacityUsage(ctx));
		setCapacityStatus(ctx, config, text);
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
			clearVibesStatus(ctx);
			return;
		}
		publishCapacity(ctx);
		publishSpeedFooter(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		stopLiveTimer();
		stopFooterTimer();
		stopCapacityTimer();
		config = loadConfig();
		speedTracker.updateConfig(config.speed);
		footerAnimator.updateDuration(config.speed.renderIntervalMs);
		speedTracker.resetSession();
		footerAnimator.reset(null);
		if (!config.enabled) {
			clearVibesStatus(ctx);
			return;
		}
		publishCapacity(ctx);
		publishSpeedFooter(ctx);
		startCapacityTimer(ctx);
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
		publishCapacity(ctx);
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
		if (!ctx || !config.enabled || !ctx.hasUI) return;
		applyIndicator(ctx, speedTracker.lastTokS);
		ctx.ui.setWorkingMessage();
	});

	pi.on("model_select", (_event, ctx) => publishCapacity(ctx));
	pi.on("session_compact", (_event, ctx) => publishCapacity(ctx));
	pi.on("session_tree", (_event, ctx) => publishCapacity(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		stopLiveTimer();
		stopFooterTimer();
		stopCapacityTimer();
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
						Math.max(0, Math.min(config.capacity.labels.length - 1, Math.floor(((usage.percent ?? 0) / 100) * config.capacity.labels.length)))
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

		ctx.ui.notify(
			"Usage: /team-vibes [on|off|speed on|off|capacity on|off]",
			"error",
		);
	}

	pi.registerCommand("team-vibes", {
		description: "Toggle crew-vibes speed + context meters (on/off, speed, capacity)",
		handler: handleCommand,
	});
}
