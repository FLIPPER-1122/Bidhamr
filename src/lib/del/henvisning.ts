import "server-only";

import { createClient } from "@/lib/supabase/server";
import { renHenvisningskode } from "@/lib/henvisning/kode";

// Del-knappen på auktionssiden lægger den indloggede brugers egen kode fra
// "Henvis en ven" i linket (?ven=<kode>, HENVISNING_PARAM).
//
// Kaldes ved hver visning af en auktionsside (GET), så det er et let,
// læsende opslag: min_henvisningskode() (20261102270000_henvis_rettelser.sql)
// udleder brugeren af auth.uid(), giver kun en kode til private konti og
// opretter aldrig en kode. Koden laves af min_henvisning() på /konto/henvis
// (og i appens POST /api/konto/henvisning). Har brugeren ingen kode endnu,
// indeholder linket kun auktionens id.
export async function henvisningskodeTilDeling(brugerId: string | null): Promise<string | null> {
  if (!brugerId) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("min_henvisningskode");
  if (error) {
    if (error.code !== "PGRST202") console.error("min_henvisningskode:", error.code, error.message);
    return null;
  }
  return renHenvisningskode(data);
}
