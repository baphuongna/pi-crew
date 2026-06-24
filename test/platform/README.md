# Platform-specific tests (HB-002)

Bugs that only manifest on one OS slip past a single-OS unit suite. The
v0.9.3 incident (BSD-vs-GNU `grep` difference) is the canonical example.

Each `*.test.ts` here self-skips unless `process.platform` matches its
target. They are NOT in the default `npm test` glob.

## Files

| File | Target | Catches |
|---|---|---|
| `windows-rename.test.ts` | win32 | EBUSY/EPERM rename retry path (v0.9.1 atomic-write) |
| `posix-tools.test.ts` | !win32 | BSD-vs-GNU grep, /var→/private/var realpath (v0.9.3) |

## Running

```bash
# Locally (only the matching-OS tests run; others self-skip):
npx tsx --test test/platform/*.test.ts

# In CI: the OS matrix (ubuntu/windows/macos) exercises each platform's tests
# when PI_CREW_RUN_PLATFORM_TESTS=1 gates the glob.
```
