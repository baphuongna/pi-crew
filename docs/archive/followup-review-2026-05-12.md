# Follow-up Review — pi-crew (2026-05-12, round 2)

Author: Droid (Factory) | Related: `docs/archive/followup-plan-2026-05-12.md`, commit `926e6ee`.

Review after commit `926e6ee` applied the B1–B9 + A1–A2 fixes from `followup-plan-2026-05-12.md`.

## Result summary

- `npm run typecheck` → Passed
- `npm run test:unit` → **1411 tests / 1408 pass / 0 fail / 3 skip** (previously: 1389/1400 with 8 bash-on-Windows failures)
- `npm run check:lazy-imports` → **FAILS on Windows** (details below)

## Per-item status

| # | Item | Status | Notes |
|---|---|---|---|
| B1 | bash portability | ✅ Done | `resolveShellForScript` + `resolveBashCmd` in `src/utils/resolve-shell.ts`. Applied to `post-checks.ts` + `iteration-hooks.ts`. The 8 previously failing tests pass. |
| B2 | `worktree-manager.test.ts` | ⚠️ Partial | Has 3 tests (branch recovery, reuse, clean leader). Missing the `linkNodeModulesIfPresent` reject-file test. |
| B3 | `artifact-store.test.ts` | ✅ Done | Hash integrity + path traversal + nested dirs. |
| B4 | lock parity test | ✅ Done | 2 new tests: stale recovery sync+async, active lock throws. |
| B5 | setup-hook env filter | ⚠️ Partial | `sanitizeEnvSecrets` applied. Uses a deny-list `SECRET_KEY_PATTERN` instead of the allow-list proposed in the plan. |
| B6 | worktree checked-out hint | ✅ Done | try/catch + actionable error message. |
| B7 | LAZY marker | ✅ Done | Marker at `team-tool.ts:58`. |
| B8 | redaction roundtrip | ✅ Done | 3 tests (api_key, bearer, on-disk). |
| B9 | CI grep-check | ❌ Broken on Windows | Script uses `sed`, fails on Windows. |
| A1 | branchExists remote-tracking | ✅ Done | Returns `{ local, remoteOnly }`. |
| A2 | jiti fallback robust | ✅ Done | 3 candidates: `lib/jiti-register.mjs`, `register.mjs`, `dist/register.mjs`. |
| A3 | test alias cleanup | ⏭️ Skipped | Plan noted "not urgent". |

---

## Issues to address next

### C1 — (Medium, ~10 minutes) `scripts/check-lazy-imports.mjs` doesn't run on Windows

**File:** `scripts/check-lazy-imports.mjs`

**Problem:**
- The script uses `execSync("sed -n '...' ...")` to read the preceding line → `sed` isn't available on Windows by default.
- When sed fails, every line falls into the `catch` block → `bad.push(line)` → 13 false positives.
- `npm run ci` will always fail on a Windows dev machine.

**Proposed fix:** use plain Node instead of sed.

```js
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const out = execSync(`git grep -nE "await import\\(" -- "src/**/*.ts"`, { encoding: "utf-8" });
const bad = [];
const fileCache = new Map();

for (const line of out.split("\n").filter(Boolean)) {
	if (line.includes("// LAZY:")) continue;
	const m = line.match(/^([^:]+):(\d+):/);
	if (!m) continue;
	const [, file, lineNum] = m;
	if (!fileCache.has(file)) fileCache.set(file, readFileSync(file, "utf-8").split(/\r?\n/));
	const lines = fileCache.get(file);
	const prevLine = lines[Number(lineNum) - 2] ?? "";
	if (!prevLine.includes("// LAZY:")) bad.push(line);
}

if (bad.length) {
	console.error("Dynamic imports without `// LAZY:` marker:\n" + bad.join("\n"));
	process.exit(1);
}
console.log("All dynamic imports have `// LAZY:` marker.");
```

**Test:** run `npm run check:lazy-imports` on both Linux and Windows → both should print "All dynamic imports have `// LAZY:` marker."

---

### C2 — (Medium, ~20 minutes) `sanitizeEnvSecrets` uses a deny-list, not meeting the defense-in-depth goal of plan B5

**File:** `src/utils/env-filter.ts`

**Current state:**
```ts
export function sanitizeEnvSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !SECRET_KEY_PATTERN.test(key)) filtered[key] = value;
	}
	return filtered;
}
```

**Problem:**
- The deny-list only blocks keys matching `SECRET_KEY_PATTERN`. Variables whose names don't match (e.g. `DB_PASS`, `MY_KEY_FOO`, `INTERNAL_TOKEN_LEGACY`) will leak into the setup hook.
- The original plan B5 proposed an allow-list `["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "LANG", "PI_*"]` → much safer for user-provided hooks.

**Proposed fix:** add an overload with an allow-list, keeping the deny-list as the default for `buildChildPiSpawnOptions` (backward-compat).

```ts
export interface SanitizeOptions {
	allowList?: string[];   // glob-like, supports trailing * (e.g. "PI_*")
}

export function sanitizeEnvSecrets(env: NodeJS.ProcessEnv, options?: SanitizeOptions): Record<string, string> {
	const filtered: Record<string, string> = {};
	if (options?.allowList && options.allowList.length > 0) {
		const matchers = options.allowList.map((p) => {
			if (p.endsWith("*")) return (k: string) => k.startsWith(p.slice(0, -1));
			return (k: string) => k === p;
		});
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined && matchers.some((fn) => fn(key))) filtered[key] = value;
		}
		return filtered;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !SECRET_KEY_PATTERN.test(key)) filtered[key] = value;
	}
	return filtered;
}
```

**Apply at `worktree-manager.ts:runSetupHook`:**

```ts
env: sanitizeEnvSecrets(process.env, {
	allowList: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "PI_*"],
}),
```

**Tests to add:** `test/unit/env-filter.test.ts`:
- Allow-list pass-through for matching keys + reject the rest.
- Glob `PI_*` matches `PI_HOME`, `PI_CREW_X` but not `PIPELINE`.
- Default deny-list keeps old behavior.

---

### C3 — (Low, ~10 minutes) `resolveShellForScript` doesn't handle `.cmd/.bat` correctly on Windows

**File:** `src/utils/resolve-shell.ts`

**Current state:**
```ts
if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
	return { command: scriptPath, args: [] };
}
```

**Problem:**
- Node ≥ 20 blocks spawning `.bat/.cmd` directly without `shell: true` (CVE-2024-27980). The `execFileSync/spawn` code path will throw `EINVAL` or `ENOENT`.
- Consequence: post-check / iteration-hook written as `.cmd/.bat` will fail silently on Node 20+.

**Proposed fix:**
```ts
if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
	return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", scriptPath] };
}
```

**Tests to add:** in `test/unit/resolve-shell.test.ts` (create new):
- Linux: `.sh` → `{ bash, [path] }`.
- Windows + `.ps1` → `{ powershell, ["-File", path] }`.
- Windows + `.cmd` → `{ cmd.exe, ["/d", "/s", "/c", path] }`.

---

### C4 — (Low, ~15 minutes) Missing test for `linkNodeModulesIfPresent` rejecting a file source (BUG-006 regression guard)

**File:** `test/unit/worktree-manager.test.ts`

**Problem:**
- Plan B2 required this test but the commit didn't add it. If someone modifies `linkNodeModulesIfPresent` and removes the `isDirectory()` check, BUG-006 will regress without a test catching it.

**Proposed fix:** add one test (assuming `linkNodeModulesIfPresent` is exported or tested indirectly via `prepareTaskWorkspace` with `worktree.linkNodeModules=true`):

```ts
test("prepareTaskWorkspace skips linkNodeModules when source is a file", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wt-fn-"));
	initGitRepo(repo);
	// Place a FILE at node_modules instead of a directory
	fs.writeFileSync(path.join(repo, "node_modules"), "not a dir", "utf-8");
	// Write project config to enable linkNodeModules
	const cfgDir = path.join(repo, ".crew");
	fs.mkdirSync(cfgDir, { recursive: true });
	fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({
		worktree: { linkNodeModules: true },
	}), "utf-8");
	const manifest = minimalManifest(repo, "run-fn");
	const task = minimalTask("task-fn", repo);
	const result = prepareTaskWorkspace(manifest, task);
	assert.equal(result.nodeModulesLinked, false);
	fs.rmSync(repo, { recursive: true, force: true });
});
```

---

### C5 — (Low, ~5 minutes) `prepareTaskWorkspace` error message affected by locale

**File:** `src/worktree/worktree-manager.ts:127-140` (try/catch around `worktree add`)

**Problem:**
- The regex `/already checked out/` only matches when git runs with an English locale. On a user machine with `LANG=vi_VN` or Git for Windows with a different locale, the original message differs → falls back to throwing the raw error.

**Proposed fix:** force an English locale for the internal git command, or broaden the regex.

Option A (simpler): broaden the regex
```ts
if (/already checked out|is already used by worktree/i.test(msg)) { ... }
```

Option B (recommended): force `LANG=C` in the `git()` helper:
```ts
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, LANG: "C", LC_ALL: "C" },
	}).trim();
}
```

Option B standardizes all git output → also improves debugging.

---

### C6 — (Info, ~5 minutes) `branchExists` remote-only creates local from HEAD, may "lose" the remote's commits

**File:** `src/worktree/worktree-manager.ts:prepareTaskWorkspace`

**Current state:**
```ts
if (exists.local) {
	git(repoRoot, ["worktree", "add", worktreePath, branch]);
} else {
	git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);  // ← both remoteOnly and "doesn't exist" fall here
}
```

**Problem:**
- When `remoteOnly === true`, plan A1 proposed creating local from HEAD to avoid divergent tracking. The current code does exactly that, but:
  - The user pushed the branch from another machine → expects the worktree to contain that code.
  - There's no log/warning → silent drop.

**Proposed fix:** emit an info event/log when hitting the remoteOnly branch:
```ts
} else {
	if (exists.remoteOnly) {
		logInternalError("worktree.branchRemoteOnly", new Error(`Branch '${branch}' exists only on remote; creating local from HEAD instead of tracking remote.`), `branch=${branch}`);
	}
	git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
}
```

(Or push it out via a run event if there's a convenient event bus.)

---

## Implementation priority

| # | Item | Severity | Effort | Recommendation |
|---|---|---|---|---|
| 1 | C1 (lazy-imports cross-platform) | Medium | 10 minutes | Current sprint — block CI failure on Windows |
| 2 | C2 (allow-list env filter) | Medium | 20 minutes | Current sprint — defense-in-depth |
| 3 | C3 (.cmd/.bat on Node 20+) | Low | 10 minutes | Current sprint — ensure B1 is truly portable |
| 4 | C4 (test linkNodeModules file source) | Low | 15 minutes | Current sprint — close B2's regression gap |
| 5 | C5 (git locale-safe error parsing) | Low | 5 minutes | Next sprint |
| 6 | C6 (warn on remote-only branch) | Info | 5 minutes | Next sprint |

**Total effort:** ~65 minutes for the hardening batch.

---

## Proposed commit batches

- **Batch 1 (must-fix CI):** C1 + C3 → 1 PR "scripts/cmd portability fix" (~20 minutes).
- **Batch 2 (security/test):** C2 + C4 → 1 PR "env allow-list + worktree regression test" (~35 minutes).
- **Batch 3 (polish):** C5 + C6 → 1 PR "git locale + remote-only branch hint" (~10 minutes).

---

## Positive notes after round 3 review

- The 8 previously failing bash-on-Windows tests now pass 100%.
- The DRY refactor of `sanitizeEnvSecrets` (extracted from `child-pi.ts`) is good.
- The `worktree-manager` resume logic + actionable error is very helpful for UX.
- The lock parity test covers both sync/async paths (exactly the BUG-004 goal).
- The artifact hash test correctly verifies the invariant `sha256(file) == contentHash`.
- `resolveJitiRegisterPath` now tolerates various jiti packaging layouts.
- The `branchExists` upgrade to `{local, remoteOnly}` is accurate per plan A1.

---

## Verification

```
npm run typecheck                  → Passed
npm run check:lazy-imports         → Fails on Windows (sed not found)
npm run test:unit                  → 1411 tests, 1408 pass, 0 fail, 3 skip (227s)
git show 926e6ee --stat            → 16 files changed, 797(+) 22(-)
```
