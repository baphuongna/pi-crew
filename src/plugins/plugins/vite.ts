import { definePlugin } from "../plugin-define.ts";

export const VitePlugin = definePlugin({
  name: "vite",
  enablers: ["vite", "rolldown-vite"],
  entryPatterns: [
    "src/main.{ts,tsx,js,jsx}",
    "src/index.{ts,tsx,js,jsx}",
    "index.html",
  ],
  configPatterns: ["vite.config.{ts,js,mts,mjs}"],
  toolingDependencies: ["vite"],
  virtualModulePrefixes: ["virtual:"],
});