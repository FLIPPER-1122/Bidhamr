import "server-only";

// Én drift-alarm pr. tilfælde (Niels F06, 20261011050000 drift_tilfaelde).
// Et tilfælde har en fast nøgle uden persondata (fx "udbetaling-haenger:<id>").
// Alarmen gives første gang, tilfældet ses - og igen, hvis det er løst
// (lukTilfaelde) og opstår på ny. Kaster aldrig.

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl, type DriftKilde } from "@/lib/drift";

export async function alarmPrTilfaelde(o: {
  noegle: string;
  hvor: string;
  fejl: string;
  kilde?: DriftKilde;
  brugerId?: string | null;
}): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("drift_tilfaelde_aabn", { p_noegle: o.noegle.slice(0, 200) });
    if (error) {
      // Tabellen findes ikke endnu (migrationen er ikke kørt): alarmér hellere
      // for meget end for lidt.
      console.error("drift_tilfaelde_aabn:", error.message);
    } else if (data !== true) {
      return false;
    }
    await logDriftFejl({ kilde: o.kilde ?? "server", hvor: o.hvor, fejl: o.fejl, brugerId: o.brugerId ?? null });
    return true;
  } catch (err) {
    console.error("alarmPrTilfaelde fejlede:", o.noegle, err);
    return false;
  }
}

export async function lukTilfaelde(noegle: string): Promise<void> {
  try {
    const { error } = await createAdminClient().rpc("drift_tilfaelde_luk", { p_noegle: noegle.slice(0, 200) });
    if (error) console.error("drift_tilfaelde_luk:", error.message);
  } catch (err) {
    console.error("lukTilfaelde fejlede:", noegle, err);
  }
}
