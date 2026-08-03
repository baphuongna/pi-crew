# Follow-up Plan — pi-crew (2026-05-12)

Author: Droid (Factory) | Related: `docs/archive/code-review-2026-05-11.md`, commits `2aebf33`, `7c5b3c2`.

This document consolidates the outstanding items AFTER fixing BUG-001..BUG-007 + NIT-001..NIT-004, comprising:
1. **Minor concerns** arising from the fixes just applied.
2. **Newly discovered gaps** found when re-reviewing the entire `pi-crew/` codebase.

Every item includes an effort estimate, priority level, related file/code section, and a concrete fix proposal.

---

## Part A — Adjusting minor concerns from the fixes just applied

### A1 — `branchExists` only checks local ref → misses remote-tracking branches

**Severity:** Low | **Effort:** ~20 minutes | **File:** `src/worktree/worktree-manager.ts:100-107`

**Current state:**
```ts
function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch { return false; }
}
```

**Problem:**
- Only checks `refs/heads/<branch>`. If the repo has a remote-tracking `refs/remotes/origin/<branch>` (pushed from another machine) but no local one yet, the function returns `false` → enters the `worktree add -b <branch> HEAD` branch → git may fail with "a branch named ... already exists" (because git creates a local branch from the remote) or create a local branch divergent from the remote.
- Rare in single-machine workflows but easily hit with CI/runner shared repos.

**Proposed fix:**
```ts
function branchExists(repoRoot: string, branch: string): { local: boolean; remoteOnly: boolean } {
  let local = false;
  try { git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]); local = true; } catch {}
  if (local) return { local: true, remoteOnly: false };
  // Check remote-tracking
  try {
    const out = execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/remotes/*/${branch}`],
      { cwd: repoRoot, encoding: "utf-8" }).trim();
    return { local: false, remoteOnly: out.length > 0 };
  } catch { return { local: false, remoteOnly: false }; }
}

// In prepareTaskWorkspace:
const exists = branchExists(repoRoot, branch);
if (exists.local) {
  git(repoRoot, ["worktree", "add", worktreePath, branch]);
} else if (exists.remoteOnly) {
  // Create local from HEAD instead of remote (avoid divergent track)
  git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
} else {
  git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
}
```

**Tests to add:** `test/unit/worktree-manager.test.ts`:
1. Mock `git for-each-ref` returning a remote-tracking ref → assert no throw.
2. Branch exists in both local and remote → prefer local (reuse).

---

### A2 — `resolveJitiRegisterPath` fallback now requires an `exists()` check

**Severity:** Low | **Effort:** ~10 minutes | **File:** `src/runtime/async-runner.ts:33-39`

**Current state:**
```ts
try {
  const fromRequire = jitiRegisterPathFromPackageJson(requireFromHere.resolve("jiti/package.json"));
  if (exists(fromRequire)) return fromRequire;   // ← added exists() check
} catch { /* Fall through. */ }
return undefined;
```

**Problem:**
- Old behavior: `require.resolve()` succeeds → push into candidates → return path (assumes `lib/jiti-register.mjs` always exists next to `package.json`).
- New behavior: adds an `exists()` check → if the test mock for `exists` only accepts one different path, the fallback always fails. The behavior is fine for production (file always exists), but reduces robustness with exotic jiti packaging (e.g. `lib` renamed in a distro build).
- Not really a bug, just a defensive change.

**Proposed fix:**
Keep the `exists()` check (safer), but add another fallback with `path.join(dirname, "register.mjs")` for different jiti versions, and log a diagnostic event when both miss:

```ts
try {
  const pkgPath = requireFromHere.resolve("jiti/package.json");
  const candidates = [
    jitiRegisterPathFromPackageJson(pkgPath),                          // lib/jiti-register.mjs
    path.join(path.dirname(pkgPath), "register.mjs"),                  // register.mjs (older jiti)
    path.join(path.dirname(pkgPath), "dist", "register.mjs"),          // dist/register.mjs (some pkg layouts)
  ];
  for (const c of candidates) if (exists(c)) return c;
} catch { /* Fall through. */ }
return undefined;
```

**Tests to add:** `test/unit/async-runner.test.ts`:
- Case where `lib/jiti-register.mjs` is missing but `register.mjs` exists → resolver returns it.

---

### A3 — Test alias `__test__renameWithRetry*` became a `const`, may disable monkey-patching

**Severity:** Info | **Effort:** ~5 minutes | **File:** `src/state/atomic-write.ts:73, 91`

**Current state:**
```ts
export const __test__renameWithRetry = renameWithRetry;
```

**Problem:**
- If old tests do `import * as mod from "../atomic-write.ts"; mod.__test__renameWithRetry = mockFn;` → the assignment fails (read-only) or has no effect on `atomicWriteFile` (which calls the local `renameWithRetry`).
- Currently no test in the repo monkey-patches this field (`Grep` confirmed), so it's not a bug.

**Proposed fix:**
- Keep the alias as-is (zero practical impact).
- Or remove both aliases to reduce the API surface: only export `renameWithRetry`, `renameWithRetryAsync`. Update tests if any use the alias.

**Action:** only do this when cleaning up the API surface; not urgent.

---

## Part B — Newly discovered gaps from re-review

### B1 — `bash` hardcoded → broken on Windows (root cause of 8 test failures)

**Severity:** Medium | **Effort:** ~45 minutes | **Files:**
- `src/runtime/post-checks.ts:82`
- `src/runtime/iteration-hooks.ts:137`

**Current state:**
```ts
// post-checks.ts:82
const output = execFileSync("bash", [scriptPath], { ... });

// iteration-hooks.ts:137
const child = spawn("bash", [hookScriptPath], { ... });
```

**Problem:**
- On Windows, `bash` is usually not on the PATH (unless Git Bash/WSL is installed). All 8 currently failing tests are due to this.
- Hot code path (post-task check, iteration hook) → Windows users cannot use this feature.
- The comment in the file says "Spawns `bash <script>`" → docs need updating too.

**Proposed fix:**
1. Resolve bash intelligently:
```ts
function resolveBashCmd(): string {
  if (process.platform !== "win32") return "bash";
  // Try Git Bash locations
  for (const cand of [
    process.env.SHELL,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ]) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return "bash"; // last resort — let spawn fail with clearer error
}
```
2. Replace both `"bash"` occurrences with `resolveBashCmd()`.
3. On Windows, if the script is `.ps1` → use `powershell -File`; if `.cmd/.bat` → spawn directly.
4. Or simpler: skip the test if `!isScriptRunnable("bash")`.

**Tests to add:**
- On Linux CI: current tests pass.
- On Windows: skip if bash is unavailable, or create a `.ps1` variant.
- Mock test for `resolveBashCmd()` with a platform stub.

---

### B2 — Missing direct tests for `worktree-manager.ts` (covers BUG-005, BUG-006)

**Severity:** Medium | **Effort:** ~1h | **File:** missing `test/unit/worktree-manager.test.ts`

**Problem:**
- The BUG-005 fix (`branchExists` + `pruneStaleWorktrees`) and BUG-006 fix (`isDirectory()` check) have **no direct tests**.
- The code review flagged this, but the fix commit only added tests for the schema.

**Proposed fix:** create `test/unit/worktree-manager.test.ts` with (using `tmpdir` + real git):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareTaskWorkspace } from "../../src/worktree/worktree-manager.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

test("prepareTaskWorkspace recovers when branch exists but worktree dir is gone", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wt-"));
  initGitRepo(repo);
  // Pre-create the branch (simulating leftover from crashed run)
  execFileSync("git", ["branch", "pi-crew/run1/task1"], { cwd: repo });
  const manifest = { /* ... minimal manifest ... */ } as TeamRunManifest;
  const task: TeamTaskState = { id: "task1", /* ... */ } as TeamTaskState;
  const result = prepareTaskWorkspace(manifest, task);
  assert.ok(result.worktreePath);
});

test("linkNodeModulesIfPresent rejects when node_modules is a file", () => {
  // ... create file at node_modules location → assert no symlink created
});
```

---

### B3 — `artifact-store.ts` missing tests for hash/size integrity (covers BUG-002)

**Severity:** Medium | **Effort:** ~20 minutes | **File:** missing `test/unit/artifact-store.test.ts`

**Problem:**
- The BUG-002 fix changed the hash from `options.content` to `redactSecretString(options.content)` ensuring `contentHash` matches the bytes on disk.
- There is no test verifying this. There's `api-artifact-security.test.ts` but it doesn't assert the hash.

**Proposed fix:** create `test/unit/artifact-store.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { writeArtifact } from "../../src/state/artifact-store.ts";

test("writeArtifact: contentHash matches sha256 of bytes on disk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-art-"));
  const desc = writeArtifact(root, {
    kind: "log", relativePath: "x.log",
    content: "api_key=AKIA0123456789ABCDEF\nplain text",
    producer: "test",
  });
  const onDisk = fs.readFileSync(desc.path);
  const expected = createHash("sha256").update(onDisk).digest("hex");
  assert.strictEqual(desc.contentHash, expected);
  assert.strictEqual(desc.sizeBytes, onDisk.length);
  assert.ok(!onDisk.toString("utf-8").includes("AKIA0123456789ABCDEF"));
});

test("writeArtifact: rejects path traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-art-"));
  assert.throws(() => writeArtifact(root, {
    kind: "log", relativePath: "../escape.log", content: "x", producer: "t",
  }), /Invalid artifact path/);
});
```

---

### B4 — Missing sync vs async parity test for lock retry (covers BUG-004)

**Severity:** Low | **Effort:** ~30 minutes | **File:** extend `test/unit/locks-race.test.ts`

**Problem:**
- The BUG-004 fix synchronized sync ↔ async behavior (both retry up to the deadline). `locks-race.test.ts` only tests superficially; there's no case for `rmSync` race + asserting the lock is acquired after retry for both sync and async.

**Proposed fix:** add 2 tests:
```ts
test("withRunLockSync retries when rmSync fails once on stale lock", async () => {
  // Create stale lock, monkey-patch fs.rmSync first call → throw EBUSY
  // Assert lock is acquired on retry
});

test("withRunLock (async) and withRunLockSync exhibit identical stale-lock recovery", async () => {
  // Same scenario for both → both succeed
});
```

---

### B5 — `runSetupHook` doesn't filter dangerous env vars when spawning the hook

**Severity:** Low (defense-in-depth) | **Effort:** ~15 minutes | **File:** `src/worktree/worktree-manager.ts:67-88`

**Current state:**
```ts
const result = spawnSync(nodeHook ? process.execPath : hookPath, ..., {
  cwd: worktreePath,
  encoding: "utf-8",
  input: JSON.stringify({...}),
  timeout: cfg.setupHookTimeoutMs ?? 30_000,
  shell: false,
  // ← Does NOT pass env → spawn uses process.env (full inherit)
});
```

**Problem:**
- The hook runs with the full `process.env` → may leak `API_KEY`, `*_TOKEN`, `OPENAI_KEY`, etc. In contrast, `post-checks.ts` and `iteration-hooks.ts` already restrict env.
- AGENTS.md security baseline: "env-secret filtering before spawn".

**Proposed fix:**
```ts
import { sanitizeEnvSecrets } from "../utils/redaction.ts"; // or equivalent

const result = spawnSync(..., {
  cwd: worktreePath,
  encoding: "utf-8",
  input: JSON.stringify({...}),
  timeout: cfg.setupHookTimeoutMs ?? 30_000,
  shell: false,
  env: sanitizeEnvSecrets(process.env, { allowList: ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "LANG", "PI_*"] }),
});
```

(Leverage the existing helper in `child-pi.ts` — refactor into a shared util.)

---

### B6 — `prepareTaskWorkspace` has no assertion about branch sanity after `branchExists`

**Severity:** Info | **Effort:** ~10 minutes | **File:** `src/worktree/worktree-manager.ts:127-133`

**Current state:**
```ts
pruneStaleWorktrees(repoRoot);
if (branchExists(repoRoot, branch)) {
  git(repoRoot, ["worktree", "add", worktreePath, branch]);
}
```

**Problem:**
- If the branch is currently **checked out** in another worktree (not yet pruned), `git worktree add <path> <branch>` will fail. We should catch this and emit a clearer hint to the user.

**Proposed fix:** wrap with try/catch, parse the error message, throw an error with an actionable message:
```ts
try {
  git(repoRoot, ["worktree", "add", worktreePath, branch]);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  if (/already checked out at/.test(msg)) {
    throw new Error(`Branch '${branch}' is checked out at another worktree. Run \`team cleanup runId=${manifest.runId} force=true\` or manually remove the conflicting worktree.`);
  }
  throw error;
}
```

---

### B7 — `team-tool.ts` has 1 lazy-import `handleRun` not following the `// LAZY: <reason>` style

**Severity:** Info | **Effort:** ~2 minutes | **File:** `src/extension/team-tool.ts:56-62`

**Current state:**
```ts
// Lazy-loaded: run.ts pulls in spawnBackgroundTeamRun, resolveCrewRuntime, etc.
// Static import fails silently in some jiti contexts (child-process), leaving handleRun undefined.
import type { handleRun as HandleRunFn } from "./team-tool/run.ts";
let _cachedHandleRun: typeof HandleRunFn | undefined;
async function handleRun(...args: Parameters<typeof HandleRunFn>): Promise<...> {
  if (!_cachedHandleRun) {
    const mod = await import("./team-tool/run.ts");   // ← missing // LAZY: marker
    ...
  }
}
```

**Proposed fix:** add the marker to align with the other 11 already-marked sites:
```ts
async function handleRun(...) {
  if (!_cachedHandleRun) {
    // LAZY: run.ts pulls in spawnBackgroundTeamRun + resolveCrewRuntime; also avoids jiti import race.
    const mod = await import("./team-tool/run.ts");
    ...
  }
}
```

---

### B8 — `redaction-transcript-roundtrip.test.ts` doesn't exist yet (NIT-004)

**Severity:** Low | **Effort:** ~30 minutes | **File:** missing new test

**Problem:**
- Code review NIT-004 suggested a test verifying that the transcript on disk and the artifact result both contain no raw secrets. This test doesn't exist yet.

**Proposed fix:** create `test/unit/redaction-transcript-roundtrip.test.ts`:
1. Create a fake transcript JSONL with a line containing `OPENAI_API_KEY=sk-abc...`.
2. Call `appendTranscript` (via the `child-pi` helper export).
3. Read the file → assert no raw secret.
4. Call the recovery path → assert the artifact result is also redacted.

---

### B9 — CI grep-check to block `await import(...)` without a marker

**Severity:** Low | **Effort:** ~15 minutes | **File:** add script + GitHub Actions

**Problem:**
- Code review BUG-003 Option A proposed "add a grep-check in CI to block unmarked dynamic imports". Not done yet.

**Proposed fix:** create `scripts/check-lazy-imports.mjs`:
```js
import { execSync } from "node:child_process";
const out = execSync(
  `git grep -nE 'await import\\(' -- 'src/**/*.ts' | grep -v '// LAZY:'`,
  { encoding: "utf-8" }
).split("\n").filter((l) => l && !l.includes("// LAZY:"));
// Or check that the preceding line contains `// LAZY:`
if (out.length > 0) {
  console.error("Dynamic imports without `// LAZY:` marker:\n" + out.join("\n"));
  process.exit(1);
}
```
Add to `package.json`:
```json
"scripts": {
  "check:lazy-imports": "node scripts/check-lazy-imports.mjs",
  "ci": "npm run typecheck && npm run check:lazy-imports && npm test && npm pack --dry-run"
}
```

---

## Implementation priority

| # | Item | Severity | Effort | Recommendation |
|---|---|---|---|---|
| 1 | B1 (bash portability) | Medium | 45 minutes | Current sprint — fix 8 failing tests on Windows |
| 2 | B2 (worktree test) | Medium | 1h | Current sprint — regression guard for BUG-005/006 |
| 3 | B3 (artifact-store test) | Medium | 20 minutes | Current sprint — verify BUG-002 fix |
| 4 | A1 (branchExists remote-tracking) | Low | 20 minutes | Next sprint |
| 5 | B5 (setup-hook env filter) | Low | 15 minutes | Next sprint — defense-in-depth |
| 6 | B6 (worktree checked-out hint) | Info | 10 minutes | Next sprint — UX |
| 7 | B7 (LAZY marker consistency) | Info | 2 minutes | Anytime |
| 8 | B4 (lock parity test) | Low | 30 minutes | Next sprint |
| 9 | B8 (redaction roundtrip test) | Low | 30 minutes | Next sprint |
| 10 | B9 (CI grep-check) | Low | 15 minutes | Next sprint |
| 11 | A2 (async-runner fallback robust) | Low | 10 minutes | Not urgent |
| 12 | A3 (test alias cleanup) | Info | 5 minutes | Optional |

**Total effort priority 1 (medium):** ~2h 5 minutes.
**Total effort priority 2 (low):** ~1h 50 minutes.

---

## Proposed commit batches

- **Batch 1 (must-fix):** B1 + B2 + B3 → 1 PR "test+portability hardening" (~2h).
- **Batch 2 (nice-to-have):** A1 + B5 + B6 + B7 + B9 → 1 PR "worktree + lazy-import polish" (~1h).
- **Batch 3 (test debt):** B4 + B8 → 1 PR "additional regression tests" (~1h).
- **Defer:** A2, A3 until there's a user-visible issue.

---

## Positive notes after round 2 review

- All 7 BUGs + 4 NITs from the prior code review have been fixed with clear commits, with tests for the schema.
- The `// LAZY:` comment has been consistently added at 11/12 dynamic import sites.
- Lock retry logic is now unified sync ↔ async (both have deadline + retry).
- Worktree handle crash resume works correctly (prune + branchExists fallback).
- Artifact `contentHash` is now verifiable via `sha256(fs.readFileSync(desc.path))`.
- No more `any` types in `src/` (grep confirmed).
- `node_modules/jiti` resolution is robust across any monorepo layout.
