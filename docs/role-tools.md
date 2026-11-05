# Role → Tools reference (generated)

> **Auto-generated** from `src/config/role-tools.ts` (`ROLE_TOOL_CONFIGS`) and
> `src/runtime/role-permission.ts`. Do not edit by hand — run
> `node --experimental-strip-types scripts/gen-role-tools-docs.mjs`.
> The enforced source of truth is the code; this doc is a rendered view. The
> `agents/*.md` frontmatter is kept in sync by `test/unit/role-tools-docs-sync.test.ts`.

| Role | Permission | Tools (allowlist) | Excluded | Scratchpad |
|---|---|---|---|---|
| `explorer` | read_only | read, grep, find, ls, glob, ask | edit, write, bash, web | — |
| `analyst` | read_only | — | edit, write | — |
| `planner` | read_only | read, grep, find, ls, glob, ask | edit, write, bash, web | — |
| `critic` | read_only | read, grep, find, ls, glob, ask | edit, write, bash, web | — |
| `executor` | workspace_write | — | — | ✅ |
| `reviewer` | read_only | read, grep, find, ls, glob, ask | edit, write | — |
| `writer` | workspace_write | read, edit, write, ls, ask | bash, web | — |
| `security-reviewer` | read_only | read, grep, find, ask | edit, write, bash, web | — |
| `verifier` | workspace_write | read, grep, find, ls, bash, scratchpad, ask | edit, write, web | ✅ |
| `test-engineer` | workspace_write | read, edit, write, bash, ls, glob, grep, find, scratchpad, ask, delegate | web | ✅ |
