import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
	requestRender,
	requestRenderTarget,
	setExtensionWidget,
	setStatusFallback,
	setWorkingIndicator,
	showCustom,
} from "../../src/ui/pi-ui-compat.ts";

function walkTsFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) return walkTsFiles(fullPath);
		return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
	});
}

test("pi UI compat centralizes requestRender casts", () => {
	const offenders = walkTsFiles(path.join(process.cwd(), "src")).filter((file) =>
		fs.readFileSync(file, "utf-8").includes("as { requestRender"),
	);
	assert.deepEqual(offenders, []);
});

test("pi UI compat safely feature-detects optional APIs", () => {
	let renderCount = 0;
	let workingOptions: unknown;
	let status: { key: string; value: string | undefined } | undefined;
	let widget: { key: string; content: unknown; placement?: string } | undefined;
	const ctx = {
		ui: {
			requestRender: () => {
				renderCount += 1;
			},
			setWorkingIndicator: (options?: unknown) => {
				workingOptions = options;
			},
			setStatus: (key: string, value?: string) => {
				status = { key, value };
			},
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				widget = { key, content, placement: options?.placement };
			},
		},
	} as never;
	requestRender(ctx);
	requestRenderTarget({
		requestRender: () => {
			renderCount += 1;
		},
	});
	setWorkingIndicator(ctx, { frames: ["x"], intervalMs: 10 });
	setExtensionWidget(ctx, "widget", ["line"], {
		placement: "belowEditor",
		persist: true,
	});
	setStatusFallback(ctx, "status", ["a", "b"], "segment");
	assert.equal(renderCount, 2);
	assert.deepEqual(workingOptions, { frames: ["x"], intervalMs: 10 });
	assert.deepEqual(widget, {
		key: "widget",
		content: ["line"],
		placement: "belowEditor",
	});
	assert.deepEqual(status, { key: "status:segment", value: "a\nb" });

	assert.doesNotThrow(() => requestRender({ ui: {} } as never));
	assert.doesNotThrow(() => requestRenderTarget({}));
	assert.doesNotThrow(() => setWorkingIndicator({ ui: {} } as never));
});

test("pi UI compat no-ops setWidget/showCustom/setStatus on older host runtimes", async () => {
	const ctx = { ui: {} } as never;
	assert.doesNotThrow(() => setExtensionWidget(ctx, "widget", ["line"], { placement: "belowEditor", persist: true }));
	assert.doesNotThrow(() => setStatusFallback(ctx, "status", ["a", "b"], "segment"));
	// showCustom must settle (never reject / never hang) when ui.custom is absent...
	const missing = await showCustom(ctx, () => undefined);
	assert.equal(missing, undefined);
	// ...or present but not callable.
	const broken = { ui: { custom: "not-a-function" } } as never;
	assert.equal(await showCustom(broken, () => undefined), undefined);
});

test("showCustom passthrough pins factory and options when ui.custom exists", async () => {
	const seen: { factory?: unknown; options?: unknown } = {};
	const factory = () => undefined;
	const ctx = {
		ui: {
			custom: (candidate: unknown, options?: unknown) => {
				seen.factory = candidate;
				seen.options = options;
				return Promise.resolve("host-result");
			},
		},
	} as never;
	const result = await showCustom<string>(ctx, factory, { overlay: true });
	assert.equal(result, "host-result");
	assert.equal(seen.factory, factory);
	assert.deepEqual(seen.options, { overlay: true });
});
