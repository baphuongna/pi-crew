---
name: safe-bash
description: "Safe shell-command workflow. Use when executing shell commands, prefer read-only, avoid destructive actions. Triggers: run this command, execute bash, safe bash, avoid rm, destructive command, shell injection."
---

# safe-bash

Use this skill whenever a task may execute shell commands. This skill covers cross-platform shell safety, destructive action confirmation, and Windows-specific patterns.

## Classification

Every shell command is either **read-only** or **mutating**. Always report which it is.

### Read-only commands (safe)
```bash
pwd              # print working directory
ls -la           # list files
find . -name "*.ts" | head -20        # search without writing
rg "pattern" --type ts | head -20     # ripgrep without write
git status       # inspect state
git log --oneline -5  # recent commits
git diff --staged    # staged changes
npm view <pkg>   # query registry (no install)
npx tsc --noEmit  # typecheck (no write)
node -e "console.log(process.version)"  # inspect version
```

### Mutating commands (require confirmation)
```bash
npm install      # changes node_modules
git commit       # creates new commit
git push         # publishes to remote
rm -rf <path>    # DESTRUCTIVE
git reset --hard # rewrites history
npm publish      # publishes to registry
```

## Cross-Platform Considerations

### Windows vs Unix paths

```typescript
// ❌ Never hardcode paths with forward slashes on Windows
const path = "D:/project/src/file.ts";

// ✅ Use path.join() or Node's path module
import * as path from "path";
const filePath = path.join(cwd, "src", "file.ts");

// ✅ Or use forward slashes that work on both
const filePath = "src/file.ts"; // relative paths work on both
```

### argv vs cmd /c

```typescript
// ✅ Preferred on Windows: argv-based execution (no shell)
import { spawn } from "child_process";
spawn("node", ["--version"], { stdio: "pipe" });

// ✅ If shell needed: use cmd /c explicitly
spawn("cmd", ["/c", "dir /b"], { stdio: "pipe" });

// ❌ Don't use cmd /c with complex commands as single string
spawn("cmd", ["/c", "node --version && npm test"], { stdio: "pipe" });
```

### Package manager detection

```typescript
// Detect npm vs pnpm vs yarn
function detectPackageManager(cwd: string): "npm" | "pnpm" | "yarn" | "unknown" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}
```

## Heredoc and Quoting Gotchas

### Quoting variables in commands

```bash
# ❌ Unsafe: variable expansion without quoting
node -e "console.log('$PATH')"  # breaks on spaces

# ✅ Safe: escape single quotes in the string
node -e "console.log(process.env.PATH)"  # use env, not shell var

# ✅ For file paths with spaces
ls "D:/my project/src"
```

### Heredoc in scripts

```bash
# ❌ Heredoc inside double quotes expands variables
cat << EOF
HOME is $HOME
EOF

# ✅ Use single quotes to prevent expansion
cat << 'EOF'
HOME is $HOME
EOF
```

## Timeout and Background Execution

### Timeout long-running commands

```bash
# Linux/macOS: use timeout command
timeout 30 npm test  # kill after 30 seconds

# Node.js: use AbortSignal
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
spawn("npm", ["test"], { signal: controller.signal });

# Windows: use /wait flag
start /wait cmd /c "npm test"
```

### Background vs foreground

```bash
# Background: run and forget (no output capture)
npm test &

# Foreground with timeout
timeout 60 npm test || echo "Timed out or failed"
```

## Signal Handling

### SIGTERM vs SIGKILL

| Signal | Effect | Use case |
|---|---|---|
| SIGTERM (15) | Graceful termination request | Normal shutdown |
| SIGKILL (9) | Immediate forced termination | Unresponsive process |
| SIGINT (2) | Interrupt (Ctrl+C) | User cancel |

```bash
# Graceful: request termination
kill -15 <pid>   # or: kill <pid>

# Force: immediate termination
kill -9 <pid>    # or: kill -SIGKILL <pid>

# On Windows (cmd):
taskkill /pid <pid> /t /f  # /t=tree, /f=force
```

### Child process inheritance

When spawning subprocesses, child processes inherit the parent's signal handlers. Use `signal: controller.signal` in Node.js to give the child its own abort signal.

## Sudo and Interactive Prompts

### Detecting interactive prompts

```bash
# Check if stdin is a terminal
[ -t 0 ] && echo "Interactive" || echo "Non-interactive"
```

### Avoiding sudo prompts in scripts

```bash
# ❌ This will hang waiting for password
npm install -g typescript

# ✅ Use expect or non-interactive mode
sudo npm install -g typescript 2>/dev/null  # ignores prompt
NPM_CONFIG_INTERACTIVE=false npm install -g typescript
```

## Error Trapping

### set -e and set -o pipefail

```bash
#!/bin/bash
set -e  # Exit immediately on error
set -o pipefail  # Pipeline fails if any command fails

# Good for CI/CD scripts
npm test
```

### Capture and handle errors

```bash
# Capture exit code
npm test || {
  echo "Tests failed with exit code $?"
  exit 1
}

# Check for command existence
command -v npm >/dev/null 2>&1 || { echo "npm not found"; exit 1; }
```

## ANSI Color Code Stripping

For log parsing, strip ANSI escape codes:

```typescript
// Strip ANSI color codes from output
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[mK]/g, "");
}

// Usage
const output = stripAnsi(child.stdout);
const hasFailure = output.includes("FAIL");
```

Or via shell:
```bash
# Strip ANSI codes using sed
npm test 2>&1 | sed 's/\x1B\[[0-9;]*[mK]//g'
```

## Node.js vs Binary Detection

```typescript
// Detect node executable
import { execSync } from "child_process";
function findNode(): string {
  // Try common paths
  for (const candidate of [
    process.execPath,
    "node",
    "C:\\Program Files\\nodejs\\node.exe",
    "/usr/local/bin/node",
  ]) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore" });
      return candidate;
    } catch { /* continue */ }
  }
  return "node"; // fallback
}
```

## Destructive Action Confirmation

Never execute destructive commands without explicit confirmation:

| Command | Risk | Confirmation needed |
|---|---|---|
| `rm -rf <path>` | Permanent data loss | "Type the path to confirm" |
| `git reset --hard` | Undo all changes | "Confirm with: YES" |
| `git clean -fd` | Remove untracked files | "Confirm with: YES" |
| `npm publish` | Public package | "Confirm version X.Y.Z" |

**Confirmation pattern:**
```bash
# Require user to type the exact path
read -p "Type the directory path to confirm deletion: " CONFIRM
if [ "$CONFIRM" = "$TARGET_PATH" ]; then
  rm -rf "$TARGET_PATH"
else
  echo "Aborted: paths do not match"
fi
```

## Anti-patterns

- **`rm -rf` without path validation**: Always double-check the path before rm -rf
- **Blocking on subprocess**: Always use async spawn with timeout
- **Ignoring exit codes**: Check `$?` or capture `exitCode` from Node.js spawn
- **Leaking secrets in args**: Use environment variables instead of command-line args
- **Not handling Windows spaces**: Test on Windows before assuming paths work
- **Background process zombie**: Always handle process exit or store the pid for cleanup

---

## Source patterns

- `src/utils/resolve-shell.ts` — cross-platform shell detection
- `src/runtime/child-pi.ts` — spawn, killProcessPid, signal handling
- `src/worktree/worktree-manager.ts` — git commands via execFileSync
- `src/config/defaults.ts` — platform detection

---

## Verification

```bash
cd pi-crew

# Check exit code handling
node -e "const {spawnSync}=require('child_process'); console.log(spawnSync('false').status)"

# Test ANSI stripping
node -e "console.log('\x1B[32mgreen\x1B[0m'.replace(/\x1B\[[0-9;]*[mK]/g,''))"

# Verify cross-platform path
node -e "const p=require('path'); console.log(p.join('D:\\\\','project','src'))"

# TypeScript
npx tsc --noEmit
```