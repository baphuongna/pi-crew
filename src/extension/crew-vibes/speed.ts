import type { SpeedConfig } from "./config.ts";

/**
 * Token-speed engine ported from pi-speeed (MIT, attribution in NOTICE.md).
 * Tracks output tok/s with a sliding window and suppresses unreliable
 * burst-only readings. No stats/font handling — just the live + session avg.
 */

export type TokenEvent = { time: number; tokens: number };

const COMPACTION_THRESHOLD = 5000;

export type EngineConfig = Pick<
	SpeedConfig,
	"slidingWindowMs" | "minReliableDurationMs" | "maxDisplayTokS"
>;

export function estimateTokensFromDelta(text: string): number {
	if (!text) return 0;
	const matches = text.match(/\w+|[^\s\w]/g);
	return matches ? matches.length : 0;
}

export class TokenSpeedEngine {
	private _isStreaming = false;
	private _tokenCount = 0;
	private _startTime = 0;
	private _endTime = 0;
	private _events: TokenEvent[] = [];
	private _windowStartIndex = 0;
	private _lastStableTokS = 0;
	private _config: EngineConfig;

	constructor(config: EngineConfig) {
		this._config = config;
	}

	updateConfig(config: EngineConfig): void {
		this._config = config;
	}

	get isStreaming(): boolean {
		return this._isStreaming;
	}

	get tokenCount(): number {
		return this._tokenCount;
	}

	get elapsedMs(): number {
		if (this._startTime === 0) return 0;
		return this._isStreaming ? Date.now() - this._startTime : this._endTime - this._startTime;
	}

	get avgTokS(): number {
		const elapsedSec = this.elapsedMs / 1000;
		if (elapsedSec <= 0) return 0;
		return this._tokenCount / elapsedSec;
	}

	sanitizeTokS(value: number | null, durationMs = this.elapsedMs): number | null {
		if (value === null || !Number.isFinite(value) || value <= 0) return null;
		if (durationMs < this._config.minReliableDurationMs) return null;
		if (value > this._config.maxDisplayTokS) return null;
		return value;
	}

	get tokS(): number {
		const candidate = this.rawTokS;
		const stable = this.sanitizeTokS(candidate);
		if (stable !== null) this._lastStableTokS = stable;
		return this._lastStableTokS;
	}

	get rawTokS(): number {
		if (this.elapsedMs < this._config.slidingWindowMs) return this.avgTokS;
		if (!this._isStreaming) return this.avgTokS;

		const now = Date.now();
		const windowStart = now - this._config.slidingWindowMs;

		while (this._windowStartIndex < this._events.length && this._events[this._windowStartIndex].time < windowStart) {
			this._windowStartIndex++;
		}

		if (this._windowStartIndex >= this._events.length) return this.avgTokS;

		let windowTokenCount = 0;
		for (let i = this._windowStartIndex; i < this._events.length; i++) {
			windowTokenCount += this._events[i].tokens;
		}
		if (windowTokenCount === 0) return this.avgTokS;

		const windowDuration = (now - this._events[this._windowStartIndex].time) / 1000;
		if (windowDuration <= 0) return 0;

		return windowTokenCount / windowDuration;
	}

	start(): void {
		this._tokenCount = 0;
		this._isStreaming = true;
		this._startTime = Date.now();
		this._endTime = this._startTime;
		this._events = [];
		this._windowStartIndex = 0;
		this._lastStableTokS = 0;
	}

	stop(): void {
		this._isStreaming = false;
		this._endTime = Date.now();
		this._events = [];
		this._windowStartIndex = 0;
	}

	recordDelta(delta: string, usageOutput?: number): void {
		if (!this._isStreaming) return;
		if (usageOutput !== undefined && usageOutput > 0) {
			this.recordTokens(usageOutput);
			return;
		}
		this.recordTokens(estimateTokensFromDelta(delta));
	}

	reconcileTotal(tokens: number): void {
		if (tokens > 0) this._tokenCount = tokens;
	}

	recordTokens(tokens: number): void {
		if (!this._isStreaming || tokens <= 0) return;
		this._tokenCount += tokens;
		this._events.push({ time: Date.now(), tokens });
		if (this._windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
	}

	private compact(): void {
		if (this._windowStartIndex === 0) return;
		this._events = this._events.slice(this._windowStartIndex);
		this._windowStartIndex = 0;
	}
}

export type CompletedMessageSpeed = {
	outputTokens: number;
	durationMs: number;
	tokS: number | null;
};

function isSuccessfulStop(stopReason: string | undefined): boolean {
	return stopReason !== "error" && stopReason !== "aborted";
}

export class SpeedTracker {
	private readonly engine: TokenSpeedEngine;
	private lastStableTokS: number | null = null;
	private sessionOutputTokens = 0;
	private sessionDurationMs = 0;

	constructor(config: SpeedConfig) {
		this.engine = new TokenSpeedEngine(config);
	}

	updateConfig(config: SpeedConfig): void {
		this.engine.updateConfig(config);
	}

	get isStreaming(): boolean {
		return this.engine.isStreaming;
	}

	get lastTokS(): number | null {
		return this.lastStableTokS;
	}

	resetSession(): void {
		this.sessionOutputTokens = 0;
		this.sessionDurationMs = 0;
	}

	startMessage(): void {
		this.engine.start();
	}

	recordDelta(delta: string, usageOutput?: number): void {
		this.engine.recordDelta(delta, usageOutput);
	}

	stopMessage(): void {
		if (this.engine.isStreaming) this.engine.stop();
	}

	liveTokS(): number | null {
		const speed = this.engine.tokS;
		return speed > 0 ? speed : this.lastStableTokS;
	}

	sessionAvgTokS(): number | null {
		return this.sessionDurationMs > 0 ? this.sessionOutputTokens / (this.sessionDurationMs / 1000) : null;
	}

	finishMessage(outputTokens: number, stopReason: string | undefined): CompletedMessageSpeed | null {
		if (!this.engine.isStreaming) return null;

		this.engine.reconcileTotal(outputTokens);
		const durationMs = this.engine.elapsedMs;
		const tokens = this.engine.tokenCount;
		const rawAvgTokS = durationMs > 0 ? tokens / (durationMs / 1000) : null;
		const tokS = this.engine.sanitizeTokS(rawAvgTokS, durationMs);
		this.lastStableTokS = tokS;
		this.engine.stop();

		if (tokS !== null && isSuccessfulStop(stopReason)) {
			this.sessionOutputTokens += tokens;
			this.sessionDurationMs += durationMs;
		}

		return { outputTokens: tokens, durationMs, tokS };
	}
}

export class SpeedAnimator {
	private from: number | null = null;
	private target: number | null = null;
	private startedAt = 0;
	private durationMs: number;

	constructor(durationMs: number) {
		this.durationMs = durationMs;
	}

	updateDuration(durationMs: number): void {
		this.durationMs = durationMs;
	}

	reset(value: number | null = null, now = Date.now()): void {
		this.from = value;
		this.target = value;
		this.startedAt = now;
	}

	setTarget(target: number | null, now = Date.now()): number | null {
		if (target === null) {
			this.reset(null, now);
			return null;
		}

		const current = this.value(now);
		if (current === null) {
			this.reset(target, now);
			return target;
		}

		if (this.target !== null && Math.abs(target - this.target) < 0.05) return current;

		this.from = current;
		this.target = target;
		this.startedAt = now;
		return current;
	}

	value(now = Date.now()): number | null {
		if (this.target === null) return null;
		if (this.from === null || this.durationMs <= 0) return this.target;

		const progress = Math.max(0, Math.min(1, (now - this.startedAt) / this.durationMs));
		if (progress >= 1) {
			this.from = this.target;
			return this.target;
		}

		return this.from + (this.target - this.from) * progress;
	}

	isAnimating(now = Date.now()): boolean {
		return (
			this.target !== null &&
			this.from !== null &&
			Math.abs(this.target - this.from) >= 0.05 &&
			now - this.startedAt < this.durationMs
		);
	}
}
