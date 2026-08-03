import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestRenderTarget } from "../../ui/pi-ui-compat.ts";
import { asCrewTheme, type CrewTheme } from "../../ui/theme-adapter.ts";
import { truncateToWidth, visibleWidth } from "../../utils/visual.ts";
import type { CrewVibesConfig } from "./config.ts";
import type { ProviderUsage } from "./provider-usage.ts";
import { formatCount, getCapacityUsage, renderCapacity, renderProviderUsage } from "./render.ts";

/**
 * Custom footer replacement for crew-vibes.
 *
 * Why this exists: pi joins ALL `setStatus()` entries onto ONE line and
 * right-truncates when the line overflows. The provider quota lives at the
 * tail, so it gets chopped to "W..." whenever the `pi-crew` widget status grows
 * during sub-agent runs. Five prior attempts (right-align padding, dynamic
 * padding, separate keys) all failed because an extension using `setStatus`
 * cannot see the widget's width, other extensions' widths, or pi's real render
 * width. `setFooter` sidesteps all of that: `render(width)` receives the REAL
 * width and we own the line layout, so the meters get a dedicated line that is
 * never truncated by the join.
 */

/** Live values the footer reads on each render (owned by the extension). */
export interface CrewVibesFooterSource {
	getConfig(): CrewVibesConfig;
	getQuotaUsage(): ProviderUsage | null;
	getThinkingLevel(): string | undefined;
}

export interface CrewVibesFooterDeps {
	tui: unknown;
	theme: unknown;
	footerData: unknown;
	ctx: ExtensionContext;
	source: CrewVibesFooterSource;
}

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(cb: () => void): () => void;
}

interface FooterComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Mirror pi's footer cwd formatting: collapse the home prefix to `~`. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** Mirror pi's status sanitizer (collapse control chars + runs of spaces). */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function asFooterData(value: unknown): FooterData | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.getGitBranch !== "function" ||
		typeof record.getExtensionStatuses !== "function" ||
		typeof record.getAvailableProviderCount !== "function" ||
		typeof record.onBranchChange !== "function"
	) {
		return undefined;
	}
	return value as FooterData;
}

interface SessionTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function computeTotals(entries: unknown[]): SessionTotals {
	const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		const rec = entry as {
			type?: string;
			message?: { role?: string; usage?: Record<string, unknown> & { cost?: { total?: unknown } } };
		};
		if (rec?.type !== "message" || rec.message?.role !== "assistant") continue;
		const usage = rec.message.usage;
		if (!usage) continue;
		totals.input += num(usage.input);
		totals.output += num(usage.output);
		totals.cacheRead += num(usage.cacheRead);
		totals.cacheWrite += num(usage.cacheWrite);
		totals.cost += num(usage.cost?.total);
	}
	return totals;
}

class CrewVibesFooter implements FooterComponent {
	private readonly theme: CrewTheme;
	private readonly footerData: FooterData | undefined;
	private readonly ctx: ExtensionContext;
	private readonly source: CrewVibesFooterSource;
	private readonly tui: unknown;
	private readonly unsubscribeBranch: () => void;

	constructor(deps: CrewVibesFooterDeps) {
		this.theme = asCrewTheme(deps.theme);
		this.footerData = asFooterData(deps.footerData);
		this.ctx = deps.ctx;
		this.source = deps.source;
		this.tui = deps.tui;
		this.unsubscribeBranch = this.footerData ? this.footerData.onBranchChange(() => requestRenderTarget(this.tui)) : () => undefined;
	}

	invalidate(): void {
		/* no-op */
	}

	dispose(): void {
		this.unsubscribeBranch();
	}

	private buildPwdLine(width: number): string {
		const sm = this.ctx.sessionManager;
		let pwd = formatCwdForFooter(sm.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData?.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = sm.getSessionName?.();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;
		return truncateToWidth(this.theme.fg("dim", pwd), width, this.theme.fg("dim", "..."));
	}

	private buildStatsLine(width: number): string {
		const theme = this.theme;
		const model = this.ctx.model as { id?: string; provider?: string; reasoning?: unknown; contextWindow?: number } | undefined;
		const totals = computeTotals(this.ctx.sessionManager.getEntries() as unknown[]);
		const contextUsage = this.ctx.getContextUsage?.();
		const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
		const percentValue = contextUsage?.percent ?? 0;
		const percentKnown = contextUsage?.percent !== null && contextUsage?.percent !== undefined;

		const statsParts: string[] = [];
		if (totals.input) statsParts.push(`↑${formatCount(totals.input)}`);
		if (totals.output) statsParts.push(`↓${formatCount(totals.output)}`);
		if (totals.cacheRead) statsParts.push(`R${formatCount(totals.cacheRead)}`);
		if (totals.cacheWrite) statsParts.push(`W${formatCount(totals.cacheWrite)}`);

		const usingSubscription = !!(model && this.ctx.modelRegistry?.isUsingOAuth?.(this.ctx.model as never));
		if (totals.cost || usingSubscription) {
			statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		// User choice: always show the "(auto)" compaction indicator (pi's default);
		// the toggle state is not observable by extensions.
		const autoIndicator = " (auto)";
		const contextDisplay = percentKnown
			? `${percentValue.toFixed(1)}%/${formatCount(contextWindow)}${autoIndicator}`
			: `?/${formatCount(contextWindow)}${autoIndicator}`;
		const contextColored =
			percentValue > 90
				? theme.fg("error", contextDisplay)
				: percentValue > 70
					? theme.fg("warning", contextDisplay)
					: contextDisplay;
		statsParts.push(contextColored);

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const minPadding = 2;
		const modelName = model?.id || "no-model";
		let rightSideWithoutProvider = modelName;
		if (model?.reasoning) {
			// Prefer the authoritative thinking level from session state
			// (buildSessionContext), which reflects the current effective level
			// including the model default — not just the last thinking_level_select
			// event (which only fires on manual switch).
			let level = this.source.getThinkingLevel();
			try {
				const ctx = this.ctx.sessionManager as { buildSessionContext?: () => { thinkingLevel?: string } };
				if (typeof ctx.buildSessionContext === "function") {
					const resolved = ctx.buildSessionContext()?.thinkingLevel;
					if (resolved) level = resolved;
				}
			} catch {
				// buildSessionContext may throw on empty/early sessions — fall back.
			}
			const finalLevel = level || "off";
			rightSideWithoutProvider = finalLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${finalLevel}`;
		}

		let rightSide = rightSideWithoutProvider;
		const providerCount = this.footerData?.getAvailableProviderCount() ?? 0;
		if (providerCount > 1 && model?.provider) {
			rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
		}

		const rightSideWidth = visibleWidth(rightSide);
		let statsLine: string;
		if (statsLeftWidth + minPadding + rightSideWidth <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}

		const dimStatsLeft = theme.fg("dim", statsLeft);
		const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
		return dimStatsLeft + dimRemainder;
	}

	private buildStatusLine(width: number): string | undefined {
		if (!this.footerData) return undefined;
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size === 0) return undefined;
		const joined = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		if (!joined) return undefined;
		return truncateToWidth(joined, width, this.theme.fg("dim", "..."));
	}

	private rightAlign(text: string, width: number): string {
		const w = visibleWidth(text);
		if (w >= width) return truncateToWidth(text, width, "…");
		return " ".repeat(width - w) + text;
	}

	/** Capacity + provider quota. Uses the REAL render width, so the quota is
	 * never chopped. When both do not fit on one line, wrap to two lines
	 * (capacity above, quota right-aligned below) per the chosen behavior. */
	private buildMeterLines(width: number): string[] {
		const config = this.source.getConfig();
		if (!config.enabled) return [];
		const capText = config.capacity.enabled ? renderCapacity(this.theme, config.capacity, getCapacityUsage(this.ctx)) : undefined;
		const quotaText = config.capacity.providerUsage ? renderProviderUsage(this.theme, this.source.getQuotaUsage()) : undefined;

		if (!capText && !quotaText) return [];
		if (capText && !quotaText) return [truncateToWidth(capText, width, "…")];
		if (!capText && quotaText) return [this.rightAlign(quotaText, width)];

		const cap = capText as string;
		const quota = quotaText as string;
		const capWidth = visibleWidth(cap);
		const quotaWidth = visibleWidth(quota);
		if (capWidth + 1 + quotaWidth <= width) {
			const pad = Math.max(1, width - capWidth - quotaWidth);
			return [cap + " ".repeat(pad) + quota];
		}
		return [truncateToWidth(cap, width, "…"), this.rightAlign(quota, width)];
	}

	render(width: number): string[] {
		const lines = [this.buildPwdLine(width), this.buildStatsLine(width)];
		const statusLine = this.buildStatusLine(width);
		if (statusLine) lines.push(statusLine);
		lines.push(...this.buildMeterLines(width));
		return lines;
	}
}

export function createCrewVibesFooter(deps: CrewVibesFooterDeps): FooterComponent {
	return new CrewVibesFooter(deps);
}
