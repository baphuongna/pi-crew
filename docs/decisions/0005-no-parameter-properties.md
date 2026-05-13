# 0005 No TypeScript Parameter Properties

Date: 2026-05-13

## Status

Accepted

## Context

Pi uses Node.js `--experimental-strip-types` mode to run TypeScript directly
without transpilation. This mode strips `type` annotations but does NOT
transform TypeScript-only syntax like parameter properties
(`constructor(private foo: string)`).

## Decision

Never use TypeScript parameter properties. Always declare fields explicitly
and assign them in the constructor body:

```typescript
// DO NOT:
class Foo {
  constructor(private bar: string) {}
}

// DO:
class Foo {
  private bar: string;
  constructor(bar: string) {
    this.bar = bar;
  }
}
```

## Alternatives Considered

1. Use tsx/ts-node for transpilation. Rejected: Pi doesn't bundle these.
2. Use parameter properties + hope Node adds support. Rejected: runtime crash.

## Consequences

Positive:
- Code runs correctly under Node strip-types mode
- No transpilation dependency

Tradeoffs:
- More verbose class definitions
- Easy to accidentally use parameter properties (caught by typecheck + test)
