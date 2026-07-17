import type { CrewTheme } from "./theme-adapter.ts";

export interface DynamicCrewBorderOptions {
	color?: (value: string) => string;
	char?: string;
}

export class DynamicCrewBorder {
	private readonly theme: CrewTheme;
	private readonly color?: (value: string) => string;
	private readonly char: string;
	private cachedWidth = -1;
	private cachedLine = "";

	constructor(theme: CrewTheme, options: DynamicCrewBorderOptions = {}) {
		this.theme = theme;
		this.color = options.color;
		this.char = options.char && options.char.length > 0 ? options.char : "─";
	}

	render(width: number): string[] {
		const w = Math.max(0, width);
		if (w !== this.cachedWidth) {
			const line = this.char.repeat(w);
			this.cachedLine = this.color ? this.color(line) : this.theme.fg("border", line);
			this.cachedWidth = w;
		}
		return [this.cachedLine];
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLine = "";
	}
}
