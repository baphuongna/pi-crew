#!/usr/bin/env node
// install-hooks.mjs — D3: point git at the committed .githooks directory.
//
// Idempotent + environment-tolerant: exits 0 when git is absent, when the
// cwd is not a git repo, or when `git config` fails for any reason — a
// developer convenience must never break `npm install` (the same reason
// postinstall.mjs is best-effort). Wired as the package.json `prepare`
// script so a plain `npm install` activates BOTH committed hooks:
//   .githooks/pre-commit — lockfile-drift gate (check-lockfile-sync)
//   .githooks/pre-push   — release gate (conflict markers + typecheck,
//                          + FULL test:unit when pushing to refs/heads/main)
import { spawnSync } from "node:child_process";

function git(args) {
	return spawnSync("git", args, { encoding: "utf8" });
}

function main() {
	const probe = git(["rev-parse", "--is-inside-work-tree"]);
	if (probe.error || probe.status !== 0) {
		console.log("[install-hooks] no usable git here — skipping core.hooksPath setup");
		return;
	}
	const set = git(["config", "core.hooksPath", ".githooks"]);
	if (set.error || set.status !== 0) {
		console.warn("[install-hooks] could not set core.hooksPath (non-fatal):", set.stderr?.trim() ?? set.error?.message);
		return;
	}
	console.log("[install-hooks] git core.hooksPath → .githooks (pre-commit + pre-push active)");
}

main();
