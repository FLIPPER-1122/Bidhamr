// Pengetestene (npm run test:penge): end-to-end mod TESTdatabasen og Stripes
// testmiljø. Se docs/TEST-PENGE.md.
//
// Testene kører én ad gangen (rigtige Stripe-kald og fælles testdata), med
// lange tidsgrænser (Stripe skal nå at behandle betalinger og udbetalinger).
import path from "node:path";
import { defineConfig } from "vitest/config";
import Navneorden from "./tests/penge/raekkefoelge";

const rod = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(rod, "src")}/` },
      // "server-only" kaster uden for Next - koden her ER server-kode.
      { find: /^server-only$/, replacement: path.resolve(rod, "tests/penge/stubs/server-only.ts") },
    ],
  },
  test: {
    include: ["tests/penge/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/penge/opsaetning.ts"],
    globalSetup: ["tests/penge/global.ts"],
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false, shuffle: false, sequencer: Navneorden },
    reporters: ["verbose"],
    // Testmails ("[testmail, ikke sendt]") og webhook-logs fylder - vis dem
    // med PENGE_LOG=1.
    onConsoleLog(log) {
      if (process.env.PENGE_LOG) return;
      if (log.includes("[testmail, ikke sendt]") || /^Stripe [a-z_.]+: /.test(log)) return false;
    },
  },
});
