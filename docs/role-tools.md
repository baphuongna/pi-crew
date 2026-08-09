# Role → Tools reference (generated)

> **Auto-generated** from `src/config/role-tools.ts` (`ROLE_TOOL_CONFIGS`) and
> `src/runtime/role-permission.ts`. Do not edit by hand — run
> `node --experimental-strip-types scripts/gen-role-tools-docs.mjs`.
> The enforced source of truth is the code; this doc is a rendered view. The
> `agents/*.md` frontmatter is kept in sync by `test/unit/role-tools-docs-sync.test.ts`.

| Role | Permission | Tools (allowlist) | Excluded | Scratchpad |
|---|---|---|---|---|
| `explorer` | read_only | read, grep, find, ls, glob, bash | edit, write, web | — |
| `analyst` | read_only | — | edit, write, ask_question | — |
| `planner` | read_only | read, grep, find, ls, glob | edit, write, bash, web, ask_question | — |
| `critic` | read_only | read, grep, find, ls, glob | edit, write, bash, web | — |
| `executor` | workspace_write | — | — | ✅ |
| `reviewer` | read_only | read, grep, find, ls, glob, bash | edit, write | — |
| `writer` | workspace_write | read, edit, write, ls | bash, web, ask_question | — |
| `security-reviewer` | read_only | read, grep, find | edit, write, bash, web, ask_question | — |
| `verifier` | workspace_write | read, grep, find, ls, bash | edit, write, web | ✅ |
| `test-engineer` | workspace_write | read, edit, write, bash, ls | web | ✅ |
