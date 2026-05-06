import { buildCapabilityInventory } from "../../runtime/capability-inventory.ts";
import type { PiTeamsConfig } from "../../config/config.ts";
import type { CapabilityItem } from "../../runtime/capability-inventory.ts";

export interface CapabilityPaneOptions {
	config?: PiTeamsConfig;
	filter?: string;
}

function kindIcon(kind: string): string {
	switch (kind) {
		case "team": return "👥";
		case "workflow": return "📋";
		case "agent": return "🤖";
		case "skill": return "🔧";
		case "tool": return "🛠";
		case "runtime": return "⚙";
		default: return "•";
	}
}

function stateLabel(state: string): string {
	switch (state) {
		case "active": return "";
		case "disabled": return " [DISABLED]";
		case "shadowed": return " [SHADOWED]";
		case "missing": return " [MISSING]";
		default: return "";
	}
}

export function renderCapabilityPane(cwd: string, opts: CapabilityPaneOptions = {}): string[] {
	const inventory = buildCapabilityInventory(cwd, opts.config);
	const filtered = opts.filter
		? inventory.filter((item) => item.kind.includes(opts.filter!.toLowerCase()) || item.name.toLowerCase().includes(opts.filter!.toLowerCase()) || item.id.toLowerCase().includes(opts.filter!.toLowerCase()))
		: inventory;

	if (filtered.length === 0) return ["Capability pane: no items found"];

	const byKind = new Map<string, CapabilityItem[]>();
	for (const item of filtered) {
		const group = byKind.get(item.kind) ?? [];
		group.push(item);
		byKind.set(item.kind, group);
	}

	const lines = [`Capability pane: ${filtered.length} item(s) (filter: ${opts.filter ?? "none"})`];
	for (const [kind, items] of byKind) {
		lines.push(`  ${kindIcon(kind)} ${kind} (${items.length}):`);
		for (const item of items.slice(0, 10)) {
			const icon = item.state === "active" ? "✓" : "✗";
			lines.push(`    ${icon} ${item.name}${stateLabel(item.state)} [${item.source}]`);
		}
		if (items.length > 10) lines.push(`    ... and ${items.length - 10} more`);
	}

	const disabled = filtered.filter((i) => i.state === "disabled").length;
	if (disabled > 0) lines.push(`  Disabled: ${disabled}`);
	return lines;
}