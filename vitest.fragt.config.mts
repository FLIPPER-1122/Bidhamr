// npm run test:fragt - enhedstests af fragt-adaptere (DAO, Shipmondo) mod gemte
// eksempelsvar i src/lib/fragt/__fixtures__/. Ingen database, intet netværk:
// fetch og Supabase er erstattet i testene.
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
    include: ["tests/fragt/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    reporters: ["verbose"],
  },
});
