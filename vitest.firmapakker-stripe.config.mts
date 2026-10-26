// npm run test:firmapakker:stripe - firmapakkerne end-to-end mod
// TESTdatabasen og Stripes testmiljø (test clock). Samme miljøvagt som
// pengetestene (tests/penge/miljoe.ts: kun testdatabasen og sk_test_).
// Fra en git worktree: PENGE_ENV_FIL=<sti til .env.local>.
import path from "node:path";
import { defineConfig } from "vitest/config";

const rod = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(rod, "src")}/` },
      { find: /^server-only$/, replacement: path.resolve(rod, "tests/penge/stubs/server-only.ts") },
    ],
  },
  test: {
    include: ["tests/stripe-firma/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/stripe-firma/opsaetning.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    reporters: ["verbose"],
  },
});
