import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";
import { pad } from "../utils/visual.ts";
import { DynamicCrewBorder } from "./dynamic-border.ts";

export type MascotStyle = "cat" | "armin";
export type MascotEffect =
	| "random"
	| "none"
	| "typewriter"
	| "scanline"
	| "rain"
	| "fade"
	| "crt"
	| "glitch"
	| "dissolve";

interface AnimatedMascotOptions {
	frameIntervalMs?: number;
	autoCloseMs?: number;
	requestRender?: () => void;
	style?: MascotStyle;
	effect?: MascotEffect;
}

const BS = String.fromCharCode(92);

const CAT_FRAMES: readonly (readonly string[])[] = [
	[` /${BS}_/${BS} `, "(='.'=)", "(  _  )", `  ${BS}_/  `],
	[` /${BS}_/${BS} `, "(='o'=)", "(  w  )", `  ${BS}_/  `],
	[` /${BS}_/${BS} `, "(=^.^=)", "(  _  )", `  ${BS}_/  `],
	[` /${BS}_/${BS} `, "(=*.*=)", "(  v  )", `  ${BS}_/  `],
] as const;

// Armin XBM: 31x36 px, LSB first, 1=background, 0=foreground (ported from pi-mono coding-agent)
const ARMIN_WIDTH = 31;
const ARMIN_HEIGHT = 36;
const ARMIN_BITS: readonly number[] = [
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

const ARMIN_BYTES_PER_ROW = Math.ceil(ARMIN_WIDTH / 8);
const ARMIN_DISPLAY_HEIGHT = Math.ceil(ARMIN_HEIGHT / 2);

const NON_NONE_EFFECTS: MascotEffect[] = [
	"typewriter",
	"scanline",
	"rain",
	"fade",
	"crt",
	"glitch",
	"dissolve",
];
const CAT_FRIENDLY_EFFECTS: MascotEffect[] = ["scanline", "glitch", "crt"];

function getArminPixel(x: number, y: number): boolean {
	if (y >= ARMIN_HEIGHT) return false;
	const byteIndex = y * ARMIN_BYTES_PER_ROW + Math.floor(x / 8);
	const bitIndex = x % 8;
	return ((ARMIN_BITS[byteIndex] >> bitIndex) & 1) === 0;
}

function getArminChar(x: number, row: number): string {
	const upper = getArminPixel(x, row * 2);
	const lower = getArminPixel(x, row * 2 + 1);
	if (upper && lower) return "█";
	if (upper) return "▀";
	if (lower) return "▄";
	return " ";
}

function buildArminGrid(): string[][] {
	const grid: string[][] = [];
	for (let row = 0; row < ARMIN_DISPLAY_HEIGHT; row++) {
		const line: string[] = [];
		for (let x = 0; x < ARMIN_WIDTH; x++) line.push(getArminChar(x, row));
		grid.push(line);
	}
	return grid;
}

function emptyArminGrid(): string[][] {
	return Array.from({ length: ARMIN_DISPLAY_HEIGHT }, () => Array(ARMIN_WIDTH).fill(" "));
}

interface EffectState {
	pos?: number;
	row?: number;
	expansion?: number;
	phase?: number;
	glitchFrames?: number;
	positions?: [number, number][];
	idx?: number;
	drops?: { y: number; settled: number }[];
	done?: boolean;
}

export class AnimatedMascot {
	private readonly theme: CrewTheme;
	private readonly frameIntervalMs: number;
	private readonly autoCloseMs: number;
	private readonly onDone: () => void;
	private readonly requestRender: (() => void) | undefined;
	private readonly doneGuard: { called: boolean } = { called: false };
	private readonly interval: ReturnType<typeof setInterval> | undefined;
	private readonly timeout: ReturnType<typeof setTimeout> | undefined;
	private readonly style: MascotStyle;
	private readonly effect: MascotEffect;
	private readonly finalArminGrid: string[][];
	private currentArminGrid: string[][];
	private effectState: EffectState = {};
	private effectDone = false;
	private frame = 0;
	private effectPhase = 0;
	private gridVersion = 0;
	private cachedWidth = 0;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(themeLike: unknown, onDone: () => void, options: AnimatedMascotOptions = {}) {
		this.theme = asCrewTheme(themeLike);
		this.onDone = onDone;
		this.frameIntervalMs = Math.max(16, Math.floor(options.frameIntervalMs ?? 180));
		this.autoCloseMs = Math.max(0, Math.floor(options.autoCloseMs ?? 7_000));
		this.requestRender = options.requestRender;
		this.style = options.style === "armin" ? "armin" : "cat";
		this.effect = this.resolveEffect(options.effect);
		this.finalArminGrid = buildArminGrid();
		this.currentArminGrid = this.style === "armin" ? this.initialArminGrid() : emptyArminGrid();
		this.initEffect();
		this.interval = setInterval(() => this.tick(), this.frameIntervalMs);
		this.interval.unref();
		this.timeout = this.autoCloseMs > 0 ? setTimeout(() => this.close(), this.autoCloseMs) : undefined;
		this.timeout?.unref();
	}

	private resolveEffect(requested: MascotEffect | undefined): MascotEffect {
		if (!requested || requested === "random") {
			const pool = this.style === "armin" ? NON_NONE_EFFECTS : CAT_FRIENDLY_EFFECTS;
			return pool[Math.floor(Math.random() * pool.length)];
		}
		return requested;
	}

	private initialArminGrid(): string[][] {
		if (this.effect === "dissolve") {
			const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
			return Array.from({ length: ARMIN_DISPLAY_HEIGHT }, () =>
				Array.from({ length: ARMIN_WIDTH }, () => chars[Math.floor(Math.random() * chars.length)]),
			);
		}
		return emptyArminGrid();
	}

	private initEffect(): void {
		this.effectState = {};
		this.effectDone = false;
		switch (this.effect) {
			case "typewriter":
				this.effectState = { pos: 0 };
				break;
			case "scanline":
				this.effectState = { row: 0 };
				break;
			case "rain":
				this.effectState = {
					drops: Array.from({ length: ARMIN_WIDTH }, () => ({
						y: -Math.floor(Math.random() * ARMIN_DISPLAY_HEIGHT * 2),
						settled: 0,
					})),
				};
				break;
			case "fade":
			case "dissolve": {
				const positions: [number, number][] = [];
				for (let row = 0; row < ARMIN_DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < ARMIN_WIDTH; x++) positions.push([row, x]);
				}
				for (let i = positions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[positions[i], positions[j]] = [positions[j], positions[i]];
				}
				this.effectState = { positions, idx: 0 };
				break;
			}
			case "crt":
				this.effectState = { expansion: 0 };
				break;
			case "glitch":
				this.effectState = { phase: 0, glitchFrames: 8 };
				break;
			case "none":
				this.currentArminGrid = this.finalArminGrid.map((row) => [...row]);
				this.effectDone = true;
				break;
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedLines = [];
	}

	private tick(): void {
		this.effectPhase++;
		this.frame = (this.frame + 1) % CAT_FRAMES.length;
		if (!this.effectDone && this.style === "armin") {
			this.effectDone = this.tickArminEffect();
			this.gridVersion++;
		}
		this.invalidate();
		this.requestRender?.();
	}

	private tickArminEffect(): boolean {
		switch (this.effect) {
			case "typewriter":
				return this.tickTypewriter();
			case "scanline":
				return this.tickScanline();
			case "rain":
				return this.tickRain();
			case "fade":
				return this.tickFade();
			case "crt":
				return this.tickCrt();
			case "glitch":
				return this.tickGlitch();
			case "dissolve":
				return this.tickDissolve();
			default:
				return true;
		}
	}

	private tickTypewriter(): boolean {
		const state = this.effectState;
		if (state.pos === undefined) return true;
		for (let i = 0; i < 6; i++) {
			const row = Math.floor(state.pos / ARMIN_WIDTH);
			const x = state.pos % ARMIN_WIDTH;
			if (row >= ARMIN_DISPLAY_HEIGHT) return true;
			this.currentArminGrid[row][x] = this.finalArminGrid[row][x];
			state.pos++;
		}
		return false;
	}

	private tickScanline(): boolean {
		const state = this.effectState;
		if (state.row === undefined) return true;
		if (state.row >= ARMIN_DISPLAY_HEIGHT) return true;
		for (let x = 0; x < ARMIN_WIDTH; x++) this.currentArminGrid[state.row][x] = this.finalArminGrid[state.row][x];
		state.row++;
		return false;
	}

	private tickRain(): boolean {
		const drops = this.effectState.drops;
		if (!drops) return true;
		let allSettled = true;
		this.currentArminGrid = emptyArminGrid();
		for (let x = 0; x < ARMIN_WIDTH; x++) {
			const drop = drops[x];
			for (let row = ARMIN_DISPLAY_HEIGHT - 1; row >= ARMIN_DISPLAY_HEIGHT - drop.settled; row--) {
				if (row >= 0) this.currentArminGrid[row][x] = this.finalArminGrid[row][x];
			}
			if (drop.settled >= ARMIN_DISPLAY_HEIGHT) continue;
			allSettled = false;
			let targetRow = -1;
			for (let row = ARMIN_DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				if (this.finalArminGrid[row][x] !== " ") {
					targetRow = row;
					break;
				}
			}
			drop.y++;
			if (drop.y >= 0 && drop.y < ARMIN_DISPLAY_HEIGHT) {
				if (targetRow >= 0 && drop.y >= targetRow) {
					drop.settled = ARMIN_DISPLAY_HEIGHT - targetRow;
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					this.currentArminGrid[drop.y][x] = "▓";
				}
			}
		}
		return allSettled;
	}

	private tickFade(): boolean {
		const state = this.effectState;
		if (!state.positions || state.idx === undefined) return true;
		for (let i = 0; i < 18; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentArminGrid[row][x] = this.finalArminGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private tickCrt(): boolean {
		const state = this.effectState;
		if (state.expansion === undefined) return true;
		const midRow = Math.floor(ARMIN_DISPLAY_HEIGHT / 2);
		this.currentArminGrid = emptyArminGrid();
		const top = midRow - state.expansion;
		const bottom = midRow + state.expansion;
		for (let row = Math.max(0, top); row <= Math.min(ARMIN_DISPLAY_HEIGHT - 1, bottom); row++) {
			for (let x = 0; x < ARMIN_WIDTH; x++) this.currentArminGrid[row][x] = this.finalArminGrid[row][x];
		}
		state.expansion++;
		return state.expansion > ARMIN_DISPLAY_HEIGHT;
	}

	private tickGlitch(): boolean {
		const state = this.effectState;
		if (state.phase === undefined || state.glitchFrames === undefined) return true;
		if (state.phase < state.glitchFrames) {
			this.currentArminGrid = this.finalArminGrid.map((row) => {
				const offset = Math.floor(Math.random() * 7) - 3;
				const glitchRow = [...row];
				if (Math.random() < 0.3) {
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					return shifted.slice(0, ARMIN_WIDTH);
				}
				if (Math.random() < 0.2) {
					const swapRow = Math.floor(Math.random() * ARMIN_DISPLAY_HEIGHT);
					return [...this.finalArminGrid[swapRow]];
				}
				return glitchRow;
			});
			state.phase++;
			return false;
		}
		this.currentArminGrid = this.finalArminGrid.map((row) => [...row]);
		return true;
	}

	private tickDissolve(): boolean {
		const state = this.effectState;
		if (!state.positions || state.idx === undefined) return true;
		for (let i = 0; i < 22; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentArminGrid[row][x] = this.finalArminGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private close(): void {
		if (this.doneGuard.called) return;
		this.doneGuard.called = true;
		if (this.interval) clearInterval(this.interval);
		if (this.timeout) clearTimeout(this.timeout);
		this.onDone();
	}

	private formatLine(line: string, width: number, color: Parameters<CrewTheme["fg"]>[0] = "accent"): string {
		const contentWidth = Math.max(0, width - 4);
		const themed = this.theme.fg(color, line);
		return `│ ${pad(themed, contentWidth)} │`;
	}

	private currentCatFrame(): readonly string[] {
		return CAT_FRAMES[this.frame];
	}

	private applyCatEffect(lines: readonly string[]): string[] {
		if (this.effect === "none") return [...lines];
		if (this.effect === "scanline") {
			const scanRow = this.effectPhase % (lines.length + 4);
			return lines.map((ln, i) =>
				i === scanRow ? this.theme.bold(this.theme.fg("accent", ln)) : ln,
			);
		}
		if (this.effect === "glitch") {
			if (this.effectPhase % 9 !== 0) return [...lines];
			return lines.map((ln) => {
				if (Math.random() > 0.4) return ln;
				const offset = 1 + Math.floor(Math.random() * 2);
				return ln.length > offset ? ln.slice(offset) + ln.slice(0, offset) : ln;
			});
		}
		if (this.effect === "crt") {
			const flickerOn = Math.floor(this.effectPhase / 4) % 2 === 0;
			return lines.map((ln) => (flickerOn ? this.theme.bold(ln) : ln));
		}
		return [...lines];
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion && this.cachedLines.length) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(20, width);
		const horizontal = new DynamicCrewBorder(this.theme).render(Math.max(0, safeWidth - 2))[0];
		const result: string[] = [
			`${this.theme.fg("border", "╭")}${horizontal}${this.theme.fg("border", "╮")}`,
			this.formatLine(this.theme.bold(" ARMIN SAYS HI "), safeWidth),
			this.formatLine("", safeWidth),
		];
		if (this.style === "armin") {
			for (const row of this.currentArminGrid) {
				const text = row.join("");
				result.push(this.formatLine(text, safeWidth));
			}
		} else {
			const frameLines = this.applyCatEffect(this.currentCatFrame());
			for (const line of frameLines) result.push(this.formatLine(line, safeWidth));
		}
		const hint = this.style === "armin"
			? `Press q or Esc to close · effect: ${this.effect}`
			: "Press q or Esc to close · animated preview";
		result.push(this.formatLine(hint, safeWidth, "muted"));
		result.push(`${this.theme.fg("border", "╰")}${horizontal}${this.theme.fg("border", "╯")}`);
		this.cachedWidth = safeWidth;
		this.cachedVersion = this.gridVersion;
		this.cachedLines = result;
		return result;
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b" || data === "\u0003") {
			this.close();
		}
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		if (this.timeout) clearTimeout(this.timeout);
	}
}
