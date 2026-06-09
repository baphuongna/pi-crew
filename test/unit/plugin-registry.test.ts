import { test, describe } from "node:test";
import assert from "node:assert";
import { PluginRegistry } from "../../src/plugins/plugin-registry.ts";
import { definePlugin } from "../../src/plugins/plugin-define.ts";
import { NextJsPlugin } from "../../src/plugins/plugins/nextjs.ts";
import { VitestPlugin } from "../../src/plugins/plugins/vitest.ts";

describe("PluginRegistry", () => {
  test("activates plugin by exact package name", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "test-plugin",
      enablers: ["test-pkg"],
    }));
    const active = registry.activePlugins(["test-pkg", "other-pkg"]);
    assert.ok(active.some(p => p.name === "test-plugin"));
  });

  test("activates plugin by prefix match (family)", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "storybook-plugin",
      enablers: ["@storybook/"],
    }));
    const active = registry.activePlugins(["@storybook/react", "@storybook/vue"]);
    assert.ok(active.some(p => p.name === "storybook-plugin"));
  });

  test("does not activate plugin with no matching dep", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "nextjs-plugin",
      enablers: ["next"],
    }));
    const active = registry.activePlugins(["react", "vite"]);
    assert.ok(!active.some(p => p.name === "nextjs-plugin"));
  });

  test("NextJsPlugin matches 'next' dependency", () => {
    const registry = new PluginRegistry();
    registry.register(NextJsPlugin);
    const active = registry.activePlugins(["next", "react"]);
    assert.ok(active.some(p => p.name === "nextjs"));
  });

  test("VitestPlugin matches 'vitest' dependency", () => {
    const registry = new PluginRegistry();
    registry.register(VitestPlugin);
    const active = registry.activePlugins(["vitest", "typescript"]);
    assert.ok(active.some(p => p.name === "vitest"));
  });
});

describe("definePlugin", () => {
  test("returns the plugin spec unchanged", () => {
    const plugin = definePlugin({ name: "my-plugin", enablers: ["my-pkg"] });
    assert.strictEqual(plugin.name, "my-plugin");
    assert.deepStrictEqual(plugin.enablers, ["my-pkg"]);
  });
});