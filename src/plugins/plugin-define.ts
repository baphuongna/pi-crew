/**
 * Simplifies plugin struct definition.
 */
export function definePlugin<T extends { name: string; enablers: readonly string[] }>(spec: T): T {
  return spec;
}