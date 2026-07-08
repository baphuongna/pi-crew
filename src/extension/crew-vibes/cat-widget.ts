import { CAT_FRAMES, CAT_FRAME_COUNT } from "./cat-frames.ts";

/**
 * Inline cat animation widget for web terminals where PUA font glyphs
 * cannot render.  Cycles through ANSI-art frames extracted from the
 * runner-spritesheet.png.
 */
export class CatWidget {
	private frameIndex = 0;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private intervalMs: number;

	constructor(intervalMs = 200) {
		this.intervalMs = intervalMs;
	}

	start(): void {
		if (this.intervalId) return;
		this.intervalId = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % CAT_FRAME_COUNT;
		}, this.intervalMs);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setIntervalMs(ms: number): void {
		this.intervalMs = ms;
		if (this.intervalId) {
			this.stop();
			this.start();
		}
	}

	render(width: number): string[] {
		// Always recalculate to show current frame (no cache during animation)
		const frame = CAT_FRAMES[this.frameIndex] ?? CAT_FRAMES[0];
		const lines: string[] = [];
		for (const row of frame) {
			// Center the frame within the available width
			const padding = Math.max(0, Math.floor((width - row.length) / 2));
			lines.push(" ".repeat(padding) + row);
		}
		return lines;
	}

	invalidate(): void {
		// No cache to invalidate
	}

	dispose(): void {
		this.stop();
	}
}
