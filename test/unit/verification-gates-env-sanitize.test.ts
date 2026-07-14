import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Verify the env-sanitize default in `src/runtime/verification-gates.ts`.
 *
 * Fix under test: `isVerificationEnvSanitizeEnabled()` returns `false` ONLY
 * when `process.env.PI_CREW_VERIFICATION_SANITIZE_ENV === "0"` OR
 * `process.env.PI_TEAMS_VERIFICATION_SANITIZE_ENV === "0"`, and returns
 * `true` for any other value (including unset, "1", "true", "", "yes", etc.).
 *
 * Because the function reads from `process.env` at call time, we cannot mutate
 * the parent's env without poisoning parallel tests. Each case runs in a
 * freshly-spawned Node child process with a clean env built from the parent's
 * env MINUS any PI_CREW_VERIFICATION/PI_TEAMS_VERIFICATION vars.
 */

// Resolve the source module path relative to THIS test file's location so the
// test works on any machine (CI runners, different checkouts, Windows).
const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = pathToFileURL(resolve(HERE, "../../src/runtime/verification-gates.ts")).href;

function runWithEnv(overrides: Record<string, string | undefined>): boolean {
	// 1) Start from a copy of the parent env, but strip any existing
	//    PI_CREW_VERIFICATION*/PI_TEAMS_VERIFICATION* vars (so a test runner
	//    that happens to have them set cannot poison the result).
	const cleanEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith("PI_CREW_VERIFICATION") || k.startsWith("PI_TEAMS_VERIFICATION")) {
			continue;
		}
		if (v != null) {
			cleanEnv[k] = v;
		}
	}

	// 2) Merge in overrides; `undefined` means "delete the var from the env".
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) {
			delete cleanEnv[k];
		} else {
			cleanEnv[k] = v;
		}
	}

	// 3) Spawn a fresh Node child that loads the source via
	//    --experimental-strip-types and prints JSON.stringify(true|false).
	const script = [
		`import(${JSON.stringify(TARGET)})`,
		"\t.then(m => { console.log(JSON.stringify(m.isVerificationEnvSanitizeEnabled())); })",
		"\t.catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(2); });",
	].join("");

	const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
		env: cleanEnv,
		encoding: "utf8",
	});

	// 4) If the child exited non-zero, surface its stderr for debugging.
	if (r.status !== 0) {
		throw new Error(`child failed (status=${r.status}, signal=${r.signal}): ${r.stderr || "<no stderr>"}`);
	}

	// 5) Parse the JSON boolean the child printed.
	const out = (r.stdout ?? "").trim();
	return JSON.parse(out) as boolean;
}

describe("isVerificationEnvSanitizeEnabled default opt-out", () => {
	it("defaults to true when neither opt-out env var is set", () => {
		const result = runWithEnv({});
		assert.equal(result, true, `expected default sanitize=true, got ${result}`);
	});

	it("explicitly delete both env vars then re-check (true)", () => {
		const result = runWithEnv({
			PI_CREW_VERIFICATION_SANITIZE_ENV: undefined,
			PI_TEAMS_VERIFICATION_SANITIZE_ENV: undefined,
		});
		assert.equal(result, true, `expected sanitize=true after deleting both vars, got ${result}`);
	});

	it("returns false when PI_CREW_VERIFICATION_SANITIZE_ENV='0'", () => {
		const result = runWithEnv({ PI_CREW_VERIFICATION_SANITIZE_ENV: "0" });
		assert.equal(result, false, `expected sanitize=false when PI_CREW...='0', got ${result}`);
	});

	it("returns false when PI_TEAMS_VERIFICATION_SANITIZE_ENV='0'", () => {
		const result = runWithEnv({ PI_TEAMS_VERIFICATION_SANITIZE_ENV: "0" });
		assert.equal(result, false, `expected sanitize=false when PI_TEAMS...='0', got ${result}`);
	});

	it("returns true when set to '1' (sanitize enabled)", () => {
		const result = runWithEnv({ PI_CREW_VERIFICATION_SANITIZE_ENV: "1" });
		assert.equal(result, true, `expected sanitize=true when PI_CREW...='1', got ${result}`);
	});
});
