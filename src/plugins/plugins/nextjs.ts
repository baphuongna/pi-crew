import { definePlugin } from "../plugin-define.ts";

export const NextJsPlugin = definePlugin({
  name: "nextjs",
  enablers: ["next"],
  entryPatterns: [
    "src/app/**/*.{ts,tsx}",
    "src/pages/**/*.{ts,tsx}",
    "src/app/**/page.{ts,tsx}",
    "src/app/**/layout.{ts,tsx}",
    "src/app/**/route.{ts,tsx}",
    "middleware.{ts,js}",
    "next.config.{ts,js,mjs}",
  ],
  configPatterns: ["next.config.{ts,js,mjs}"],
  toolingDependencies: ["next", "@next/font", "@next/mdx"],
  pathAliases: [["~", "src"]],
  virtualModulePrefixes: ["next:"],
});