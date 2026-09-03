/**
 * Regression guard: a lazy-import wrapper must not cache the imported symbol
 * in a module-level `let`.
 *
 * `let` bindings are not hoisted, function declarations are. Under a cyclic
 * import the cycle partner can call the hoisted wrapper while the declaring
 * module body is still pending, so the read hits the temporal dead zone and
 * the process dies with `ReferenceError: Cannot access '_cachedX' before
 * initialization`. Reported in the field on 0.2.20 for
 * `src/extension/team-tool.ts` (`_cachedHandleRun`), whose cycle partner
 * `src/extension/team-tool/dispatch/run.ts` imports `handleRun` back from it.
 *
 * The cache is redundant: the module loader already caches `import()`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const SRC_DIR = join(import.meta.dirname, "..", "..", "src");

/**
 * Sites whose module-level cache is read by something other than the lazy
 * wrapper, so dropping it would change behavior: `commands/shared.ts` has the
 * `__test__setHandleTeamTool` seam, `crash-recovery-cache.ts` has a sync
 * purge-if-loaded probe.
 */
const STATEFUL_BY_DESIGN: Record<string, true> = {
	"extension/registration/commands/shared.ts": true,
	"extension/registration/crash-recovery-cache.ts": true,
};

function listTsFiles(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listTsFiles(full, `${prefix}${entry}/`));
		else if (entry.endsWith(".ts")) out.push(`${prefix}${entry}`);
	}
	return out;
}

describe("lazy-import TDZ", () => {
	it("a module-level `let` cache crashes when a cycle partner calls the wrapper", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-crew-tdz-"));
		try {
			writeFileSync(join(dir, "impl.mjs"), `export function run() { return "ran"; }\n`);
			writeFileSync(join(dir, "partner.mjs"), `import { run } from "./facade.mjs";\nawait run();\n`);
			// TEST SEAM: fixtures are written at runtime, so the specifier cannot be static.
			writeFileSync(
				join(dir, "facade.mjs"),
				`import "./partner.mjs";\nlet _cachedRun;\nexport async function run() {\n\tif (_cachedRun === undefined) _cachedRun = (await import("./impl.mjs")).run;\n\treturn _cachedRun();\n}\n`,
			);
			await assert.rejects(
				() => import(pathToFileURL(join(dir, "facade.mjs")).href),
				/Cannot access '_cachedRun' before initialization/,
			);

			// Same cycle without the cache: the loader caches `import()` itself.
			writeFileSync(
				join(dir, "ok-partner.mjs"),
				`import { run } from "./ok.mjs";\nif ((await run()) !== "ran") throw new Error("wrong result");\n`,
			);
			writeFileSync(
				join(dir, "ok.mjs"),
				`import "./ok-partner.mjs";\nexport async function run() {\n\treturn (await import("./impl.mjs")).run();\n}\n`,
			);
			await import(pathToFileURL(join(dir, "ok.mjs")).href);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("no lazy wrapper in src caches an imported symbol in a module-level `let`", () => {
		const offenders: string[] = [];
		for (const file of listTsFiles(SRC_DIR)) {
			if (STATEFUL_BY_DESIGN[file]) continue;
			const content = readFileSync(join(SRC_DIR, file), "utf8");
			if (!content.includes("import(")) continue;
			for (const [, name] of content.matchAll(/^let (\w+)[^\n]*;$/gm)) {
				if (new RegExp(`\\b${name} = (mod\\.\\w+|\\w*mod\\b)`).test(content)) offenders.push(`${file}: ${name}`);
			}
		}
		assert.deepEqual(offenders, [], `TDZ-unsafe lazy caches under cyclic imports:\n${offenders.join("\n")}`);
	});
});
