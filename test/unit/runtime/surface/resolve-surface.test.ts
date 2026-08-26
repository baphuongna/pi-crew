/**
 * resolveSurface detection matrix tests (spec §3)
 *
 * Fail-closed contract: any failed check (missing binary, dead socket, depth,
 * async run, cap, mode) degrades to headless (null). Never throws because a
 * multiplexer is missing.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PiTeamsConfig } from "../../../../src/config/types.ts";
import { MAX_SURFACE_WORKERS, resolveSurface } from "../../../../src/runtime/surface/resolve-surface.ts";
import type { SurfaceHandle, SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";

let binDir: string;

test.before(() => {
	binDir = mkdtempSync(join(tmpdir(), "resolve-surface-test-"));
});

test.after(() => {
	rmSync(binDir, { recursive: true, force: true });
});

/** Fake executable that `command -v` resolves (exit 0). */
function fakeBinary(name: string): string {
	const p = join(binDir, `${name}-${Math.random().toString(36).slice(2, 8)}`);
	writeFileSync(p, "#!/bin/sh\nexit 0\n");
	chmodSync(p, 0o755);
	return p;
}

function missingBinary(): string {
	return join(binDir, `missing-${Math.random().toString(36).slice(2, 8)}`);
}

function stubProvider(kind: "tmux" | "herdr"): SurfaceProvider {
	const handle: SurfaceHandle = {
		id: `${kind}-stub`,
		kind,
		onExit: () => undefined,
		dispose: () => undefined,
	};
	return {
		kind,
		detect: () => ({ ok: true, kind }),
		createSurface: async () => handle,
		attach: () => null,
		readScreen: async () => "",
		closeSurface: async () => undefined,
	};
}

const providers = {
	tmux: stubProvider("tmux"),
	herdr: stubProvider("herdr"),
};

const baseEnv: Record<string, string | undefined> = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	HOME: tmpdir(),
	PI_CREW_DEPTH: "0",
};

const tmuxEnv = {
	...baseEnv,
	TMUX: "/tmp/tmux-1000/default,12345,0",
	TMUX_PANE: "%0",
};

const herdrEnv = {
	...baseEnv,
	HERDR_ENV: "1",
	HERDR_SOCKET_PATH: "/tmp/herdr-test.sock",
};

function makeConfig(overrides?: { mode?: "auto" | "tmux" | "herdr" | "off"; visibleAgents?: string[] }): PiTeamsConfig {
	return {
		runtime: {
			surface: {
				mode: overrides?.mode ?? "auto",
				visibleAgents: overrides?.visibleAgents ?? ["*"],
			},
		},
	};
}

test("matrix: depth>0 → null (no pane-in-pane)", () => {
	const env = { ...tmuxEnv, PI_CREW_DEPTH: "1" };
	assert.equal(resolveSurface(env, makeConfig(), "executor", 0, { tmuxBin: fakeBinary("tmux"), providers }), null);
	// PI_TEAMS_DEPTH legacy alias also blocks. PI_CREW_DEPTH must be undefined
	// for "??" to fall through — baseEnv already sets "0", which shadows it.
	const legacyEnv = { ...tmuxEnv, PI_CREW_DEPTH: undefined, PI_TEAMS_DEPTH: "2" };
	assert.equal(resolveSurface(legacyEnv, makeConfig(), "executor", 0, { tmuxBin: fakeBinary("tmux"), providers }), null);
});

test("matrix: TMUX + binary → tmux provider", () => {
	const result = resolveSurface(tmuxEnv, makeConfig(), "executor", 0, {
		tmuxBin: fakeBinary("tmux"),
		providers,
	});
	assert.equal(result?.kind, "tmux");
});

test("matrix: HERDR_ENV + binary + socket sống → herdr", () => {
	const result = resolveSurface(herdrEnv, makeConfig(), "executor", 0, {
		herdrBin: fakeBinary("herdr"),
		pingSocket: () => true,
		providers,
	});
	assert.equal(result?.kind, "herdr");
});

test("matrix: cả hai → tmux (innermost wins)", () => {
	const bothEnv = { ...tmuxEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr-test.sock" };
	const result = resolveSurface(bothEnv, makeConfig(), "executor", 0, {
		tmuxBin: fakeBinary("tmux"),
		herdrBin: fakeBinary("herdr"),
		pingSocket: () => true,
		providers,
	});
	assert.equal(result?.kind, "tmux");
});

test("matrix: không gì cả → null", () => {
	assert.equal(resolveSurface(baseEnv, makeConfig(), "executor", 0, { providers }), null);
	// binary tồn tại nhưng env không khớp ô nào vẫn null
	assert.equal(
		resolveSurface(baseEnv, makeConfig(), "executor", 0, {
			tmuxBin: fakeBinary("tmux"),
			herdrBin: fakeBinary("herdr"),
			pingSocket: () => true,
			providers,
		}),
		null,
	);
});

test("surface.mode 'off' → null luôn; 'tmux' ép + detect fail → null (fail-closed)", () => {
	// off giết mọi thứ kể cả khi tmux đầy đủ
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig({ mode: "off" }), "executor", 0, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
	// ép tmux nhưng TMUX env không có (detect fail) → null, KHÔNG hạ xuống herdr
	assert.equal(
		resolveSurface(baseEnv, makeConfig({ mode: "tmux" }), "executor", 0, {
			tmuxBin: fakeBinary("tmux"),
			herdrBin: fakeBinary("herdr"),
			pingSocket: () => true,
			providers,
		}),
		null,
	);
	// ép tmux, binary thiếu → null
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig({ mode: "tmux" }), "executor", 0, {
			tmuxBin: missingBinary(),
			providers,
		}),
		null,
	);
});

test("livePaneCount >= MAX_SURFACE_WORKERS → null", () => {
	assert.equal(MAX_SURFACE_WORKERS, 6);
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig(), "executor", MAX_SURFACE_WORKERS, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
	// boundary: MAX - 1 pane sống vẫn được cấp pane thứ MAX
	const boundary = resolveSurface(tmuxEnv, makeConfig(), "executor", MAX_SURFACE_WORKERS - 1, {
		tmuxBin: fakeBinary("tmux"),
		providers,
	});
	assert.equal(boundary?.kind, "tmux");
});

test("visibleAgents [] → null; ['executor'] + role 'executor' → provider; role khác → null", () => {
	// rỗng (default A1) — không ai được pane
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig({ visibleAgents: [] }), "executor", 0, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
	// config không khai surface — như rỗng
	assert.equal(
		resolveSurface(tmuxEnv, {} as PiTeamsConfig, "executor", 0, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
	// match chính xác role
	const matched = resolveSurface(tmuxEnv, makeConfig({ visibleAgents: ["executor"] }), "executor", 0, {
		tmuxBin: fakeBinary("tmux"),
		providers,
	});
	assert.equal(matched?.kind, "tmux");
	// role khác → null
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig({ visibleAgents: ["executor"] }), "planner", 0, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
	// exact-match: không prefix-match
	assert.equal(
		resolveSurface(tmuxEnv, makeConfig({ visibleAgents: ["executor"] }), "executor-2", 0, {
			tmuxBin: fakeBinary("tmux"),
			providers,
		}),
		null,
	);
});

test("async run (PI_CREW_ASYNC_RUN=1) → null — A1 force headless (spec §14)", () => {
	const env = { ...tmuxEnv, PI_CREW_ASYNC_RUN: "1" };
	assert.equal(resolveSurface(env, makeConfig(), "executor", 0, { tmuxBin: fakeBinary("tmux"), providers }), null);
});

test("wiring T3/T4: không inject providers → factory thật cho cả tmux và herdr, mỗi kind một singleton", () => {
	// tmux cell detect thành công, không inject → provider tmux thật (không null)
	const tmux = resolveSurface(tmuxEnv, makeConfig(), "executor", 0, {
		tmuxBin: fakeBinary("tmux"),
	});
	assert.equal(tmux?.kind, "tmux");
	assert.notEqual(tmux, providers.tmux);
	// cùng singleton qua các lần gọi
	const again = resolveSurface(tmuxEnv, makeConfig(), "executor", 0, {
		tmuxBin: fakeBinary("tmux"),
	});
	assert.equal(again, tmux);
	// herdr cell detect thành công → provider herdr thật (T4), cùng singleton
	const herdr = resolveSurface(herdrEnv, makeConfig(), "executor", 0, {
		herdrBin: fakeBinary("herdr"),
		pingSocket: () => true,
	});
	assert.equal(herdr?.kind, "herdr");
	assert.notEqual(herdr, providers.herdr);
	assert.equal(
		resolveSurface(herdrEnv, makeConfig(), "executor", 0, {
			herdrBin: fakeBinary("herdr"),
			pingSocket: () => true,
		}),
		herdr,
	);
});

test("default pingSocket: socket thật sống → herdr; socket chết → null", async () => {
	const server = net.createServer(() => undefined);
	const socketPath = join(binDir, `herdr-live-${Math.random().toString(36).slice(2, 8)}.sock`);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		const liveEnv = { ...baseEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath };
		// KHÔNG inject pingSocket — dùng default net.connect probe
		const result = resolveSurface(liveEnv, makeConfig(), "executor", 0, {
			herdrBin: fakeBinary("herdr"),
			providers,
		});
		assert.equal(result?.kind, "herdr");

		// socket chết (file không tồn tại) → fail-closed null
		const deadEnv = { ...baseEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: join(binDir, "no-such.sock") };
		assert.equal(
			resolveSurface(deadEnv, makeConfig(), "executor", 0, {
				herdrBin: fakeBinary("herdr"),
				providers,
			}),
			null,
		);
	} finally {
		server.close();
	}
});
