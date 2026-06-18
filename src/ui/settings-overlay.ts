/**
 * Interactive TUI Settings Overlay for pi-crew.
 * Mirrors Pi's built-in /settings selector: tab bar, settings list with
 * label/value alignment, inline toggle, select submenu, and text input.
 */
import type { CrewTheme } from "./theme-adapter.ts";
import { DynamicCrewBorder } from "./dynamic-border.ts";
import { discoverPiThemes, getActivePiTheme } from "./theme-discovery.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingType = "boolean" | "enum" | "number" | "string" | "agent" | "action";

export interface SettingDef {
	id: string;
	label: string;
	description?: string;
	type: SettingType;
	/** For enum: list of allowed values */
	values?: string[];
	/** Tab grouping */
	tab: string;
	/** For type="action": identifier dispatched to onAction (e.g. "piTheme"). */
	action?: string;
}

export interface SettingsOverlayCallbacks {
	onChange: (id: string, value: unknown) => void;
	onClose: () => void;
	/** Dispatched for type="action" settings (e.g. Pi theme switch, which
	 * writes to settings.json rather than pi-crew config). Optional. */
	onAction?: (action: string, value: unknown) => void;
}

interface TabDef {
	id: string;
	label: string;
	icon: string;
}

// ---------------------------------------------------------------------------
// Setting Definitions — mirrors config schema
// ---------------------------------------------------------------------------

const TABS: TabDef[] = [
	{ id: "runtime", label: "Runtime", icon: "⚙" },
	{ id: "limits", label: "Limits", icon: "📐" },
	{ id: "agents", label: "Agents", icon: "🤖" },
	{ id: "ui", label: "UI", icon: "🖥" },
	{ id: "themes", label: "Themes", icon: "🎨" },
	{ id: "autonomous", label: "Auto", icon: "🚀" },
	{ id: "advanced", label: "Advanced", icon: "🔧" },
];

const SETTINGS: SettingDef[] = [
	// Runtime
	{ id: "runtime.mode", label: "Runtime Mode", type: "enum", values: ["auto", "scaffold", "child-process", "live-session"], tab: "runtime", description: "How workers execute. 'auto' picks best available. 'scaffold' = dry-run." },
	{ id: "runtime.maxTurns", label: "Max Turns", type: "number", tab: "runtime", description: "Maximum agent turns per task." },
	{ id: "runtime.graceTurns", label: "Grace Turns", type: "number", tab: "runtime", description: "Extra turns allowed after completion." },
	{ id: "runtime.inheritContext", label: "Inherit Context", type: "boolean", tab: "runtime", description: "Pass parent conversation context to workers." },
	{ id: "runtime.promptMode", label: "Prompt Mode", type: "enum", values: ["compact", "full", "minimal"], tab: "runtime", description: "How much prompt detail to send to workers." },
	{ id: "runtime.completionMutationGuard", label: "Mutation Guard", type: "enum", values: ["off", "warn", "block"], tab: "runtime", description: "Guard against tasks completing without file mutations." },
	{ id: "runtime.isolationPolicy", label: "Isolation Policy", type: "enum", values: ["workspace", "none"], tab: "runtime", description: "Workspace isolation between agents." },
	// Limits
	{ id: "limits.maxConcurrentWorkers", label: "Max Concurrent", type: "number", tab: "limits", description: "Max number of workers running simultaneously." },
	{ id: "limits.maxTaskDepth", label: "Max Task Depth", type: "number", tab: "limits", description: "Maximum depth of nested task spawning." },
	{ id: "limits.maxRunMinutes", label: "Max Run Minutes", type: "number", tab: "limits", description: "Maximum total run time in minutes." },
	{ id: "limits.maxRetriesPerTask", label: "Max Retries", type: "number", tab: "limits", description: "Max retry attempts per failed task." },
	{ id: "limits.maxTasksPerRun", label: "Max Tasks", type: "number", tab: "limits", description: "Maximum number of tasks per run." },
	{ id: "limits.heartbeatStaleMs", label: "Heartbeat Stale", type: "number", tab: "limits", description: "Milliseconds before a worker is considered stale." },
	// Agents
	{ id: "agents.overrides", label: "Agent Model Overrides", type: "agent", tab: "agents", description: "Model and thinking overrides per agent role." },
	{ id: "agents.disableBuiltins", label: "Disable Builtins", type: "boolean", tab: "agents", description: "Disable built-in agent definitions." },
	// UI
	{ id: "ui.showModel", label: "Show Model", type: "boolean", tab: "ui", description: "Show model name in widget/dashboard." },
	{ id: "ui.showTokens", label: "Show Tokens", type: "boolean", tab: "ui", description: "Show token counts in dashboard." },
	{ id: "ui.showTools", label: "Show Tools", type: "boolean", tab: "ui", description: "Show tool usage in dashboard." },
	{ id: "ui.dashboardPlacement", label: "Dashboard Placement", type: "enum", values: ["center", "right"], tab: "ui", description: "Where to place the dashboard overlay." },
	{ id: "ui.dashboardWidth", label: "Dashboard Width", type: "number", tab: "ui", description: "Dashboard width as percentage or pixels." },
	{ id: "ui.autoOpenDashboard", label: "Auto Open Dashboard", type: "boolean", tab: "ui", description: "Auto-open dashboard when a run starts." },
	{ id: "ui.widgetPlacement", label: "Widget Placement", type: "enum", values: ["bottom", "hidden"], tab: "ui", description: "Where to place the crew widget." },
	// ── Themes tab ──
	{ id: "__piTheme__", label: "Pi UI Theme", type: "action", action: "piTheme", values: discoverPiThemes().map((t) => t.name), tab: "themes", description: "Overall terminal theme. Switches live (no restart). Currently: " + (getActivePiTheme() ?? "dark (default)") },
	// Autonomous
	{ id: "autonomous.enabled", label: "Enabled", type: "boolean", tab: "autonomous", description: "Enable autonomous pi-crew delegation." },
	{ id: "autonomous.injectPolicy", label: "Inject Policy", type: "boolean", tab: "autonomous", description: "Inject delegation policy into agent context." },
	{ id: "autonomous.preferAsyncForLongTasks", label: "Prefer Async", type: "boolean", tab: "autonomous", description: "Prefer async execution for long tasks." },
	{ id: "autonomous.allowWorktreeSuggestion", label: "Allow Worktree", type: "boolean", tab: "autonomous", description: "Allow suggesting worktree isolation." },
	// Advanced
	{ id: "executeWorkers", label: "Execute Workers", type: "boolean", tab: "advanced", description: "Allow real child Pi workers. false = scaffold only." },
	{ id: "asyncByDefault", label: "Async By Default", type: "boolean", tab: "advanced", description: "Run teams asynchronously by default." },
	{ id: "notifierIntervalMs", label: "Notifier Interval", type: "number", tab: "advanced", description: "Async run notifier check interval in ms." },
	{ id: "reliability.autoRetry", label: "Auto Retry", type: "boolean", tab: "advanced", description: "Automatically retry failed tasks." },
	{ id: "reliability.autoRecover", label: "Auto Recover", type: "boolean", tab: "advanced", description: "Automatically recover from crashes." },
	{ id: "reliability.cleanupOrphanedTempDirs", label: "Cleanup Orphaned Temp Dirs", type: "boolean", tab: "advanced", description: "Remove /tmp/pi-crew-* directories after reconciliation (1h age threshold)." },
	{ id: "telemetry.enabled", label: "Telemetry", type: "boolean", tab: "advanced", description: "Enable telemetry collection." },
	{ id: "notifications.enabled", label: "Notifications", type: "boolean", tab: "advanced", description: "Enable run notifications." },
];

// ---------------------------------------------------------------------------
// Effective defaults — values used when config key is not set
// ---------------------------------------------------------------------------

const EFFECTIVE_DEFAULTS: Record<string, unknown> = {
	"runtime.mode": "auto",
	"runtime.maxTurns": 10000,
	"runtime.graceTurns": 5,
	"runtime.inheritContext": false,
	"runtime.promptMode": "replace",
	"runtime.completionMutationGuard": "warn",
	"runtime.isolationPolicy": undefined,
	"limits.maxConcurrentWorkers": 1024,
	"limits.maxTaskDepth": 100,
	"limits.maxRunMinutes": 1440,
	"limits.maxRetriesPerTask": 100,
	"limits.maxTasksPerRun": 10000,
	"limits.heartbeatStaleMs": 86400000,
	"agents.disableBuiltins": false,
	"ui.showModel": true,
	"ui.showTokens": true,
	"ui.showTools": true,
	"ui.dashboardPlacement": "center",
	"ui.dashboardWidth": 72,
	"ui.autoOpenDashboard": false,
	"ui.widgetPlacement": "aboveEditor",
	"autonomous.enabled": true,
	"autonomous.injectPolicy": true,
	"autonomous.preferAsyncForLongTasks": false,
	"autonomous.allowWorktreeSuggestion": true,
	"executeWorkers": true,
	"asyncByDefault": false,
	"notifierIntervalMs": 5000,
	"reliability.autoRetry": false,
	"reliability.autoRecover": false,
	"reliability.cleanupOrphanedTempDirs": true,
	"telemetry.enabled": false,
	"notifications.enabled": false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Visible character width (ignores ANSI escapes). */
function visibleWidth(text: string): number {
	// eslint-disable-next-line no-control-regex
	let w = 0;
	let inEscape = false;
	for (const ch of text) {
		if (ch === "\x1b") { inEscape = true; continue; }
		if (inEscape) { if (/[a-zA-Z]/.test(ch)) inEscape = false; continue; }
		w++;
	}
	return w;
}

/** Truncate string to fit within maxVis visible characters. */
function truncateToWidth(text: string, maxVis: number): string {
	// eslint-disable-next-line no-control-regex
	let w = 0;
	let result = "";
	let inEscape = false;
	for (const ch of text) {
		if (ch === "\x1b") { inEscape = true; result += ch; continue; }
		if (inEscape) { result += ch; if (/[a-zA-Z]/.test(ch)) inEscape = false; continue; }
		w++;
		if (w > maxVis) return result + "…";
		result += ch;
	}
	return result;
}

/** Pad string to exactly maxVis visible width. */
function padToWidth(text: string, maxVis: number, padChar = " "): string {
	const vw = visibleWidth(text);
	if (vw >= maxVis) return truncateToWidth(text, maxVis);
	return text + padChar.repeat(maxVis - vw);
}

function formatValue(value: unknown, id: string): string {
	if (value === undefined || value === null) {
		const def = EFFECTIVE_DEFAULTS[id];
		if (def !== undefined) return `${String(def)}`;
		return "<not set>";
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const keys = path.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function isExplicitlySet(config: Record<string, unknown>, id: string): boolean {
	return getNestedValue(config, id) !== undefined;
}

/** Resolve the live current value for a setting, including special-case IDs
 * (e.g. __piTheme__ which lives in Pi's settings.json, not pi-crew config). */
function currentValueFor(config: Record<string, unknown>, id: string): unknown {
	if (id === "__piTheme__") return getActivePiTheme() ?? "dark";
	return getNestedValue(config, id);
}

// ---------------------------------------------------------------------------
// Submenu: Select from list (enum picker)
// ---------------------------------------------------------------------------

class SelectSubmenu {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private readonly maxVisible = 14;
	private readonly items: string[];
	private readonly theme: CrewTheme;
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private readonly title: string;
	private readonly description: string;

	constructor(title: string, description: string, options: string[], current: string, theme: CrewTheme, onSelect: (value: string) => void, onCancel: () => void) {
		this.title = title;
		this.description = description;
		this.items = options;
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.selectedIndex = Math.max(0, options.indexOf(current));
		// Center the cursor in the visible window on open.
		this.scrollOffset = Math.max(0, this.selectedIndex - Math.floor(this.maxVisible / 2));
	}

	invalidate(): void {}

	private ensureVisible(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
		}
	}

	render(width: number): string[] {
		void width;
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", this.title)));
		if (this.description) {
			lines.push(this.theme.fg("muted", this.description));
		}
		lines.push("");
		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.items.length);
		const needsScroll = this.items.length > this.maxVisible;
		if (needsScroll && start > 0) {
			lines.push(this.theme.fg("dim", `  ▲ ${start} more above`));
		}
		for (let i = start; i < end; i++) {
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? " → " : "   ";
			const line = `${prefix}${this.items[i]}`;
			lines.push(isSelected ? (this.theme.inverse?.(line) ?? line) : line);
		}
		if (needsScroll && end < this.items.length) {
			lines.push(this.theme.fg("dim", `  ▼ ${this.items.length - end} more below`));
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ navigate · Enter to select · Esc to go back"));
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\x1b[A" || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
			this.ensureVisible();
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
			this.ensureVisible();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.onSelect(this.items[this.selectedIndex]!);
			return;
		}
		if (data === "\x1b" || data === "q") {
			this.onCancel();
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Submenu: Text input (number / string)
// ---------------------------------------------------------------------------

class TextinputSubmenu {
	private buffer = "";
	private readonly title: string;
	private readonly description: string;
	private readonly theme: CrewTheme;
	private readonly onSubmit: (value: string) => void;
	private readonly onCancel: () => void;

	constructor(title: string, description: string, initialValue: string, theme: CrewTheme, onSubmit: (value: string) => void, onCancel: () => void) {
		this.title = title;
		this.description = description;
		this.buffer = initialValue;
		this.theme = theme;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", this.title)));
		if (this.description) {
			lines.push(this.theme.fg("muted", this.description));
		}
		lines.push("");
		lines.push(`  ${this.buffer}█`);
		lines.push("");
		lines.push(this.theme.fg("dim", "Enter to save · Esc to cancel · Clear to unset"));
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\r" || data === "\n") {
			this.onSubmit(this.buffer);
			return;
		}
		if (data === "\x1b" || data === "q") {
			this.onCancel();
			return;
		}
		// Backspace
		if (data === "\x7f" || data === "\b") {
			this.buffer = this.buffer.slice(0, -1);
			return;
		}
		// Printable character
		if (data.length === 1 && data >= " " && data <= "~") {
			this.buffer += data;
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Submenu: Agent overrides editor
// ---------------------------------------------------------------------------

class AgentOverridesSubmenu {
	private readonly overrides: Record<string, { model?: string; thinking?: string }>;
	private readonly theme: CrewTheme;
	private readonly agents: string[];
	private selectedIndex = 0;
	private editField: "model" | "thinking" | null = null;
	private editBuffer = "";
	private readonly onApply: (overrides: Record<string, unknown>) => void;
	private readonly onCancel: () => void;

	constructor(config: Record<string, unknown>, theme: CrewTheme, onApply: (overrides: Record<string, unknown>) => void, onCancel: () => void) {
		this.theme = theme;
		this.onApply = onApply;
		this.onCancel = onCancel;
		const existing = (config.agents as Record<string, unknown>)?.overrides as Record<string, { model?: string; thinking?: string }> | undefined;
		this.overrides = existing ? structuredClone(existing) : {};
		this.agents = ["explorer", "planner", "analyst", "critic", "executor", "reviewer", "security-reviewer", "test-engineer", "verifier", "cold-verifier", "writer"];
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.editField) return this.renderEdit(width);

		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", "Agent Model Overrides")));
		lines.push("");
		const labelWidth = 22;
		for (const [i, agent] of this.agents.entries()) {
			const isSelected = i === this.selectedIndex;
			const ov = this.overrides[agent];
			const model = ov?.model ?? "";
			const thinking = ov?.thinking ?? "";
			const label = padToWidth(agent, labelWidth);
			const modelPart = model ? `model=${model}` : "";
			const thinkingPart = thinking ? `thinking=${thinking}` : "";
			const valueParts = [modelPart, thinkingPart].filter(Boolean).join(", ");
			const valueText = valueParts || this.theme.fg("dim", "(default)");
			const prefix = isSelected ? " → " : "   ";
			const line = `${prefix}${label} ${valueText}`;
			lines.push(isSelected ? (this.theme.inverse?.(truncateToWidth(line, width - 2)) ?? truncateToWidth(line, width - 2)) : truncateToWidth(line, width - 2));
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "Enter to edit model · e to edit thinking · Esc to go back"));
		return lines;
	}

	private renderEdit(width: number): string[] {
		const agent = this.agents[this.selectedIndex];
		const field = this.editField === "model" ? "model" : "thinking";
		const lines: string[] = [];
		lines.push(this.theme.bold(this.theme.fg("accent", `Edit ${agent} ${field}`)));
		lines.push("");
		lines.push(`  ${this.editBuffer}█`);
		lines.push("");
		lines.push(this.theme.fg("dim", "Enter to save · Esc to cancel · Clear to unset"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.editField) return this.handleEditInput(data);

		if (data === "\x1b[A" || data === "k") { this.selectedIndex = (this.selectedIndex - 1 + this.agents.length) % this.agents.length; return; }
		if (data === "\x1b[B" || data === "j") { this.selectedIndex = (this.selectedIndex + 1) % this.agents.length; return; }
		if (data === "\r" || data === "\n") {
			const agent = this.agents[this.selectedIndex]!;
			this.editField = "model";
			this.editBuffer = this.overrides[agent]?.model ?? "";
			return;
		}
		if (data === "e") {
			const agent = this.agents[this.selectedIndex]!;
			this.editField = "thinking";
			this.editBuffer = this.overrides[agent]?.thinking ?? "";
			return;
		}
		if (data === "\x1b") { this.onCancel(); return; }
	}

	private handleEditInput(data: string): void {
		if (data === "\r" || data === "\n") {
			const agent = this.agents[this.selectedIndex]!;
			if (!this.overrides[agent]) this.overrides[agent] = {};
			if (this.editField === "model") {
				this.overrides[agent]!.model = this.editBuffer || undefined;
			} else {
				this.overrides[agent]!.thinking = this.editBuffer || undefined;
			}
			// Clean up empty overrides
			if (!this.overrides[agent]!.model && !this.overrides[agent]!.thinking) {
				delete this.overrides[agent];
			}
			this.editField = null;
			return;
		}
		if (data === "\x1b") { this.editField = null; return; }
		if (data === "\x7f" || data === "\b") { this.editBuffer = this.editBuffer.slice(0, -1); return; }
		if (data.length === 1 && data >= " " && data <= "~") { this.editBuffer += data; }
	}
}

// ---------------------------------------------------------------------------
// Main Overlay
// ---------------------------------------------------------------------------

class SettingsOverlay {
	private config: Record<string, unknown>;
	private theme: CrewTheme;
	private callbacks: SettingsOverlayCallbacks;
	private currentTabIndex = 0;
	private selectedIndex = 0;
	private scrollOffset = 0;
	private maxVisible = 10;
	private submenu: SelectSubmenu | TextinputSubmenu | AgentOverridesSubmenu | null = null;
	private submenuSettingId: string | null = null;
	private changedValues = new Map<string, unknown>();

	constructor(config: Record<string, unknown>, theme: CrewTheme, callbacks: SettingsOverlayCallbacks) {
		this.config = config;
		this.theme = theme;
		this.callbacks = callbacks;
	}

	invalidate(): void {
		this.submenu?.invalidate();
	}

	render(width: number): string[] {
		// Border wrapper — same style as RunDashboard
		const innerWidth = Math.max(30, width - 4);
		const borderWidth = Math.min(innerWidth, Math.max(0, width - 2));
		const fg = (color: Parameters<CrewTheme["fg"]>[0], text: string) => this.theme.fg(color, text);
		const borderFill = (count: number) => new DynamicCrewBorder(this.theme).render(Math.max(0, count))[0];
		const border = (left: string, right: string) => `${fg("border", left)}${borderFill(borderWidth)}${fg("border", right)}`;
		const row = (text: string) => `│ ${padToWidth(truncateToWidth(text, innerWidth - 1), innerWidth - 1)}│`;

		const lines: string[] = [];

		// ── Title bar ──
		lines.push(border("╭", "╮"));
		lines.push(row(`${fg("accent", "▐")} ${this.theme.bold("pi-crew Settings")}`));

		// ── Tab bar ──
		const tabLine = this.renderTabBarContent(innerWidth - 2);
		lines.push(row(tabLine));
		lines.push(border("├", "┤"));

		// ── Content ──
		const content = this.submenu
			? this.renderSubmenuContent(innerWidth - 4)
			: this.renderSettingsContent(innerWidth - 4);
		for (const line of content) {
			lines.push(row(` ${truncateToWidth(line, innerWidth - 2)}`));
		}

		// ── Bottom border ──
		lines.push(border("╰", "╯"));

		return lines;
	}

	private renderTabBarContent(innerWidth: number): string {
		const parts: string[] = [];
		for (const [i, tab] of TABS.entries()) {
			const isActive = i === this.currentTabIndex;
			const text = `${tab.icon} ${tab.label}`;
			parts.push(isActive
				? this.theme.bold(this.theme.fg("accent", text))
				: this.theme.fg("dim", text),
			);
		}
		return parts.join("  " + this.theme.fg("border", "│") + "  ");
	}

	private renderSettingsContent(innerWidth: number): string[] {
		const tabId = TABS[this.currentTabIndex]?.id ?? "runtime";
		const settings = SETTINGS.filter(s => s.tab === tabId);
		const lines: string[] = [];

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(28, Math.max(...settings.map(s => visibleWidth(s.label))));

		// Render visible items
		const startIdx = this.scrollOffset;
		const endIdx = Math.min(startIdx + this.maxVisible, settings.length);

		for (let i = startIdx; i < endIdx; i++) {
			const def = settings[i];
			if (!def) continue;
			const isSelected = i === this.selectedIndex;

			const effective = this.changedValues.has(def.id)
				? this.changedValues.get(def.id)
				: currentValueFor(this.config, def.id);
			const isDefault = !this.changedValues.has(def.id) && !isExplicitlySet(this.config, def.id) && def.id !== "__piTheme__";
			const valueStr = formatValue(effective, def.id);
			const suffix = isDefault && (effective !== undefined || EFFECTIVE_DEFAULTS[def.id] !== undefined) ? " (default)" : "";

			const prefix = isSelected ? " → " : "   ";
			const labelPad = padToWidth(def.label, maxLabelWidth);
			const valueMax = innerWidth - maxLabelWidth - 6 - prefix.length - suffix.length;
			const valueText = truncateToWidth(valueStr, Math.max(10, valueMax));
			const line = `${prefix}${labelPad}  ${this.theme.fg(isSelected ? "accent" : "muted", valueText)}${suffix ? this.theme.fg("dim", suffix) : ""}`;

			if (isSelected) {
				lines.push(this.theme.inverse?.(truncateToWidth(line, innerWidth)) ?? truncateToWidth(line, innerWidth));
			} else {
				lines.push(truncateToWidth(line, innerWidth));
			}
		}

		// Scroll indicator
		if (startIdx > 0 || endIdx < settings.length) {
			const remaining = settings.length - endIdx;
			const count = startIdx > 0 ? `↑${startIdx}` : "";
			const below = remaining > 0 ? `↓${remaining}` : "";
			const parts = [count, below].filter(Boolean);
			if (parts.length > 0) {
				lines.push(this.theme.fg("dim", `   (${this.selectedIndex + 1}/${settings.length}) ${parts.join(" ")}`));
			}
		}

		// Description
		const selectedDef = settings[this.selectedIndex];
		if (selectedDef?.description) {
			lines.push("");
			lines.push(this.theme.fg("muted", `  ${selectedDef.description}`));
		}

		// Hints
		lines.push("");
		lines.push(this.theme.fg("dim", "  ↑↓ Navigate · Enter/Space change · Tab switch · Esc close"));

		return lines;
	}

	private renderSubmenuContent(innerWidth: number): string[] {
		if (!this.submenu) return [];
		return this.submenu.render(innerWidth);
	}

	handleInput(data: string): void {
		// Submenu takes priority
		if (this.submenu) {
			this.submenu.handleInput(data);
			return;
		}

		// Escape closes overlay
		if (data === "\x1b" || data === "q") {
			this.callbacks.onClose();
			return;
		}

		// Tab navigation
		if (data === "\t" || data === "\x1b[C") {
			this.currentTabIndex = (this.currentTabIndex + 1) % TABS.length;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}
		if (data === "Z" || data === "\x1b[D") {
			this.currentTabIndex = (this.currentTabIndex - 1 + TABS.length) % TABS.length;
			this.selectedIndex = 0;
			this.scrollOffset = 0;
			return;
		}

		// Item navigation
		const tabId = TABS[this.currentTabIndex]?.id ?? "runtime";
		const settings = SETTINGS.filter(s => s.tab === tabId);

		if (data === "\x1b[A" || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureVisible(settings.length);
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.selectedIndex = Math.min(settings.length - 1, this.selectedIndex + 1);
			this.ensureVisible(settings.length);
			return;
		}

		// Activate item
		if (data === "\r" || data === "\n" || data === " ") {
			this.activateItem(settings);
		}
	}

	private activateItem(settings: SettingDef[]): void {
		const def = settings[this.selectedIndex];
		if (!def) return;

		const current = this.changedValues.has(def.id) ? this.changedValues.get(def.id) : getNestedValue(this.config, def.id);

		switch (def.type) {
			case "boolean": {
				const newVal = current !== true;
				this.changedValues.set(def.id, newVal);
				this.callbacks.onChange(def.id, newVal);
				break;
			}
			case "enum": {
				if (!def.values?.length) return;
				this.submenuSettingId = def.id;
				this.submenu = new SelectSubmenu(
					def.label,
					def.description ?? "",
					def.values,
					typeof current === "string" ? current : def.values[0]!,
					this.theme,
					(value: string) => {
						this.changedValues.set(def.id, value);
						this.callbacks.onChange(def.id, value);
						this.submenu = null;
						this.submenuSettingId = null;
					},
					() => { this.submenu = null; this.submenuSettingId = null; },
				);
				break;
			}
			case "number": {
				this.submenuSettingId = def.id;
				this.submenu = new TextinputSubmenu(
					def.label,
					def.description ?? "",
					typeof current === "number" ? String(current) : "",
					this.theme,
					(value: string) => {
						const num = value === "" ? undefined : Number(value);
						if (num !== undefined && !Number.isNaN(num)) {
							this.changedValues.set(def.id, num);
							this.callbacks.onChange(def.id, num);
						} else if (value === "") {
							this.changedValues.set(def.id, undefined);
							this.callbacks.onChange(def.id, undefined);
						}
						this.submenu = null;
						this.submenuSettingId = null;
					},
					() => { this.submenu = null; this.submenuSettingId = null; },
				);
				break;
			}
			case "string": {
				this.submenuSettingId = def.id;
				this.submenu = new TextinputSubmenu(
					def.label,
					def.description ?? "",
					typeof current === "string" ? current : "",
					this.theme,
					(value: string) => {
						this.changedValues.set(def.id, value || undefined);
						this.callbacks.onChange(def.id, value || undefined);
						this.submenu = null;
						this.submenuSettingId = null;
					},
					() => { this.submenu = null; this.submenuSettingId = null; },
				);
				break;
			}
			case "agent": {
				this.submenu = new AgentOverridesSubmenu(
					this.config,
					this.theme,
					(overrides: Record<string, unknown>) => {
						this.changedValues.set("agents.overrides", overrides);
						this.callbacks.onChange("agents.overrides", overrides);
						this.submenu = null;
						this.submenuSettingId = null;
					},
					() => { this.submenu = null; this.submenuSettingId = null; },
				);
				break;
			}
			case "action": {
				if (!def.values?.length || !def.action) break;
				const actionCurrent = typeof this.changedValues.get(def.id) === "string"
					? (this.changedValues.get(def.id) as string)
					: (currentValueFor(this.config, def.id) as string | undefined) ?? "";
				this.submenuSettingId = def.id;
				this.submenu = new SelectSubmenu(
					def.label,
					def.description ?? "",
					def.values,
					actionCurrent,
					this.theme,
					(value: string) => {
						this.changedValues.set(def.id, value);
						this.callbacks.onAction?.(def.action!, value);
						this.submenu = null;
						this.submenuSettingId = null;
					},
					() => { this.submenu = null; this.submenuSettingId = null; },
				);
				break;
			}
		}
	}

	private ensureVisible(count: number): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = Math.max(0, this.selectedIndex - this.maxVisible + 1);
		}
	}
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createSettingsOverlay(
	config: Record<string, unknown>,
	theme: CrewTheme,
	onChange: (id: string, value: unknown) => void,
	done: () => void,
	onAction?: (action: string, value: unknown) => void,
) {
	const overlay = new SettingsOverlay(config, theme, { onChange, onClose: done, onAction });
	return { overlay, component: overlay };
}
