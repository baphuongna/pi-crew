---
name: resource-discovery-config
description: >
  pi-crew resource and configuration discovery workflow.
  When NOT to use: runtime state questions (use runtime-state-reader); model-specific config (use model-routing-context).

origin: pi-crew
triggers:
  - "discover agents"
  - "find teams"
  - "config override"
  - "resource discovery"
  - "skill loading"

---
# resource-discovery-config

Use this skill for pi-crew resource/config work.

## Source patterns distilled

- Pi resource loader: `source/pi/packages/coding-agent/src/core/resource-loader.ts`, extension `resources_discover` hook
- pi-crew discovery: `src/agents/discover-agents.ts`, `src/teams/discover-teams.ts`, `src/workflows/discover-workflows.ts`
- Config: `src/config/config.ts`, `src/schema/config-schema.ts`, `schema.json`, `docs/resource-formats.md`

## Rules

- Respect discovery precedence: project resources should override user/builtin where supported.
- Keep built-in resource formats stable and documented.
- Project config (`.pi/pi-crew.json`) must be sanitized: do not allow dangerous user-only settings such as agent override injection if project trust is lower.
- Resource paths exposed through Pi hooks must point to package-root resources after build; verify `__dirname` resolution carefully.
- Avoid dynamic inline imports; keep discovery synchronous or async according to call-site expectations.
- Validate config with schema and provide actionable errors.
- When adding new config fields, update defaults, schema, docs, tests, and examples together.

## Enforcement — Resource Discovery Config Gate

**Before adding config or changing resource discovery, verify:**

- [ ] Discovery precedence respected (project > user > builtin)
- [ ] Config schema validated with actionable errors on invalid input
- [ ] Dangerous user-only settings blocked in lower-trust contexts
- [ ] Resource paths resolved correctly (package-root not src/skills after build)
- [ ] New config fields have defaults, schema, docs, tests, and examples

If ANY answer is NO → Stop. Fix config/discovery issues before proceeding.

## Anti-patterns

- Resolving package skills to `src/skills` instead of package-root `skills` after publishing.
- Letting project-local config inject arbitrary global agent overrides.
- Introducing precedence ambiguity between project/user/builtin resources.
- Changing resource file syntax without migration notes.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/config-schema-validation.test.ts test/unit/config.test.ts test/unit/extension-api-surface.test.ts test/unit/agent-override-skills.test.ts
npm test
npm pack --dry-run
```
