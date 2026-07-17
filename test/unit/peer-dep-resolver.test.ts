import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	__resetPeerDepCacheForTest,
	getAgentDir,
	PEER_DEP_DIR_ENV,
	PEER_DEP_NAMES,
	peerDepResolutionBases,
	primePeerDep,
	resolvePeerDep,
	resolvePeerDepDir,
} from "../../src/runtime/peer-dep.ts";
import { __setNpmGlobalRootForTest } from "../../src/runtime/pi-spawn.ts";

/**
 * Build a fake ESM peer-dep package under a temp root and return the root.
 * Layout:
 *   <root>/node_modules/@earendil-works/pi-coding-agent/package.json + index.js
 * The fake exports getAgentDir() returning `agentDirValue`.
 */
function buildFakePeerDep(agentDirValue: string): {
	root: string;
	pkgDir: string;
} {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peerdep-"));
	const scopeDir = path.join(tmpRoot, "node_modules", "@earendil-works");
	const pkgDir = path.join(scopeDir, "pi-coding-agent");
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0-fake",
			type: "module",
			main: "./index.js",
			exports: { ".": { import: "./index.js" } },
		}),
	);
	fs.writeFileSync(
		path.join(pkgDir, "index.js"),
		`export function getAgentDir(){return ${JSON.stringify(agentDirValue)};}\nexport const __FAKE__ = true;\n`,
	);
	return { root: tmpRoot, pkgDir };
}

describe("peer-dep resolver", () => {
	const origEnv = { ...process.env };
	const origArgv1 = process.argv[1];

	beforeEach(() => {
		__resetPeerDepCacheForTest();
		// Skip the real ~200ms `npm root -g` probe during tests.
		__setNpmGlobalRootForTest(undefined);
		delete process.env[PEER_DEP_DIR_ENV];
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		__resetPeerDepCacheForTest();
		__setNpmGlobalRootForTest(undefined);
		for (const k of Object.keys(process.env)) {
			if (!(k in origEnv)) delete process.env[k];
		}
		for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
		process.argv[1] = origArgv1;
	});

	it("resolves via the parent-provided env hint (strategy 0, no npm probe)", () => {
		const { root, pkgDir } = buildFakePeerDep("/fake/agent-envhint");
		process.env[PEER_DEP_DIR_ENV] = root;
		const resolved = resolvePeerDep();
		assert.ok(resolved, "expected env-hint resolution to succeed");
		assert.equal(resolved?.name, "@earendil-works/pi-coding-agent");
		assert.equal(resolved?.dir, pkgDir);
		assert.match(resolved?.mainUrl ?? "", /^file:\/\//);
		assert.ok(resolved?.mainUrl.endsWith("index.js"));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("resolutionBases puts the env hint FIRST", () => {
		const hint = path.join(os.tmpdir(), "hint-first");
		process.env[PEER_DEP_DIR_ENV] = hint;
		const bases = peerDepResolutionBases();
		// Compare resolved paths — the resolver runs path.resolve() on the env
		// hint, which on Windows turns "/tmp/x" into "C:\tmp\x". Raw-string
		// comparison would falsely fail cross-platform.
		assert.equal(bases[0], path.resolve(hint));
	});

	it("primePeerDep loads the ESM module and getAgentDir reads the REAL function", async () => {
		const { root } = buildFakePeerDep("/fake/agent-primed");
		process.env[PEER_DEP_DIR_ENV] = root;
		await primePeerDep();
		assert.equal(getAgentDir(), "/fake/agent-primed");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("primePeerDep is memoized (one dynamic import shared)", async () => {
		const { root } = buildFakePeerDep("/fake/agent-memo");
		process.env[PEER_DEP_DIR_ENV] = root;
		const p1 = primePeerDep();
		const p2 = primePeerDep();
		assert.equal(p1, p2, "concurrent prime calls must share one promise");
		const m1 = await p1;
		const m2 = await primePeerDep();
		assert.equal(m1, m2, "module namespace cached");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("getAgentDir NEVER throws when not primed — falls back to ~/.pi/agent", () => {
		// Force resolution failure: no env hint, argv1 in a temp dir with no
		// peer dep, and npm root disabled. Resolution returns undefined; cache
		// stays empty; getAgentDir must still return a sane default.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peerdep-empty-"));
		process.argv[1] = path.join(tmp, "child-entry.ts");
		__resetPeerDepCacheForTest();
		// resolvePeerDep may still find the REAL dev-installed peer dep (this
		// test's repo has it as a devDep). Either way, getAgentDir must not
		// throw: it returns the real value OR the computed default.
		const result = getAgentDir();
		assert.equal(typeof result, "string");
		assert.ok(result.length > 0);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("getAgentDir fallback respects PI_CODING_AGENT_DIR override", () => {
		// Clear cache so the cachedModule path is skipped.
		__resetPeerDepCacheForTest();
		process.env.PI_CODING_AGENT_DIR = "/custom/agent-dir";
		// Note: if the real peer dep resolved earlier in THIS process it may be
		// cached; reset guarantees we exercise the fallback branch.
		assert.equal(getAgentDir(), "/custom/agent-dir");
	});

	it("resolvePeerDepDir returns the dir string (for env propagation)", () => {
		const { root, pkgDir } = buildFakePeerDep("/fake/agent-dir");
		process.env[PEER_DEP_DIR_ENV] = root;
		assert.equal(resolvePeerDepDir(), pkgDir);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("PEER_DEP_NAMES includes both scopes", () => {
		assert.ok(PEER_DEP_NAMES.includes("@earendil-works/pi-coding-agent"));
		assert.ok(PEER_DEP_NAMES.includes("@mariozechner/pi-coding-agent"));
	});

	it("mainUrl is a loadable file:// URL under jiti (the child's loader)", async () => {
		const { root } = buildFakePeerDep("/fake/agent-url");
		process.env[PEER_DEP_DIR_ENV] = root;
		const resolved = resolvePeerDep();
		assert.ok(resolved);
		// Dynamic import of a file:// URL is exactly what the child does — must work.
		const mod = await import(resolved!.mainUrl);
		assert.equal((mod as { __FAKE__?: boolean }).__FAKE__, true);
		assert.equal(typeof (mod as { getAgentDir: unknown }).getAgentDir, "function");
		fs.rmSync(root, { recursive: true, force: true });
	});
});
