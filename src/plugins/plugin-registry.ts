import type { Plugin } from "./plugin-define.ts";

export interface Plugin {
  readonly name: string;
  readonly enablers: readonly string[];
  readonly entryPatterns?: readonly string[];
  readonly configPatterns?: readonly string[];
  readonly toolingDependencies?: readonly string[];
  readonly pathAliases?: readonly [string, string][];
  readonly virtualModulePrefixes?: readonly string[];
}

export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  activePlugins(allDeps: string[]): Plugin[] {
    return this.plugins.filter((p) =>
      p.enablers.some((enabler) => {
        if (enabler.endsWith("/")) {
          return allDeps.some((d) => d.startsWith(enabler));
        }
        return allDeps.includes(enabler);
      }),
    );
  }

  allPlugins(): Plugin[] {
    return [...this.plugins];
  }
}