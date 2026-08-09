import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	flushScratchpadSnapshot,
	PI_CREW_ARTIFACTS_ROOT_ENV,
	PI_CREW_ATTEMPT_ENV,
	PI_CREW_SCRATCHPAD_SNAPSHOT_ENV,
	PI_CREW_TASK_ID_ENV,
	type ScratchpadSnapshotDeps,
	SNAPSHOT_MAX_BYTES,
	validateSnapshotEnv,
} from "../../src/prompt/scratchpad-lifecycle.ts";
import type { EngineManager } from "../../src/runtime/scratchpad/engine.ts";
import type { ArtifactWriteOptions } from "../../src/state/stores/artifact-store.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

interface MockEngineShape {
	isRunning: boolean;
	state: "idle" | "starting" | "running" | "shutdown";
	snapshotState: () => Promise<{ path: string; saved: string[]; failed: { name: string; reason: string }[] } | null>;
	kill: () => Promise<void>;
}

function makeMockEngine(overrides: Partial<MockEngineShape> = {}): { engine: EngineManager; calls: Record<string, number> } {
	const calls: Record<string, number> = { snapshotState: 0, kill: 0 };
	const base: MockEngineShape = {
		isRunning: true,
		state: "running",
		snapshotState: async () => {
			calls.snapshotState++;
			return null;
		},
		kill: async () => {
			calls.kill++;
		},
	};
	return { engine: { ...base, ...overrides } as unknown as EngineManager, calls };
}

interface TempCtx {
	root: string;
	artifactsRoot: string;
	snapshotDir: string;
	snapshotPath: string;
	cleanup(): void;
}

function makeTempCtx(): TempCtx {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scratchpad-art-"));
	const artifactsRoot = path.join(root, "artifacts");
	const snapshotDir = path.join(root, "snap");
	fs.mkdirSync(artifactsRoot, { recursive: true });
	fs.mkdirSync(snapshotDir, { recursive: true });
	const snapshotPath = path.join(snapshotDir, "task-1.snapshot.json");
	return {
		root,
		artifactsRoot,
		snapshotDir,
		snapshotPath,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function makeEnv(ctx: TempCtx, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: Record<string, string | undefined> = {
		PI_CREW_SCRATCHPAD: "1",
		[PI_CREW_TASK_ID_ENV]: "task-1",
		[PI_CREW_ATTEMPT_ENV]: "2",
		[PI_CREW_ARTIFACTS_ROOT_ENV]: ctx.artifactsRoot,
		[PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: ctx.snapshotPath,
	};
	return { ...env, ...overrides };
}

function makeDeps(
	engine: EngineManager,
	ctx: TempCtx,
	opts: {
		env?: NodeJS.ProcessEnv;
		writeArtifact?: (root: string, options: ArtifactWriteOptions) => unknown;
		log?: (scope: string, error: unknown, details?: string, severity?: string) => void;
	} = {},
): ScratchpadSnapshotDeps {
	return {
		engine,
		env: opts.env ?? makeEnv(ctx),
		...(opts.writeArtifact ? { writeArtifact: opts.writeArtifact } : {}),
		...(opts.log ? { logInternalError: opts.log } : {}),
	};
}

function capturedWriteArtifact() {
	const calls: Array<{ root: string; options: ArtifactWriteOptions }> = [];
	const spy = (root: string, options: ArtifactWriteOptions): unknown => {
		calls.push({ root, options });
		return { path: "fake", kind: options.kind, createdAt: "", producer: options.producer, sizeBytes: 0, contentHash: "" };
	};
	return { calls, spy };
}

const BASE64_SECRET = Buffer.from("top-secret-value").toString("base64");

// ── tests ───────────────────────────────────────────────────────────────────

afterEach(() => {
	// No module timers used here, but keep parity with sibling suites.
});

describe("scratchpad-artifact (T7 §10.3 / plan T7)", () => {
	it("F4/C3: flush writes correct relativePath (taskId.attempt), kind result, producer taskId", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: [] };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy }));
			assert.equal(writes.length, 1);
			assert.equal(writes[0].root, ctx.artifactsRoot);
			assert.equal(writes[0].options.kind, "result");
			assert.equal(writes[0].options.relativePath, "scratchpad/task-1.attempt-2.snapshot.json");
			assert.equal(writes[0].options.producer, "task-1");
			assert.equal(writes[0].options.content, JSON.stringify({ version: 1, vars: {}, failed: [] }));
			// N2-4: temp snapshot removed after a successful write
			assert.equal(fs.existsSync(ctx.snapshotPath), false, "raw temp snapshot must be unlinked after writeArtifact");
		} finally {
			ctx.cleanup();
		}
	});

	it("N2-4: raw temp is chmod 0600 before content is handed to writeArtifact", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, "raw-bytes");
			const { engine } = makeMockEngine({
				snapshotState: async () => ({ path: ctx.snapshotPath, saved: [], failed: [] }),
			});
			const modeAtWriteTime: number[] = [];
			const spy = (_root: string, _options: ArtifactWriteOptions): unknown => {
				modeAtWriteTime.push(fs.statSync(ctx.snapshotPath).mode & 0o777);
				return null;
			};
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy }));
			assert.equal(modeAtWriteTime.length, 1);
			assert.equal(modeAtWriteTime[0], 0o600, "raw temp file must be owner-only before leaving tempDir");
			assert.equal(fs.existsSync(ctx.snapshotPath), false);
		} finally {
			ctx.cleanup();
		}
	});

	it("F12/S-7: redaction — apiKey value redacted via structural walk, benign base64 data passes through", async () => {
		const ctx = makeTempCtx();
		try {
			const fixture = JSON.stringify({
				version: 1,
				vars: { apiKey: "sk-super-secret-value-12345", data: BASE64_SECRET },
				failed: [],
			});
			fs.writeFileSync(ctx.snapshotPath, fixture);
			const { engine } = makeMockEngine({
				snapshotState: async () => ({ path: ctx.snapshotPath, saved: ["apiKey", "data"], failed: [] }),
			});
			// No PI_CREW_ATTEMPT → fail-open attempt "0" (R-8), exercising the default path too.
			const env = makeEnv(ctx, { [PI_CREW_ATTEMPT_ENV]: undefined });
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { env }));
			const artifactPath = path.join(ctx.artifactsRoot, "scratchpad", "task-1.attempt-0.snapshot.json");
			assert.ok(fs.existsSync(artifactPath), "redacted artifact must be written");
			const written = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
				vars: { apiKey: string; data: string };
			};
			// (1) sensitive key-name → redacted
			assert.equal(written.vars.apiKey, "***", "sensitive key name must be structurally redacted");
			// (2) benign key-name holding base64 → NOT redacted (documented Phase-1 caveat)
			assert.equal(written.vars.data, BASE64_SECRET, "benign-named base64 passes through (accepted Phase-1 behavior)");
			// CAVEAT (docs): Phase 2 restore will hand the model the REDACTED value for
			// sensitive vars — intentional, we never persist raw secrets.
			assert.ok(!written.vars.data.includes("***"));
		} finally {
			ctx.cleanup();
		}
	});

	it("F4/S-1: crash between snapshotState and writeArtifact leaves NO raw file in artifactsRoot", async () => {
		const ctx = makeTempCtx();
		try {
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: { apiKey: "sk-leak" }, failed: [] }));
			const { engine } = makeMockEngine({
				snapshotState: async () => ({ path: ctx.snapshotPath, saved: ["apiKey"], failed: [] }),
			});
			const logged: string[] = [];
			const throwingWrite = (_root: string, _options: ArtifactWriteOptions): never => {
				// Simulate the crash: writeArtifact blows up mid-write.
				throw new Error("simulated crash inside writeArtifact");
			};
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, { writeArtifact: throwingWrite, log: (_s, _e, _d, sev) => logged.push(sev ?? "debug") }),
			);
			// Nothing may exist under artifactsRoot (no raw snapshot, no partial artifact).
			assert.equal(fs.existsSync(path.join(ctx.artifactsRoot, "scratchpad")), false, "no raw/partial file in artifactsRoot");
			// R-4: raw temp cleaned even though writeArtifact threw.
			assert.equal(fs.existsSync(ctx.snapshotPath), false, "raw temp must be unlinked in finally");
			// F13: the failure is logged, not swallowed.
			assert.ok(logged.length > 0, "crash must be surfaced via logInternalError");
		} finally {
			ctx.cleanup();
		}
	});

	it("F8/SEC-NULL-1: snapshotState null while engine is running is surfaced (not silent)", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine } = makeMockEngine({ isRunning: true, state: "running", snapshotState: async () => null });
			const logged: Array<{ scope: string; sev?: string }> = [];
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, {
					log: (scope, _e, _d, sev) => logged.push({ scope, sev }),
				}),
			);
			assert.equal(
				logged.some((l) => l.scope === "scratchpad.snapshot"),
				true,
				"error-null must be logged (F13)",
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("F8: snapshotState null while engine idle is a silent no-op (no chmod/unlink on a missing file)", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine({
				isRunning: false,
				state: "idle",
				snapshotState: async () => {
					calls.snapshotState++;
					return null;
				},
			});
			const logged: Array<{ scope: string; sev?: string }> = [];
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, {
					log: (scope, _e, _d, sev) => logged.push({ scope, sev }),
				}),
			);
			assert.equal(calls.snapshotState, 1);
			assert.equal(
				logged.some((l) => l.scope === "scratchpad.snapshot"),
				false,
				"idle-null is expected, not an error",
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("F11/SEC-ENV-1: missing artifactsRoot env → skip write, no throw, logged, snapshotState not called", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine();
			const env = makeEnv(ctx, { [PI_CREW_ARTIFACTS_ROOT_ENV]: undefined });
			const logged: Array<{ scope: string; sev?: string }> = [];
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, { env, writeArtifact: spy, log: (scope, _e, _d, sev) => logged.push({ scope, sev }) }),
			);
			assert.equal(writes.length, 0, "no write without a validated artifactsRoot (never derive)");
			assert.equal(calls.snapshotState, 0, "snapshotState must not run when env validation fails");
			assert.equal(
				logged.some((l) => l.scope === "scratchpad.env-validation"),
				true,
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("F11/SEC-ENV-1: missing snapshot env → skip write, no throw, logged", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine, calls } = makeMockEngine();
			const env = makeEnv(ctx, { [PI_CREW_SCRATCHPAD_SNAPSHOT_ENV]: undefined });
			const logged: Array<{ scope: string; sev?: string }> = [];
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, { env, writeArtifact: spy, log: (scope, _e, _d, sev) => logged.push({ scope, sev }) }),
			);
			assert.equal(writes.length, 0);
			assert.equal(calls.snapshotState, 0);
			assert.equal(
				logged.some((l) => l.scope === "scratchpad.env-validation"),
				true,
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("F11: missing taskId env → skip write, no throw, logged (taskId is provenance)", async () => {
		const ctx = makeTempCtx();
		try {
			const { engine } = makeMockEngine();
			const env = makeEnv(ctx, { [PI_CREW_TASK_ID_ENV]: undefined });
			const logged: Array<{ scope: string; sev?: string }> = [];
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(
				makeDeps(engine, ctx, { env, writeArtifact: spy, log: (scope, _e, _d, sev) => logged.push({ scope, sev }) }),
			);
			assert.equal(writes.length, 0);
			assert.equal(
				logged.some((l) => l.scope === "scratchpad.env-validation"),
				true,
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("R-8: PI_CREW_ATTEMPT is fail-open (missing → '0')", () => {
		const ctx = makeTempCtx();
		try {
			const validation = validateSnapshotEnv(makeEnv(ctx, { [PI_CREW_ATTEMPT_ENV]: undefined }));
			assert.equal(validation.valid, true);
			assert.equal(validation.attempt, "0", "attempt must default to 0");
		} finally {
			ctx.cleanup();
		}
	});

	it("SEC-ENV-1: symlinked snapshot dirname escaping the container → validation fails closed (Linux O_NOFOLLOW)", {
		skip: process.platform === "win32" || process.platform === "darwin",
	}, () => {
		const ctx = makeTempCtx();
		// Linux-only: resolveRealContainedPath rejects a symlinked baseDir via
		// O_NOFOLLOW (ELOOP → throw → valid=false). On macOS the function FOLLOWS
		// symlinks via realpath (deliberate, for /var→/private/var compat) so this
		// strict-rejection assertion is Linux-specific — skipped on darwin+win32.
		// (Containment on macOS is enforced by realpath + ancestor-walk against the
		// resolved target, a different mechanism; the parent validates the snapshot
		// path under tempDir at spawn time.) Symlink target OUTSIDE artifactsRoot:
		// macOS via realpath, so it must point outside to be cross-platform.)
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sec-env1-outside-"));
		try {
			const linkDir = path.join(ctx.root, "link");
			fs.symlinkSync(outside, linkDir);
			const validation = validateSnapshotEnv({
				PI_CREW_SCRATCHPAD: "1",
				PI_CREW_TASK_ID: "task-1",
				PI_CREW_ARTIFACTS_ROOT: ctx.artifactsRoot,
				PI_CREW_SCRATCHPAD_SNAPSHOT: path.join(linkDir, "s.json"),
			});
			assert.equal(validation.valid, false, "symlinked ancestor escaping the container must be rejected");
			assert.match(validation.reason ?? "", /env-path-invalid/);
		} finally {
			ctx.cleanup();
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	// ── Phase 2 (D6) — write-side cap: measure RAW byteLength; trim failed ONLY
	// when over cap; still over → skip persist (keep previous artifact). ────────

	it("P2-T4: under cap with many failed entries → persisted UNTRIMMED (align spec D6 — NIT-4)", async () => {
		const ctx = makeTempCtx();
		try {
			const many = Array.from({ length: 200 }, (_, i) => ({ name: `v${i}`, reason: "r" }));
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: {}, failed: many }));
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: [], failed: many };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy }));
			assert.equal(writes.length, 1, "small payload must persist");
			const reparsed = JSON.parse(writes[0].options.content as string);
			assert.equal(reparsed.failed.length, 200, "under-cap payload is NOT trimmed");
		} finally {
			ctx.cleanup();
		}
	});

	it("P2-T4: over cap → failed list trimmed to 50, then persisted", async () => {
		const ctx = makeTempCtx();
		try {
			// Make each failed entry ~2KB so trimming 200→50 saves ~300KB, enough to
			// land the trimmed payload UNDER the cap (vars occupy most of the cap).
			const big = "x".repeat(SNAPSHOT_MAX_BYTES - 350_000);
			const many = Array.from({ length: 200 }, (_, i) => ({ name: `var${i}`, reason: "x".repeat(1900) }));
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: { data: big }, failed: many }));
			const rawSize = fs.statSync(ctx.snapshotPath).size;
			assert.ok(rawSize > SNAPSHOT_MAX_BYTES, `fixture must exceed cap (raw=${rawSize})`);
			const { engine, calls } = makeMockEngine({
				snapshotState: async () => {
					calls.snapshotState++;
					return { path: ctx.snapshotPath, saved: ["data"], failed: many };
				},
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy }));
			assert.equal(writes.length, 1, "trimmed payload must persist");
			const reparsed = JSON.parse(writes[0].options.content as string);
			assert.equal(reparsed.failed.length, 50, "failed list trimmed to 50");
			assert.equal(reparsed.vars.data, big, "vars preserved by trim");
		} finally {
			ctx.cleanup();
		}
	});

	it("P2-T4: still over cap after trim → skip persist (no write, logs cap)", async () => {
		const ctx = makeTempCtx();
		try {
			const huge = "x".repeat(SNAPSHOT_MAX_BYTES + 10_000);
			fs.writeFileSync(ctx.snapshotPath, JSON.stringify({ version: 1, vars: { data: huge }, failed: [] }));
			const { engine } = makeMockEngine({
				snapshotState: async () => ({ path: ctx.snapshotPath, saved: ["data"], failed: [] }),
			});
			const { calls: writes, spy } = capturedWriteArtifact();
			const logs: string[] = [];
			await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy, log: (scope) => logs.push(scope) }));
			assert.equal(writes.length, 0, "oversized payload must NOT be persisted");
			assert.ok(logs.includes("scratchpad.cap"), "cap skip must be logged");
		} finally {
			ctx.cleanup();
		}
	});
});

it("P2-T4: over cap AND non-JSON → skip persist + log scratchpad.cap (MINOR-2)", async () => {
	const ctx = makeTempCtx();
	try {
		// Non-JSON oversized content (e.g. a partial write after a crash).
		fs.writeFileSync(ctx.snapshotPath, `${"x".repeat(SNAPSHOT_MAX_BYTES + 100)} not json`);
		const { engine } = makeMockEngine({
			snapshotState: async () => ({ path: ctx.snapshotPath, saved: [], failed: [] }),
		});
		const { calls: writes, spy } = capturedWriteArtifact();
		const logs: string[] = [];
		await flushScratchpadSnapshot(makeDeps(engine, ctx, { writeArtifact: spy, log: (scope) => logs.push(scope) }));
		assert.equal(writes.length, 0, "non-JSON oversized must NOT persist");
		assert.ok(logs.includes("scratchpad.cap"), "cap skip logged");
	} finally {
		ctx.cleanup();
	}
});
