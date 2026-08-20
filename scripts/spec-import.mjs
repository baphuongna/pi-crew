#!/usr/bin/env node
/**
 * spec-import.mjs — USER-facing SpecRecord import (ADR-6 §4 provenance v2).
 *
 * The ONLY production path that mints a manual+trusted spec (written to the
 * USER store ~/.pi/agent/specs/<projectSlug>/ with a digest-bound sidecar).
 * Skill/worker paths can never invoke this — they only ever write generated
 * (workspace-store) records, which the strict gate never re-executes.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings scripts/spec-import.mjs <record.json> [--cwd <project-dir>]
 *
 * The record must match SpecRecord (src/state/types.ts): id, version, title,
 * requirements[{id,text,priority:must|should|could}],
 * acceptance[{id,requirementId,check,command?,expectedDigest?,expectedExitCode?,
 * idempotent?}]. source is forced to manual+user by the import itself.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const cwdArgIdx = args.indexOf("--cwd");
const cwd = cwdArgIdx >= 0 ? args[cwdArgIdx + 1] : process.cwd();

if (!file) {
	console.error("Usage: node --experimental-strip-types scripts/spec-import.mjs <record.json> [--cwd <project-dir>]");
	process.exit(2);
}

let record;
try {
	record = JSON.parse(readFileSync(resolve(cwd, file), "utf-8"));
} catch (err) {
	console.error(`Cannot read/parse ${file}: ${err.message}`);
	process.exit(2);
}

const fail = (msg) => {
	console.error(`Invalid SpecRecord: ${msg}`);
	process.exit(2);
};
if (typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id)) fail("id missing/invalid");
if (typeof record.version !== "number") fail("version must be a number");
if (!Array.isArray(record.requirements) || record.requirements.length === 0) fail("requirements[] required");
for (const r of record.requirements) {
	if (typeof r.id !== "string" || typeof r.text !== "string") fail("requirements[].id/text required");
	if (!["must", "should", "could"].includes(r.priority)) fail(`requirements[${r.id}].priority must be must|should|could`);
}
if (!Array.isArray(record.acceptance) || record.acceptance.length === 0) fail("acceptance[] required");
const reqIds = new Set(record.requirements.map((r) => r.id));
for (const a of record.acceptance) {
	if (typeof a.id !== "string" || typeof a.check !== "string") fail("acceptance[].id/check required");
	if (!reqIds.has(a.requirementId)) fail(`acceptance[${a.id}].requirementId '${a.requirementId}' matches no requirement`);
	if (a.expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(a.expectedDigest)) fail(`acceptance[${a.id}].expectedDigest must be lowercase 64-hex sha-256`);
}

const store = await import(new URL("../src/state/stores/spec-store.ts", import.meta.url).href);
// The import IS the explicit user trust decision — userAction mint.
record.source = { kind: "manual", by: process.env.USER ?? "user", from: file };
const saved = store.saveSpecRecord(cwd, record, { userAction: true });
const trusted = store.isSpecTrusted(cwd, saved.id, saved);
console.log(`SpecRecord '${saved.id}' v${saved.version} imported.`);
console.log(trusted ? "  minted: manual+trusted (user store, digest-bound sidecar)" : "  ERROR: sidecar mint failed");
if (!trusted) process.exit(1);
