# 0004 execFileSync Over execSync

Date: 2026-05-13

## Status

Accepted

## Context

`gh-protocol.ts` used `execSync` with string interpolation to construct `gh`
CLI commands. This creates a command injection surface when any parameter
(user input, repo name, PR number) contains shell metacharacters.

## Decision

Always use `execFileSync` for external commands. Pass arguments as an array,
not interpolated strings. This prevents shell injection entirely.

## Alternatives Considered

1. Sanitize inputs before interpolation. Rejected: fragile, easy to bypass.
2. Shell escape functions. Rejected: another dependency, edge cases.
3. `execFileSync` with argument array. Accepted — eliminates injection by design.

## Consequences

Positive:
- No command injection surface
- No need for input sanitization of shell metacharacters

Tradeoffs:
- Slightly more verbose code
- Cannot use shell features (pipes, redirects) in command
