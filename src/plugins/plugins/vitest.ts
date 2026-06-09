import { definePlugin } from "../plugin-define.ts";

export const VitestPlugin = definePlugin({
  name: "vitest",
  enablers: ["vitest"],
  entryPatterns: [
    "**/*.test.{ts,tsx}",
    "**/*.spec.{ts,tsx}",
    "src/**/*.test.{ts,tsx}",
    "src/**/*.spec.{ts,tsx}",
  ],
  configPatterns: ["vitest.config.{ts,js,mjs}", "vite.config.ts"],
  toolingDependencies: ["vitest"],
});