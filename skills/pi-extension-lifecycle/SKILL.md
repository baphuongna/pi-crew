---
name: pi-extension-lifecycle
description: >
  Pi extension lifecycle and registration patterns.
  When NOT to use: single registration event (use direct API calls); for child worker lifecycle (use child-pi-spawning).

origin: pi-crew
triggers:
  - "add extension"
  - "register tools"
  - "session hooks"
  - "context API"
  - "extension lifecycle"

---
# pi-extension-lifecycle

Use this skill when working on Pi extension registration or lifecycle behavior.

## Source patterns distilled

- Pi core: `source/pi/packages/coding-agent/src/core/extensions/types.ts`, `loader.ts`, `runner.ts`
- Pi examples: `source/pi/packages/coding-agent/examples/extensions/`
- pi-crew extension entry: `src/extension/register.ts`, `src/extension/registration/*.ts`

## Rules

- Register tools, commands, shortcuts, widgets, providers, and event handlers from the extension factory or lifecycle callbacks.
- Tool definitions should use a TypeBox schema and an `execute(toolCallId, params, signal, onUpdate, ctx)` handler.
- Use fresh `ExtensionContext`/`ExtensionCommandContext` after session replacement (`newSession`, `fork`, `switchSession`, `reload`). Do not retain old context references for later work.
- For session-scoped work, derive session identity from `ctx.sessionManager.getSessionId()` and pass it into pi-crew `TeamContext`.
- Prefer small registration modules under `src/extension/registration/`; keep `index.ts` minimal.
- Clean up intervals, event subscriptions, child processes, and watchers on session switch/shutdown.
- Wrap optional Pi API hooks in compatibility checks/try-catch when supporting older Pi versions.

## Enforcement — Pi Extension Lifecycle Gate

**Before registering tools or handling session lifecycle, verify:**

- [ ] ExtensionContext/ExtensionCommandContext fresh after session replacement
- [ ] No stale context references retained after session switch/fork/reload
- [ ] Cleanup registered for intervals, subscriptions, child processes, watchers
- [ ] Tool/command names unique (no duplicate registrations)
- [ ] No blocking filesystem/network work in extension render callbacks

If ANY answer is NO → Stop. Fix lifecycle issues before proceeding.

## Anti-patterns

- Do not use stale context objects after session switch.
- Do not register duplicate tool/command names and assume override behavior.
- Do not perform blocking filesystem or network work inside extension render callbacks.
- Do not add hardcoded global keybindings without config or collision review.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
npm test
```
