import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { logDriftFejl } from "@/lib/drift";
import { lavMineDataPdf } from "@/lib/pdf/mineDataPdf";

// "Download dine data" (GDPR) - ÉN kodevej for hjemmesiden (/konto/data,
// formularen på /konto) og appen (POST /api/konto/data). Indholdet bygges af
// mine_data() i databasen (udleder brugeren af auth.uid(), højst 1 gang i
// timen). PDF og JSON bygger på præcis samme kald, så grænsen deles: én fil i
// timen, uanset format. supabase kalder databasen SOM brugeren.

export type MineDataFil =
  | { ok: true; indhold: Uint8Array | string; type: string; filnavn: string }
  | { fejl: "vent" | "fejl" };

export async function lavMineDataFil(
  supabase: SupabaseClient,
  brugerId: string,
  somPdf: boolean,
  sti: string,
): Promise<MineDataFil> {
  const { data, error } = await supabase.rpc("mine_data");
  if (error) {
    if (error.code === "BHR01") return { fejl: "vent" };
    await logDriftFejl({ kilde: "server", sti, fejl: error, brugerId });
    return { fejl: "fejl" };
  }

  // Egne maksimumbud (automatisk bud) er med i mine_data() under
  // "mine_maksimumbud" (20261010010000_autobud.sql).
  const dato = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });

  if (somPdf) {
    try {
      return {
        ok: true,
        indhold: await lavMineDataPdf(data),
        type: "application/pdf",
        filnavn: `bidhamr-dine-data-${dato}.pdf`,
      };
    } catch (e) {
      await logDriftFejl({ kilde: "server", sti, fejl: e, brugerId });
      return { fejl: "fejl" };
    }
  }
  return {
    ok: true,
    indhold: JSON.stringify(data, null, 2),
    type: "application/json; charset=utf-8",
    filnavn: `bidhamr-mine-data-${dato}.json`,
  };
}
