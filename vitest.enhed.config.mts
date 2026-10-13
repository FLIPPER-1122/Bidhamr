// Enhedstest (npm run test:enhed): ren logik uden database, Stripe eller
// netværk. Hurtige og kan køres når som helst.
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
    include: ["tests/enhed/**/*.test.ts"],
    environment: "node",
  },
});
