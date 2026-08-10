import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { discoverProviderExtensionPaths, discoverProviderExtensions } from "../../../../src/runtime/model/provider-extensions.ts";
import { packageRoot } from "../../../../src/utils/paths.ts";

// ─── discoverProviderExtensions — pure discovery logic ─────────────────────

function makeFakeRegistry(): { settingsPath: string; npmBase: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prov-ext-"));
	const settingsPath = path.join(root, "settings.json");
	const npmBase = path.join(root, "npm", "node_modules");
	return {
		settingsPath,
		npmBase,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function writePackage(pkgName: string, npmBase: string, piExtensions?: string[], main?: string): string {
	const dir = path.join(npmBase, pkgName);
	fs.mkdirSync(dir, { recursive: true });
	const pkg: Record<string, unknown> = { name: pkgName, version: "1.0.0", type: "module" };
	if (piExtensions) pkg.pi = { extensions: piExtensions };
	if (main) pkg.main = main;
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
	const entry = piExtensions?.[0] ?? main ?? "index.ts";
	const abs = path.resolve(dir, entry);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, "export default function () {}", "utf-8");
	return dir;
}

test("discoverProviderExtensions: resolves npm: packages via pi.extensions", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		writePackage("pi-commandcode-provider", npmBase, ["./index.ts"]);
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-commandcode-provider"] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 1);
		assert.equal(result[0].spec, "npm:pi-commandcode-provider");
		assert.ok(result[0].entryPath.endsWith("index.ts"));
		assert.ok(result[0].entryPath.includes("pi-commandcode-provider"));
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: skips self (pi-crew orchestrator) even when listed in settings", () => {
	const { settingsPath, cleanup } = makeFakeRegistry();
	try {
		// packageRoot() is invariant; a settings.json that happens to list it
		// (dev installs) must not re-add pi-crew to child workers.
		const selfDir = packageRoot();
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: [selfDir] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 0, "self (pi-crew) must be skipped");
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: resolves local-path packages relative to settings.json dir", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		// Simulate a local-path provider extension (like pi-other-provider).
		// Local paths are recorded relative to the settings.json dir (~/.pi/agent).
		const localPkgDir = path.resolve(path.dirname(settingsPath), "..", "local-prov-ext");
		fs.mkdirSync(localPkgDir, { recursive: true });
		fs.writeFileSync(
			path.join(localPkgDir, "package.json"),
			JSON.stringify({ name: "local-prov-ext", pi: { extensions: ["./index.ts"] } }),
			"utf-8",
		);
		fs.writeFileSync(path.join(localPkgDir, "index.ts"), "export default function () {}", "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["../local-prov-ext"] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 1, "local-path spec should resolve");
		assert.equal(result[0].spec, "../local-prov-ext");
		assert.ok(result[0].entryPath.endsWith("local-prov-ext/index.ts"));
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: skips git/file/http specs (only npm: and local paths)", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		writePackage("pi-commandcode-provider", npmBase, ["./index.ts"]);
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				packages: ["git:github.com/x/y", "file:///nonexistent", "https://example.com/x"],
			}),
			"utf-8",
		);
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 0, "git/file/http specs should be skipped");
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: skips local-path spec when dir does not exist", () => {
	const { settingsPath, cleanup } = makeFakeRegistry();
	try {
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["../nonexistent-local-pkg"] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 0, "missing local-path dir should be skipped");
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: falls back to index.ts when pi.extensions missing", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		writePackage("plain-ext", npmBase, undefined, undefined);
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:plain-ext"] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 1);
		assert.ok(result[0].entryPath.endsWith("index.ts"));
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: skips packages with no resolvable entry", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		fs.mkdirSync(path.join(npmBase, "empty-pkg"), { recursive: true });
		fs.writeFileSync(path.join(npmBase, "empty-pkg", "package.json"), JSON.stringify({ name: "empty-pkg", version: "1.0.0" }), "utf-8");
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:empty-pkg"] }), "utf-8");
		const result = discoverProviderExtensions(settingsPath);
		assert.equal(result.length, 0, "package with no index.ts / pi.extensions should be skipped");
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: missing settings.json → empty", () => {
	const { settingsPath, cleanup } = makeFakeRegistry();
	try {
		assert.deepEqual(discoverProviderExtensions(settingsPath), []);
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensions: malformed settings.json → empty (no crash)", () => {
	const { settingsPath, cleanup } = makeFakeRegistry();
	try {
		fs.writeFileSync(settingsPath, "{ not json !!!", "utf-8");
		assert.deepEqual(discoverProviderExtensions(settingsPath), []);
	} finally {
		cleanup();
	}
});

test("discoverProviderExtensionPaths: returns entry paths only", () => {
	const { settingsPath, npmBase, cleanup } = makeFakeRegistry();
	try {
		writePackage("pi-commandcode-provider", npmBase, ["./index.ts"]);
		fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-commandcode-provider"] }), "utf-8");
		const paths = discoverProviderExtensionPaths(settingsPath);
		assert.equal(paths.length, 1);
		assert.ok(paths[0].endsWith("index.ts"));
	} finally {
		cleanup();
	}
});
