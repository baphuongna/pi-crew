import { pad, truncate } from "../utils/visual.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";

export interface BorderedLoaderOptions {
	message: string;
	cancellable?: boolean;
	frames?: string[];
	intervalMs?: number;
	minWidth?: number;
	onAbort?: () => void;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class CrewBorderedLoader {
	private readonly abortController = new AbortController();
	private readonly frameOptions: string[];
	private readonly intervalMs: number;
	private readonly minWidth: number;
	private readonly onAbort?: () => void;
	private theme: CrewTheme;
	private message: string;
	private lineCache = "";
	private width = 0;
	private startedAt = Date.now();

	constructor(_ui: unknown, themeLike: unknown, options: BorderedLoaderOptions) {
		const theme = asCrewTheme(themeLike);
		this.theme = theme;
		this.message = options.message;
		this.minWidth = Math.max(12, options.minWidth ?? 24);
		this.onAbort = options.onAbort;
		this.frameOptions = options.frames ?? DEFAULT_FRAMES;
		this.intervalMs = Math.max(40, options.intervalMs ?? 120);
	}

	private spinnerFrame(): string {
		if (this.frameOptions.length === 0) return "•";
		const elapsed = Date.now() - this.startedAt;
		const index = Math.floor(elapsed / this.intervalMs) % this.frameOptions.length;
		return this.frameOptions[Math.max(0, index)];
	}

	setMessage(message: string): void {
		this.message = message;
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	handleInput(data: string): void {
		if (!this.onAbort || this.abortController.signal.aborted) return;
		if (data === "c" || data === "q" || data === "\u001b" || data === "\u0003") {
			this.abortController.abort();
			this.onAbort();
		}
	}

	render(width: number): string[] {
		if (width === this.width && this.lineCache) {
			return this.lineCache.split("\n");
		}
		const innerWidth = Math.max(this.minWidth - 4, 1);
		const contentWidth = Math.max(1, Math.min(width - 4, innerWidth));
		const frame = this.spinnerFrame();
		const loaderLine = ` ${frame} ${truncate(this.message, Math.max(1, contentWidth - 4))} `;
		const body = ` ${truncate(loaderLine, contentWidth - 2)} `;
		const inner = ` ${pad(body, contentWidth - 1)} `;
		const padWidth = Math.max(0, width - (contentWidth + 4));
		const leftRightPad = " ".repeat(Math.floor(padWidth / 2));
		const widthAwareInner = contentWidth + padWidth;
		const top = `${leftRightPad}┌${"─".repeat(widthAwareInner + 2)}┐`;
		const line = `${leftRightPad}│ ${truncate(inner, widthAwareInner)} │`;
		const hint = `${leftRightPad}│${" ".repeat(widthAwareInner + 2)}│`;
		const bottom = `${leftRightPad}└${"─".repeat(widthAwareInner + 2)}┘`;
		const lineWithHint = optionsHint(this.theme, this.message, widthAwareInner);
		this.width = width;
		const lines = [
			top,
			line,
			`${leftRightPad}│ ${pad(lineWithHint, widthAwareInner)} │`,
			hint,
			bottom,
		];
		this.lineCache = lines.join("\n");
		return lines;
	}

	invalidate(): void {
		this.lineCache = "";
		this.width = 0;
	}

	dispose(): void {
		this.abortController.abort();
	}
}

export interface CountdownTimerOptions {
	timeoutMs: number;
	onTick: (seconds: number) => void;
	onExpire: () => void;
}

export class CountdownTimer {
	private readonly onExpire: () => void;
	private readonly onTick: (seconds: number) => void;
	private readonly startedAt: number;
	private readonly timeoutMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private expired = false;

	constructor(options: CountdownTimerOptions) {
		this.timeoutMs = Math.max(0, options.timeoutMs);
		this.onTick = options.onTick;
		this.onExpire = options.onExpire;
		this.startedAt = Date.now();
		this.onTick(this.secondsLeft());
		if (this.timeoutMs === 0) {
			this.emitExpire();
			return;
		}
		this.timer = setInterval(() => {
			const seconds = this.secondsLeft();
			this.onTick(seconds);
			if (seconds <= 0) {
				this.emitExpire();
			}
		}, 250);
	}

	private emitExpire(): void {
		if (this.expired) return;
		this.expired = true;
		this.dispose();
		this.onExpire();
	}

	private secondsLeft(): number {
		const remainingMs = this.startedAt + this.timeoutMs - Date.now();
		return Math.max(0, Math.ceil(remainingMs / 1000));
	}

	dispose(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

function optionsHint(theme: CrewTheme, message: string, width: number): string {
	if (!message) return "";
	return truncate(theme.fg("muted", message), width);
}
