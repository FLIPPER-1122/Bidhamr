// Migrationen 20261102410000_huskeliste_oprydning.sql er delt i afsnit
// ("-- @afsnit <navn>"), så hver penge-db-test kan køre netop sit afsnit mod
// sine egne stubs. Hjælperne ("faelles") og oprydningen ("slut") kommer altid
// med. I drift køres hele filen.
import { readFileSync } from "node:fs";
import path from "node:path";

export const HUSKELISTE_FIL = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations/20261102410000_huskeliste_oprydning.sql",
);

export function huskelisteAfsnit(...navne: string[]): string {
  const sql = readFileSync(HUSKELISTE_FIL, "utf8");
  const dele = sql.split(/^-- @afsnit (\w+)\s*$/m);
  const afsnit = new Map<string, string>();
  for (let i = 1; i < dele.length; i += 2) afsnit.set(dele[i], dele[i + 1]);
  for (const n of ["faelles", "slut", ...navne]) {
    if (!afsnit.has(n)) throw new Error(`Afsnittet ${n} findes ikke i 20261102410000`);
  }
  return ["faelles", ...navne, "slut"].map((n) => afsnit.get(n)).join("\n");
}
