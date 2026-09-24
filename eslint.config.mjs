import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agenternes git-worktrees er fulde kopier af repoet og ligger inde i
    // projektmappen. Uden dette linter vi hver fil to gange.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
