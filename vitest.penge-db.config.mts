// npm run test:penge:db - migrationen 20261019020000_pengeafstemning.sql i
// PGlite (Postgres i processen) + de rene regler. Ingen database, intet
// netværk. Se docs/TEST-PENGE.md.
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
    include: ["tests/penge-db/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    reporters: ["verbose"],
  },
});
