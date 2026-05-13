# Platform (Cross-Platform)

## Behavior

pi-crew runs on Windows, macOS, and Linux. Primary development is on Windows.

### Windows Considerations

- **EBUSY/EPERM**: Files locked by antivirus, shell, or indexer
  - `rmSyncRetry()` with exponential backoff (50ms, 100ms, 200ms, 400ms)
  - `existsSync` check before cleanup in finally blocks
- **Path separators**: Use `path.join()` everywhere, never hardcoded `/`
- **Shell**: `resolve-shell.ts` handles `cmd.exe` vs `bash` detection
- **Case sensitivity**: Windows is case-insensitive for file paths

### Unix Considerations

- `unref()` on timers to prevent blocking process exit
- POSIX shell compatibility in any shell scripts
- Signal handling (SIGTERM, SIGINT) for graceful shutdown

### CI Matrix

All changes validated on:
- `ubuntu-latest` / Node 22
- `windows-latest` / Node 22
- `macos-latest` / Node 22
