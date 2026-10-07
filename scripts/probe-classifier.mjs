#!/usr/bin/env node
/**
 * P2-1 (pi 1.0.4 adoption, 2026-10-07): manual live-fire probe for the
 * host-process classifier seam — mirrors the R2 p3b extension probe
 * (docs/reviews/pi-1.0.0-adoption-review-2026-10-03.md §R2.3).
 *
 * What it does:
 *   1. Writes a throwaway pi extension to a temp dir that, on
 *      before_agent_start, logs to stderr:
 *        - available classifiers   (modelRegistry.getAvailableOfType — ASYNC,
 *          credential-gated: models whose provider has a working key)
 *        - known classifier models (modelRegistry.getModelsOfType — sync
 *          catalog, NOT credential-gated)
 *        - ONE classify() call on the requested model with latency ms and the
 *          FULL structured result (answers / stopReason / errorMessage).
 *   2. Spawns `pi --mode json -p "reply ok" --extension <probe>` (override
 *      the binary with PI_CREW_PROBE_PI_BIN), captures stderr, and re-prints
 *      every [PROBE:classifier] line.
 *
 * Expected on THIS host (OPENCODE_API_KEY absent): available = [],
 * classify SKIPPED or stopReason:"error" + "Provider is not configured:
 * opencode" — the never-rejects shape the service wraps (§R2.3 R2-V).
 * The script ALWAYS exits 0: diagnostics, not a gate.
 *
 * Usage:
 *   node scripts/probe-classifier.mjs                       # default model
 *   PI_CREW_CLASSIFIER_MODEL=typesafe/jev-latest node scripts/probe-classifier.mjs
 *   node scripts/probe-classifier.mjs openrouter/~typesafe/jev-latest
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "[PROBE:classifier]";
const DEFAULT_MODEL = "opencode/jev-1.13-free";

const requestedModel = process.argv[2] ?? process.env.PI_CREW_CLASSIFIER_MODEL ?? DEFAULT_MODEL;

// ── 1. Throwaway extension probe (plain JS — pi loads it like any -e path) ──
const probeSource = `
export default function register(pi) {
	const TAG = ${JSON.stringify(TAG)};
	const MODEL = ${JSON.stringify(requestedModel)};
	// modelRegistry lives on the ExtensionContext passed to handlers
	// (core/extensions/types.d.ts:225), not on the top-level ExtensionAPI.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const reg = ctx && ctx.modelRegistry;
			if (!reg || typeof reg.classify !== "function") {
				console.error(TAG + " model registry or classify() absent on this surface");
				return undefined;
			}
			const fmt = (m) => (m && typeof m === "object" && m.provider && m.id ? m.provider + "/" + m.id : String(m));
			const catalog = reg.getModelsOfType ? reg.getModelsOfType("classifier") : [];
			console.error(TAG + " known classifier models (catalog, sync) = " + JSON.stringify(catalog.map(fmt)));
			let available = [];
			try {
				available = (await reg.getAvailableOfType("classifier")) ?? [];
			} catch (e) {
				console.error(TAG + " getAvailableOfType threw: " + e);
			}
			console.error(TAG + " available classifiers (credentialed, async) = " + JSON.stringify(available.map(fmt)));
			let model = null;
			for (const candidate of available) {
				if (fmt(candidate) === MODEL) { model = candidate; break; }
			}
			if (!model && (!Array.isArray(available) || available.length === 0)) {
				// Live-fire shape (R2 p3b): with zero credentialed classifiers, classify()
				// still accepts a CATALOG model and returns the structured never-rejects
				// error result (stopReason:"error" + "Provider is not configured: …").
				const slash = MODEL.indexOf("/");
			const provider = slash > 0 ? MODEL.slice(0, slash) : "";
			const id = slash > 0 ? MODEL.slice(slash + 1) : MODEL;
			try {
				model = (reg.findOfType && reg.findOfType("classifier", provider, id)) || (reg.getModelOfType && reg.getModelOfType("classifier", provider, id)) || null;
				}
				catch (e) {
					console.error(TAG + " catalog lookup threw: " + e);
				}
				if (model) console.error(TAG + " no credentialed classifier — live-firing the catalog entry " + fmt(model) + " (expect stopReason error)");
			}
			if (!model) {
				model = available[0];
				console.error(TAG + " requested model not available — substituting first available: " + fmt(model));
			} else if (available.length > 0) {
				console.error(TAG + " using " + fmt(model));
			}
			if (!model) {
				console.error(TAG + " classify SKIPPED — no classifier resolved (catalog + available both empty for " + MODEL + ")");
				return undefined;
			}
			const t0 = Date.now();
			const result = await reg.classify(model, {
				state: { failureSummary: "Provider error: api_error (probe fixture)", failedModel: "probe/model", exitCode: 1 },
				questions: {
					transient: {
						type: "bool",
						instructions: "A worker task failed and a retry on a different model is queued. Is the failure TRANSIENT (retry may succeed) rather than PERMANENT (retry will fail the same way)?",
						criteria: { true: "Transient — retry may succeed", false: "Permanent — retry will fail again" },
					},
				},
			});
			const ms = Date.now() - t0;
			console.error(TAG + " classify latency = " + ms + "ms");
			console.error(TAG + " classify result = " + JSON.stringify(result));
		} catch (e) {
			console.error(TAG + " probe error: " + (e && e.stack ? e.stack : String(e)));
		}
		return undefined;
	});
}
`;

const probeDir = mkdtempSync(join(tmpdir(), "pi-crew-probe-classifier-"));
const probePath = join(probeDir, "probe-classifier-ext.mjs");
writeFileSync(probePath, probeSource, "utf-8");

// ── 2. Spawn pi with the probe injected (json one-shot mode) ─────────────
const piBin = process.env.PI_CREW_PROBE_PI_BIN ?? "pi";
console.log(`probe-classifier: spawning \`${piBin} --mode json -p ... --extension <probe>\``);
console.log(`probe-classifier: requested classifier model = ${requestedModel}`);

const child = spawn(piBin, ["--mode", "json", "-p", "reply with ok", "--extension", probePath], {
	stdio: ["ignore", "pipe", "pipe"],
});

let probeLines = [];
let stdoutTail = "";
child.stdout.on("data", (chunk) => {
	stdoutTail = (stdoutTail + chunk.toString()).slice(-2000);
});
child.stderr.on("data", (chunk) => {
	for (const line of chunk.toString().split("\n")) {
		if (!line) continue;
		if (line.includes(TAG)) probeLines.push(line);
	}
});

const exitCode = await new Promise((resolve) => {
	child.on("error", (err) => {
		console.error(`probe-classifier: failed to spawn '${piBin}': ${err.message}`);
		console.error("probe-classifier: override the binary with PI_CREW_PROBE_PI_BIN=/path/to/pi");
		resolve(null);
	});
	child.on("close", (code) => resolve(code));
});

try {
	rmSync(probeDir, { recursive: true, force: true });
} catch {
	/* best-effort temp cleanup */
}

console.log("──── probe output (stderr) ────");
if (probeLines.length === 0) {
	console.log("(no [PROBE:classifier] lines captured — the extension may not have loaded;)");
	console.log("(check that the pi binary supports --extension and the session reached before_agent_start)");
} else {
	for (const line of probeLines) console.log(line);
}
console.log("──── end probe output ────");
console.log(`probe-classifier: pi exit code = ${exitCode ?? "spawn-error"}`);
if (stdoutTail.trim()) console.log(`probe-classifier: stdout tail (last 2KB): ${stdoutTail.trim().slice(-500)}`);
console.log(
	"probe-classifier: diagnostics complete — expected shape on a host without classifier credentials: available=[] + classify SKIPPED, or stopReason:\"error\" with errorMessage (never-rejects contract, §R2.3).",
);
process.exit(0);
