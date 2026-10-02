import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WorkingIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}

type UiContext = Pick<ExtensionContext, "ui">;
type ExtensionUi = ExtensionContext["ui"];
type WidgetContent = string[] | ((tui: unknown, theme: unknown) => unknown);
type WidgetOptions = Parameters<ExtensionUi["setWidget"]>[2];
type WidgetOptionsWithPersist = WidgetOptions & { persist?: boolean };

type CustomOptions = Parameters<ExtensionUi["custom"]>[1];

type CustomFactory<T> = (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown;
type GenericCustom = <T>(factory: CustomFactory<T>, options?: CustomOptions) => Promise<T>;

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function requestRender(ctx: UiContext): void {
	requestRenderTarget(ctx.ui);
}

export function requestRenderTarget(target: unknown): void {
	const record = maybeRecord(target);
	const fn = record?.requestRender;
	if (typeof fn === "function") fn.call(target);
}

export function setWorkingIndicator(ctx: UiContext, options?: WorkingIndicatorOptions): void {
	const record = maybeRecord(ctx.ui);
	const fn = record?.setWorkingIndicator;
	if (typeof fn === "function") fn.call(ctx.ui, options);
}

/** Install or update an extension widget slot.
 * No-op when the host UI predates the `setWidget` API. */
export function setExtensionWidget(
	ctx: UiContext,
	key: string,
	content: WidgetContent | undefined,
	options?: WidgetOptionsWithPersist,
): void {
	const { persist: _persist, ...widgetOptions } = options ?? {};
	const record = maybeRecord(ctx.ui);
	const fn = record?.setWidget;
	if (typeof fn === "function") fn.call(ctx.ui, key, content as never, widgetOptions as WidgetOptions);
}

/**
 * Map the crew widget placement onto pi's `WidgetPlacement`. `"bottom"` is a
 * crew-only placement (rendered inside the crew-vibes footer, below the quota
 * lines); when a raw widget slot is involved it falls back to `belowEditor`.
 */
export function toPiWidgetPlacement(placement: "aboveEditor" | "belowEditor" | "bottom"): "aboveEditor" | "belowEditor" {
	return placement === "bottom" ? "belowEditor" : placement;
}

type FooterFactory = (tui: unknown, theme: unknown, footerData: unknown) => unknown;

/** Install a custom footer component, or pass `undefined` to restore pi's built-in footer.
 * No-op when the host UI predates the `setFooter` API. */
export function setFooter(ctx: UiContext | undefined, factory: FooterFactory | undefined): void {
	if (!ctx) return;
	const record = maybeRecord(ctx.ui);
	const fn = record?.setFooter;
	if (typeof fn === "function") fn.call(ctx.ui, factory as never);
}

/** Show a custom focused component.
 * When the host UI predates (or mangles) the `custom` API, resolves `undefined`
 * instead of rejecting or hanging: the sole caller today
 * (src/extension/registration/ui.ts) already fire-and-forgets via
 * `void showCustom(...)`, so a rejected or never-settling promise would only
 * surface as an unhandled rejection. */
export function showCustom<T>(ctx: UiContext, factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
	const record = maybeRecord(ctx.ui);
	const fn = record?.custom;
	if (typeof fn !== "function") return Promise.resolve(undefined as T);
	const custom = fn as unknown as GenericCustom;
	return custom<T>(factory, options);
}

/** Set a status fallback line.
 * No-op when the host UI predates the `setStatus` API. */
export function setStatusFallback(ctx: UiContext, key: string, lines: string | readonly string[] | undefined, segment?: string): void {
	const text = typeof lines === "string" ? lines : lines ? [...lines].join("\n") : undefined;
	const record = maybeRecord(ctx.ui);
	const fn = record?.setStatus;
	if (typeof fn === "function") fn.call(ctx.ui, segment ? `${key}:${segment}` : key, text);
}
