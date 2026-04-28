import { pad, wrapHard } from "../utils/visual.ts";

export interface RenderableComponent {
	invalidate(): void;
	render(width: number): string[];
}

export class Container implements RenderableComponent {
	private children: RenderableComponent[] = [];

	addChild(child: RenderableComponent): void {
		this.children.push(child);
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

export class Box extends Container {
	private readonly paddingX: number;
	private readonly paddingY: number;

	constructor(paddingX = 0, paddingY = 0) {
		super();
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - this.paddingX * 2);
		const rows = super.render(innerWidth);
		const paddedRows: string[] = [];
		const left = " ".repeat(this.paddingX);
		const right = " ".repeat(this.paddingX);
		for (const row of rows) {
			paddedRows.push(pad(`${left}${row}${right}`, width));
		}
		const emptyRow = pad("", width);
		if (this.paddingY <= 0) return paddedRows;
		if (this.paddingY > 0) {
			const topAndBottom = Array.from({ length: this.paddingY }, () => emptyRow);
			return [...topAndBottom, ...paddedRows, ...topAndBottom];
		}
		return paddedRows;
	}
}

export class Text implements RenderableComponent {
	private text: string;
	private cachedWidth = 0;
	private cachedResult: string[] = [];

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedResult = [];
	}

	render(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedResult;
		const wrapped = wrapHard(this.text, Math.max(1, width));
		const lines = wrapped.length ? wrapped : [""];
		this.cachedWidth = width;
		this.cachedResult = lines.map((line) => pad(line, width));
		return this.cachedResult;
	}
}

export class Spacer implements RenderableComponent {
	private readonly rows: number;

	constructor(rows = 0) {
		this.rows = rows;
	}

	render(width: number): string[] {
		if (this.rows <= 0) return [];
		return Array.from({ length: Math.max(0, this.rows) }, () => pad("", width));
	}

	invalidate(): void {}
}
