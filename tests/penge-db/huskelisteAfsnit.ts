// Migrationerne 20261102410000_huskeliste_oprydning.sql og rettelserne
// 20261102430000_huskeliste_oprydning_rettelser.sql er delt i afsnit
// ("-- @afsnit <navn>"), så hver penge-db-test kan køre netop sit afsnit mod
// sine egne stubs. Hjælperne ("faelles") og oprydningen ("slut") kommer altid
// med. I drift køres hele filen.
import { readFileSync } from "node:fs";
import path from "node:path";

export const HUSKELISTE_FIL = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations/20261102410000_huskeliste_oprydning.sql",
);
export const RETTELSE_FIL = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations/20261102430000_huskeliste_oprydning_rettelser.sql",
);

function afsnitFra(fil: string, navne: string[]): string {
  const sql = readFileSync(fil, "utf8");
  const dele = sql.split(/^-- @afsnit (\w+)\s*$/m);
  const afsnit = new Map<string, string>();
  for (let i = 1; i < dele.length; i += 2) afsnit.set(dele[i], dele[i + 1]);
  for (const n of ["faelles", "slut", ...navne]) {
    if (!afsnit.has(n)) throw new Error(`Afsnittet ${n} findes ikke i ${path.basename(fil)}`);
  }
  return ["faelles", ...navne, "slut"].map((n) => afsnit.get(n)).join("\n");
}

export function huskelisteAfsnit(...navne: string[]): string {
  return afsnitFra(HUSKELISTE_FIL, navne);
}

// Afsnit fra 20261102430000 (køres efter det tilsvarende afsnit fra 410000).
export function rettelseAfsnit(...navne: string[]): string {
  return afsnitFra(RETTELSE_FIL, navne);
}
