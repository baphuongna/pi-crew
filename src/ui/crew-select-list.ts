import { pad, truncate } from "../utils/visual.ts";
import { keyOf } from "./key-utils.ts";
import type { CrewTheme } from "./theme-adapter.ts";

export interface CrewSelectItem<T = string> {
	value: T;
	label: string;
	description?: string;
}

export interface CrewSelectListOptions<T = string> {
	onSelect: (item: CrewSelectItem<T>) => void;
	onCancel: () => void;
	onPreview?: (item: CrewSelectItem<T>) => void;
	maxHeight?: number;
}

export class CrewSelectList<T = string> {
	private readonly items: CrewSelectItem<T>[];
	private readonly theme: CrewTheme;
	private readonly options: CrewSelectListOptions<T>;
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(items: CrewSelectItem<T>[], theme: CrewTheme, options: CrewSelectListOptions<T>) {
		this.items = [...items];
		this.theme = theme;
		this.options = options;
		this.selectedIndex = this.items.length ? 0 : -1;
	}

	invalidate(): void {
		/* no-op */
	}

	getSelected(): CrewSelectItem<T> | undefined {
		return this.selectedIndex >= 0 ? this.items[this.selectedIndex] : undefined;
	}

	setSelectedIndex(index: number): void {
		if (!this.items.length) {
			this.selectedIndex = -1;
			this.scrollOffset = 0;
			return;
		}
		const next = Math.min(this.items.length - 1, Math.max(0, index));
		const changed = next !== this.selectedIndex;
		this.selectedIndex = next;
		this.ensureVisible();
		if (changed) {
			const selected = this.getSelected();
			if (selected) this.options.onPreview?.(selected);
		}
	}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.options.onCancel();
			return;
		}
		if (data === "j" || keyOf(data) === "down") {
			this.setSelectedIndex(this.selectedIndex + 1);
			return;
		}
		if (data === "k" || keyOf(data) === "up") {
			this.setSelectedIndex(this.selectedIndex - 1);
			return;
		}
		if (data === "\r" || data === "\n") {
			const selected = this.getSelected();
			if (selected) this.options.onSelect(selected);
		}
	}

	render(width: number): string[] {
		if (!this.items.length) return [this.theme.fg("muted", "(no items)")];
		const maxHeight = Math.max(1, Math.floor(this.options.maxHeight ?? this.items.length));
		this.ensureVisible();
		const hasTop = this.scrollOffset > 0;
		const availableWithoutBottom = Math.max(1, maxHeight - (hasTop ? 1 : 0));
		const hasBottom = this.scrollOffset + availableWithoutBottom < this.items.length;
		const slots = this.visibleItemSlots(maxHeight, hasTop, hasBottom);
		const visibleItems = this.items.slice(this.scrollOffset, this.scrollOffset + slots);
		const lines: string[] = [];
		if (hasTop) lines.push(this.theme.fg("muted", `↑ ${this.scrollOffset} more`));
		for (const [offset, item] of visibleItems.entries()) {
			const index = this.scrollOffset + offset;
			const prefix = index === this.selectedIndex ? " → " : "   ";
			const suffix = item.description ? this.theme.fg("dim", ` — ${item.description}`) : "";
			const raw = `${prefix}${item.label}${suffix}`;
			const line = index === this.selectedIndex ? (this.theme.inverse?.(raw) ?? raw) : raw;
			lines.push(pad(truncate(line, width), Math.max(1, width)));
		}
		if (hasBottom) lines.push(this.theme.fg("muted", `↓ ${this.items.length - (this.scrollOffset + slots)} more`));
		return lines.slice(0, maxHeight);
	}

	private visibleItemSlots(maxHeight: number, hasTop: boolean, hasBottom: boolean): number {
		return Math.max(1, maxHeight - (hasTop ? 1 : 0) - (hasBottom ? 1 : 0));
	}

	private ensureVisible(): void {
		if (this.selectedIndex < 0) return;
		const maxHeight = Math.max(1, Math.floor(this.options.maxHeight ?? this.items.length));
		const reservedTop = this.scrollOffset > 0 ? 1 : 0;
		const visibleSlots = Math.max(1, maxHeight - reservedTop - 1);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + visibleSlots) {
			this.scrollOffset = Math.max(0, this.selectedIndex - visibleSlots + 1);
		}
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.items.length - 1));
	}
}
