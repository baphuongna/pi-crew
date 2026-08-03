# Code Review Findings — pi-crew (2026-05-11)

Reviewer: Droid (Factory)
Scope: the entire `pi-crew/` directory (src + schema + worktree + state + extension), read-only.
Method: cross-referenced code against `AGENTS.md` (project + workspace), reviewed security/concurrency/cleanup per OWASP + best practices.

---

## Severity Summary

| ID | Severity | Area | Title |
|---|---|---|---|
| BUG-001 | **High** | Schema / Tool dispatch | `action: "retry"` rejected by schema but has a handler |
| BUG-002 | **High** | Artifact integrity | `contentHash` does not match the bytes written to disk |
| BUG-003 | Medium | AGENTS.md compliance | 12 `await import(...)` sites violate the "no dynamic inline imports" rule |
| BUG-004 | Medium | Concurrency | `withRunLockSync` and `withRunLock` handle stale locks differently |
| BUG-005 | Medium | Worktree lifecycle | `git worktree add -b <branch>` fails when the branch already exists from a previous run |
| BUG-006 | Low/Med | Worktree | `linkNodeModulesIfPresent` does not verify the source is a directory |
| BUG-007 | Low | Worktree setup hook | Errored / non-JSON hook output is swallowed entirely with no log |
| NIT-001 | Low | API hygiene | `__test__renameWithRetry` is called from a production code path |
| NIT-002 | Low | Code style | Empty-string argv flag in `git worktree remove` |
| NIT-003 | Low | Immutability | `executedConfig.runtime` is mutated on resume |
| NIT-004 | Low | Redaction | Need to verify the transcript on disk is always redacted |

---

## BUG-001 — `action: "retry"` rejected by schema but has a handler

**Severity:** High
**Files:**
- `src/schema/team-tool-schema.ts:18-49` (TypeBox schema)
- `src/schema/team-tool-schema.ts:95` (TS interface)
- `src/extension/team-tool.ts:264` (dispatch)
- `src/extension/team-tool/cancel.ts` (`handleRetry`)

### Description

The TypeBox schema `TeamToolParams` defines `action` as a `Type.Union` of `Type.Literal` values. The literal list **does not include** `"retry"`:

```ts
// src/schema/team-tool-schema.ts:18-49
action: Type.Optional(Type.Union([
    Type.Literal("run"),
    Type.Literal("parallel"),
    Type.Literal("plan"),
    Type.Literal("status"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("cancel"),
    // ... there is NO Type.Literal("retry") here
    Type.Literal("resume"),
    Type.Literal("respond"),
    ...
])),
```

But the TypeScript interface **does include** `"retry"`:

```ts
// src/schema/team-tool-schema.ts:95
action?: "run" | "parallel" | "plan" | "status" | "list" | "get" | "cancel" | "retry" | "resume" | ...;
```

And `handleTeamTool` dispatches it:

```ts
// src/extension/team-tool.ts:264
case "retry": return handleRetry(params, ctx);
```

### Consequences

- When pi-coding-agent validates tool params via the TypeBox schema (the usual way to gate input from the LLM), a call like `team {action: "retry"}` is **rejected at the validation layer** and never reaches `handleRetry`.
- The TS interface and TypeBox schema are out of sync; from the tool runtime's perspective, the `handleRetry` code path is **dead code**.

### How to reproduce

```bash
# From the pi REPL or via the tool API:
team(action="retry", runId="<id>")
# → schema validation error "must be equal to one of the allowed values"
```

### Suggested fix

Add the literal to the union and sync the tests:

```ts
// src/schema/team-tool-schema.ts
action: Type.Optional(Type.Union([
    Type.Literal("run"),
    ...
    Type.Literal("cancel"),
    Type.Literal("retry"),   // ← add this line
    Type.Literal("resume"),
    ...
])),
```

And add a test in `test/unit/team-tool-schema.test.ts`:

```ts
test("schema accepts action: retry", () => {
    const ok = Value.Check(TeamToolParams, { action: "retry", runId: "r1" });
    assert.strictEqual(ok, true);
});
```

---

## BUG-002 — `writeArtifact` writes redacted content but hashes the original bytes

**Severity:** High
**File:** `src/state/artifact-store.ts:106-129`

### Description

```ts
// src/state/artifact-store.ts:117-121
// Compute hash on original content for integrity verification.
const contentHash = hashContent(options.content);
const content = redactSecretString(options.content);
atomicWriteFile(filePath, content);
const stats = fs.statSync(filePath);
return {
    kind: options.kind,
    path: filePath,
    ...
    sizeBytes: stats.size,       // ← size of the redacted bytes
    contentHash,                 // ← hash of the original, pre-redaction bytes
    ...
};
```

`contentHash` is computed on `options.content` (pre-redaction) while the file on disk is `redactSecretString(options.content)`. `sizeBytes` is taken from `fs.statSync(filePath)` → it is the size of the redacted bytes.

### Consequences

- Any consumer that "verifies integrity" by re-hashing the file path will always get a digest **different** from `contentHash` whenever the original content contains a secret pattern.
- `sizeBytes` and `contentHash` are inconsistent with each other (size is post-redaction, hash is pre-redaction).
- The comment "Compute hash on original content for integrity verification" states the **rationale**, but the contract is still wrong: an integrity check compares the hash against the file on disk, not against an in-memory value.

### Two ways to fix

**Option A — Hash post-redaction (recommended):**
```ts
const content = redactSecretString(options.content);
atomicWriteFile(filePath, content);
const contentHash = hashContent(content);
const stats = fs.statSync(filePath);
```
Guarantees `contentHash === sha256(fs.readFileSync(filePath))`. You lose the ability to "trace back to the pre-redaction source" — but that is the safe behavior for the artifact store.

**Option B — Store both fields if needed:**
```ts
return {
    ...,
    contentHash,                  // pre-redaction (source-of-truth)
    storedContentHash: hashContent(content),  // post-redaction (matches the file)
    sizeBytes: stats.size,
};
```
Then update `ArtifactDescriptor` in `src/state/types.ts:8-16` and every consumer.

### Test to add

```ts
test("writeArtifact: contentHash matches bytes on disk", () => {
    const desc = writeArtifact(root, {
        kind: "log", relativePath: "x.log",
        content: "api_key=AKIA0123456789ABCDEF",
        producer: "test",
    });
    const onDisk = fs.readFileSync(desc.path);
    assert.strictEqual(desc.contentHash, sha256(onDisk));
    assert.strictEqual(desc.sizeBytes, onDisk.length);
});
```

---

## BUG-003 — 12 `await import(...)` sites violate the "Avoid dynamic inline imports" rule

**Severity:** Medium (rule violation, not a runtime bug)
**Source rule:** `pi-crew/AGENTS.md` — "Avoid dynamic inline imports."

### List of violations

| File | Line | Module lazily imported |
|---|---|---|
| `src/extension/team-tool.ts` | 35 | `../runtime/team-runner.ts` |
| `src/extension/team-tool/run.ts` | 18 | `../../runtime/team-runner.ts` |
| `src/extension/team-manager-command.ts` | 8 | `./team-tool.ts` |
| `src/extension/cross-extension-rpc.ts` | 8 | `./team-tool.ts` |
| `src/extension/registration/team-tool.ts` | 17 | `../team-tool.ts` |
| `src/extension/registration/subagent-tools.ts` | 9 | `../team-tool.ts` |
| `src/runtime/task-runner.ts` | 294 | `./task-runner/live-executor.ts` |
| `src/runtime/runtime-resolver.ts` | 40 | `@mariozechner/pi-coding-agent` |
| `src/runtime/live-session-runtime.ts` | 311 | `@mariozechner/pi-coding-agent` |
| `src/runtime/background-runner.ts` | 13 | `./team-runner.ts` |
| `src/runtime/yield-handler.ts` | 9 | `ajv` |
| `src/ui/run-action-dispatcher.ts` | 8 | `../extension/team-tool.ts` |

### Analysis

Some have a comment explaining the reason (extension/team-tool.ts:33-34):
> Heavy runtime — lazy-loaded to avoid 1.4s import cost at extension registration. executeTeamRun is only called when a team run actually executes.

This is a legitimate optimization. But AGENTS.md states an absolute "avoid" with no exceptions. Two ways to resolve:

**Option A — Update AGENTS.md to legitimize the lazy boundary:**
```md
- Avoid dynamic inline imports, EXCEPT at documented lazy-load boundaries
  to defer heavy runtime cost (mark with `// LAZY: <reason>`).
```

**Option B — Refactor to top-level imports:**
- Move heavy modules into a separate package, or use `import type` for type-only and a top-level runtime import.
- You could keep the lazy import for `runtime-resolver.ts:40` (`@mariozechner/pi-coding-agent`) because it is an optional peer dependency.

### Recommendation

Choose **Option A**, add a `// LAZY: <reason>` marker comment to each site, and add a grep check in CI to block unmarked dynamic imports.

---

## BUG-004 — `withRunLockSync` and `withRunLock` handle stale locks differently

**Severity:** Medium
**File:** `src/state/locks.ts:50-91`

### Description

**Sync path** (`acquireLockWithRetry` → `readLockState`):
```ts
// locks.ts:43-50
function readLockState(filePath: string, staleMs: number): boolean {
    if (!isLockStale(filePath, staleMs)) return false;
    try {
        fs.rmSync(filePath, { force: true });
        return true;     // ← only true when rmSync succeeds
    } catch {
        return false;    // ← a throw will happen at the caller
    }
}

// locks.ts:71-83
function acquireLockWithRetry(filePath, staleMs) {
    ...
    if (!readLockState(filePath, staleMs)) {
        throw new Error(`Run '...' is locked by another operation.`);
    }
    ...
}
```

**Async path** (`acquireLockWithRetryAsync` → `readLockStateAsync`):
```ts
// locks.ts:96-103
function readLockStateAsync(filePath: string, staleMs: number): void {
    try {
        if (isLockStale(filePath, staleMs)) fs.rmSync(filePath, { force: true });
    } catch {
        // Ignore stale-check races.
    }
}

// locks.ts:105-117
async function acquireLockWithRetryAsync(...) {
    ...
    if (Date.now() > deadline) {
        throw new Error(`Run '...' is locked by another operation.`);
    }
    readLockStateAsync(filePath, staleMs);    // ← return value not checked
    await sleep(delay);
    attempt++;
    // ← always loops again
}
```

### Consequences

- Sync version: if `rmSync` fails (file is locked by another process on Windows), it throws **immediately** the first time it sees a stale lock, with no retry.
- Async version: always retries until the `deadline`.

Inconsistent behavior → the same stale-lock + transient `rmSync` race can fail in the sync code path but pass in the async path.

### Suggested fix

Align the behavior: the sync version should also retry until the deadline:

```ts
function acquireLockWithRetry(filePath: string, staleMs: number): void {
    let attempt = 0;
    const deadline = Date.now() + staleMs * 2;
    while (true) {
        try {
            writeLockFile(filePath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw error;
            if (Date.now() > deadline) {
                throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
            }
            // Try to clear the stale lock, but don't bail on an rmSync error — let the loop retry
            try {
                if (isLockStale(filePath, staleMs)) fs.rmSync(filePath, { force: true });
            } catch { /* race — let loop retry */ }
            sleepSync(Math.min(250, 25 * 2 ** attempt));
            attempt++;
        }
    }
}
```

### Test to add

Expand `test/unit/locks-race.test.ts` with a case: stale lock + `rmSync` race (mock `fs.rmSync` to throw the first time and pass the second) → assert the lock is acquired after a retry.

---

## BUG-005 — `git worktree add -b <branch>` fails when the branch already exists from a previous run

**Severity:** Medium
**File:** `src/worktree/worktree-manager.ts:100-114`

### Description

```ts
// worktree-manager.ts:100-114
if (fs.existsSync(worktreePath)) {
    // ... reuse path: verify branch matches
    return { cwd: worktreePath, worktreePath, branch, reused: true };
}
git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
```

The reuse condition only checks the `worktreePath` directory. But the branch `pi-crew/<runId>/<taskId>` can exist in git while the worktree directory was deleted manually (or `cleanupRunWorktrees` deleted the directory while the git worktree metadata remained).

### Consequences

- After a crash or an incomplete cleanup, a retry/resume run fails with a git error: `fatal: a branch named 'pi-crew/.../...' already exists`.
- The user gets stuck and must run `git branch -D` manually.

### Suggested fix

Add a branch-existence check before `add`:

```ts
function branchExists(repoRoot: string, branch: string): boolean {
    try {
        git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
        return true;
    } catch {
        return false;
    }
}

function pruneStaleWorktrees(repoRoot: string): void {
    try { execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" }); }
    catch { /* best-effort */ }
}

// In prepareTaskWorkspace, before `git worktree add`:
pruneStaleWorktrees(repoRoot);
if (branchExists(repoRoot, branch)) {
    // Option 1: reuse the existing branch
    git(repoRoot, ["worktree", "add", worktreePath, branch]);
} else {
    git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
}
```

### Test to add

`test/unit/worktree-manager.test.ts` (does not yet exist):
1. Create a worktree, manually delete the directory (`rm -rf` outside of git), branch still exists.
2. Call `prepareTaskWorkspace` again → expect success, not a fatal error.

---

## BUG-006 — `linkNodeModulesIfPresent` does not verify the source is a directory

**Severity:** Low/Medium
**File:** `src/worktree/worktree-manager.ts:43-53`

### Description

```ts
function linkNodeModulesIfPresent(repoRoot: string, worktreePath: string): boolean {
    const source = path.join(repoRoot, "node_modules");
    const target = path.join(worktreePath, "node_modules");
    if (!fs.existsSync(source) || fs.existsSync(target)) return false;
    try {
        fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
        return true;
    } catch {
        return false;
    }
}
```

- If `repoRoot/node_modules` is a **file** (rare but possible with a corrupt setup), `existsSync` is still true, and the symlink is created with type `"dir"/"junction"` → undefined behavior, especially since a junction on Windows requires a directory.
- If the source is a **symlink to a directory**, a link chain can result → hard to debug.

### Suggested fix

```ts
function linkNodeModulesIfPresent(repoRoot: string, worktreePath: string): boolean {
    const source = path.join(repoRoot, "node_modules");
    const target = path.join(worktreePath, "node_modules");
    let sourceStat: fs.Stats;
    try { sourceStat = fs.statSync(source); } catch { return false; }
    if (!sourceStat.isDirectory()) return false;
    if (fs.existsSync(target)) return false;
    try {
        fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
        return true;
    } catch {
        return false;
    }
}
```

Use `statSync` (follows symlinks) instead of `existsSync` to also catch the "source is a dangling symlink" case.

---

## BUG-007 — Errored / non-JSON setup hook output is swallowed entirely with no log

**Severity:** Low
**File:** `src/worktree/worktree-manager.ts:75-89`

### Description

```ts
try {
    const lines = trimmed.split(/\r?\n/);
    const lastLine = lines[lines.length - 1] ?? trimmed;
    const parsed = JSON.parse(lastLine) as { syntheticPaths?: unknown };
    if (!Array.isArray(parsed.syntheticPaths)) return [];
    return [...new Set(parsed.syntheticPaths.filter(...).map(...))];
} catch {
    // Hook output was not valid JSON — treat as no synthetic paths
    return [];
}
```

The hook returns a JSON parse error → returns `[]` silently. The user has no idea the hook is misbehaving until the worktree is missing paths.

### Suggested fix

```ts
} catch (error) {
    logInternalError("worktree.setupHook.parse", error,
        `lastLine=${(trimmed.split(/\r?\n/).pop() ?? "").slice(0, 200)}`);
    return [];
}
```

Alternatively, if the hook output is non-empty but JSON parsing fails → emit an event into the run's event log.

---

## NIT-001 — `__test__renameWithRetry` called from a production code path

**File:** `src/state/atomic-write.ts:55-67, 99`

```ts
export function __test__renameWithRetry(tempPath, filePath, retries = 10, rename = fs.renameSync) {
    ...
}

// Production usage:
export function atomicWriteFile(filePath: string, content: string): void {
    ...
    __test__renameWithRetry(tempPath, filePath);    // ← production
}
```

Convention: the `__test__` name implies "test-only, not stable." Using it in production is a code smell. Rename it to `renameWithRetry` (a public utility) and re-export the test version under an alias.

---

## NIT-002 — Empty-string argv flag in `git worktree remove`

**File:** `src/worktree/cleanup.ts:64`

```ts
git(manifest.cwd, ["worktree", "remove", options.force ? "--force" : "", worktreePath].filter(Boolean));
```

The `cond ? "--force" : ""` then `.filter(Boolean)` pattern works but is fragile. Better:

```ts
const args = ["worktree", "remove"];
if (options.force) args.push("--force");
args.push(worktreePath);
git(manifest.cwd, args);
```

---

## NIT-003 — `executedConfig.runtime` mutated on resume

**File:** `src/extension/team-tool.ts:184-190`

```ts
const executedConfig = effectiveRunConfig(loadedConfig.config, params.config);
if (!executedConfig.runtime?.mode && resumeManifest.runtimeResolution?.safety === "explicit_dry_run") {
    const workersDisabled = executedConfig.executeWorkers === false || ...;
    if (!workersDisabled) executedConfig.runtime = { ...executedConfig.runtime, mode: "scaffold" };
}
```

The code may be assuming `effectiveRunConfig` returns a fresh object. Verify and document immutability, or replace with an explicit clone:

```ts
const executedConfig: PiTeamsConfig = {
    ...effectiveRunConfig(loadedConfig.config, params.config),
};
```

---

## NIT-004 — Verify the transcript on disk is always redacted

**File:** `src/runtime/child-pi.ts:148-152`, cross-referenced with `recoverCheckpointedTasks` (`src/extension/team-tool.ts:155-156`)

```ts
// child-pi.ts:148-152
function appendTranscript(input: ChildPiRunInput, line: string): void {
    if (!input.transcriptPath) return;
    fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
    fs.appendFileSync(input.transcriptPath, `${redactJsonLine(line)}\n`, "utf-8");
}
```

The transcript is redacted via `redactJsonLine` — good. But in the recovery path:

```ts
// team-tool.ts:155-156
const transcript = fs.readFileSync(transcriptPath, "utf-8");
const parsed = parsePiJsonOutput(transcript);
...
const resultArtifact = writeArtifact(manifest.artifactsRoot, {
    kind: "result", ..., content: parsed.finalText ?? "..."
});
```

Because `writeArtifact` redacts again (verified in BUG-002), double-redaction is idempotent (`***` does not match the secret pattern). OK.

**Action:** add a test `test/unit/redaction-transcript-roundtrip.test.ts`:
1. Spawn a mock child producing a JSON line with a secret.
2. Read the transcript file → assert it contains no raw secret.
3. Run `recoverCheckpointedTasks` → assert the result artifact also contains no secret.

---

## Test coverage gaps

| Module | Status |
|---|---|
| `src/worktree/worktree-manager.ts` | Only has `branch-freshness.test.ts`. Missing tests for `prepareTaskWorkspace` (reuse path, branch mismatch, setupHook). |
| `src/worktree/cleanup.ts` | Has `lifecycle-actions.test.ts` indirectly. Missing a direct test for dirty-preserve + diff artifact. |
| `src/state/locks.ts` (sync vs async parity) | `locks-race.test.ts` + `api-locks.test.ts` do not assert the difference described in BUG-004. |
| `src/state/artifact-store.ts` | Needs a hash/size match test (BUG-002). |
| `src/schema/team-tool-schema.ts` | `team-tool-schema.test.ts` has no case for `retry` (BUG-001). |

---

## Positives

- **Path-traversal guards** in `resolveInside` (`artifact-store.ts:96-105`) combine a relative-segment check, a `path.relative` check, and a `path.normalize + startsWith(base + sep)` check.
- **Atomic write** uses `O_EXCL | O_NOFOLLOW`, a post-open `fstatSync().isFile()` verification, and a Windows EPERM/EBUSY rename retry.
- **Process management** in `child-pi.ts` tracks the PID in `activeChildProcesses`, supports `taskkill /T /F` (Win) + `process.kill(-pid, ...)` (POSIX), has a hard-kill fallback, and a post-exit stdio guard.
- **Env-secret filtering** before spawning the child Pi (`child-pi.ts:113`) uses `SECRET_KEY_PATTERN` to strip token/api_key/password from the env.
- **Default-safe execution**: `executeWorkers=false` / `PI_CREW_EXECUTE_WORKERS=0` / `PI_TEAMS_EXECUTE_WORKERS=0` block workers; `runtime.mode=scaffold` for dry-runs.
- **Index.ts minimal**: follows the rule, only 5 lines.
- **Lockstep destructive gates**: `delete` requires `confirm:true`, referenced resources block unless `force:true` (verified in `management.ts:344-353`).

---

## Suggested fix priority

1. **BUG-001** (5 minutes): add one line `Type.Literal("retry")` + 1 test.
2. **BUG-002** (15 minutes): choose Option A, swap the hash/write order + add an integrity test.
3. **BUG-004** (30 minutes): align the sync/async lock retry behavior + test.
4. **BUG-005** (1 hour): add a branch-existence check + worktree prune before add, write tests.
5. **BUG-003** (1 hour): update AGENTS.md with a rule exception for lazy boundaries, add marker comments.
6. The rest: batch into a later release.
