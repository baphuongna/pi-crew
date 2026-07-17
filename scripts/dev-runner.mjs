#!/usr/bin/env node
/**
 * Dev runner — spawn `watch:bundle` and `test:watch` in parallel.
 *
 * Replaces the `npm-run-all --parallel watch:bundle test:watch` form that
 * would require an additional dev-dependency. Uses Node's stdlib
 * `child_process.spawn` so we keep the dev tooling dependency-free.
 *
 * Behavior:
 *   - Spawns both child processes with stdio: inherit (the parent's TTY
 *     sees both streams interleaved).
 *   - Forwards Ctrl+C (SIGINT) and SIGTERM to both children so they shut
 *     down cleanly when the user aborts.
 *   - Exits with a non-zero code if EITHER child exits with a non-zero
 *     status (mimics `npm-run-all --parallel` semantics).
 *
 * Usage:
 *   npm run dev
 *   node scripts/dev-runner.mjs
 */

import { spawn } from "node:child_process";
import process from "node:process";

const tasks = [
	{ name: "watch:bundle", script: "watch:bundle" },
	{ name: "test:watch", script: "test:watch" },
];

/**
 * @typedef {{name: string, child: import("node:child_process").ChildProcess, exited: boolean, code: number|null, signal: NodeJS.Signals|null}} Task
 */

/** @type {Task[]} */
const children = tasks.map((t) => ({
	name: t.name,
	child: spawnNpm(t.script),
	exited: false,
	code: null,
	signal: null,
}));

let shuttingDown = false;
let exitCode = 0;

function spawnNpm(script) {
	return spawn("npm", ["run", "--silent", script], {
		stdio: "inherit",
		env: process.env,
	});
}

function maybeExit() {
	if (!shuttingDown) return;
	if (children.some((c) => !c.exited)) return;
	process.exit(exitCode);
}

function shutdown(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	process.stderr.write(`\n[dev-runner] received ${reason}, forwarding to children...\n`);
	for (const c of children) {
		if (c.exited) continue;
		try {
			c.child.kill("SIGTERM");
		} catch {
			/* already dead */
		}
	}
	// Hard-kill grace window: if children ignore SIGTERM for 3s, send SIGKILL.
	setTimeout(() => {
		for (const c of children) {
			if (c.exited) continue;
			try {
				c.child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}
	}, 3000).unref();
	maybeExit();
}

for (const c of children) {
	c.child.on("exit", (code, signal) => {
		c.exited = true;
		c.code = code;
		c.signal = signal;
		const note = signal ? `signal=${signal}` : `code=${code}`;
		process.stderr.write(`[dev-runner] ${c.name} exited (${note})\n`);
		// Non-zero is only meaningful when the child exited via code (not signal).
		if (signal === null && code !== 0) exitCode = exitCode || (code ?? 1);
		maybeExit();
	});

	c.child.on("error", (err) => {
		process.stderr.write(`[dev-runner] failed to spawn ${c.name}: ${err.message}\n`);
		c.exited = true;
		exitCode = exitCode || 1;
		maybeExit();
	});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
